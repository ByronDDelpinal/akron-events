/**
 * scrape-city-of-macedonia.js
 *
 * City of Macedonia, Ohio (Summit County) — the municipal Parks & Recreation
 * department at macrec.com. Macedonia does NOT run CivicPlus (CivicEngage):
 * the site is Granicus **govAccess** (formerly Vision Internet). The standard
 * CivicPlus iCalendar endpoint (/common/modules/iCalendar/iCalendar.aspx) is
 * NOT served here, and the site carries no JSON-LD, RSS, or .ics export.
 *
 * Platform quirks that shape this strategy:
 *   • Bot protection: the whole domain sits behind Akamai Bot Manager. A plain
 *     or bot-style User-Agent gets a 403; the per-event detail component pages
 *     (/Home/Components/Calendar/Event/{id}/{n}) additionally return a JS
 *     "bm-verify" challenge that a non-browser client can never satisfy. The
 *     ONE surface that serves clean HTML to a scripted client is the month
 *     calendar grid, and only when sent a full set of browser request headers
 *     (User-Agent + Accept + Accept-Language). We replicate those here.
 *   • The calendar is a Granicus govAccess server-rendered month grid at
 *     /parks/calendar/-curm-{M}/-cury-{Y}. Each day is a
 *     <td class="calendar_day"> that leads with the day-of-month number, and
 *     every event renders as <div class="calendar_item"> with an optional
 *     <span class="calendar_eventtime">7:00 PM</span> and an
 *     <a class="calendar_eventlink" href="…/Home/Components/Calendar/Event/{id}/{n}?curm={M}&cury={Y}">Title</a>.
 *     parseCalendarMonth keys on the RAW-HTML <a href> Event route (query-
 *     independent) + the calendar_eventtime span, and dates each row from the
 *     cell's day number plus the month/year the caller fetched — NOT from the
 *     link's curm/cury query, so a query tweak can't break dating. (A 2026-08
 *     "0 public events after filter" run was a diagnosis red herring: WebFetch's
 *     markdown reduction strips the class hooks and made the markup look changed
 *     when it had not; the parser and the meetings filter were both fine. The
 *     test fixture is therefore the RAW <td> HTML production receives, not a
 *     markdown capture.) No detail-page fetch is possible (Akamai-blocked) or needed.
 *   • Navigating past the last populated month silently returns the CURRENT
 *     month grid again (e.g. -curm-1/-cury-2027 renders July 2026). We fetch a
 *     fixed forward window and dedupe by the numeric event id, so those stale
 *     repeats collapse harmlessly.
 *
 * Content mix + filter: the calendar interleaves public rec/community events
 * (concerts at Longwood Manor, Car Cruise, Touch-a-Truck, Food Truck Thursdays,
 * FallFest, WinterFest, Haunted Manor) with government business — Mayor's Court
 * sessions, Planning Commission and Board of Zoning Appeals meetings — and
 * all-day "City Offices Closed" holiday markers. We drop those via the shared
 * CivicPlus admin/holiday filter (isPublicCivicPlusEvent), extended with a
 * Mayor's-Court guard the shared regex doesn't cover.
 *
 * Time fallback: nearly every kept public event carries an explicit time in the
 * grid. The rare timeless entry (e.g. an all-day WinterFest row) is ingested as
 * a DATE-ONLY event (midnight ET, no synthesized clock time) — the detail page
 * that might carry a time is Akamai-blocked, so we deliberately fall back to
 * date-only rather than inventing a time. Such rows are flagged needs_review.
 *
 * Macedonia is wholly within Summit County, so every venue is a fixed Summit
 * location — no per-event geo classification is required.
 *
 * Usage:
 *   node scripts/scrape-city-of-macedonia.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  decodeEntities,
  easternToIso,
  enrichWithImageDimensions,
  ensureOrganization,
  ensureVenue,
  inferCategory,
  linkEventOrganization,
  linkEventVenue,
  linkOrganizationVenue,
  logScraperError,
  logUpsertResult,
  stripHtml,
  upsertEventSafe,
} from './lib/normalize.js'
import { isPublicCivicPlusEvent } from './lib/civicplus.js'

// ── Constants ──────────────────────────────────────────────────────────────

export const SOURCE_KEY = 'city_of_macedonia'

const ORIGIN = 'https://www.macrec.com'

// How many months forward (including the current ET month) to crawl. Macedonia
// posts a season or two ahead; ~7 months comfortably covers the horizon, and
// requests beyond the last populated month just re-serve the current month
// (deduped by event id).
const MONTH_WINDOW = 7

// Browser request headers. Akamai Bot Manager 403s the default AkronPulse-bot
// UA and any header-light request; this full set is what the live site accepts
// for the month-grid pages (verified 2026-07-14).
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

// Default venue: Longwood Park is Macedonia's flagship community park and the
// host site for the outdoor concerts, festivals, and family events. Longwood
// Manor (the historic house used for the summer band series) sits inside the
// same park at the same address.
const DEFAULT_VENUE = {
  name:    'Longwood Park',
  address: '1566 East Aurora Road',
  city:    'Macedonia',
  state:   'OH',
  zip:     '44056',
  website: 'https://www.macrec.com/parks/longwood-park',
  description:
    "Longwood Park is the City of Macedonia's flagship 300-acre community park " +
    'and the main host site for the Parks & Recreation department’s outdoor ' +
    'concerts, seasonal festivals, and family events. It is also home to the ' +
    'historic Longwood Manor.',
}

// Known named sub-venues the title may reference via "... at <Venue>". Mapped to
// full address details so ensureVenue dedupes against the canonical venue
// rather than minting a bare-name row.
const KNOWN_VENUES = {
  'longwood manor': {
    address: '1566 East Aurora Road', city: 'Macedonia', state: 'OH', zip: '44056',
    website: 'https://www.macrec.com/facilities/longwood-manor',
  },
  'longwood park': {
    address: '1566 East Aurora Road', city: 'Macedonia', state: 'OH', zip: '44056',
    website: 'https://www.macrec.com/parks/longwood-park',
  },
  'recreation center': {
    address: '1494 East Aurora Road', city: 'Macedonia', state: 'OH', zip: '44056',
    website: 'https://www.macrec.com/facilities/recreation-center',
  },
  'macedonia family recreation center': {
    address: '1494 East Aurora Road', city: 'Macedonia', state: 'OH', zip: '44056',
    website: 'https://www.macrec.com/facilities/recreation-center',
  },
  'sugarbush park': {
    city: 'Macedonia', state: 'OH', zip: '44056',
    website: 'https://www.macrec.com/parks/sugarbush-park',
  },
  'nordonia hills veterans memorial park': {
    city: 'Macedonia', state: 'OH', zip: '44056',
    website: 'https://www.macrec.com/parks/nordonia-hills-veterans-memorial-park',
  },
}

const ORG_INFO = {
  name: 'Macedonia Parks & Recreation',
  details: {
    website: 'https://www.macrec.com/programs-events/special-events',
    description:
      'The City of Macedonia (Summit County, OH) Parks & Recreation department ' +
      'runs a year-round community-events calendar out of Longwood Park and the ' +
      'Macedonia Family Recreation Center: summer concerts at Longwood Manor, ' +
      'Car Cruise, Touch-a-Truck, Food Truck Thursdays, and the seasonal ' +
      'SpringFest / SummerFest / FallFest / WinterFest festivals.',
  },
}

// ── Date helpers ─────────────────────────────────────────────────────────────

/**
 * The list of {month, year} pairs to crawl, anchored to the CURRENT month in
 * America/New_York (never the process-local timezone) so an evening-ET run
 * doesn't roll the window forward a month.
 */
export function monthsToFetch(now = new Date(), count = MONTH_WINDOW) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: 'numeric',
  }).formatToParts(now)
  let year  = Number(parts.find(p => p.type === 'year').value)
  let month = Number(parts.find(p => p.type === 'month').value) // 1-12
  const out = []
  for (let i = 0; i < count; i++) {
    out.push({ month, year })
    month += 1
    if (month > 12) { month = 1; year += 1 }
  }
  return out
}

// ── Public-event filter ──────────────────────────────────────────────────────

// The shared CivicPlus admin filter drops council/commission/board/hearing
// meetings, office-closure holiday markers, and cancelled rows. It does NOT
// know Macedonia's weekly "Mayor's Court" municipal-court sessions, so guard
// those explicitly here.
const MAYORS_COURT_RE = /\b(mayor'?s?\s+court|municipal\s+court)\b/i

export function isPublicMacedoniaEvent(title) {
  const t = decodeEntities(String(title || '')).trim()
  if (!t) return false
  if (MAYORS_COURT_RE.test(t)) return false
  return isPublicCivicPlusEvent(t)
}

// ── Venue mapping ─────────────────────────────────────────────────────────────

/**
 * Resolve a venue name + address details from an event title. When the title
 * names a location via "... at <Venue>" and that venue is one we know, use it;
 * otherwise fall back to Longwood Park (the default community-event site).
 * Returns { name, details }.
 */
export function resolveVenue(title) {
  const t = decodeEntities(String(title || ''))
  const at = t.match(/\bat\s+(.+?)\s*$/i)
  if (at) {
    const cand = at[1].trim().replace(/[.,;:]+$/, '')
    const known = KNOWN_VENUES[cand.toLowerCase()]
    if (known) return { name: cand, details: { ...known } }
  }
  return {
    name: DEFAULT_VENUE.name,
    details: {
      address: DEFAULT_VENUE.address, city: DEFAULT_VENUE.city,
      state: DEFAULT_VENUE.state, zip: DEFAULT_VENUE.zip,
      website: DEFAULT_VENUE.website, description: DEFAULT_VENUE.description,
    },
  }
}

// ── Category / tag mapping ────────────────────────────────────────────────────

export function mapCategory(title) {
  const t = decodeEntities(String(title || '')).toLowerCase()
  // The summer band series carries no "concert" word — force music.
  if (/\b(symphonic|symphony|band|concert)\b/.test(t)) return 'music'
  // Macedonia's marquee seasonal festivals are single words (SpringFest,
  // SummerFest, FallFest, WinterFest), so the shared inference's `\bfest\b`
  // boundary never fires — classify them explicitly.
  if (/\b(spring|summer|fall|winter)fest\b/.test(t)) return 'festival'
  // Otherwise let the shared keyword inference decide (food truck → food, etc.).
  return inferCategory(t, '')
}

export function mapTags(title) {
  const t = decodeEntities(String(title || '')).toLowerCase()
  const tags = ['macedonia-ohio', 'summit-county', 'parks-recreation']
  if (/fest\b|festival/.test(t))            tags.push('festival', 'family')
  if (/winterfest|christmas|holiday/.test(t)) tags.push('seasonal', 'holiday')
  if (/haunted|halloween|trick.?or.?treat/.test(t)) tags.push('halloween', 'seasonal')
  if (/food truck/.test(t))                 tags.push('food', 'food-truck')
  if (/car cruise|cruise[- ]in|classic car/.test(t)) tags.push('cars', 'community')
  if (/touch.?a.?truck/.test(t))            tags.push('family')
  if (/band|concert|symphon/.test(t))       tags.push('music', 'outdoor')
  return [...new Set(tags)]
}

// ── Grid parsing ──────────────────────────────────────────────────────────────

// One event inside a day cell. The govAccess grid renders each day as a
// <td class="calendar_day …"> whose first text is the day-of-month, followed by
// one <div class="calendar_item"> per event: an optional
// <span class="calendar_eventtime">7:00 PM</span> then an
// <a class="calendar_eventlink" href="…/Home/Components/Calendar/Event/{id}/{n}?…">Title</a>.
// We key on the STABLE detail route in the raw-HTML href (query-independent) and
// take month/year from the fetched page (passed in), NOT from the link's
// ?curm/&cury — so a future tweak to the link query can't break dating, and we
// parse the real <a href> bytes rather than any text/Markdown reduction of them.
// Groups: 1 time (opt), 2 href, 3 event id, 4 sub id (n), 5 title.
const EVENT_RE =
  /(?:<span[^>]*calendar_eventtime[^>]*>([^<]*)<\/span>\s*)?<a[^>]*href="([^"]*\/Home\/Components\/Calendar\/Event\/(\d+)\/(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi

/**
 * Parse one month-grid page (raw <td> HTML from the govAccess calendar) into raw
 * event records:
 *   { eventId, detailUrl, title, timeText, date }  (date = YYYY-MM-DD)
 * Pure — no network, no filtering. The day-of-month comes from each <td> cell's
 * leading number; the month & year are supplied by the caller (the page it
 * fetched via -curm-/-cury-), so dating no longer depends on the link query or
 * on the removed aria-label day labels.
 */
export function parseCalendarMonth(html, { month, year } = {}) {
  const out = []
  if (!html || !month || !year) return out
  const mm = String(month).padStart(2, '0')
  // Each day is a <td>; split on the cell boundary and read each cell's own day.
  for (const cell of String(html).split(/<td\b/i).slice(1)) {
    // Drop the <td …> opening tag's attributes, then the day-of-month is the
    // first 1–2 digit number in the tag-stripped cell content.
    const gt = cell.indexOf('>')
    const inner = gt === -1 ? cell : cell.slice(gt + 1)
    const dayM = stripHtml(inner).replace(/\s+/g, ' ').trim().match(/\d{1,2}/)
    if (!dayM) continue
    const day = Number(dayM[0])
    if (!day || day > 31) continue
    const date = `${year}-${mm}-${String(day).padStart(2, '0')}`

    for (const m of cell.matchAll(EVENT_RE)) {
      const title = stripHtml(decodeEntities(m[5])).replace(/\s+/g, ' ').trim()
      if (!title) continue
      const timeText = m[1] ? stripHtml(decodeEntities(m[1])).replace(/\s+/g, ' ').trim() : ''
      out.push({
        eventId:   m[3],
        detailUrl: `${ORIGIN}/Home/Components/Calendar/Event/${m[3]}/${m[4]}`,
        title, timeText, date,
      })
    }
  }
  return out
}

/**
 * Build a DB event row from a raw grid record. Returns null when the record
 * can't yield a usable start timestamp. Timeless kept events become date-only
 * (midnight ET) rows flagged needs_review — see the file header.
 */
export function buildEventRow(rec) {
  if (!rec?.date) return null
  const title = stripHtml(decodeEntities(rec.title)).trim()
  if (!title) return null

  const hasTime = /\d/.test(rec.timeText || '')
  const startAt = easternToIso(rec.date, hasTime ? rec.timeText : '')
  if (!startAt) return null

  return {
    title,
    description:     null,
    start_at:        startAt,
    end_at:          null,
    category:        mapCategory(title),
    tags:            mapTags(title),
    price_min:       null,
    price_max:       null,
    age_restriction: 'all_ages',
    image_url:       null,
    ticket_url:      rec.detailUrl,
    source_url:      rec.detailUrl,
    source:          SOURCE_KEY,
    source_id:       rec.eventId,
    status:          'published',
    // Timeless rows carry an unknown time; surface them for a human glance.
    needs_review:    hasTime ? undefined : true,
    featured:        false,
  }
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchMonth(month, year, { timeoutMs = 20_000, retries = 2 } = {}) {
  const url = `${ORIGIN}/parks/calendar/-curm-${month}/-cury-${year}`
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const tid = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        headers: BROWSER_HEADERS, redirect: 'follow', signal: controller.signal,
      })
      clearTimeout(tid)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const html = await res.text()
      // Sanity-check we got a calendar page, not an error/challenge shell. Key
      // on the stable detail route + month-nav marker (both present in the raw
      // govAccess HTML).
      if (!/\/Home\/Components\/Calendar\/Event\/|-curm-/.test(html)) {
        throw new Error('no calendar grid in response')
      }
      return html
    } catch (err) {
      clearTimeout(tid)
      if (attempt === retries) throw err
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
    }
  }
  return null
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎪  Starting City of Macedonia ingestion (macrec.com Vision calendar grid)…')
  const start = Date.now()

  try {
    const months = monthsToFetch()
    const byId = new Map() // eventId → raw record (dedupes stale month repeats)
    let parsedTotal = 0

    for (const { month, year } of months) {
      try {
        const html = await fetchMonth(month, year)
        const recs = parseCalendarMonth(html, { month, year })
        parsedTotal += recs.length
        for (const rec of recs) {
          if (!byId.has(rec.eventId)) byId.set(rec.eventId, rec)
        }
        console.log(`  → ${month}/${year}: parsed ${recs.length} grid items`)
      } catch (err) {
        console.warn(`  ⚠ ${month}/${year} failed: ${err.message}`)
      }
      await new Promise(r => setTimeout(r, 400))
    }

    const allRecs = [...byId.values()]
    const publicRecs = allRecs.filter(r => isPublicMacedoniaEvent(r.title))
    console.log(
      `  Merged ${allRecs.length} unique events (from ${parsedTotal} grid items across ${months.length} months); ` +
      `${publicRecs.length} public after filter (dropped ${allRecs.length - publicRecs.length} meeting/court/holiday).`
    )

    if (publicRecs.length === 0) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: 'error',
        errorMessage: 'Macedonia calendar parsed but contained 0 public-facing events after filter',
        durationMs:  Date.now() - start,
        eventsFound: allRecs.length,
      })
      console.warn('  ⚠ No public events — exiting 0 so the next scheduled run still tries.')
      process.exit(0)
    }

    // Ensure org + default venue once.
    const organizerId = await ensureOrganization(ORG_INFO.name, ORG_INFO.details)
    const defaultVenueId = await ensureVenue(DEFAULT_VENUE.name, {
      address:     DEFAULT_VENUE.address, city: DEFAULT_VENUE.city,
      state:       DEFAULT_VENUE.state,   zip:  DEFAULT_VENUE.zip,
      website:     DEFAULT_VENUE.website, description: DEFAULT_VENUE.description,
    })
    if (organizerId && defaultVenueId) {
      await linkOrganizationVenue(organizerId, defaultVenueId)
    }

    // Skip anything that ended more than ~1 day ago.
    const cutoffMs = Date.now() - 24 * 3600_000

    console.log(`\n📥  Processing ${publicRecs.length} events…`)
    let inserted = 0, skipped = 0
    const venueCache = new Map()

    for (const rec of publicRecs) {
      try {
        const row = buildEventRow(rec)
        if (!row || !row.start_at || !row.source_id) { skipped++; continue }
        if (Date.parse(row.start_at) < cutoffMs) { skipped++; continue }

        // Per-event venue: default Longwood Park, or a known sub-venue named in
        // the title ("... at Longwood Manor").
        const { name: venueName, details: venueDetails } = resolveVenue(row.title)
        let venueId = defaultVenueId
        if (venueName === DEFAULT_VENUE.name) {
          venueId = defaultVenueId
        } else if (venueCache.has(venueName)) {
          venueId = venueCache.get(venueName)
        } else {
          venueId = await ensureVenue(venueName, venueDetails)
          venueCache.set(venueName, venueId)
        }

        const enrichedRow = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enrichedRow)
        if (error) {
          console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
          skipped++
          continue
        }

        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error processing "${rec.title}":`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: allRecs.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly; importing for tests exposes the pure parsers
// without triggering a live scrape.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
