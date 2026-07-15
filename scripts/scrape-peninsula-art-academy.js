/**
 * scrape-peninsula-art-academy.js
 *
 * Peninsula Art Academy — a community art school in the village of Peninsula
 * (Cuyahoga Valley), Summit County. It runs exactly the kind of grassroots
 * cultural programming Akron Pulse exists to surface: drop-in and multi-week
 * classes and workshops in painting, drawing, glass, weaving, jewelry, and
 * more, plus kids' art camps.
 *
 * Platform: the Academy's public calendar (peninsulaartacademy.org/calendar)
 * is a Google Calendar AGENDA embed. Viewing source exposes the embed's
 * `src` calendar ID, which maps to the standard public iCal feed:
 *   https://calendar.google.com/calendar/ical/<id>/public/basic.ics
 * We ingest that through the shared lib/ics.js runIcsScraper.
 *
 * Feed quirks (all handled here):
 *   • RECURRING SCHEDULES — Google Calendar encodes multi-week class sessions
 *     as recurring masters (RRULE), not one VEVENT per session, so we run with
 *     `expandRecurring` to materialise each session into a concrete dated
 *     event over a bounded future window (recurrenceWindowDays).
 *   • FULL HISTORY — the feed carries years of past one-offs (~1,900 VEVENTs
 *     back to 2018), so `skipPast` drops anything already over.
 *   • STALE OPEN-ENDED MASTERS — a couple of legacy recurring masters were left
 *     open-ended (no UNTIL / no COUNT) with start dates years in the past (e.g.
 *     an "Acrylic Painting I" weekly series from 2019). Because expansion runs
 *     forward from today, those would manufacture phantom weekly events for
 *     classes that no longer run. Every genuinely-current session in this feed
 *     is bounded with an UNTIL, so we treat an open-ended master whose DTSTART
 *     is older than STALE_AFTER_DAYS as dead and drop its occurrences
 *     (findStaleMasterUids + includeEvent). See the census note.
 *   • ROOM-NAME LOCATIONS — the VEVENT LOCATION is almost always an internal
 *     room ("white room", "high top area", "kiln room", "glass studio"), not a
 *     separate venue. We must NOT mint a venue per room name, so parseLocation
 *     returns null for room names (→ the single fixed Academy venue) and only
 *     maps genuine off-site addresses (e.g. G.A.R. Hall, Happy Days Lodge —
 *     both also in Peninsula) to their own venue.
 *
 * Geography: the Academy is a fixed Summit County venue (Peninsula). Off-site
 * events historically stay in Peninsula (Summit). As a belt-and-suspenders
 * guard against the strict Summit mandate, includeEvent drops any off-site
 * event whose parsed city classifies as 'out' via classifySummitLocation.
 *
 * Category rule (documented + tested in mapCategory): this is an art school,
 * so the default is 'visual-art' (hands-on studio classes/workshops/camps —
 * the overwhelming majority). Events whose FORMAT is educational rather than
 * art-making — lectures, talks, seminars, demos, art history / appreciation,
 * homeschool academic programs — map to 'learning'.
 *
 * Price: null — the feed never states a price; classes are registration-based
 * with fees that vary, and we never assume free.
 *
 * Usage:  node scripts/scrape-peninsula-art-academy.js
 * Env:    VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *         PENINSULA_ART_ACADEMY_ICS_URL — optional feed URL override
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { runIcsScraper, fetchIcsFeed, parseIcs, parseRrule } from './lib/ics.js'
import { classifySummitLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'peninsula_art_academy'

// Public Google Calendar iCal feed (calendar ID lifted from the site's
// Google Calendar embed src).
const ICS_URL =
  process.env.PENINSULA_ART_ACADEMY_ICS_URL ||
  'https://calendar.google.com/calendar/ical/4ipr60i5va24d5u2acrtg8rlrk%40group.calendar.google.com/public/basic.ics'

const RECURRENCE_WINDOW_DAYS = 180
// An open-ended recurring master (no UNTIL / no COUNT) whose DTSTART is older
// than this is treated as a dead legacy series, not a live standing class.
const STALE_AFTER_DAYS = 365
const DAY_MS = 86_400_000

// ── Category mapping ────────────────────────────────────────────────────────

// Educational-FORMAT signals (watching/listening/study) rather than hands-on
// studio art-making. Everything else at this art school is 'visual-art'.
const LEARNING_RE =
  /\b(lecture|talk|seminar|panel|book club|art history|appreciation|demo\b|demonstration|home\s?school|homeschool|what is )\b/i

/**
 * Content category for an event. Default 'visual-art' (hands-on art class /
 * workshop / camp — the dominant case); 'learning' for educational-format
 * events (lectures, talks, seminars, demos, art history/appreciation,
 * homeschool academic programs). Exported for tests.
 */
export function mapCategory(ev) {
  const text = `${ev?.SUMMARY || ''} ${ev?.DESCRIPTION || ''}`
  return LEARNING_RE.test(text) ? 'learning' : 'visual-art'
}

/** Supplementary medium/audience tags from the title + description. */
export function mapTags(ev) {
  const text = `${ev?.SUMMARY || ''} ${ev?.DESCRIPTION || ''}`.toLowerCase()
  const tags = ['art', 'peninsula', 'peninsula-art-academy']
  if (/\bglass|fus(e|ing|ed)|enamel|stained[- ]?glass|blow/i.test(text)) tags.push('glass-art')
  if (/\bpaint|watercolo|oil|acrylic/i.test(text))                        tags.push('painting')
  if (/\bdraw|sketch|comic/i.test(text))                                  tags.push('drawing')
  if (/\bweav|loom|fiber|sew|felt|knit|silk/i.test(text))                 tags.push('fiber-art')
  if (/\bjewel|metal(?:smith|working)?\b/i.test(text))                    tags.push('jewelry')
  if (/\bceramic|clay|pottery|glaze/i.test(text))                         tags.push('ceramics')
  if (/\bphoto/i.test(text))                                              tags.push('photography')
  if (/\bcamp\b|\bkids?\b|\bchild|age\s*\d|\bteen/i.test(text))           tags.push('kids')
  return [...new Set(tags)]
}

// ── Off-site venue parsing (keeps room names on the single Academy venue) ────

// A LOCATION only names a distinct venue when it carries a street address; the
// Academy's room names ("white room", "high top area", "kiln room", …) never
// do. This detects "…, <number> <street>, <city>, <ST>[ <zip>][, country]".
const HAS_STREET_ADDRESS_RE = /\b\d{1,6}\s+[A-Za-z]/

/**
 * Parse a Google Calendar LOCATION into { name, details, city } when it is a
 * genuine off-site venue with a street address; return null for internal room
 * names (so the event falls back to the fixed Academy venue) and for the
 * Academy's own address form (same venue). Exported for tests.
 */
export function parsePeninsulaLocation(loc) {
  const raw = (loc || '').trim()
  if (!raw) return null
  if (!HAS_STREET_ADDRESS_RE.test(raw)) return null   // room name → default venue

  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return null
  if (/^(united states|usa|us)$/i.test(parts[parts.length - 1] || '')) parts.pop()

  // Google Calendar packs state + zip into one comma part ("OH 44264"); accept
  // that, plus the split forms ("OH", "44264") some entries use.
  let zip = null, state = null, city = null
  const stZip = (parts[parts.length - 1] || '').match(/^([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/)
  if (stZip) {
    state = stZip[1]; zip = stZip[2]; parts.pop()
  } else {
    if (/^\d{5}(-\d{4})?$/.test(parts[parts.length - 1] || '')) zip = parts.pop()
    if (/^[A-Za-z]{2}$/.test(parts[parts.length - 1] || '')) state = parts.pop()
  }
  if (parts.length) city = parts.pop()

  let address = null, name = null
  if (parts.length >= 2) {
    address = parts.pop()          // street address sits last, before the city
    name = parts.join(', ')
  } else {
    name = parts.join(', ') || city
  }
  if (!name) return null
  // The Academy's own address form → use the fixed default venue, not a copy.
  if (/peninsula art academy/i.test(name)) return null

  return {
    name,
    city: city || 'Peninsula',
    details: { address, city: city || 'Peninsula', state: (state || 'OH').toUpperCase(), zip },
  }
}

// ── Stale recurring-master detection ────────────────────────────────────────

/**
 * Collect the base UIDs of open-ended recurring masters (RRULE with neither
 * UNTIL nor COUNT) whose DTSTART is older than STALE_AFTER_DAYS — legacy series
 * that no longer run but would otherwise manufacture phantom future
 * occurrences on expansion. Exported for tests.
 *
 * @param {object[]} rawEvents — parseIcs() output
 * @param {object} [opts] — { nowMs, staleAfterDays }
 * @returns {Set<string>} base UIDs to drop
 */
export function findStaleMasterUids(rawEvents = [], opts = {}) {
  const nowMs = opts.nowMs ?? Date.now()
  const staleAfterDays = opts.staleAfterDays ?? STALE_AFTER_DAYS
  const cutoffMs = nowMs - staleAfterDays * DAY_MS
  const stale = new Set()
  for (const ev of rawEvents) {
    if (!ev?.RRULE || !ev?.DTSTART?.value) continue
    const rule = parseRrule(ev.RRULE)
    if (rule.UNTIL || rule.COUNT) continue           // bounded → self-expires
    const m = (ev.DTSTART.value || '').match(/^(\d{4})(\d{2})(\d{2})/)
    if (!m) continue
    const startMs = Date.UTC(+m[1], +m[2] - 1, +m[3])
    if (startMs < cutoffMs) {
      const uid = (ev.UID || '').trim()
      if (uid) stale.add(uid)
    }
  }
  return stale
}

/** Strip the `_YYYYMMDD` occurrence suffix expandRecurrence appends to UIDs. */
function baseUid(uid) {
  return (uid || '').trim().replace(/_\d{8}$/, '')
}

/**
 * Per-occurrence filter: drop phantom occurrences of stale masters, private
 * (non-public) classes, internal admin/volunteer meetups, and any off-site
 * event whose city classifies as outside Summit County. Exported (curried)
 * for tests.
 */
export function makeIncludeEvent(staleUids = new Set()) {
  return function includeEvent(ev) {
    const uid = ev?.UID || ''
    if (staleUids.has(baseUid(uid))) return false

    const title = (ev?.SUMMARY || '').trim()
    // Private lessons / internal coordination are not public events.
    if (/\bprivate\b/i.test(title)) return false
    if (/\b(staff|board|members?)\b.*\bmeet|meet-?up\b|\bmeeting\b/i.test(title)) return false

    // Off-site Summit gate: only meaningful when LOCATION names a real address.
    const parsed = parsePeninsulaLocation(ev?.LOCATION)
    if (parsed && classifySummitLocation({ city: parsed.city }) === 'out') return false

    return true
  }
}

export const config = {
  source: SOURCE_KEY,
  feedUrl: ICS_URL,
  expandRecurring: true,
  recurrenceWindowDays: RECURRENCE_WINDOW_DAYS,
  skipPast: true,
  organizationName: 'Peninsula Art Academy',
  organizationDetails: {
    website: 'https://www.peninsulaartacademy.org',
    description:
      'Peninsula Art Academy is a community art school in the village of Peninsula (Cuyahoga Valley), offering classes, workshops, and camps in painting, drawing, glass, weaving, jewelry, and more.',
  },
  defaultVenueName: 'Peninsula Art Academy',
  defaultVenueDetails: {
    address: '1600 W Mill St', city: 'Peninsula', state: 'OH', zip: '44264',
    website: 'https://www.peninsulaartacademy.org',
  },
  parseLocation: parsePeninsulaLocation,
  mapCategory,
  mapTags,
  defaultPriceMin: null,   // never assume free
  defaultPriceMax: null,
}

export async function main() {
  // Fetch once, use the text to (a) detect stale open-ended masters and (b)
  // feed runIcsScraper (via getIcsText) so we don't hit the network twice.
  const icsText = await fetchIcsFeed(config.feedUrl)
  const staleUids = findStaleMasterUids(parseIcs(icsText), { nowMs: Date.now() })
  if (staleUids.size) {
    console.log(`  ⏭  Dropping ${staleUids.size} stale open-ended recurring master(s)`)
  }
  await runIcsScraper({
    ...config,
    getIcsText: async () => icsText,
    includeEvent: makeIncludeEvent(staleUids),
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
