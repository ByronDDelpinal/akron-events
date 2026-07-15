/**
 * scrape-akron-power-squadron.js
 *
 * Akron Sail & Power Squadron (akronpowersquadron.com) — the Akron chapter of
 * America's Boating Club (United States Power Squadrons). Beyond internal club
 * business it runs public, open-registration boating-safety education: on-water
 * kayaking seminars (PaddleSmart), America's Boating Course classes, and open
 * paddle/cruise outings on the Portage Lakes and nearby reservoirs. Those public
 * events are what Akron Pulse surfaces; members-only meetings and social
 * gatherings are filtered out.
 *
 * Platform: WordPress + The Events Calendar (Tribe). The site's Tribe REST API
 * and its iCal export are BOTH gated behind a SiteGround "sgcaptcha" bot wall —
 * every URL on the domain (even robots.txt, even a Googlebot UA) returns an
 * HTTP 202 meta-refresh to /.well-known/sgcaptcha/, a passive JS proof-of-work
 * challenge. A normal browser solves it transparently and gets a clearance
 * cookie; a plain fetch never clears. So we mirror the north_hill_cdc /
 * life_gurukula strategy: try a direct fetch first (cheap, in case the WAF ever
 * relaxes), then fall back to headless Chrome which renders /events/, lets the
 * challenge clear, and fetches the ICS from inside the page context (cookie +
 * realistic UA attached).
 *
 * Why ICS over the Tribe REST API here: the REST feed on Tribe installs is prone
 * to the "UTC+0" timezone misconfiguration (utc_start_date === start_date; see
 * scrape-peninsula-coffee-house.js). This site's ICS export instead carries a
 * proper VTIMEZONE with DTSTART;TZID=America/New_York on every VEVENT, so
 * icsDateToIso resolves the correct UTC instant with no misconfiguration guard
 * needed. Verified 2026-07-15: PaddleSmart's "warm summer evening" seminar is
 * DTSTART;TZID=America/New_York:20260728T173000 (5:30 PM ET) — a real posted
 * time, not a synthesized midnight.
 *
 * Feed quirks (verified 2026-07-15):
 *   • LOCATION is the Events-Calendar composite string
 *     "Venue Name, [locality,] Street, City, [State,] [Zip,] Country" — commas
 *     inside are ICS-escaped (\,). State and/or zip are sometimes omitted. We
 *     pop the trailing country/zip/state/city off the end (parseLocation) so we
 *     mint a clean venue name + address instead of an address-in-name junk venue.
 *   • Events are held at VARYING venues (Portage Lakes parks, Mogadore Reservoir,
 *     restaurants, and occasionally out-of-county club outings), so each event is
 *     geo-gated with classifySummitLocation on its parsed city: 'out' → skip,
 *     'unknown' → ingest as pending_review, 'in' → published (strict Summit
 *     mandate).
 *   • ORGANIZER is a per-event contact person (e.g. CN="Craig Feldman"), not the
 *     club, so we pin every event to the one canonical organization instead.
 *   • Image is carried as ATTACH;FMTTYPE=image/*; price is never stated (kept null).
 *   • UID is the stable Tribe form "<postid>-<startEpoch>-<endEpoch>@domain",
 *     unique per occurrence — used verbatim as source_id.
 *
 * Scope: public boating-safety education (course/seminar/class → learning) and
 * open paddle/cruise outings (→ outdoors); everything else defers to
 * inferCategory. Members-only business meetings and member/family socials
 * (bridge/board meetings, corn roast, Christmas party, awards banquet, …) are
 * skipped as internal programs (isInternalEvent).
 *
 * Usage:   node scripts/scrape-akron-power-squadron.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional: AKRON_POWER_SQUADRON_ICS_URL — direct ICS feed URL (tried first)
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, enrichWithImageDimensions,
  upsertEventSafe, ensureVenue, ensureOrganization, linkEventVenue,
  linkEventOrganization,
} from './lib/normalize.js'
import { inferCategory } from './lib/category-inference.js'
import { parseIcs, icsDateToIso } from './lib/ics.js'
import { classifySummitLocation } from './lib/summit-county.js'
import { withBrowser, newConfiguredPage } from './lib/puppeteer.js'

export const SOURCE_KEY = 'akron_power_squadron'

const EVENTS_PAGE_URL = 'https://akronpowersquadron.com/events/'
// The list-view iCal export returns every upcoming event; the /events/?ical=1
// month view is a narrower fallback. Both verified serving text/calendar.
const FEED_CANDIDATES = [...new Set([
  process.env.AKRON_POWER_SQUADRON_ICS_URL,
  'https://akronpowersquadron.com/?post_type=tribe_events&ical=1&eventDisplay=list',
  'https://akronpowersquadron.com/events/?ical=1',
].filter(Boolean))]

// Realistic Chrome-on-Mac fingerprint — matches lib/puppeteer.js so we look
// identical to a normal browser to the SiteGround WAF.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const ORG_NAME = 'Akron Sail & Power Squadron'
const ORG_DETAILS = {
  website: 'https://akronpowersquadron.com',
  description:
    'The Akron chapter of America’s Boating Club (United States Power Squadrons), ' +
    'offering public boating-safety education, on-water paddling seminars, and open ' +
    'boating outings on the Portage Lakes and around Summit County.',
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/**
 * Internal, members-only events we never surface on a public community calendar:
 * business/bridge/board meetings and member-and-family socials (corn roast,
 * Christmas/holiday party, awards banquet, installation dinner, potluck). Public
 * boating education and open paddles/cruises deliberately do NOT match. Matched
 * on the title only. Exported for tests.
 */
const INTERNAL_RE = new RegExp(
  '\\b(' +
  'meeting|bridge meeting|board meeting|membership|executive committee|exec\\.? comm|' +
  'business session|corn roast|(?:christmas|holiday|new year(?:\'s)?) party|' +
  'awards? (?:dinner|banquet|night)|installation (?:dinner|banquet|ceremony)|' +
  'pot ?luck|change of watch|dining out' +
  ')\\b', 'i',
)
export function isInternalEvent(title = '') {
  return INTERNAL_RE.test(String(title))
}

/**
 * Parse an Events-Calendar composite LOCATION —
 * "Venue Name[, locality], Street, City[, State][, Zip], Country" (the name may
 * itself contain commas) — into { name, details:{ address, city, state, zip } }.
 * Pops the trailing Country / 5-digit Zip / 2-letter State / City off the end;
 * of what remains, the last part is the street address and the rest is the venue
 * name. State and zip are optional (this feed omits them on some events).
 * Returns null when the string is empty. Exported for tests.
 */
export function parseLocation(loc) {
  if (!loc) return null
  const parts = String(loc).split(',').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return null

  if (/^(united states|usa|us)$/i.test(parts[parts.length - 1] || '')) parts.pop()
  let zip = null, state = null, city = null
  if (/^\d{5}(-\d{4})?$/.test(parts[parts.length - 1] || '')) zip = parts.pop()
  if (/^[A-Z]{2}$/.test(parts[parts.length - 1] || '')) state = parts.pop()
  if (parts.length) city = parts.pop()

  let address = null, name = null
  if (parts.length >= 2) {
    address = parts.pop()          // street address sits last, before the city
    name = parts.join(', ')
  } else {
    name = parts.join(', ') || city
  }
  if (!name) return null
  return {
    name,
    details: {
      address: address || null,
      city: city || null,
      state: state || 'OH',
      zip: zip || null,
    },
  }
}

// Public boating-safety EDUCATION → learning (checked first — a PaddleSmart
// "seminar" is education even though it happens from a kayak). Open on-water
// recreation (paddles, cruises, sails) → outdoors. Everything else falls through
// to inferCategory (null hint).
const EDUCATION_RE = new RegExp(
  '\\b(course|seminar|workshop|class(?:es)?|lesson|instruction(?:al)?|training|' +
  'certification|clinic|vessel safety|safety check|america\'?s boating|' +
  'boating (?:course|skills|class)|navigation|paddlesmart|abc course)\\b', 'i',
)
const ONWATER_RE = new RegExp(
  '\\b(paddle|kayak|canoe|cruise|sail|regatta|reservoir|\\blake\\b|on[- ]the[- ]water|' +
  'raft|float|boating outing|rendezvous)\\b', 'i',
)
/** 'learning' | 'outdoors' | null (null → inferCategory decides). Exported for tests. */
export function mapCategory(title = '', description = '') {
  const hay = `${title} ${description}`
  if (EDUCATION_RE.test(hay)) return 'learning'
  if (ONWATER_RE.test(hay))   return 'outdoors'
  return inferCategory(title, description) || null
}

/**
 * Normalise a parsed VEVENT into an event row plus its Summit-County
 * classification, or null when the event should be skipped (no title/start,
 * internal event, out-of-county, or already ended). `nowMs` is injectable for
 * deterministic tests. Exported for tests.
 */
export function normalizeEvent(ev, nowMs = Date.now()) {
  const title = stripHtml(ev.SUMMARY ?? '').trim()
  if (!title) return null
  if (isInternalEvent(title)) return { skip: 'internal' }

  const start_at = ev.DTSTART ? icsDateToIso(ev.DTSTART.value, ev.DTSTART.params) : null
  if (!start_at) return null
  if (Date.parse(start_at) < nowMs - 86_400_000) return { skip: 'past' } // ended > ~1 day ago

  const end_at = ev.DTEND ? icsDateToIso(ev.DTEND.value, ev.DTEND.params) : null
  const source_id = (ev.UID ?? '').trim()
  if (!source_id) return null

  const parsed = parseLocation(ev.LOCATION)
  const geo = classifySummitLocation({ city: parsed?.details?.city })
  if (geo === 'out') return { skip: 'out_of_county' }

  const description = ev.DESCRIPTION ? stripHtml(ev.DESCRIPTION).slice(0, 5000) || null : null
  const attach = typeof ev.ATTACH === 'string' && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(ev.ATTACH)
    ? ev.ATTACH
    : null

  const row = {
    title,
    description,
    start_at,
    end_at,
    category: mapCategory(title, description ?? ''),
    tags: ['boating', 'akron-sail-power-squadron', 'summit-county'],
    price_min: null,
    price_max: null,
    age_restriction: 'not_specified',
    image_url: attach,
    ticket_url: ev.URL || null,
    source: SOURCE_KEY,
    source_id,
    // Strict Summit gate: publish in-county, queue unknown-locality for review.
    status: geo === 'in' ? 'published' : 'pending_review',
    needs_review: geo !== 'in',
    featured: false,
  }
  return { row, venue: parsed, geo }
}

// ── Fetch (SiteGround sgcaptcha aware) ───────────────────────────────────────

/** Direct fetch of one candidate with browser-like headers; throws unless ICS. */
async function fetchFeedCandidate(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent':      BROWSER_UA,
      'Accept':          'text/calendar, text/plain, */*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer':         EVENTS_PAGE_URL,
      'Sec-Fetch-Dest':  'document',
      'Sec-Fetch-Mode':  'navigate',
      'Sec-Fetch-Site':  'same-origin',
      'Sec-Fetch-User':  '?1',
    },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('non-iCalendar body (sgcaptcha?)')
  return text
}

/**
 * Headless-Chrome fallback for the SiteGround sgcaptcha wall. Render /events/
 * so the passive JS challenge runs and sets its clearance cookie, then fetch
 * each candidate ICS URL from inside the page context (inherits the cookie + UA).
 */
async function fetchIcsViaBrowser() {
  return withBrowser(async (browser) => {
    const page = await newConfiguredPage(browser, { userAgent: BROWSER_UA })
    await page.goto(EVENTS_PAGE_URL, { waitUntil: 'networkidle2', timeout: 30_000 })

    try {
      await page.waitForFunction(
        () =>
          !/\/\.well-known\/(?:sgcaptcha|captcha)\//.test(location.href) &&
          !/robot challenge/i.test(document.title || ''),
        { timeout: 25_000, polling: 500 },
      )
    } catch {
      throw new Error(
        'sgcaptcha challenge did not clear within 25s — an interactive CAPTCHA ' +
        'may have been served to the headless browser instead of the passive ' +
        'JS challenge a normal browser receives.',
      )
    }

    if (!page.url().includes('/events')) {
      await page.goto(EVENTS_PAGE_URL, { waitUntil: 'networkidle2', timeout: 30_000 })
    }

    const failures = []
    for (const url of FEED_CANDIDATES) {
      const result = await page.evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: 'include' })
          if (!r.ok) return { error: `HTTP ${r.status}` }
          return { body: await r.text() }
        } catch (e) { return { error: String(e) } }
      }, url)
      if (result.body && result.body.includes('BEGIN:VCALENDAR')) return result.body
      failures.push(`${url} → ${result.error || 'non-iCalendar body'}`)
    }
    throw new Error(`Browser-context fetch failed for all candidates:\n  ${failures.join('\n  ')}`)
  })
}

async function getIcsText() {
  const failures = []
  for (const url of FEED_CANDIDATES) {
    try {
      const text = await fetchFeedCandidate(url)
      console.log(`  ✓ Direct feed fetch succeeded: ${url} (${text.length} bytes)`)
      return text
    } catch (err) {
      console.warn(`  ⚠ Direct feed candidate failed: ${url} → ${err.message}`)
      failures.push(`${url} → ${err.message}`)
    }
  }
  console.warn('  ↳ All direct fetches failed (sgcaptcha); falling back to Puppeteer…')
  const text = await fetchIcsViaBrowser()
  console.log(`  ✓ Puppeteer fetch succeeded (${text.length} bytes)`)
  return text
}

// ── Process ──────────────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId) {
  let inserted = 0, skipped = 0
  const venueCache = new Map()

  for (const ev of rawEvents) {
    try {
      const result = normalizeEvent(ev)
      if (!result || result.skip) { skipped++; continue }
      const { row, venue, geo } = result

      // Resolve the per-event venue (cached by its LOCATION string).
      let venueId = null
      if (venue?.name) {
        if (venueCache.has(venue.name)) {
          venueId = venueCache.get(venue.name)
        } else {
          venueId = await ensureVenue(venue.name, venue.details || { city: 'Akron', state: 'OH' })
          venueCache.set(venue.name, venueId)
        }
      }

      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
        continue
      }
      if (venueId)     await linkEventVenue(upserted.id, venueId)
      if (organizerId) await linkEventOrganization(upserted.id, organizerId)
      inserted++
      const flag = geo === 'in' ? '' : ` [${geo} → pending_review]`
      console.log(`  ✓ ${row.title} — ${row.start_at}${flag}`)
    } catch (err) {
      console.warn(`  ⚠ Error processing event "${ev.SUMMARY}":`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('⛵  Starting Akron Sail & Power Squadron ingestion…')
  const start = Date.now()
  try {
    const organizerId = await ensureOrganization(ORG_NAME, ORG_DETAILS)

    console.log('\n🔍  Fetching ICS feed…')
    const icsText = await getIcsText()
    const rawEvents = parseIcs(icsText)
    console.log(`  Parsed ${rawEvents.length} VEVENT blocks`)

    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skipped } = await processEvents(rawEvents, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
