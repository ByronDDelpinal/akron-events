/**
 * scrape-christ-community-chapel.js
 *
 * Christ Community Chapel (CCH / "CCC") — large nondenominational church whose
 * main campus is at 750 W Streetsboro St, Hudson, OH 44236 (Summit County).
 *
 * Platform: a bespoke, SERVER-RENDERED events page at ccchapel.com/events that
 * is a themed front-end over Planning Center Events. Each list row is an
 * `<a class="event-item">` carrying a stable `data-event-id`
 * ("event_20899793"), a machine `data-date-full-start` ("2026-09-03 16:00"),
 * comma `data-tags`, the title, and a Planning Center image URL. There is NO
 * JSON-LD event feed and NO iCal export (the "ical" substrings on the page are
 * false positives inside CSS filenames), so we parse the HTML directly.
 *
 * Strategy — list + detail crawl:
 *   1. GET /events → parse every event-item (title, href, id, tags, image).
 *   2. GET each detail page → the human description plus the authoritative
 *      date/time data. Recurring events render an "Upcoming Event Dates" list
 *      of `.instance-item` blocks (each with a start–end time); single events
 *      render one "Event Information" sidebar card with Date + Time. The list
 *      page only shows a single (next) occurrence, so the detail page is the
 *      only place to get END times and every upcoming recurrence.
 *
 * FAITH ALLOWLIST (mandatory): a church calendar is overwhelmingly internal
 * congregational activity — worship, classes, small groups, ministry team
 * meetings, member care. We ingest ONLY genuinely public-community events via
 * the shared allowlist `isPublicFaithEvent` (lib/faith-events.js), plus a small
 * scraper-local supplement (EXTRA_PUBLIC_RE) for two public event types this
 * church clearly runs that the shared list phrases just miss: an outdoor
 * community car show ("show of 400+ great cars") and an outdoor movie night
 * ("Pixar in the Park … under the stars"). A hard PRIVATE_RE override keeps
 * anything explicitly internal out even if it trips a public keyword. Expect to
 * skip the large majority of the page — that is correct behavior. (Recommend
 * folding the EXTRA_PUBLIC_RE patterns into faith-events.js; see report.)
 *
 * GEOGRAPHY (strict Summit mandate): the detail pages carry no per-event
 * location, and the surviving public events are held at the Hudson campus /
 * its outdoor "Legacy Park" grounds (both Hudson, Summit County). We default
 * the venue to the Hudson campus and gate every event through
 * classifySummitLocation(): if an event's text names a known non-Summit
 * community (e.g. Aurora/Streetsboro = Portage, Independence = Cuyahoga) it is
 * dropped ('out') or queued ('unknown'); Hudson resolves 'in' → published.
 *
 * Usage:   node scripts/scrape-christ-community-chapel.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, htmlToText, easternToIso,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'
import { isPublicFaithEvent } from './lib/faith-events.js'
import {
  classifySummitLocation, SUMMIT_COUNTY_CITIES, NOT_SUMMIT_COUNTY_CITIES,
} from './lib/summit-county.js'

export const SOURCE_KEY = 'christ_community_chapel'

const ORIGIN   = 'https://ccchapel.com'
const LIST_URL = `${ORIGIN}/events`
const DAYS_AHEAD = 180
const FETCH_DELAY_MS = 150
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

const ORG_NAME = 'Christ Community Chapel'
const CAMPUS_VENUE = 'Christ Community Chapel'
const CAMPUS_DETAILS = {
  address: '750 W Streetsboro St',
  city: 'Hudson', state: 'OH', zip: '44236',
  lat: 41.2398, lng: -81.4404,
  website: ORIGIN,
  parking_type: 'lot',
  description: 'Nondenominational church in Hudson; hosts public community events at its campus and adjacent Legacy Park grounds.',
}
// Legacy Park is CCC's own outdoor grounds beside the Hudson campus.
const LEGACY_PARK_VENUE = 'Legacy Park'
const LEGACY_PARK_DETAILS = {
  address: '750 W Streetsboro St',
  city: 'Hudson', state: 'OH', zip: '44236',
  lat: 41.2398, lng: -81.4404,
  website: ORIGIN,
  parking_type: 'lot',
  description: "Christ Community Chapel's outdoor community grounds in Hudson.",
}

// ── Faith allowlist gate (exported for tests) ───────────────────────────────

// Public event types this church runs that the shared allowlist's phrasing
// narrowly misses. Kept deliberately specific and PUBLIC-only so no internal
// event can leak in: an outdoor movie night and an outdoor car cruise-in.
const EXTRA_PUBLIC_RE = new RegExp([
  'outdoor movie', 'movie (?:night )?(?:in|under|at) the (?:park|stars)',
  'movie in the park', 'dive[- ]?in movie', 'films? (?:in|under) the (?:park|stars)',
  '\\bcar show\\b', 'car cruise', '\\bcruise[- ]?in\\b',
  'show of \\d+\\+? (?:great )?cars', 'classic cars',
].join('|'), 'i')

// Hard internal markers — override any public keyword. A church "class",
// "study", "worship", "rehearsal", "small group" or internal "meeting" is
// never a public community event even if the blurb mentions e.g. "live music".
const PRIVATE_RE = new RegExp([
  'bible study', 'small group', 'prayer (?:group|meeting|gathering)',
  'worship (?:service|night|gathering)', '\\bmass\\b', 'sunday service',
  'rehearsal', 'staff meeting', 'board meeting', 'member(?:ship)? (?:meeting|class)',
  'sunday school', 'discipleship',
].join('|'), 'i')

// Incidental uses of the shared list's fundraiser signal "benefit" — the VERB
// ("would benefit from", "beneficial") rather than the noun ("Benefit Concert").
// Left in, it false-matches internal ministry blurbs (the Ability Inclusion
// classes: "…would benefit from a volunteer pairing…"). Stripped before the
// shared check so a real fundraiser "benefit" still matches. (Recommend the
// shared list gain the same guard — see report.)
const INCIDENTAL_RE =
  /\bbenefits?\s+from\b|\b(?:would|could|may|might|will|can|to)\s+benefits?\b|\bbeneficial\b/gi

// Cancelled/postponed events are left on the page with a title marker rather
// than removed. Title-scoped (never description — "no refunds if cancelled").
const CANCELLED_RE = /\bcancel?led\b|\bpostponed\b/i

/** True when a CCC event is a genuinely public-community event (allowlist). */
export function isPublicEvent(title, description = '') {
  // Fold apostrophes so possessives don't defeat the allowlist — e.g. the
  // shared `farmers?[ -]?market` pattern misses "Farmer's Market" verbatim.
  const norm = (s) => String(s || '').replace(/[’']/g, '')
  const t = norm(title); const d = norm(description)
  const text = `${t} ${d}`
  if (CANCELLED_RE.test(t)) return false      // scratched — drop
  if (PRIVATE_RE.test(text)) return false
  // Neutralise incidental "benefit" before the shared allowlist runs.
  const ts = t.replace(INCIDENTAL_RE, ' ')
  const ds = d.replace(INCIDENTAL_RE, ' ')
  return isPublicFaithEvent(ts, ds) || EXTRA_PUBLIC_RE.test(text)
}

// ── Summit County campus resolution (exported for tests) ────────────────────

// City detector restricted to GENUINE location contexts. A bare free-text scan
// is unsafe here because many Ohio place names are common English words
// ("Independence Day", "mentor kids", "Orange you glad", "Warren", "Canton") —
// scanning the whole title/description silently dropped legit Hudson public
// events whenever a blurb happened to contain such a word. Instead we only
// treat a city name as a location signal when it appears in an explicit
// locative frame: "in/at/near <City>" or "<City> campus". Non-Summit hit still
// wins (strict mandate). Absent any location signal → Hudson campus.
// Prepositions are deliberately limited to in/at/near — "to"/"from" front verbs
// ("to mentor", "benefit from") and would re-introduce the collision.
function findCity(text, citySet) {
  const t = String(text || '').toLowerCase()
  for (const city of citySet) {
    const c = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\b(?:in|at|near)\\s+${c}\\b|\\b${c}\\s+campus\\b`)
    if (re.test(t)) return city
  }
  return null
}

/**
 * Resolve venue + city for the Summit gate from an event's text/tags.
 * Returns { venueName, venueDetails, city }.
 */
export function resolveCampus(title, description = '', tags = '') {
  const text = `${title || ''} ${description || ''} ${tags || ''}`
  // Explicit out-of-county community named in the text → gate it there.
  const outCity = findCity(text, NOT_SUMMIT_COUNTY_CITIES)
  if (outCity) {
    return { venueName: CAMPUS_VENUE, venueDetails: CAMPUS_DETAILS, city: outCity }
  }
  if (/legacy park/i.test(text)) {
    return { venueName: LEGACY_PARK_VENUE, venueDetails: LEGACY_PARK_DETAILS, city: 'Hudson' }
  }
  const inCity = findCity(text, SUMMIT_COUNTY_CITIES)
  return { venueName: CAMPUS_VENUE, venueDetails: CAMPUS_DETAILS, city: inCity || 'Hudson' }
}

// ── List parsing (exported for tests) ───────────────────────────────────────

/** Parse the /events list into raw event-item descriptors. */
export function parseListItems(html) {
  const out = []
  const chunks = String(html).split(/(?=<a href="[^"]*"\s+class="event-item")/)
  for (const c of chunks) {
    if (!/class="event-item"/.test(c)) continue
    const href  = c.match(/<a href="([^"]+)"/)?.[1] ?? null
    const id    = c.match(/data-event-id="([^"]+)"/)?.[1] ?? null
    const start = c.match(/data-date-full-start="([^"]*)"/)?.[1] ?? null
    const tags  = c.match(/data-tags="([^"]*)"/)?.[1] ?? ''
    const title = stripHtml(c.match(/<h3 class="event-title">([\s\S]*?)<\/h3>/)?.[1] ?? '')
    const image = c.match(/<div class="event-image">[\s\S]*?<img[^>]+src="([^"]+)"/)?.[1] ?? null
    if (!href || !id || !title) continue
    out.push({ href, id, title, tags, listStart: start, image: decodeAmp(image) })
  }
  return out
}

function decodeAmp(url) {
  return url ? url.replace(/&amp;/g, '&') : url
}

// ── Detail parsing (exported for tests) ─────────────────────────────────────

/** Extract the plain-text description from a detail page. */
export function parseDescription(html) {
  const m = String(html).match(/<div class="description-content">([\s\S]*?)<\/div>\s*<\/div>/)
  if (!m) return ''
  return htmlToText(m[1]).replace(/\s+/g, ' ').trim()
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
}

/** "Thursday, September 03, 2026" → "2026-09-03" (weekday optional). */
export function parseHumanDate(text) {
  const m = String(text || '').match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/)
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  if (!month) return null
  const day = Number(m[2]); const year = Number(m[3])
  if (!day || !year) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** "4:00 PM - 7:00 PM" | "6:30 PM" | "All Day" | "" → {start, end, allDay}. */
export function parseTimeRange(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw || /all\s*day/i.test(raw)) return { start: null, end: null, allDay: true }
  const parts = raw.split(/\s*[-–—]\s*/)
  const clock = /\d{1,2}(?::\d{2})?\s*[AaPp]\.?[Mm]\.?/
  const start = parts[0] && clock.test(parts[0]) ? parts[0].trim() : null
  const end   = parts[1] && clock.test(parts[1]) ? parts[1].trim() : null
  if (!start) return { start: null, end: null, allDay: true }
  return { start, end, allDay: false }
}

/**
 * Parse every upcoming occurrence from a detail page.
 * Recurring events: one `.instance-item` per date. Single events: the
 * "Event Information" sidebar card. Returns [{ date, start, end, allDay }].
 */
export function parseOccurrences(html) {
  const src = String(html)
  const out = []
  const instances = src.split('class="instance-item"').slice(1)
  if (instances.length) {
    for (const block of instances) {
      const dateText = block.match(/instance-date">([\s\S]*?)<\/div>/)?.[1] ?? ''
      const timeText = block.match(/instance-time">([\s\S]*?)<\/div>/)?.[1] ?? ''
      const date = parseHumanDate(stripHtml(dateText))
      if (!date) continue
      out.push({ date, ...parseTimeRange(stripHtml(timeText)) })
    }
    return out
  }
  // Single-occurrence: the "Event Information" sidebar card. The Date/Time
  // "info-label → info-value" pairs are unique to this card on a detail page,
  // so we anchor on the label rather than windowing a fragile block.
  const infoValue = (label) =>
    src.match(new RegExp(`info-label">\\s*${label}\\s*</div>\\s*<div[^>]*class="info-value"[^>]*>([\\s\\S]*?)</div>`, 'i'))?.[1] ?? ''
  const dateText = infoValue('Date')
  const timeText = infoValue('Time')
  const date = parseHumanDate(stripHtml(dateText))
  if (date) out.push({ date, ...parseTimeRange(stripHtml(timeText)) })
  return out
}

/** Stable per-occurrence id: the Planning Center event id + the date. */
export function buildSourceId(eventId, dateYmd) {
  return `${eventId}-${dateYmd}`
}

// ── Fetch helpers ───────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
  return res.text()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log('⛪  Starting Christ Community Chapel ingestion…')
  const start = Date.now()
  const nowMs = Date.now()
  const horizonMs = nowMs + DAYS_AHEAD * 86400_000
  const pastCutoffMs = nowMs - 86400_000 // ~1 day grace

  try {
    const [organizerId, campusVenueId] = await Promise.all([
      ensureOrganization(ORG_NAME, {
        website: ORIGIN,
        description: 'Nondenominational church in Hudson (Summit County) serving the greater Akron area.',
      }),
      ensureVenue(CAMPUS_VENUE, CAMPUS_DETAILS),
    ])
    if (campusVenueId) await linkOrganizationVenue(organizerId, campusVenueId)

    console.log(`\n🔍  Fetching event list: ${LIST_URL}`)
    const listHtml = await fetchHtml(LIST_URL)
    const items = parseListItems(listHtml)
    console.log(`  Found ${items.length} event-items on the list page.`)

    let inserted = 0, skippedInternal = 0, skippedGeo = 0, skippedOther = 0
    const venueCache = new Map([[CAMPUS_VENUE, campusVenueId]])

    for (const item of items) {
      try {
        // Detail page: needed for the description (faith gate), end times and
        // every upcoming recurrence.
        const detailHtml = await fetchHtml(item.href)
        await sleep(FETCH_DELAY_MS)
        const description = parseDescription(detailHtml)

        if (!isPublicEvent(item.title, description)) {
          skippedInternal++ // internal congregational activity — the common case
          continue
        }

        const { venueName, venueDetails, city } = resolveCampus(item.title, description, item.tags)
        const locality = classifySummitLocation({ city })
        if (locality === 'out') {
          console.log(`  ⤫ Out of Summit County ("${item.title}" → ${city}) — skipped`)
          skippedGeo++
          continue
        }
        const status = locality === 'in' ? 'published' : 'pending_review'
        const needsReview = locality !== 'in'

        // Resolve (and cache) the venue.
        let venueId = venueCache.get(venueName)
        if (venueId === undefined) {
          venueId = await ensureVenue(venueName, venueDetails)
          venueCache.set(venueName, venueId)
        }

        const occurrences = parseOccurrences(detailHtml)
        if (!occurrences.length) {
          console.warn(`  ⚠ No parseable date for "${item.title}" (${item.href}) — skipped`)
          skippedOther++
          continue
        }

        console.log(`  ✓ Public event: "${item.title}" — ${occurrences.length} date(s)`)
        for (const occ of occurrences) {
          const start_at = easternToIso(occ.date, occ.start || '')
          if (!start_at) { skippedOther++; continue }
          const startMs = Date.parse(start_at)
          if (startMs < pastCutoffMs || startMs > horizonMs) continue

          const end_at = occ.end ? easternToIso(occ.date, occ.end) : null
          const row = {
            title:           item.title,
            description:     description || null,
            start_at,
            end_at,
            tags:            ['christ-community-chapel', 'hudson', 'faith', 'community'],
            price_min:       null,
            price_max:       null,
            age_restriction: 'not_specified',
            image_url:       item.image,
            ticket_url:      item.href,
            source_url:      item.href,
            source:          SOURCE_KEY,
            source_id:       buildSourceId(item.id, occ.date),
            status,
            needs_review:    needsReview,
            featured:        false,
          }

          const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
          if (error) {
            console.warn(`  ⚠ Upsert failed for "${row.title}" (${occ.date}): ${error.message}`)
            skippedOther++
          } else {
            if (venueId) await linkEventVenue(upserted.id, venueId)
            await linkEventOrganization(upserted.id, organizerId)
            inserted++
          }
        }
      } catch (err) {
        console.warn(`  ⚠ Error processing "${item.title}": ${err.message}`)
        skippedOther++
      }
    }

    const skipped = skippedInternal + skippedGeo + skippedOther
    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: items.length, durationMs: Date.now() - start,
    })
    console.log(
      `\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ` +
      `${skipped} skipped (${skippedInternal} internal, ${skippedGeo} out-of-county, ${skippedOther} other).`,
    )
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
