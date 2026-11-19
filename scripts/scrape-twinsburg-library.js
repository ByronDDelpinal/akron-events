/**
 * scrape-twinsburg-library.js
 *
 * Twinsburg Public Library — an independent library district (not a branch of
 * Akron-Summit County Public Library, which scrape-akron-library.js covers).
 * Its calendar runs to ~240 listed programs: story times, teen gaming, book
 * groups, job-seeker workshops, local-history talks in the Bissell Room, and
 * bookmobile stops around Twinsburg and Reminderville.
 *
 * Platform: Springshare LibCal. The public calendar is rendered from an
 * unauthenticated JSON list endpoint, the same one the Barberton scraper
 * reads, so fetching and the shape helpers come from lib/libcal.js:
 *   https://twinsburglibrary.libcal.com/ajax/calendar/list?c=-1&…
 * `c=-1` is "every calendar". The embed's `iid=4446` is the institution id,
 * not a calendar id: `c=4446` answers 200 with zero rows.
 *
 * Feed facts (verified against the live feed 2026-11-18, 242 rows):
 *   • One id per occurrence. A weekly program gets a new id each week, so
 *     source_id is `tpl_<id>` with no date suffix.
 *   • `location` is one of three things:
 *       a room or rooms      "Story Time Room A, Story Time Room B",
 *                            "Meeting Rooms 1, 2, and 3", "Children's Place"
 *       an off-site address  "Pinewood Gardens, 8788 Ray Ct., Twinsburg, OH"
 *                            (bookmobile stops)
 *       blank                the building, room not booked
 *     Rooms and blanks resolve to the library. An address resolves to its own
 *     venue and is gated on Summit County by city. Anything else names a place
 *     we cannot put on a map: the row is published without a venue and flagged
 *     for review. It is never pinned to the library, which would send someone
 *     to the wrong building.
 *   • `online_event: true` rows have no venue.
 *   • `all_day: true` rows carry no clock time; libCalTimes() applies the
 *     sanctioned noon default and the row is marked `time_inferred`.
 *   • `registration_cost` is blank on every row: library programs are free.
 *   • Board of Trustees meetings are governance, not events, and are skipped
 *     (the same rule the municipal scrapers apply). "Teen Advisory Board
 *     Meeting" is a teen program and stays.
 *   • A canceled program keeps its row with a "CANCELED-" style title. Those
 *     are upserted with status 'cancelled', so a program we already published
 *     comes down on the next run instead of lingering.
 *
 * Usage:   node scripts/scrape-twinsburg-library.js [--dry-run]
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (not needed for --dry-run)
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { htmlToText } from './lib/normalize.js'
import {
  fetchLibCalEvents, libCalNames, isLibCalCanceledTitle, libCalTimes,
  parseLibCalPrice, libCalImageUrl, libCalDescription,
} from './lib/libcal.js'
import { classifySummitLocation } from './lib/summit-county.js'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'

export const SOURCE_KEY = 'twinsburg_library'
const ORIGIN = 'https://twinsburglibrary.libcal.com'
const CALENDAR_ID = -1
const HORIZON_DAYS = 180
const DAY_MS = 86_400_000

const ORG = {
  name: 'Twinsburg Public Library',
  details: {
    website: 'https://www.twinsburglibrary.org',
    description: 'The Twinsburg Public Library serves Twinsburg, Twinsburg Township and Reminderville with programs, story times, classes and events for all ages.',
  },
}

export const MAIN_VENUE = {
  name: 'Twinsburg Public Library',
  details: {
    address: '10050 Ravenna Rd',
    city: 'Twinsburg', state: 'OH', zip: '44087',
    website: 'https://www.twinsburglibrary.org',
    parking_type: 'lot',
  },
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

const lower = (names) => new Set(names.map((n) => n.toLowerCase()))

/**
 * Why a row is not an event, or null. `canceled` is not a skip: see buildRow.
 */
export function skipReason(categoryNames = [], title = '') {
  if (lower(categoryNames).has('board of trustees meeting')) return 'governance'
  if (/^\s*(?:library\s+)?closed\b|\blibrary\s+(?:is\s+)?closed\b/i.test(title)) return 'closure'
  return null
}

// The library's own category names → our content categories. Only the names
// that say what a program IS are mapped. "Children Events", "Teen Events",
// "Adult Events", "All Patrons" and "Bookmobile" say who it is for or where,
// so rows carrying only those fall through to text inference and the
// manifest's defaultCategory.
const CATEGORY_TABLE = [
  ['story times', 'learning'],
  ['book groups', 'learning'],
  ['job seeker workshop', 'learning'],
  ['continuing education', 'learning'],
  ['teen afterschool gaming', 'games'],
]

export function mapCategories(categoryNames = []) {
  const cats = lower(categoryNames)
  const slugs = []
  for (const [name, slug] of CATEGORY_TABLE) {
    if (cats.has(name) && !slugs.includes(slug)) slugs.push(slug)
  }
  return slugs.slice(0, 2)
}

const KID_AUDIENCES = ['babies', 'toddlers', 'preschool', 'school aged children', 'tweens']

/** True for a program aimed at children, teens or families; else undefined. */
export function parseIsFamily(audienceNames = []) {
  const a = lower(audienceNames)
  return [...KID_AUDIENCES, 'teens', 'family'].some((n) => a.has(n)) ? true : undefined
}

export function parseTags(audienceNames = [], priceMin = null, online = false) {
  const a = lower(audienceNames)
  const tags = ['library', 'twinsburg']
  if (priceMin === 0) tags.push('free')
  if (KID_AUDIENCES.some((n) => a.has(n))) tags.push('kids')
  if (a.has('teens')) tags.push('teens')
  if (a.has('adults')) tags.push('adults')
  if (a.has('seniors')) tags.push('seniors')
  if (online === true) tags.push('online')
  return tags
}

// "Pinewood Gardens, 8788 Ray Ct., Twinsburg, OH": a name, a house number and
// street, a city, the state.
const ADDRESS_RE = /^(.+?),\s*(\d{1,6}\s+[^,]+?)\.?,\s*([A-Za-z][A-Za-z .'-]+?),\s*(?:OH|Ohio)\b/
// A booked space inside the building, in whatever form staff type it.
const ROOM_RE = /\b(?:rooms?|place|desk|lobby|floor|area|library|lab)\b/i

/**
 * Resolve the feed's `location` to a venue.
 * @returns {{venue: object|null, needsReview?: boolean, drop?: boolean}}
 *   `drop` is true for an off-site address in a city known to be outside
 *   Summit County.
 */
export function resolveVenue(location = '', online = false) {
  if (online === true) return { venue: null }
  const loc = String(location ?? '').replace(/\s+/g, ' ').trim()
  if (!loc) return { venue: MAIN_VENUE }

  const m = loc.match(ADDRESS_RE)
  if (m) {
    const [, name, address, city] = m
    const where = classifySummitLocation({ city })
    if (where === 'out') return { venue: null, drop: true }
    return {
      venue: { name: name.trim(), details: { address: address.trim(), city: city.trim(), state: 'OH' } },
      needsReview: where === 'unknown' ? true : undefined,
    }
  }
  if (ROOM_RE.test(loc)) return { venue: MAIN_VENUE }
  return { venue: null, needsReview: true }
}

/**
 * One feed object → { row, venue } or { skip: <reason> }.
 */
export function buildRow(e = {}) {
  const title = htmlToText(String(e?.title || '')).trim()
  if (e?.id == null || e.id === '' || !title) return { skip: 'invalid' }

  const categoryNames = libCalNames(e.categories_arr)
  const audienceNames = libCalNames(e.audiences)
  const reason = skipReason(categoryNames, title)
  if (reason) return { skip: reason }

  const times = libCalTimes(e)
  if (!times) return { skip: 'invalid' }

  const online = e.online_event === true
  const { venue, needsReview, drop } = resolveVenue(e.location, online)
  if (drop) return { skip: 'out_of_county' }

  const canceled = isLibCalCanceledTitle(title)
  const { price_min, price_max } = parseLibCalPrice(e.registration_cost)
  const categories = mapCategories(categoryNames)

  return {
    row: {
      title,
      description: libCalDescription(e),
      start_at: times.startAt,
      end_at: times.endAt,
      // Sent only when the library's vocabulary maps: `categories` is
      // authoritative in upsertEventSafe, so an empty array must not be.
      ...(categories.length ? { categories } : {}),
      is_family: parseIsFamily(audienceNames),
      tags: parseTags(audienceNames, price_min, online),
      price_min,
      price_max,
      age_restriction: 'not_specified',
      image_url: libCalImageUrl(e),
      ticket_url: e.url || `${ORIGIN}/event/${e.id}`,
      source: SOURCE_KEY,
      source_id: `tpl_${e.id}`,
      status: canceled ? 'cancelled' : 'published',
      // Noon on an all-day row is a default, not a confirmed time.
      // upsertEventSafe turns this into the placeholder-time note and
      // needs_review (scripts/lib/inferred-time.js); it never reaches Postgres.
      time_inferred: times.isAllDay ? true : undefined,
      // undefined, never false, so upsertEventSafe's own default still runs.
      needs_review: needsReview ? true : undefined,
      featured: false,
    },
    venue,
  }
}

/** Feed objects → the run's work list. Pure: no clock of its own, no I/O. */
export function planRun(events = [], { nowMs = Date.now() } = {}) {
  const rows = []
  const skipped = {}
  const skip = (reason) => { skipped[reason] = (skipped[reason] ?? 0) + 1 }
  const earliest = nowMs - DAY_MS
  const latest = nowMs + HORIZON_DAYS * DAY_MS

  for (const e of events) {
    const built = buildRow(e)
    if (built.skip) { skip(built.skip); continue }
    const startMs = Date.parse(built.row.start_at)
    if (startMs < earliest) { skip('past'); continue }
    if (startMs > latest) { skip('beyond_horizon'); continue }
    rows.push(built)
  }
  return { found: events.length, rows, skipped }
}

// ── Run ─────────────────────────────────────────────────────────────────────

export async function collect({ fetchImpl, sleep, now = Date.now } = {}) {
  const { events, total, truncated } = await fetchLibCalEvents({
    origin: ORIGIN, calendarId: CALENDAR_ID, fetchImpl, sleep,
  })
  if (truncated) console.warn(`  ⚠ Pagination hit the page cap: read ${events.length} of ${total}. Later programs were not read.`)
  return planRun(events, { nowMs: now() })
}

export function run({ dryRun = false, fetchImpl, sleep, now } = {}) {
  return runPlannedScraper({
    source: SOURCE_KEY,
    label: 'Twinsburg Public Library (LibCal)',
    emoji: '📚',
    org: ORG,
    homeVenue: MAIN_VENUE,
    collect: () => collect({ fetchImpl, sleep, now }),
    dryRun,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
