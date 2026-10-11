/**
 * scrape-barberton-library.js
 *
 * Barberton Public Library: a standalone Summit County library (one building
 * at 602 West Park Avenue, separate from the Akron-Summit system). Its public
 * event calendar runs on LibCal (Springshare), served from
 * https://events.barbertonlibrary.org/ (calendar id `c=14558`).
 *
 * Feed strategy: LibCal's calendar JSON, not the HTML. The fetch, pagination
 * and the platform-level shape helpers (times, price, image, description, the
 * canceled-title convention) live in scripts/lib/libcal.js; see its header
 * for the endpoint. This file holds only what is specific to this library:
 * which rows are not public events, its category and audience vocabulary, and
 * where its programs actually meet.
 *
 * Lookahead: the list is ongoing and upcoming rows in date order, and it is
 * count-capped server-side (about 240 rows when checked on 2026-10-08; see
 * lib/libcal.js). So a run sees the SHORTER of HORIZON_DAYS (180) and however
 * far the cap reaches that night. Rows past the cap are picked up on a later
 * night, months before they happen.
 *
 * Not events (skipped, see skipReason): canceled programs, Board meetings,
 * closures ("Library Closed", "Library Closes Early"), the Friends of the
 * Library's own meetings and donation days, and passive all-day entries with
 * no gathering to attend ("Book Club to Go" kit pickups, contest entry
 * windows). The Friends of the Library Book Sale IS a public event and stays.
 *
 * Venues: `location` is normally an internal room name ("Spillette Meeting
 * Room", "Board Room, Spillette Meeting Room"), and rooms collapse onto the
 * one library venue. Only a string that is recognizably a room does: anything
 * else non-blank (a park, "Virtual", an address) is left venue-less and
 * flagged for review, never asserted to be the library. A blank location is
 * usually the library too, but NOT always: the "Afternoon Hooks & Books"
 * series meets at a rotating downtown business and says so only in prose
 * ("meets at White Rabbit Galleries, 571 W. Tuscarawas Ave."). resolveVenue
 * recovers that venue when the sentence parses and otherwise leaves the event
 * venue-less and flagged; it never asserts the library for a row that says it
 * meets somewhere else. Online programs get no venue.
 *
 * Geography: the library serves Barberton (Summit County), so as a first-party
 * single-institution source every program is Summit by organizer. Off-site
 * venues are still guarded with classifySummitLocation and dropped when their
 * explicit city is known non-Summit ('out').
 *
 * All-day rows: the feed gives no clock time, so libCalTimes stores noon ET
 * (SANCTIONED-DEFAULT-TIME) and buildRow marks the row `time_inferred`.
 * upsertEventSafe does the rest (the placeholder-time note and needs_review,
 * unless a human has locked start_at). No all-day row survives the skip rules
 * today, but the path is live for the first one that does.
 *
 * Canceled programs: LibCal keeps the entry and prefixes the title, so a
 * program we already published can flip to "CANCELED- ...". Skipping it is not
 * enough, because the row we ingested earlier would stay published. After the
 * upsert loop those rows are set to status 'cancelled' (never deleted, and
 * never when an admin has pinned `status` in manual_overrides). See
 * planCancelFlip. A cancellation is NEVER inferred from a row merely vanishing:
 * the list is count-capped, so far-out programs drop off its tail whenever
 * staff add nearer ones, and come back later.
 *
 * Price: library programs are free. The feed's `registration_cost` is the
 * explicit signal (empty across the feed = free) and is parsed if populated.
 *
 * Usage:
 *   node scripts/scrape-barberton-library.js
 *   node scripts/scrape-barberton-library.js --dry-run   # fetch + parse only
 *
 * Required .env vars (not needed for --dry-run):
 *   VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, htmlToText, hasStatusOverride,
  enrichWithImageDimensions, upsertEventSafe, setEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'
import {
  fetchLibCalEvents, libCalNames, isLibCalCanceledTitle, libCalTimes,
  parseLibCalPrice, libCalImageUrl, libCalDescription,
} from './lib/libcal.js'
import { classifySummitLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'barberton_library'
const ORIGIN = 'https://events.barbertonlibrary.org'
const CID = 14558
// The project's usual forward window. The feed's own count cap can be shorter
// on a given night (see the header); whichever is shorter wins.
const HORIZON_DAYS = 180
const DAY_MS = 86_400_000

// Ceiling on how many PUBLISHED rows one run may flip to cancelled. A handful
// of cancellations at once is normal. Dozens means the title convention or the
// feed changed, and a status sweep is the wrong response.
export const CANCEL_FLIP_MAX_ROWS = 25

const ORG_NAME = 'Barberton Public Library'
const ORG_WEBSITE = 'https://www.barbertonlibrary.org'
const ORG_DESCRIPTION = 'The Barberton Public Library serves Barberton with programs, classes, story times, and events for all ages.'

// Name, address and coordinates are the exact values already stored for this
// venue (main_street_barberton writes the same address nightly). ensureVenue
// overwrites address and coordinates on every run, so any other spelling here
// would make the two scrapers flap the row. Parking fields are omitted on
// purpose: nothing has verified them.
export const MAIN_VENUE = {
  name: 'Barberton Public Library',
  details: {
    address: '602 West Park Avenue', city: 'Barberton', state: 'OH', zip: '44203',
    lat: 41.013477, lng: -81.611871,
    website: ORG_WEBSITE,
    description: ORG_DESCRIPTION,
  },
}

// ── Pure parsers (unit-tested) ────────────────────────────────────────────────

/** Case- and whitespace-insensitive key for a controlled vocabulary name. */
function vocabKey(name) {
  return String(name ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
}

/** Set of vocabKeys for a list of names (or a single name). */
function vocabSet(names) {
  return new Set((Array.isArray(names) ? names : [names]).map(vocabKey).filter(Boolean))
}

// Title fallback for a board meeting that lost its category. Anchored to the
// library's own governance titles ("Regular Board Meeting", "Special Board
// Meeting", "Board of Trustees Meeting") so a program that merely ends in the
// same words ("Teen Advisory Board Meeting", a real teen program name at many
// libraries) is not skipped as governance. Every real board row seen so far
// also carries the `Board Meeting` category, which is the primary signal.
const BOARD_TITLE_RE = /^(?:(?:regular|special)\s+)?(?:library\s+)?board\s+(?:of\s+trustees\s+)?meeting\b/i

/**
 * Why a feed row is not a public event, or null when it is one. First match
 * wins, and `canceled` is checked first so a canceled board meeting is still
 * reported as a cancellation.
 *
 *   canceled       title carries the library's cancellation prefix
 *   board          Board of Trustees meetings (internal governance)
 *   closure        "Library Closed", "Library Closes Early", "Closed for ..."
 *   friends-admin  the Friends group's own meetings and donation drop-offs
 *   passive        nothing to attend at a time: "Book Club to Go" kit pickups,
 *                  and contest entry windows published as all-day or multi-day
 *
 * Kept on purpose: the Friends of the Library Book Sale (a public market) and
 * timed contest-adjacent programs such as "Pumpkin Decorating".
 *
 * @param {object} e                raw feed object (for all_day / multi_day_event)
 * @param {string[]} categoryNames  libCalNames(e.categories_arr)
 * @param {string} title            plain-text title
 * @returns {'canceled'|'board'|'closure'|'friends-admin'|'passive'|null}
 */
export function skipReason(e = {}, categoryNames = [], title = '') {
  const cats = vocabSet(categoryNames)
  const t = String(title ?? '').trim()

  if (isLibCalCanceledTitle(t)) return 'canceled'
  if (cats.has('board meeting') || BOARD_TITLE_RE.test(t)) return 'board'
  if (cats.has('library closing') || /\blibrary (?:is |will be )?clos(?:ed|es|ing)\b|\bclosed for\b/i.test(t)) return 'closure'
  if (/^friends of the library (?:meeting|donation day)\b/i.test(t)) return 'friends-admin'
  if (/^book club to go\b/i.test(t)) return 'passive'
  if (cats.has('challenges & contests') && (e?.all_day === true || e?.multi_day_event === true)) return 'passive'
  return null
}

// The library's controlled program-type vocabulary (categories_arr[].name) →
// v2 content category. TABLE order, not feed order, decides which slug is
// primary: the feed lists the same two categories in either order from one
// occurrence of a series to the next ("Arts & Crafts, Book Club" one month,
// "Book Club, Arts & Crafts" the next), and the primary category must not
// flip with it.
//
// Unmapped on purpose, because they describe who or what kind of occasion
// rather than content: Community Connections, Homeschool, Special Event,
// Movies & Music (film or music, the name cannot say which), Friends of the
// Library, Challenges & Contests. Rows carrying only those fall through to
// text inference and the manifest's defaultCategory.
const CATEGORY_TABLE = [
  ['storytime',                  'learning'],
  ['book club',                  'learning'],
  ['arts & crafts',              'visual-art'],
  ['games & trivia',             'games'],
  ['food & cooking',             'food'],
  ['health & wellness',          'fitness'],
  ['local history & genealogy',  'learning'],
  ['education & skills',         'learning'],
]

/**
 * Map the controlled category names to 0-2 v2 slugs, primary first, in
 * CATEGORY_TABLE order. A non-empty result is passed to upsertEventSafe as
 * `categories`, which is authoritative and bypasses text inference; an empty
 * result passes nothing, so inference and the manifest default decide.
 *
 * The title is consulted for exactly one thing: the Friends book sale, whose
 * only category ("Friends of the Library") is unmapped but which is plainly a
 * market.
 */
export function mapCategories(categoryNames = [], title = '') {
  const cats = vocabSet(categoryNames)
  const slugs = []
  for (const [name, slug] of CATEGORY_TABLE) {
    if (cats.has(name) && !slugs.includes(slug)) slugs.push(slug)
  }
  if (!slugs.length && /\bbook sale\b/i.test(String(title ?? ''))) slugs.push('market')
  return slugs.slice(0, 2)
}

// Audience names (audiences[].name) that mean "programmed for kids, teens or
// families". "All Abilities" is an accessibility statement, not an age band,
// and is ignored everywhere below.
const FAMILY_AUDIENCES = new Set(['birth to age 5', 'grades k - 5', 'grades 6 - 12', 'all ages'])

/**
 * The library's Audience field is the authoritative audience signal. Returns
 * true for youth and all-ages audiences, otherwise undefined (never false) so
 * inference can still flag family events the field misses.
 */
export function parseIsFamily(audienceNames = []) {
  for (const a of vocabSet(audienceNames)) if (FAMILY_AUDIENCES.has(a)) return true
  return undefined
}

/**
 * Build the tags array from the audience names. 'free' is added only for an
 * explicit zero price, so a program with a materials fee is never tagged free.
 *
 * @param {string[]} audienceNames  libCalNames(e.audiences)
 * @param {number|null} [priceMin]  price_min from parseLibCalPrice
 * @param {boolean} [online]        the feed's online_event flag
 */
export function parseTags(audienceNames = [], priceMin = null, online = false) {
  const audiences = vocabSet(audienceNames)
  const tags = ['library', 'barberton']
  if (priceMin === 0) tags.push('free')
  if (audiences.has('birth to age 5') || audiences.has('grades k - 5')) tags.push('kids')
  if (audiences.has('grades 6 - 12')) tags.push('teens')
  if (audiences.has('adult')) tags.push('adults')
  if (online === true) tags.push('online')
  return tags
}

// "<Series> meets at <Venue Name>, <street address>." A capitalized name, a
// comma, then a house number and a street ending in a recognized suffix. The
// name class has no semicolon and no digits-only form, so an undecoded entity
// ("Kav&eacute; Coffee Bar") or a bare address ("meets at 571 W. Tuscarawas
// Ave.") does not match and the caller fails closed.
const MEETS_AT_RE = /\bmeets at\s+(\p{Lu}[\p{L}\p{M}\p{N}'’&.\- ]{2,60}?),\s*(\d{1,5}\s+(?:[NSEW]\.?\s+)?[\p{L}.' ]{2,40}?\b(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Dr|Drive|Ln|Pkwy)\b)\.?/u

/** Description HTML as one line of plain text (\s also folds the feed's &nbsp;). */
function proseText(descriptionHtml) {
  return htmlToText(String(descriptionHtml || '')).replace(/\s+/g, ' ').trim()
}

/**
 * Recover an off-site venue from the event PROSE for a blank-location row.
 * Returns { name, details } or null when the description has no parseable
 * "meets at <Name>, <address>" sentence.
 *
 * City is Barberton: the series meets at downtown Barberton businesses and the
 * sentence never states a city. Periods are stripped from the address ("571 W.
 * Tuscarawas Ave." → "571 W Tuscarawas Ave"). No lat/lng: the geocoder owns
 * coordinates, and ensureVenue matches an existing venue by name first.
 */
export function resolveProseVenue(descriptionHtml = '') {
  const m = proseText(descriptionHtml).match(MEETS_AT_RE)
  if (!m) return null
  const name = m[1].trim()
  const address = m[2].replace(/\./g, '').replace(/\s+/g, ' ').trim()
  if (!name || !address) return null
  return { name, details: { address, city: 'Barberton', state: 'OH' } }
}

// Every non-blank `location` value the feed has carried (2026-10-08). The
// two-room string "Board Room, Spillette Meeting Room" is these parts joined.
const KNOWN_ROOMS = new Set([
  "children's activity room",
  'spillette meeting room',
  'board room',
  'teen room',
  'study room 1',
])

// A room the library adds later should not need a code change to resolve, so
// a part that names a kind of indoor space, or the library itself, also counts.
const GENERIC_ROOM_RE = /\b(?:room|desk|floor|lobby|area)\b|library/i

/**
 * True when a non-blank location string names space inside the library:
 * EVERY comma-separated part is a known room or reads like one. One part that
 * does not ("Board Room, Lake Anna Park") makes the whole string not a room.
 */
export function isLibraryRoom(location) {
  const parts = String(location ?? '').split(',').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
  if (!parts.length) return false
  return parts.every((p) => KNOWN_ROOMS.has(vocabKey(p)) || GENERIC_ROOM_RE.test(p))
}

/**
 * Resolve a feed row to a venue. Returns { venue, needsReview }.
 *
 *   0. An online program has no venue (same as the Stow-Munroe Falls scraper):
 *      it is ingested venue-less and is not a review case.
 *   1. A non-blank, address-shaped location (a comma followed by a house
 *      number) is not a room. No row has one today, so fail closed: no venue,
 *      flagged for review.
 *   2. A non-blank location that is a library room (isLibraryRoom) →
 *      MAIN_VENUE. The address test needs a comma followed by a house number,
 *      so "Board Room, Spillette Meeting Room" reaches this rule.
 *   2b. Any OTHER non-blank location ("Lake Anna Park", "Virtual") names
 *      somewhere we cannot place: no venue, flagged for review. Never the
 *      library.
 *   3. Blank location with a parseable "meets at" sentence → that venue.
 *   4. Blank location that says "meets at" but does not parse → no venue,
 *      flagged for review. Never assert the library for a row that tells the
 *      reader it meets somewhere else.
 *   5. Any other blank location → MAIN_VENUE (a booked room is optional, the
 *      building is not).
 *
 * @param {string} location         the feed's `location`
 * @param {string} descriptionHtml  the feed's `description`
 * @param {boolean} [online]        the feed's `online_event === true`
 */
export function resolveVenue(location = '', descriptionHtml = '', online = false) {
  if (online === true) return { venue: null, needsReview: false }
  const loc = String(location || '').replace(/\s+/g, ' ').trim()
  if (loc) {
    if (/,\s*\d+\s+\S/.test(loc)) return { venue: null, needsReview: true }
    if (isLibraryRoom(loc)) return { venue: MAIN_VENUE, needsReview: false }
    return { venue: null, needsReview: true }
  }
  const prose = resolveProseVenue(descriptionHtml)
  if (prose) return { venue: prose, needsReview: false }
  if (/\bmeets at\b/i.test(proseText(descriptionHtml))) return { venue: null, needsReview: true }
  return { venue: MAIN_VENUE, needsReview: false }
}

/**
 * Geo decision for a resolved venue. Venue-less events publish (Summit
 * institution). A venue is dropped only when its EXPLICIT city is known
 * non-Summit; the library itself (Barberton) always passes.
 */
export function shouldDropForGeo(venue) {
  if (!venue) return false
  return classifySummitLocation({ city: venue.details?.city }) === 'out'
}

/**
 * Build an event row (+ resolved venue) from one LibCal feed object.
 *
 * Returns { row, venue } for a public event, otherwise { skip: <reason> }.
 * A canceled row also carries `sourceId` so run() can retire the copy we
 * published before the library canceled it. `invalid` covers a row with no
 * id, no title or no parseable start.
 *
 * source_id is `bpl_<id>` with no date suffix: a LibCal id already identifies
 * one occurrence (a recurring program gets a new id per date).
 */
export function buildRow(e = {}) {
  const title = htmlToText(String(e?.title || '')).trim()
  if (e?.id == null || e.id === '' || !title) return { skip: 'invalid' }
  const sourceId = `bpl_${e.id}`

  const categoryNames = libCalNames(e.categories_arr)
  const audienceNames = libCalNames(e.audiences)

  const reason = skipReason(e, categoryNames, title)
  if (reason === 'canceled') return { skip: reason, sourceId }
  if (reason) return { skip: reason }

  // libCalTimes owns the all-day noon default (SANCTIONED-DEFAULT-TIME).
  const times = libCalTimes(e)
  if (!times) return { skip: 'invalid' }

  const online = e.online_event === true
  const { venue, needsReview } = resolveVenue(e.location, e.description, online)
  const { price_min, price_max } = parseLibCalPrice(e.registration_cost)
  const categories = mapCategories(categoryNames, title)

  return {
    row: {
      title,
      description: libCalDescription(e),
      start_at: times.startAt,
      end_at: times.endAt,
      // Only when the controlled vocabulary maps: `categories` is authoritative
      // in upsertEventSafe, so an empty array must not be sent.
      ...(categories.length ? { categories } : {}),
      is_family: parseIsFamily(audienceNames),
      tags: parseTags(audienceNames, price_min, online),
      price_min,
      price_max,
      age_restriction: 'not_specified',
      image_url: libCalImageUrl(e),
      ticket_url: e.url || `${ORIGIN}/event/${e.id}`,
      source: SOURCE_KEY,
      source_id: sourceId,
      status: 'published',
      // Noon on an all-day row is a default, not a confirmed time. The
      // transient time_inferred key hands that to upsertEventSafe, which
      // appends the placeholder-time note and sets needs_review unless a human
      // has locked start_at (scripts/lib/inferred-time.js). It never reaches
      // Postgres.
      time_inferred: times.isAllDay ? true : undefined,
      // Set here only for a location we could not place, which needs a human
      // to attach the venue. Otherwise undefined (never false) so
      // upsertEventSafe's own needs_review default still runs.
      needs_review: needsReview ? true : undefined,
      featured: false,
    },
    venue,
  }
}

/**
 * Turn the fetched feed into the run's work list. Pure: no clock, no network,
 * no DB.
 *
 * Applies buildRow, the ingestion window (start no older than one day and no
 * further out than HORIZON_DAYS) and the geo drop, and collects the source_ids
 * of canceled rows. Canceled ids are NOT windowed: retiring a row we never
 * ingested is a no-op, and the cancellation of a far-out program we did ingest
 * earlier still has to land.
 *
 * @param {object[]} events  raw feed objects
 * @param {object} [opts]
 * @param {number} [opts.nowMs=Date.now()]
 * @returns {{rows: Array<{row: object, venue: object|null}>, skipped: Record<string, number>, canceledSourceIds: string[]}}
 */
export function planRun(events = [], { nowMs = Date.now() } = {}) {
  const cutoffPast = nowMs - DAY_MS
  const cutoffFuture = nowMs + HORIZON_DAYS * DAY_MS
  const rows = []
  const skipped = {}
  const canceled = new Set()
  const seen = new Set()
  const skip = (reason) => { skipped[reason] = (skipped[reason] || 0) + 1 }

  for (const e of Array.isArray(events) ? events : []) {
    const built = buildRow(e)
    if (built.skip) {
      if (built.skip === 'canceled' && built.sourceId) canceled.add(built.sourceId)
      skip(built.skip)
      continue
    }
    const startMs = Date.parse(built.row.start_at)
    if (startMs < cutoffPast) { skip('past'); continue }
    if (startMs > cutoffFuture) { skip('horizon'); continue }
    if (shouldDropForGeo(built.venue)) { skip('geo'); continue }
    // fetchLibCalEvents already dedupes by id; this keeps planRun safe for any
    // other caller, since two rows with one source_id would upsert twice.
    if (seen.has(built.row.source_id)) { skip('duplicate'); continue }
    seen.add(built.row.source_id)
    rows.push(built)
  }
  return { rows, skipped, canceledSourceIds: [...canceled] }
}

/**
 * How to record a feed that fetched and parsed cleanly but carried no events.
 * Same shape as emptyFeedOutcome() in lib/ics.js, and the opposite default to
 * a seasonal source: a public library's calendar is never legitimately empty,
 * so zero rows means the endpoint or the calendar id changed. Recorded as an
 * error run (exit 0, like the ICS runner) so it surfaces the first night.
 *
 * @returns {{status: 'error', errorMessage: string, reason: string}}
 */
export function emptyFeedOutcome() {
  const reason = 'LibCal feed returned 0 events'
  return { status: 'error', errorMessage: reason, reason }
}

/**
 * Decide which already-ingested rows to retire after the library canceled
 * them. Pure, so the guards are testable.
 *
 * A row is retired only when it is currently `published` and no admin has
 * pinned `status` in manual_overrides: a pin is a human decision, and
 * _stripOverriddenFields protects it from the upsert path for the same reason.
 * Rows already cancelled or in review are left alone.
 *
 * `overCap` is measured on the rows that would actually CHANGE, not on how
 * many canceled titles the feed carries. A cancelled weekly series keeps its
 * canceled titles in the feed for months after we flipped those rows, and
 * counting them would switch the step off for all that time.
 *
 * @param {Array<{id: string, status: string, manual_overrides?: object|null}>} rows
 * @returns {{cancel: object[], pinned: number, overCap: boolean}}
 */
export function planCancelFlip(rows = []) {
  const published = (Array.isArray(rows) ? rows : []).filter((r) => r?.status === 'published')
  const cancel = published.filter((r) => !hasStatusOverride(r))
  return {
    cancel,
    pinned: published.length - cancel.length,
    overCap: cancel.length > CANCEL_FLIP_MAX_ROWS,
  }
}

// ── Database (never reached under --dry-run) ─────────────────────────────────

/**
 * Cancel-on-flip: set status 'cancelled' on published rows whose LibCal entry
 * now carries the cancellation prefix. Status-only UPDATE: no delete, no
 * insert, no manual_overrides stamp, so a normal upsert re-publishes the row
 * if the library un-cancels it.
 *
 * Returns { cancelled, pinned, note }. `note` is null when the step did its
 * job, otherwise a short reason for the run's `degraded:` disclosure (query
 * failed, over the cap, an update failed). May throw; run() treats that as a
 * degraded run too, never as a failed one.
 */
async function cancelFlippedRows(canceledSourceIds) {
  if (!canceledSourceIds.length) return { cancelled: 0, pinned: 0, note: null }

  const { supabaseAdmin } = await import('./lib/supabase-admin.js')
  const { data: rows, error } = await supabaseAdmin
    .from('events')
    .select('id, title, source_id, status, manual_overrides')
    .eq('source', SOURCE_KEY)
    .in('source_id', canceledSourceIds)
  if (error) {
    console.warn(`  ⚠ Cancel-on-flip query failed: ${error.message}. Cancelling nothing.`)
    return { cancelled: 0, pinned: 0, note: `cancel-on-flip query failed (${error.message})` }
  }

  const plan = planCancelFlip(rows ?? [])
  if (plan.pinned) console.log(`  🛡  ${plan.pinned} canceled row(s) left alone: manual_overrides.status is a human decision`)
  if (plan.overCap) {
    console.warn(`  ⚠ ${plan.cancel.length} published rows would be cancelled in one run (cap ${CANCEL_FLIP_MAX_ROWS}). Cancel-on-flip SKIPPED; investigate before retiring.`)
    return {
      cancelled: 0,
      pinned: plan.pinned,
      note: `cancel-on-flip skipped, ${plan.cancel.length} published rows over the cap of ${CANCEL_FLIP_MAX_ROWS}`,
    }
  }

  let cancelled = 0
  let failed = 0
  for (const row of plan.cancel) {
    // Source and status are repeated in the UPDATE, not just the SELECT: the
    // write must be unable to touch another source's row or a row that
    // changed status between the read and the write.
    const { error: upErr } = await supabaseAdmin
      .from('events')
      .update({ status: 'cancelled' })
      .eq('id', row.id)
      .eq('source', SOURCE_KEY)
      .eq('status', 'published')
    if (upErr) { console.warn(`  ⚠ Cancel-on-flip failed for ${row.source_id}: ${upErr.message}`); failed++; continue }
    console.log(`     - cancelled "${row.title}" (${row.source_id})`)
    cancelled++
  }
  return {
    cancelled,
    pinned: plan.pinned,
    note: failed ? `cancel-on-flip failed for ${failed} of ${plan.cancel.length} rows` : null,
  }
}

/** Skip tally as one log line, e.g. "board 15 · closure 18". */
function formatSkips(skipped) {
  const parts = Object.entries(skipped).map(([reason, n]) => `${reason} ${n}`)
  return parts.length ? parts.join(' · ') : 'none'
}

/** Latest start date ("YYYY-MM-DD") among the fetched rows, or null. */
function lastListedDate(events) {
  let last = ''
  for (const e of events) {
    const d = typeof e?.startdt === 'string' ? e.startdt.slice(0, 10) : ''
    if (d > last) last = d
  }
  return last || null
}

// ── Run ────────────────────────────────────────────────────────────────────

/**
 * One full scrape. Everything main() does except reading argv and setting the
 * process exit code, so tests can drive it with a stub fetch and a fake
 * Supabase client.
 *
 * Never throws: a fatal error is logged (to scraper_runs, unless dryRun) and
 * returned as exitCode 1. With dryRun the database is never touched, on the
 * success path, the empty-feed path or the error path.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]  fetch + parse only, no DB access at all
 * @param {function} [opts.fetchImpl]    injectable fetch (tests)
 * @param {function} [opts.sleep]        injectable retry backoff sleep (tests)
 * @param {function} [opts.now=Date.now] clock for the ingestion window (tests)
 * @returns {Promise<object>} { exitCode, status, fetched, total, planned,
 *   inserted, updated, failed, aliasSkipped, cancelled, notes, error }
 */
export async function run({ dryRun = false, fetchImpl, sleep, now = Date.now } = {}) {
  console.log('📚  Starting Barberton Public Library (LibCal JSON feed) scrape…')
  if (dryRun) console.log('   [dry-run mode: fetch + parse only, no DB access]')
  const start = Date.now()
  const result = {
    exitCode: 0, status: 'success', fetched: 0, total: 0, planned: 0,
    inserted: 0, updated: 0, failed: 0, aliasSkipped: 0, cancelled: 0, notes: [], error: null,
  }

  try {
    const { events, total, truncated } = await fetchLibCalEvents({ origin: ORIGIN, calendarId: CID, fetchImpl, sleep })
    result.fetched = events.length
    result.total = total
    // "N of N" alone hides the server-side count cap (total_results is the
    // capped number), so say how far ahead tonight's list actually reaches.
    console.log(`\n📥  Fetched ${events.length} of ${total} listed events; the list reaches ${lastListedDate(events) ?? '(nothing)'}`)
    console.log(`   (the list is count-capped server-side, so lookahead is the shorter of that date and ${HORIZON_DAYS} days)`)
    if (truncated) {
      console.warn(`  ⚠ Pagination hit our page cap: fetched ${events.length} of ${total}. Later events were not read.`)
      result.notes.push(`pagination capped, fetched ${events.length} of ${total}`)
    }

    if (!events.length) {
      const outcome = emptyFeedOutcome()
      console.warn(`  ❌  ${outcome.reason}`)
      result.status = outcome.status
      if (!dryRun) {
        await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
          status: outcome.status,
          errorMessage: outcome.errorMessage,
          durationMs: Date.now() - start,
          eventsFound: 0,
        })
      }
      return result
    }

    const plan = planRun(events, { nowMs: now() })
    result.planned = plan.rows.length
    console.log(`  ${plan.rows.length} event(s) to publish within the ${HORIZON_DAYS}-day window`)
    console.log(`  Skipped: ${formatSkips(plan.skipped)}`)

    if (dryRun) {
      console.log(`\n🧪  Dry-run: ${plan.rows.length} event(s) prepared, nothing written.`)
      for (const { row, venue } of plan.rows) {
        console.log(
          `     • ${row.title}\n       ${row.start_at} → ${row.end_at ?? '(no end)'}` +
          `  cats=${row.categories ? row.categories.join('+') : '(inferred)'}` +
          `  @ ${venue ? venue.name : '(no venue)'}` +
          `${row.time_inferred ? '  [time_inferred]' : ''}` +
          `${row.needs_review ? '  [needs_review]' : ''}  id=${row.source_id}`,
        )
      }
      if (plan.canceledSourceIds.length) {
        console.log(`\n  Canceled at the source (would be set to 'cancelled' if published and not status-pinned): ${plan.canceledSourceIds.join(', ')}`)
      }
      console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s [dry-run]`)
      result.status = 'dry-run'
      return result
    }

    const organizationId = await ensureOrganization(ORG_NAME, {
      website: ORG_WEBSITE,
      description: ORG_DESCRIPTION,
    })

    const venueCache = new Map()

    for (const { row, venue } of plan.rows) {
      try {
        const enriched = await enrichWithImageDimensions(row, { organizationId })
        const { data: upserted, error, isNew } = await upsertEventSafe(enriched)
        if (error) {
          // An alias-skip is upsertEventSafe doing its job (this row was
          // hand-merged into another event and must not be re-created), not a
          // failed write. It only arrives in the error slot so callers need no
          // extra branch to skip it.
          if (/^alias-skip:/.test(String(error.message ?? ''))) {
            console.log(`  ↷ Merged duplicate, not re-created: "${row.title}" (${row.source_id})`)
            result.aliasSkipped++
          } else {
            console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`)
            result.failed++
          }
          continue
        }

        if (venue) {
          const vKey = venue.name
          let venueId = venueCache.get(vKey)
          if (venueId === undefined) {
            venueId = await ensureVenue(venue.name, venue.details)
            venueCache.set(vKey, venueId)
            // Only the library's own building belongs to the library. An
            // off-site host (a gallery, a coffee bar) must not be claimed.
            if (venue === MAIN_VENUE && organizationId && venueId) await linkOrganizationVenue(organizationId, venueId)
          }
          // setEventVenue, not linkEventVenue: one program has exactly one
          // venue, and a series that moves must not keep its old link.
          if (venueId) await setEventVenue(upserted.id, venueId)
        }
        if (organizationId) await linkEventOrganization(upserted.id, organizationId)
        if (isNew) result.inserted++
        else result.updated++
      } catch (err) {
        console.warn(`  ⚠ Error on "${row.title}": ${err.message}`)
        result.failed++
      }
    }

    // The upserts are done and stand on their own. Whatever happens in the
    // cancel step, the run completed: a problem here is disclosed as degraded,
    // never promoted to a failed run.
    try {
      const flip = await cancelFlippedRows(plan.canceledSourceIds)
      result.cancelled = flip.cancelled
      if (flip.note) result.notes.push(flip.note)
      if (plan.canceledSourceIds.length) {
        console.log(`  🗄  ${flip.cancelled} row(s) set to cancelled (${plan.canceledSourceIds.length} canceled title(s) in the feed)`)
      }
    } catch (err) {
      console.warn(`  ⚠ Cancel-on-flip threw: ${err.message}. The upserts above are unaffected.`)
      result.notes.push(`cancel-on-flip threw (${err.message})`)
    }

    const skipped = events.length - result.inserted - result.updated
    await logUpsertResult(SOURCE_KEY, result.inserted, result.updated, skipped, {
      eventsFound: events.length,
      durationMs: Date.now() - start,
      // Same convention as runIcsScraper: the pipeline worked, so status stays
      // 'success', and the disclosure rides in error_message where the nightly
      // health checks look for `degraded:%`.
      ...(result.notes.length ? { errorMessage: `degraded: ${result.notes.join('; ')}` } : {}),
    })
    console.log(
      `\n✅  Barberton Public Library: ${result.inserted} inserted, ${result.updated} updated, ` +
      `${result.failed} failed, ${result.aliasSkipped} merged duplicate(s) skipped, ` +
      `${events.length - plan.rows.length} filtered in ${((Date.now() - start) / 1000).toFixed(1)}s`,
    )
    return result
  } catch (err) {
    result.exitCode = 1
    result.status = 'error'
    result.error = err
    // --dry-run must never touch the database, including on the error path.
    if (dryRun) console.error(`\n❌  Fatal error [${SOURCE_KEY}] (dry-run, not logged to DB):`, err.message)
    else await logScraperError(SOURCE_KEY, err, start)
    return result
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'
  const result = await run({ dryRun })
  if (result.exitCode) process.exit(result.exitCode)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
