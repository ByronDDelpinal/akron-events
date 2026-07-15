/**
 * scrape-village-of-northfield.js
 *
 * Village of Northfield, Ohio (Summit County) — Revize CMS. Despite the
 * calendar.php URL shape (which looks like it could be Revize, Drupal, or a
 * bespoke municipal CMS), the site is Revize: the page ships the FullCalendar-
 * based `revize_calendar` plugin, and — like Bath Township and the City of
 * Akron — it exposes the identical public JSON feed at
 * `calendar_data_handler.php`. We pull that feed rather than screen-scraping the
 * JS-rendered month grid: the JSON carries clean, timezone-consistent start/end
 * fields, per-item locations, and calendar metadata.
 *
 * Feed (verified 2026-07-14):
 *   https://www.northfieldvillage-oh.gov/_assets_/plugins/revizeCalendar/
 *     calendar_data_handler.php
 *       ?webspace=northfieldoh
 *       &relative_revize_url=//cms7.revize.com
 *       &protocol=https:
 *   (webspace + relative_revize_url are read from RZ.webspace /
 *    RZ.protocolRelativeRevizeBaseUrl in the page's inline config.)
 *
 * Wire format (mirrors the Akron Lock 3 / Bath Township feeds):
 *   Array of events; each has title, primary_calendar_name, calendar_displays[],
 *   start, end, url, location, image, rid, id, desc, color, allDay, [rrule].
 *   `start`/`end` are ISO-shaped LOCAL-EASTERN strings without a "Z" suffix
 *   (e.g. "2026-08-08T20:00:00"); we convert via easternToIso.
 *
 * This is a small VILLAGE GOVERNMENT calendar, so the feed is dominated by
 * administrative rows we drop:
 *   • Village Council / Caucus, Planning Commission, Board of Zoning Appeals and
 *     other board/commission meetings (MEETING_RE).
 *   • "Village Offices Closed…" holiday-closure markers (CLOSURE_RE).
 *   • Municipal service notices with no gathering — leaf pick-ups, senior trash
 *     & snowplow sign-up windows, daylight-saving reminders (SERVICE_RE).
 *   • Bare observance markers (Valentine's Day, St. Patrick's Day, …)
 *     (BARE_HOLIDAY_RE), and the leftover Revize demo "Testing Calendar" rows.
 * What survives is the handful of real public events: the summer "Movie at Smith
 * Park" outdoor-film nights, the Halloween Trick-or-Treat / Haunted House, and
 * the Village Tree Lighting Ceremony.
 *
 * Data-quality quirks handled here:
 *   • Times are duplicated into the title as terse tokens ("- 6p", "- 7:30P",
 *     "at Dark"). The `start` field is authoritative and carries the real time
 *     for every public event, so we trust it. As a safety net, when a row is
 *     flagged allDay (or `start` is exactly midnight) we mine the TITLE prose for
 *     a concrete time before falling back to an honest all-day midnight — we
 *     never silently synthesize a time. (No current public event needs the
 *     fallback; it exists for future data-entry drift.)
 *   • Titles carry a trailing redundant time annotation ("Village Tree Lighting
 *     Ceremony - 6p"); we strip only that trailing "- <time>" suffix for
 *     readability and leave compound titles ("Movie at Smith Park - at Dark;
 *     MATILDA") otherwise intact.
 *   • `location` is always a bare street address; the ensureVenue guard refuses
 *     to mint address-named venues, so we map the known village addresses to
 *     their real venue names (Smith Park, the other village parks, the Village
 *     Service Department) and fall back to a "Village of Northfield" municipal
 *     venue for anything unmapped.
 *   • Images are always the Revize placeholder → dropped (image_url null).
 *   • Rows carry no per-event detail URL, so source_url falls back to the public
 *     calendar page.
 *
 * Geography: the Village of Northfield lies entirely within Summit County, so
 * every venue is a fixed Summit location. We still route the resolved venue city
 * through classifySummitLocation so the strict Summit gate is honored uniformly.
 *
 * Usage:
 *   node scripts/scrape-village-of-northfield.js
 *   node scripts/scrape-village-of-northfield.js --dry-run   # fetch + parse only
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

// ── Constants ────────────────────────────────────────────────────────────────

export const SOURCE_KEY = 'village_of_northfield'
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'

const ORIGIN = 'https://www.northfieldvillage-oh.gov'
const FEED_URL =
  `${ORIGIN}/_assets_/plugins/revizeCalendar/calendar_data_handler.php` +
  '?webspace=northfieldoh&relative_revize_url=//cms7.revize.com&protocol=https:'

// Rows carry no per-event URL, so every event links back to the public calendar.
const LANDING_URL = `${ORIGIN}/calendar.php`

// 1 day of grace so same-day events stay visible until midnight ET.
const PAST_GRACE_MS = 86_400_000
// 180-day forward horizon — matches the project's other ingestion windows.
const HORIZON_DAYS = 180

// ── Non-event filters ────────────────────────────────────────────────────────

// Government meetings — council, caucus, boards, commissions, hearings, etc.
const MEETING_RE = new RegExp(
  [
    'city council', 'village council', '\\bcouncil\\b', '\\bcaucus\\b',
    'planning commission', 'zoning commission', 'zoning appeals?',
    'board of zoning', 'appearance review', 'civil service',
    '\\bcommission\\b', '\\bcommittee\\b', '\\btrustees?\\b', '\\bboard\\b',
    'work session', 'special meeting', 'regular meeting', 'executive session',
    'public hearing', 'budget hearing', '\\bhearing\\b', '\\bcourt\\b',
    'board meeting',
  ].join('|'),
  'i',
)

// Holiday / office-closure markers ("Village Offices Closed…").
const CLOSURE_RE = /offices?\s+closed/i

// Cancelled / postponed rows. Revize leaves a scratched calendar entry in place
// with a CANCELLED/POSTPONED marker rather than removing it, so a cancelled
// public event ("Movie at Smith Park - CANCELLED") is still in the feed and
// must be dropped. Matches both spellings (cancelled / canceled). Mirrors the
// shared CivicPlus filter (lib/civicplus.js isPublicCivicPlusEvent).
const CANCELLED_RE = /\bcancel?led\b|\bpostponed\b/i

// Municipal service notices with no public gathering: leaf/brush/trash pick-ups,
// snowplow & trash SIGN-UP windows, recycling, hydrant flushing, street
// sweeping, and daylight-saving "turn clocks" reminders.
const SERVICE_RE = new RegExp(
  [
    'leaf\\s*(?:pick|collection)', 'brush\\s*(?:pick|collection)',
    'bulk\\s*(?:pick|collection|item)', '\\btrash\\b', 'snow\\s*plow',
    'snowplow', 'sign[\\s-]?ups?', 'recycl(?:e|ing)', 'hydrant',
    'street\\s*sweep', 'daylight\\s*saving', 'turn\\s*clocks',
  ].join('|'),
  'i',
)

// Bare observance markers — the title is essentially just a holiday name with no
// event content. Matched against the whole cleaned title (anchored), so a real
// "St. Patrick's Day Parade" or "Valentine's Dance" still passes.
const BARE_HOLIDAY_RE = new RegExp(
  '^(?:' +
    "valentine'?s?\\s*day|st\\.?\\s*patrick'?s?\\s*day|" +
    "president'?s?\\s*day|columbus\\s*day|groundhog\\s*day|flag\\s*day|" +
    'daylight\\s*saving[^;]*' +
  ')$',
  'i',
)

/**
 * True when a feed title is a genuine public community event (not a meeting,
 * office closure, service notice, bare holiday, or Revize demo row).
 * Exported pure for tests.
 */
export function isPublicCommunityEvent(title) {
  const t = stripHtml(String(title || '')).replace(/\s+/g, ' ').trim().toLowerCase()
  if (!t) return false
  if (CANCELLED_RE.test(t)) return false
  if (CLOSURE_RE.test(t)) return false
  if (MEETING_RE.test(t)) return false
  if (SERVICE_RE.test(t)) return false
  if (BARE_HOLIDAY_RE.test(t)) return false
  return true
}

// ── Title cleanup ────────────────────────────────────────────────────────────

// A trailing "- <time>" annotation duplicated from the start field, e.g.
// "Village Tree Lighting Ceremony - 6p" or "… - 7:30P". Only stripped when the
// suffix is purely a clock time (never a date like "10/31/26").
const TRAILING_TIME_RE = /\s*[-–—]\s*(?:at\s+)?\d{1,2}(?::\d{2})?\s*[ap]\.?m?\.?\s*$/i

/** Decode entities, flatten &nbsp;, collapse whitespace, and drop a trailing
 *  redundant time annotation. Exported pure for tests. */
export function cleanTitle(rawTitle) {
  let t = stripHtml(String(rawTitle || '')).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
  t = t.replace(TRAILING_TIME_RE, '').trim()
  return t
}

// ── Time resolution ──────────────────────────────────────────────────────────

/**
 * Convert a Revize start/end value into a UTC ISO string.
 * Feed values look like "2026-08-08T20:00:00" — local Eastern, no zone.
 */
export function revizeIsoToUtc(raw) {
  if (!raw) return null
  const cleaned = String(raw).trim().replace(/Z$/, '').replace('T', ' ').slice(0, 19)
  return easternToIso(cleaned)
}

/** True when a Revize datetime string carries no time component (midnight). */
function isMidnight(raw) {
  return /T00:00:00/.test(String(raw || ''))
}

/**
 * Extract a concrete clock token from prose and normalize it to a form
 * easternToIso can parse. The village writes terse meridiems ("6p", "7:30P");
 * easternToIso needs a full "am"/"pm" (it reads a bare "p" as AM), so we expand
 * the single-letter meridiem here. Returns e.g. "6pm" / "7:30pm" / "8am", or
 * null when there is no numeric time (phrases like "at Dark"). Exported for
 * tests.
 */
export function extractTimeFromText(text) {
  const m = String(text || '').match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m?\.?/i)
  if (!m) return null
  const mins = m[2] ? `:${m[2]}` : ''
  const meridiem = m[3].toLowerCase() === 'p' ? 'pm' : 'am'
  return `${m[1]}${mins}${meridiem}`
}

/**
 * Resolve an event's start/end to UTC ISO. The `start` field is authoritative
 * and carries the real time for every public Northfield event. Only when a row
 * is flagged allDay (or start is exactly midnight) do we look to the TITLE prose
 * for a time before honestly falling back to an all-day midnight start — never a
 * silently synthesized time. Returns { start_at, end_at, allDay }.
 * Exported pure for tests.
 */
export function resolveTimes(ev, rawTitle) {
  const timeless = ev?.allDay === true || isMidnight(ev?.start)

  if (timeless) {
    const token = extractTimeFromText(rawTitle)
    if (token) {
      const datePart = String(ev.start).slice(0, 10)
      return { start_at: easternToIso(datePart, token), end_at: null, allDay: false }
    }
    // Honest all-day fallback: midnight ET start, no fabricated end.
    return { start_at: revizeIsoToUtc(ev.start), end_at: null, allDay: true }
  }

  const start_at = revizeIsoToUtc(ev.start)
  let end_at = revizeIsoToUtc(ev.end)
  // Drop a non-sensical end (missing, or not strictly after start).
  if (!end_at || (start_at && new Date(end_at) <= new Date(start_at))) end_at = null
  return { start_at, end_at, allDay: false }
}

// ── Category mapping ─────────────────────────────────────────────────────────

/**
 * Content categories for the recurring Northfield event types that text
 * inference alone under-classifies:
 *   • "Movie at Smith Park" outdoor-film nights → ['film','outdoors'] (inference
 *     lands only on 'outdoors' from the park cue and misses the film content).
 *   • Trick-or-Treat / Haunted House and the Tree Lighting Ceremony are seasonal
 *     community celebrations → ['festival'] (inference lands on 'other').
 * Everything else returns null and defers to inferCategory. Exported for tests.
 */
export function resolveCategories(title) {
  const t = String(title || '').toLowerCase()
  if (/\b(movie|film|screening)\b/.test(t)) {
    return /\b(park|outdoor|lawn|green)\b/.test(t) ? ['film', 'outdoors'] : ['film']
  }
  if (/\b(trick[\s-]?or[\s-]?treat|haunted|halloween|tree\s*lighting|tree-lighting|holiday\s*(?:parade|celebration)|santa|fireworks|festival|celebration)\b/.test(t)) {
    return ['festival']
  }
  return null
}

// ── Venue resolution ─────────────────────────────────────────────────────────

const DEFAULT_VENUE = {
  name: 'Village of Northfield',
  address: '10455 Northfield Rd',
  city: 'Northfield',
  state: 'OH',
  zip: '44067',
}

// Known village addresses → real venue names (the ensureVenue guard refuses to
// mint address-named venues). Parks sourced from the village Recreation page;
// 199 Ledge Rd is the Dept. of Public Service, which hosts the Halloween event.
const KNOWN_VENUES = {
  '169 houghton rd': {
    name: 'Smith Park', address: '169 Houghton Rd', city: 'Northfield', state: 'OH', zip: '44067',
  },
  '236 magnolia ave': {
    name: 'Huntington Park', address: '236 Magnolia Ave', city: 'Northfield', state: 'OH', zip: '44067',
  },
  '10414 electric blvd': {
    name: 'Pitluk Preserve', address: '10414 Electric Blvd', city: 'Northfield', state: 'OH', zip: '44067',
  },
  '199 ledge rd': {
    name: 'Northfield Village Service Department', address: '199 Ledge Rd', city: 'Northfield', state: 'OH', zip: '44067',
  },
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
 * Resolve a feed `location` string to a venue spec.
 * - empty / the municipal-building address → "Village of Northfield" default
 * - known village address → mapped real venue
 * - anything else → village default (a village-scoped municipal calendar; the
 *   handful of real locations are all mapped, so unmapped values are municipal)
 * Exported pure for tests.
 */
export function resolveVenueSpec(rawLocation) {
  const key = normalizeLocationKey(rawLocation)
  if (!key || key === '10455 northfield rd' || key === 'village of northfield') return DEFAULT_VENUE
  if (KNOWN_VENUES[key]) return KNOWN_VENUES[key]
  return DEFAULT_VENUE
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
 * Exported for tests.
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

/** True when the event's window overlaps [now - grace, now + horizon]. */
export function isWithinWindow(startUtc, endUtc, nowMs = Date.now()) {
  if (!startUtc) return false
  const startMs = new Date(startUtc).getTime()
  const endMs = endUtc ? new Date(endUtc).getTime() : startMs
  if (Number.isNaN(startMs)) return false
  if (endMs < nowMs - PAST_GRACE_MS) return false
  if (startMs > nowMs + HORIZON_DAYS * 86_400_000) return false
  return true
}

/**
 * Pure transform: feed row → { row, venueSpec, allDay } (no DB access).
 * Returns null for non-events / unparseable rows. Exported for tests.
 */
export function buildRow(ev) {
  if (!ev || !ev.title || !ev.start) return null
  // Drop the leftover Revize demo calendar rows.
  if (ev.primary_calendar_name === 'Testing Calendar') return null

  const rawTitle = stripHtml(ev.title).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
  const title = cleanTitle(ev.title)
  if (!isPublicCommunityEvent(title)) return null

  const { start_at, end_at, allDay } = resolveTimes(ev, rawTitle)
  if (!start_at) return null

  const description = decodeDescription(ev.desc)
  const categories = resolveCategories(title)
  const venueSpec = resolveVenueSpec(ev.location)

  // Stable id. Append the occurrence date for recurring rows so a future series
  // instance never collides.
  const baseId = `revize_${ev.rid || ev.id}`
  const source_id = ev.rrule ? `${baseId}-${String(start_at).slice(0, 10)}` : baseId

  const row = {
    title,
    description,
    start_at,
    end_at,
    tags: ['village-of-northfield', 'northfield-ohio', 'summit-county'],
    price_min: null,
    price_max: null,
    age_restriction: 'all_ages',
    image_url: extractImageUrl(ev.image),
    ticket_url: null,
    source_url: LANDING_URL,
    source: SOURCE_KEY,
    source_id,
    status: 'published',
    featured: false,
  }
  // Explicit categories when we have a confident mapping; otherwise inference.
  if (categories) row.categories = categories
  else row.category = inferCategory(title, description || '')

  return { venueSpec, allDay, row }
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

async function ensureNorthfieldVenue(venueSpec, organizerId) {
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

async function ensureVillageOrg() {
  return ensureOrganization('Village of Northfield', {
    website: ORIGIN,
    description:
      'Village of Northfield, Ohio (Summit County). Hosts community events ' +
      'including the summer Movie at Smith Park outdoor-film nights, the ' +
      'Halloween Trick-or-Treat and Haunted House, and the Village Tree ' +
      'Lighting Ceremony.',
  })
}

// ── Upsert pipeline ──────────────────────────────────────────────────────────

async function processEvents(prepared, organizerId) {
  let inserted = 0
  let skipped = 0

  for (const { row, venueSpec } of prepared) {
    try {
      // Strict Summit gate, applied on the resolved venue's city. Every
      // Northfield event is in Summit County, but we route defensively.
      const geo = classifySummitLocation({ city: venueSpec.city })
      if (geo === 'out') {
        skipped++
        continue
      }
      if (geo === 'unknown') {
        row.status = 'pending_review'
        row.needs_review = true
      }

      const venueId = await ensureNorthfieldVenue(venueSpec, organizerId)
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
  console.log('🚀  Starting Village of Northfield ingestion…')
  if (DRY_RUN) console.log('   [dry-run mode — fetch + parse only, no DB writes]')
  const start = Date.now()

  try {
    const organizerId = DRY_RUN ? null : await ensureVillageOrg()

    console.log('\n🔍  Fetching Village of Northfield Revize feed…')
    const all = await fetchFeed()
    console.log(`  Feed returned ${all.length} total calendar row(s).`)

    const now = Date.now()
    const built = all.map(buildRow).filter(Boolean)
    console.log(`  ${built.length} public community event(s) after dropping meetings/closures/notices.`)

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
      for (const { row, venueSpec, allDay } of unique) {
        console.log(`     • ${row.title}  [${row.start_at}${allDay ? ' all-day' : ''}]  @ ${venueSpec.name}`)
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
