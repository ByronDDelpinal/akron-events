/**
 * scrape-richfield-township.js
 *
 * Richfield Township, Ohio (Summit County) — Revize CMS.
 *
 * IMPORTANT: despite the calendar.php URL shape, richfield-twp.org is NOT a
 * CivicPlus site (the CivicPlus /common/modules/iCalendar/iCalendar.aspx feed
 * returns empty). The page is "Powered by revize." and — exactly like Bath
 * Township, the Village of Northfield, and the City of Akron — it exposes the
 * public Revize Calendar JSON feed at calendar_data_handler.php. We pull that
 * feed rather than screen-scraping the JS-rendered month grid: the JSON carries
 * clean, timezone-consistent start/end fields, per-item locations, and calendar
 * metadata.
 *
 * Feed (verified 2026-08-05):
 *   https://richfield-twp.org/_assets_/plugins/revizeCalendar/
 *     calendar_data_handler.php
 *       ?webspace=richfieldtwpoh
 *       &relative_revize_url=//webgen1.revize.com
 *       &protocol=https:
 *   (webspace + relative_revize_url mirror the page's inline Revize config;
 *    webgen1.revize.com is Richfield's builder host, taken from the site's
 *    login/asset URLs.)
 *
 * Wire format (mirrors the Akron Lock 3 / Bath Township / Northfield feeds):
 *   Array of events; each has title, primary_calendar_name, calendar_displays[],
 *   start, end, url, location, image, rid, id, desc, color, allDay, [rrule].
 *   `start`/`end` are ISO-shaped LOCAL-EASTERN strings without a "Z" suffix
 *   (e.g. "2026-07-14T19:00:00"); we convert via easternToIso.
 *   `desc`/`image` are URL-encoded HTML fragments — decode + sanitise.
 *
 * This is a TOWNSHIP GOVERNMENT calendar, so the feed is dominated by
 * administrative rows we drop:
 *   • Board of Trustees, Zoning Commission, Board of Zoning Appeals, the Joint
 *     Economic Development District, and generic "… Meeting" rows (MEETING_RE).
 *   • Cancelled/postponed entries left in place with a marker (CANCELLED_RE).
 *   • Municipal service notices with no public gathering — brush chipping,
 *     humus/wood-chip giveaways, elections/voting, leaf & trash pick-ups
 *     (SERVICE_RE).
 *   • Comprehensive Land Use Plan public-input workshops/open houses and
 *     property-valuation road-show sessions (governance; MEETING_RE), plus the
 *     internal Revize "Content Editing Training" rows.
 * What survives is the handful of genuine public events: Richfield Community
 * Day, the Kiwanis Community Day, the Snowbird Festival at Richfield Heritage
 * Preserve, the Akron Symphonic Winds America-250 concert, and the Furnace Run
 * watershed workshops/tours/presentations.
 *
 * Geography: Richfield Township lies inside Summit County, but the township's
 * administration office carries a Brecksville (Cuyahoga County) mailing city —
 * "3038 Boston Mills Road, Brecksville, OH 44141" — which classifySummitLocation
 * would (correctly, by postal city) call 'out'. Every event on this calendar is
 * a Richfield Township event, so we pin every resolved venue's city to
 * 'Richfield' (a Summit locality) and still route it through the strict Summit
 * gate defensively — mirroring how Bath Township / Northfield hardcode their own
 * Summit city. We never trust the feed's mailing city to gate an event out.
 *
 * Venues: `location` is a mix of "Venue Name, Street, City, ST ZIP" and bare
 * "Street, City, ST ZIP" strings. Name-first locations use the name; bare
 * address-first locations (the ensureVenue guard refuses to mint address-named
 * venues) fall back to the township-wide "Richfield Township" venue. Images are
 * always the Revize placeholder → dropped. Rows rarely carry a per-event URL, so
 * source_url falls back to the public calendar page.
 *
 * Usage:
 *   node scripts/scrape-richfield-township.js
 *   node scripts/scrape-richfield-township.js --dry-run   # fetch + parse only
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY  — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  stripHtml,
  htmlToText,
  inferCategory,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'
import { classifySummitLocation } from './lib/summit-county.js'
import { makeWindowFilter } from './lib/event-window.js'

// ── Constants ────────────────────────────────────────────────────────────────

export const SOURCE_KEY = 'richfield_township'
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'

const ORIGIN = 'https://richfield-twp.org'
const FEED_URL =
  `${ORIGIN}/_assets_/plugins/revizeCalendar/calendar_data_handler.php` +
  '?webspace=richfieldtwpoh&relative_revize_url=//webgen1.revize.com&protocol=https:'

// Rows rarely carry a per-event URL, so events link back to the public calendar.
const LANDING_URL = `${ORIGIN}/calendar.php`

// 1 day of grace so same-day events stay visible until midnight ET.
const PAST_GRACE_MS = 86_400_000
// 180-day forward horizon — matches the project's other ingestion windows.
const HORIZON_DAYS = 180

// ── Non-event filters ────────────────────────────────────────────────────────
//
// A township government calendar: the overwhelming majority of rows are board /
// commission meetings and governance sessions. We gate on the title the same way
// the Bath Township and Village of Northfield Revize scrapers do. A bare
// "\bmeeting\b" is safe here — no genuine public event on this calendar carries
// the word "meeting" in its title, while it cleanly catches the "Logo Design
// Meeting", "Property Valuation Meeting", and JEDD/board rows that don't match a
// more specific token.
const MEETING_RE = new RegExp(
  [
    'board of trustees', '\\btrustees?\\b', 'board of zoning',
    'zoning commission', 'zoning appeals?', 'appearance review',
    'joint economic development', '\\bjedd\\b', 'land use plan',
    'property valuation', 'content editing training',
    '\\bcommission\\b', '\\bcommittee\\b', 'city council', 'village council',
    '\\bcouncil\\b', 'work session', 'public hearing', 'executive session',
    '\\bcaucus\\b', '\\bboard\\b', '\\bmeeting\\b',
  ].join('|'),
  'i',
)

// Holiday / office-closure markers ("Township Offices Closed…"). None present in
// the feed today; kept for parity with the sibling township scrapers.
const CLOSURE_RE = /offices?\s+closed/i

// Cancelled / postponed rows. Revize leaves a scratched entry in place with a
// CANCELLED/POSTPONED marker rather than removing it. Matches both spellings.
// Mirrors the shared CivicPlus filter (lib/civicplus.js isPublicCivicPlusEvent).
const CANCELLED_RE = /\bcancel?led\b|\bpostponed\b/i

// Municipal service notices with no public gathering: brush chipping, humus /
// wood-chip giveaways, elections/voting, leaf/brush/bulk/trash pick-ups,
// recycling, hydrant flushing, street sweeping, snowplow & sign-up windows,
// daylight-saving reminders.
const SERVICE_RE = new RegExp(
  [
    '\\bchipping\\b', 'wood\\s*chip', '\\bgiveaway\\b',
    '\\bvoting\\b', '\\belection\\b',
    'leaf\\s*(?:pick|collection)', 'brush\\s*(?:pick|collection)',
    'bulk\\s*(?:pick|collection|item)', '\\btrash\\b', 'recycl(?:e|ing)',
    'hydrant', 'street\\s*sweep', 'snow\\s*plow', 'snowplow',
    'sign[\\s-]?ups?', 'daylight\\s*saving',
  ].join('|'),
  'i',
)

/**
 * True when a feed title is a genuine public community event (not a meeting,
 * office closure, cancellation, or municipal service notice). Exported for tests.
 */
export function isPublicCommunityEvent(title) {
  const t = stripHtml(String(title || '')).replace(/\s+/g, ' ').trim().toLowerCase()
  if (!t) return false
  if (CANCELLED_RE.test(t)) return false
  if (CLOSURE_RE.test(t)) return false
  if (MEETING_RE.test(t)) return false
  if (SERVICE_RE.test(t)) return false
  return true
}

// ── Time resolution ──────────────────────────────────────────────────────────

/**
 * Convert a Revize start/end value into a UTC ISO string.
 * Feed values look like "2026-07-14T19:00:00" — local Eastern, no zone.
 * Exported for tests.
 */
export function revizeIsoToUtc(raw) {
  if (!raw) return null
  const cleaned = String(raw).trim().replace(/Z$/, '').replace('T', ' ').slice(0, 19)
  return easternToIso(cleaned)
}

// ── Venue resolution ─────────────────────────────────────────────────────────
//
// Every venue city is pinned to a Summit locality ('Richfield') so the strict
// Summit gate never drops a real township event on a Brecksville mailing city
// (see the geography note in the file header). Bath Township / Northfield do the
// same with 'Akron' / 'Northfield'.
const VENUE_CITY = 'Richfield'
const VENUE_STATE = 'OH'
const VENUE_ZIP = '44286'

const DEFAULT_VENUE = {
  name: 'Richfield Township',
  address: null,
  city: VENUE_CITY,
  state: VENUE_STATE,
  zip: VENUE_ZIP,
}

function normalizeLocationKey(raw) {
  return stripHtml(String(raw || ''))
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '')
    .toLowerCase()
}

/**
 * Split a Revize `location` string into { name, address }.
 *   "Revere High School, 3420 Everett Road, Richfield, OH 44286"
 *     → { name: 'Revere High School', address: '3420 Everett Road' }
 *   "Brushwood Lodge, Furnace Run Metro Park"
 *     → { name: 'Brushwood Lodge', address: null }
 *   "3038 Boston Mills Road, Brecksville, OH 44141"  (address-first)
 *     → { name: null, address: '3038 Boston Mills Road' }
 * Returns null for an empty string. Exported for tests.
 */
export function parseLocation(rawLocation) {
  const cleaned = stripHtml(String(rawLocation || ''))
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '')
  if (!cleaned) return null

  const segments = cleaned.split(',').map(s => s.trim()).filter(Boolean)
  const first = segments[0]
  // Address-first: the leading segment is a street number, so there is no venue
  // name — only a bare postal address (which ensureVenue's guard won't mint).
  if (/^\d/.test(first)) return { name: null, address: first }

  // Name-first: the leading segment is the venue name; the first following
  // segment that starts with a street number is the street address.
  const street = segments.slice(1).find(s => /^\d/.test(s)) || null
  return { name: first, address: street }
}

/**
 * Resolve a feed `location` string to a venue spec, city pinned to Summit.
 *   • empty / "Richfield Township"      → township-wide default venue
 *   • name-first location               → the named venue (+ street address)
 *   • bare address-first location       → township-wide default venue
 * Exported for tests.
 */
export function resolveVenueSpec(rawLocation) {
  const key = normalizeLocationKey(rawLocation)
  if (!key || key === 'richfield township') return DEFAULT_VENUE

  const parsed = parseLocation(rawLocation)
  if (!parsed || !parsed.name) return DEFAULT_VENUE

  return {
    name: parsed.name,
    address: parsed.address || null,
    city: VENUE_CITY,
    state: VENUE_STATE,
    zip: VENUE_ZIP,
  }
}

// ── Field helpers ────────────────────────────────────────────────────────────

/** Decode the URL-encoded `desc` HTML fragment to readable plain text. */
export function decodeDescription(rawDesc) {
  if (!rawDesc || typeof rawDesc !== 'string') return null
  let html
  try {
    html = decodeURIComponent(rawDesc)
  } catch {
    html = rawDesc
  }
  const text = htmlToText(html).trim()
  return text.length ? text : null
}

/**
 * Extract a usable image URL from the feed's `image` markup, dropping Revize
 * placeholder assets and resolving relative paths against the origin.
 * Exported for tests. (The live feed only ever ships placeholders today, so this
 * returns null in practice; kept so a future real image flows through.)
 */
export function extractImageUrl(rawImage) {
  if (!rawImage || typeof rawImage !== 'string') return null
  let html
  try {
    html = decodeURIComponent(rawImage)
  } catch {
    html = rawImage
  }
  const m = html.match(/<img[^>]*src="([^"]+)"/i)
  if (!m) return null
  let src = m[1].trim()
  if (/placeholder\.(?:png|gif)|noimage\.(?:gif|png)/i.test(src)) return null
  if (/^https?:/i.test(src)) return src
  if (/^\/\//.test(src)) return `https:${src}`
  src = src.replace(/^\.?\//, '')
  return encodeURI(`${ORIGIN}/${src}`)
}

/**
 * Normalise a feed URL: rewrite the internal Revize builder host to the public
 * richfield-twp.org origin; reject relative / non-http values. Exported for tests.
 */
export function normalizeSourceUrl(raw) {
  if (!raw || typeof raw !== 'string') return null
  const u = raw.trim()
  if (!/^https?:/i.test(u)) return null
  return u.replace(
    /^https?:\/\/webgen1\.revize\.com\/revize\/richfieldtwpoh\//i,
    `${ORIGIN}/`,
  )
}

/**
 * True when the event's window overlaps [now - grace, now + horizon].
 * Single implementation lives in scripts/lib/event-window.js; the horizon
 * stays per-scraper because these calendars publish different distances out.
 */
export const isWithinWindow = makeWindowFilter({
  horizonDays: HORIZON_DAYS,
  pastGraceMs: PAST_GRACE_MS,
})

/**
 * Pure transform: feed row → { row, venueSpec } (no DB access).
 * Returns null for non-events / unparseable rows. Exported for tests.
 */
export function buildRow(ev) {
  if (!ev || !ev.title || !ev.start) return null
  const title = stripHtml(ev.title).replace(/\s+/g, ' ').trim()
  if (!isPublicCommunityEvent(title)) return null

  const start_at = revizeIsoToUtc(ev.start)
  if (!start_at) return null

  let end_at = revizeIsoToUtc(ev.end)
  // Drop a non-sensical end (missing, or not strictly after start).
  if (!end_at || new Date(end_at) <= new Date(start_at)) end_at = null

  const description = decodeDescription(ev.desc)
  const category = inferCategory(title, description || '')
  const evUrl = normalizeSourceUrl(ev.url)
  const venueSpec = resolveVenueSpec(ev.location)

  // Stable id. Append the occurrence date for recurring rows so a future series
  // instance never collides with another.
  const baseId = `revize_${ev.rid || ev.id}`
  const source_id = ev.rrule ? `${baseId}-${String(start_at).slice(0, 10)}` : baseId

  return {
    venueSpec,
    row: {
      title,
      description,
      start_at,
      end_at,
      category,
      tags: ['richfield-township', 'summit-county'],
      price_min: null,
      price_max: null,
      age_restriction: 'all_ages',
      image_url: extractImageUrl(ev.image),
      ticket_url: evUrl,
      source_url: evUrl ?? LANDING_URL,
      source: SOURCE_KEY,
      source_id,
      status: 'published',
      featured: false,
    },
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchFeed() {
  const res = await fetch(FEED_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronEventsBot/1.0)',
      Accept: 'application/json',
    },
  })
  if (!res.ok) throw new Error(`Revize feed HTTP ${res.status}`)
  const json = await res.json()
  if (Array.isArray(json)) return json
  if (Array.isArray(json?.events)) return json.events
  throw new Error(`Unexpected feed shape: top-level=${typeof json}`)
}

// ── Venue / organizer ────────────────────────────────────────────────────────

const venueCache = new Map()

async function ensureRichfieldVenue(venueSpec, organizerId) {
  const key = venueSpec.name
  if (venueCache.has(key)) return venueCache.get(key)

  const venueId = await ensureVenue(venueSpec.name, {
    address: venueSpec.address || undefined,
    city: venueSpec.city,
    state: venueSpec.state,
    zip: venueSpec.zip,
    website: ORIGIN,
  })

  if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)
  venueCache.set(key, venueId)
  return venueId
}

async function ensureTownshipOrg() {
  return ensureOrganization('Richfield Township', {
    website: ORIGIN,
    description:
      'Richfield Township, Ohio (Summit County). Hosts community events ' +
      'including Richfield Community Day, the Snowbird Festival at Richfield ' +
      'Heritage Preserve, and Furnace Run watershed workshops and tours.',
  })
}

// ── Upsert pipeline ──────────────────────────────────────────────────────────

async function processEvents(prepared, organizerId) {
  let inserted = 0
  let skipped = 0

  for (const { row, venueSpec } of prepared) {
    try {
      // Strict Summit gate, applied on the resolved venue's city. Every Richfield
      // Township event is in Summit County (city pinned to 'Richfield'), but we
      // route defensively.
      const geo = classifySummitLocation({ city: venueSpec.city })
      if (geo === 'out') {
        skipped++
        continue
      }
      if (geo === 'unknown') {
        row.status = 'pending_review'
        row.needs_review = true
      }

      const venueId = await ensureRichfieldVenue(venueSpec, organizerId)
      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        if (venueId) await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${row.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Richfield Township ingestion…')
  if (DRY_RUN) console.log('   [dry-run mode — fetch + parse only, no DB writes]')
  const start = Date.now()

  try {
    const organizerId = DRY_RUN ? null : await ensureTownshipOrg()

    console.log('\n🔍  Fetching Richfield Township Revize feed…')
    const all = await fetchFeed()
    console.log(`  Feed returned ${all.length} total calendar row(s).`)

    const now = Date.now()
    const built = all.map(buildRow).filter(Boolean)
    console.log(`  ${built.length} public community event(s) after dropping meetings/notices.`)

    const prepared = built.filter(b => isWithinWindow(b.row.start_at, b.row.end_at, now))
    console.log(`  ${prepared.length} within the ${HORIZON_DAYS}-day window.`)

    // Defensive within-run dedup on source_id.
    const seen = new Set()
    const unique = prepared.filter(b => {
      if (seen.has(b.row.source_id)) return false
      seen.add(b.row.source_id)
      return true
    })

    if (DRY_RUN) {
      console.log(`\n🧪  Dry-run: ${unique.length} event(s) prepared — nothing written.`)
      for (const { row, venueSpec } of unique) {
        console.log(`     • ${row.title}  [${row.start_at}]  cat=${row.category}  @ ${venueSpec.name}`)
      }
      console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s [dry-run]`)
      return
    }

    console.log(`\n📥  Processing ${unique.length} event(s)…`)
    const { inserted, skipped } = await processEvents(unique, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: unique.length,
      durationMs: Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — inserted ${inserted}, skipped ${skipped}`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly; importing for tests exposes the pure parsers
// without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
