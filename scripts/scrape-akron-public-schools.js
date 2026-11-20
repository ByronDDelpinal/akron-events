/**
 * scrape-akron-public-schools.js
 *
 * Fetches district-wide calendar events from Akron Public Schools.
 *
 * Caveat: the district calendar mixes public-facing events (music
 * performances, sports, open houses, community meetings) with internal
 * administrative dates (PTO meetings, staff training, building closures).
 * We apply a keyword filter to surface only public-facing items.
 *
 * Per the config memory, final filter tuning should be reviewed with the
 * user — this is a conservative starting pass.
 *
 * Usage:
 *   node scripts/scrape-akron-public-schools.js
 *   DRY_RUN=1 node scripts/scrape-akron-public-schools.js   (or --dry-run)
 *     Reads the feed and the existing APS rows, prints what would change,
 *     and writes nothing (no org/venue/event upserts, no scraper_runs row).
 *
 * Environment overrides:
 *   AKRON_PUBLIC_SCHOOLS_ICS_URL — direct ICS feed URL(s), comma-separated.
 *     Optional — falls back to DEFAULT_FEED_URLS (the district's public
 *     Finalsite iCal feeds) when unset, same as its sibling scrapers. If the
 *     resolved feeds together parse to 0 VEVENTs, the scraper makes one
 *     last-resort attempt to discover a feed URL from CALENDAR_PAGE and,
 *     if that yields a URL not already tried, fetches and parses it too.
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  enrichWithImageDimensions,
  ensureOrganization,
  ensureVenue,
  inferCategory,
  linkEventOrganization,
  linkEventVenue,
  logScraperError,
  logUpsertResult,
  stripHtml,
  upsertEventSafe,
  easternToIso,
  sanitizeEventText,
} from './lib/normalize.js'
import {
  fetchIcsFeed, parseIcs, normaliseIcsEvent, discoverIcsFeed,
  isDateOnlyIcsEvent, applyNeedsReviewHook, DATE_ONLY_TIME_NOTE,
} from './lib/ics.js'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { addDaysYmd } from '../src/lib/recurrence.js'

const SOURCE_KEY = 'akron_public_schools'
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'
const CALENDAR_PAGE = 'https://www.akronschools.com/district/district-information/calendar'

// The district (Finalsite) publishes one iCal feed per calendar; these are the
// public District Calendar + Fine Arts Calendar feeds, verified serving
// text/calendar. calendar_397 (Fine Arts) is currently a valid but EMPTY
// calendar (0 VEVENTs) — kept here for when the district starts populating it.
// AKRON_PUBLIC_SCHOOLS_ICS_URL overrides this list when set.
const DEFAULT_FEED_URLS = [
  'https://www.akronschools.com/calendar/calendar_349.ics',
  'https://www.akronschools.com/calendar/calendar_397.ics',
]

// Pure — exported for tests. Returns the configured feed URL(s): env var
// (comma-separated, trimmed, blanks dropped) when non-empty, else the
// hardcoded default feeds.
export function resolveFeedUrls(env = process.env) {
  const fromEnv = (env.AKRON_PUBLIC_SCHOOLS_ICS_URL || '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean)
  return fromEnv.length > 0 ? fromEnv : DEFAULT_FEED_URLS
}

// ── Public-facing event filter ────────────────────────────────────────────
//
// Rather than ingest every VEVENT, only include items that look like public
// gatherings. Tune these keyword lists as patterns emerge from real data.

const PUBLIC_KEYWORDS = [
  'concert', 'recital', 'performance', 'show', 'play', 'musical', 'band', 'choir', 'orchestra',
  'game', 'match', 'meet', 'tournament', 'scrimmage',   // athletics
  'open house', 'family night', 'community', 'fair', 'festival',
  'graduation', 'commencement', 'ceremony',
  'board meeting', 'school board', 'public hearing',
  'fundraiser', 'bake sale', 'book fair',
]

const EXCLUDE_KEYWORDS = [
  'staff', 'pd day', 'professional development', 'in-service', 'teacher workday',
  'no school', 'early dismissal', 'late start', 'closed',
  'report cards', 'progress reports', 'conferences only',
]

function isPublicFacing(ev) {
  const hay = `${ev.SUMMARY || ''} ${ev.DESCRIPTION || ''} ${ev.CATEGORIES || ''}`.toLowerCase()
  if (EXCLUDE_KEYWORDS.some(k => hay.includes(k))) return false
  return PUBLIC_KEYWORDS.some(k => hay.includes(k))
}

// Category: infer from event text; school events default to 'learning'.
function mapCategory(ev) {
  const cat = inferCategory(ev.SUMMARY || '', ev.DESCRIPTION || '')
  return cat === 'other' ? 'learning' : cat
}

function mapTags(ev) {
  const tags = ['schools', 'education']
  const text = (ev.SUMMARY || '').toLowerCase()
  if (/\b(game|match|tournament)\b/.test(text)) tags.push('athletics')
  if (/\b(concert|recital|band|choir|orchestra)\b/.test(text)) tags.push('music')
  return [...new Set(tags)]
}

// ── Date-only twins + explicit times ──────────────────────────────────────
//
// The district feeds list many events twice under different UIDs: one timed
// VEVENT and one bare-date (VALUE=DATE) twin. Left alone the twin is
// noon-defaulted and published beside the timed row.

function squashTitle(title) {
  return String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/**
 * Pure — exported for tests. Groups VEVENTs by squashed SUMMARY + DTSTART
 * calendar day. When a group has at least one timed member, every date-only
 * member is dropped; groups with no timed member pass through untouched.
 * "Date-only" means a bare 8-digit DTSTART (hasBareDateStart), so a
 * VALUE=DATE VEVENT carrying a real clock counts as timed and is never dropped.
 * Survivors keep their original order. Returns { events, dropped }.
 */
export function collapseDateOnlyTwins(events) {
  const timedByKey = new Map()
  // Raw DTSTART slice: a UTC-suffixed value ("20261013T020000Z") keys on its
  // UTC day, which can differ from the Eastern day of a bare-date twin; the
  // district feeds emit TZID/floating values so this is left as is.
  const keyOf = (ev) => `${squashTitle(ev.SUMMARY)}|${String(ev.DTSTART?.value || '').slice(0, 8)}`
  for (const ev of events) {
    if (!hasBareDateStart(ev)) {
      const key = keyOf(ev)
      if (!timedByKey.has(key)) timedByKey.set(key, ev)
    }
  }
  const out = []
  let dropped = 0
  for (const ev of events) {
    const timed = timedByKey.get(keyOf(ev))
    if (timed && hasBareDateStart(ev)) {
      dropped++
      console.log(`  ↳ date-only twin ${ev.UID} of ${timed.UID}: "${ev.SUMMARY}"`)
      continue
    }
    out.push(ev)
  }
  return { events: out, dropped }
}

/**
 * True for a bare 8-digit DTSTART value ("20261012") — the only shape for
 * which normaliseIcsEvent synthesizes noon. Mirrors ics.js isBareIcsDate:
 * isDateOnlyIcsEvent is also true for VALUE=DATE carrying a real clock
 * ("20261012T180000"), and that time must never be overwritten.
 */
function hasBareDateStart(ev) {
  return /^\d{8}$/.test(String(ev?.DTSTART?.value || '').trim())
}

// ── Multi-day runs of date-only rows ──────────────────────────────────────
//
// The district feed expresses a multi-day event (a school-wide window, a book
// fair week) as one bare-date VEVENT per day, each under its own UID and the
// same SUMMARY. Published as-is they flood the calendar with N noon rows.
// A run of >= minRun consecutive days becomes one ranged head row; the other
// days are still upserted (so a stable UID keeps updating its own row) but
// held as pending_review instead of published.

const ymdDash = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
const ymdBare = (dash) => dash.replace(/-/g, '')

/**
 * Pure — exported for tests. Plans consecutive-day runs of bare-date VEVENTs
 * (hasBareDateStart) that share a squashed SUMMARY. Within a title, days are
 * sorted (ties by UID string) and split wherever the next day is not exactly
 * +1 calendar day. A second UID on a day already in the run is a member and
 * does not extend it. Only runs spanning >= minRun distinct days appear in
 * the result. The head is the earliest day's lowest UID, so the plan does not
 * depend on input order. Timed and VALUE=DATE-with-clock VEVENTs, blank
 * titles and repeated UIDs (first occurrence wins) are never grouped.
 *
 * @returns {Map<string, {role:'head', lastYmd:string, length:number}
 *   | {role:'member', headUid:string}>}
 */
export function planDateOnlyRuns(events, { minRun = 3 } = {}) {
  const byTitle = new Map()
  const seenUids = new Set()
  for (const ev of events || []) {
    if (!hasBareDateStart(ev)) continue
    const uid = String(ev.UID ?? '')
    const title = squashTitle(ev.SUMMARY)
    if (!uid || !title || seenUids.has(uid)) continue
    seenUids.add(uid)
    const ymd = String(ev.DTSTART.value).trim()
    if (!byTitle.has(title)) byTitle.set(title, [])
    byTitle.get(title).push({ uid, ymd })
  }

  const plan = new Map()
  const flush = (run) => {
    if (!run || run.length < minRun) return
    const [head, ...members] = run.uids
    plan.set(head, { role: 'head', lastYmd: run.lastYmd, length: run.length })
    for (const uid of members) plan.set(uid, { role: 'member', headUid: head })
  }
  for (const items of byTitle.values()) {
    items.sort((a, b) => (a.ymd < b.ymd ? -1 : a.ymd > b.ymd ? 1 : a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0))
    let run = null
    for (const { uid, ymd } of items) {
      if (run && ymd === run.lastYmd) {
        run.uids.push(uid)
      } else if (run && ymd === ymdBare(addDaysYmd(ymdDash(run.lastYmd), 1))) {
        run.uids.push(uid)
        run.lastYmd = ymd
        run.length++
      } else {
        flush(run)
        run = { uids: [uid], lastYmd: ymd, length: 1 }
      }
    }
    flush(run)
  }
  return plan
}

// Words that introduce a deadline, an end, or a bound rather than a start
// ("RSVP by 5 pm", "ends at 3 p.m.", "until 4 pm", "through 6 pm").
const NON_START_LEAD = /\b(?:by|until|ends?|before|through)(?:\s+at)?\s*$/i
// A range dash immediately before the token ("9-12 pm", "3pm-5pm"): the token
// after the dash is an end, not a start.
const RANGE_DASH_LEAD = /\d\s*[-\u2013]\s*$/

/**
 * Pure — exported for tests. First 12-hour clock token in the DESCRIPTION
 * ("5:30 p.m.", "7 PM", "10:00am") as a normalised string easternToIso can
 * parse ("5:30 pm"), or null when none qualifies. Hour must be 1-12, minute
 * 0-59. A token preceded by a range dash or by by/until/ends/end/before/
 * through (optionally "at") is rejected as a non-start time, and no later
 * token is considered: a description whose first clock mention is a deadline
 * or an end is not a reliable statement of the start.
 */
export function explicitTimeFromDescription(ev) {
  const text = stripHtml(ev?.DESCRIPTION || '')
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\b/i)
  if (!m) return null
  const lead = text.slice(Math.max(0, m.index - 12), m.index)
  if (RANGE_DASH_LEAD.test(lead) || NON_START_LEAD.test(lead)) return null
  const hour   = parseInt(m[1], 10)
  const minute = m[2] != null ? parseInt(m[2], 10) : 0
  if (hour < 1 || hour > 12 || minute > 59) return null
  return `${hour}:${String(minute).padStart(2, '0')} ${m[3].toLowerCase()}m`
}

/**
 * Pure — exported for tests. For a bare-date VEVENT whose DESCRIPTION states
 * a clock time, replace the noon placeholder with that time, drop the
 * synthetic end only when it would now precede the start (mirrors
 * normaliseIcsEvent), and strip DATE_ONLY_TIME_NOTE. Returns true when the
 * row was re-timed. needs_review is left to the caller's hook so the review
 * queue still audits the substituted time.
 */
export function applyExplicitTime(row, ev) {
  if (!row || !hasBareDateStart(ev)) return false
  const time = explicitTimeFromDescription(ev)
  if (!time) return false
  const v = String(ev.DTSTART.value).trim()
  const iso = easternToIso(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, time)
  if (!iso) return false
  row.start_at = iso
  if (row.end_at && Date.parse(row.end_at) <= Date.parse(iso)) row.end_at = null
  if (row.description) {
    const stripped = row.description.replace(DATE_ONLY_TIME_NOTE, '').trim()
    row.description = stripped || null
  }
  return true
}

// ── Stable identity across UID re-issues ──────────────────────────────────
//
// The district feed periodically re-issues every VEVENT UID. Upserting on
// (source, source_id) then tries to INSERT a fresh row, which collides with
// the DB-only unique index uniq_events_aps_natural_key
// (source, title_normalized, start_at) and the event is skipped — the stored
// row is frozen (no description, time, or needs_review updates). Before
// upserting, adopt the stored source_id of the row with the same natural key
// so the upsert becomes an UPDATE of that row.

/**
 * Pure — exported for tests. Natural key mirroring uniq_events_aps_natural_key:
 * epoch-ms start (so "…Z" and "…+00:00" spellings agree) plus the title
 * normalised like title_normalized = unaccent(lower(title)) (migrations 024,
 * 034). unaccent is approximated by NFD + dropping combining marks, which
 * covers the Latin accents the feed can carry; trim is applied on top
 * (stored titles are already trimmed by the normaliser). The title first goes
 * through sanitizeEventText — the same pass upsertEventSafe applies before
 * writing — so an entity-encoded feed title ("Arts &amp; Crafts") keys like
 * its stored, decoded form.
 */
export function naturalKey(row) {
  const title = String(sanitizeEventText({ title: row?.title ?? '' }).title ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toLowerCase()
  return `${Date.parse(row?.start_at)}|${title}`
}

// Map value for a natural key held by more than one stored source_id.
export const AMBIGUOUS_KEY = null

/**
 * Pure — exported for tests. When `existingByKey` (naturalKey → stored
 * source_id) holds this row's key under a different source_id, point the row
 * at the stored one and return true. Otherwise — no entry, same source_id, or
 * an AMBIGUOUS_KEY entry (several stored rows share the key, so no single
 * row is the right target) — leave the row untouched and return false. Only
 * live `events` rows feed the map, so this never revives a merged-away event
 * (event_aliases are not consulted or written).
 */
export function adoptExistingSourceId(row, existingByKey) {
  if (!row || !existingByKey) return false
  const stored = existingByKey.get(naturalKey(row))
  if (stored === AMBIGUOUS_KEY || stored === undefined || stored === row.source_id) return false
  row.source_id = stored
  return true
}

// Matches the district Administration Building address as written in the
// Board Meeting descriptions ("…board room… Administration Building,
// 10 N. Main St."). The optional backslash tolerates a raw ICS `\,` escape
// should a description ever reach here un-unescaped.
const ADMIN_BUILDING_RE = /Administration Building\\?,?\s*10 N\.? Main St/i

/**
 * Pure — exported for tests. Venue for a LOCATION-less VEVENT whose
 * DESCRIPTION names the district Administration Building, else null. This is
 * the only description-derived venue; nothing else is guessed.
 */
export function venueFromDescription(ev) {
  const text = stripHtml(ev?.DESCRIPTION || '')
  if (!ADMIN_BUILDING_RE.test(text)) return null
  return { name: 'Akron Public Schools', address: '10 N. Main Street', city: 'Akron', state: 'OH' }
}

const EXISTING_PAGE_SIZE = 1000 // PostgREST's default max-rows; page explicitly.

/**
 * Exported for tests. Reads this source's upcoming (start_at >= now - 1 day)
 * rows into naturalKey → source_id, paging EXISTING_PAGE_SIZE at a time. A
 * key seen under two different source_ids maps to AMBIGUOUS_KEY and is never
 * adopted. Cancelled rows are excluded (.neq status): normaliseIcsEvent emits
 * status 'published', so adopting a cancelled row would un-cancel it unless an
 * admin had locked status in manual_overrides. A cancelled row's key thus
 * keeps skipping on the unique index, as before this fix, and stays cancelled.
 * A read failure yields an empty map with readFailed set, so the run degrades
 * to the pre-fix behaviour and main() discloses it in scraper_runs.
 *
 * @returns {Promise<{map: Map<string, string|null>, readFailed: boolean,
 *   readError: string|null, ambiguous: number}>}
 */
export async function loadExistingByKey({ client = supabaseAdmin, now = Date.now() } = {}) {
  const map = new Map()
  const since = new Date(now - 24 * 60 * 60 * 1000).toISOString()
  try {
    for (let from = 0; ; from += EXISTING_PAGE_SIZE) {
      const { data, error } = await client
        .from('events')
        .select('source_id,title,start_at')
        .eq('source', SOURCE_KEY)
        .neq('status', 'cancelled')
        .gte('start_at', since)
        .order('start_at', { ascending: true })
        .order('source_id', { ascending: true })
        .range(from, from + EXISTING_PAGE_SIZE - 1)
      if (error) throw new Error(error.message)
      for (const r of data || []) {
        if (!r.source_id) continue
        const key = naturalKey(r)
        if (!map.has(key)) map.set(key, r.source_id)
        else if (map.get(key) !== r.source_id) map.set(key, AMBIGUOUS_KEY)
      }
      if (!data || data.length < EXISTING_PAGE_SIZE) break
    }
  } catch (err) {
    console.warn(`  ⚠ Could not read existing ${SOURCE_KEY} rows (continuing without UID adoption): ${err.message}`)
    return { map: new Map(), readFailed: true, readError: err.message, ambiguous: 0 }
  }
  let ambiguous = 0
  for (const v of map.values()) if (v === AMBIGUOUS_KEY) ambiguous++
  return { map, readFailed: false, readError: null, ambiguous }
}

const DEFAULT_WRITERS = {
  ensureVenue, enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
}

/**
 * Exported for tests. Normalises, re-times, flags, adopts and (unless dryRun)
 * writes each public VEVENT. `writers` is injectable so tests can prove a dry
 * run calls no write path. Returns the run's counters.
 */
export async function processEvents(publicEvents, {
  dryRun = false, existingByKey = new Map(), organizationId = null, writers = DEFAULT_WRITERS,
  runPlan = new Map(),
} = {}) {
  const counts = {
    inserted: 0, skipped: 0, retimed: 0, adopted: 0, venueLinks: 0, flagged: 0, ranged: 0, held: 0,
  }
  const venueCache = new Map()

  for (const ev of publicEvents) {
    try {
      const row = normaliseIcsEvent(ev, {
        source: SOURCE_KEY,
        mapCategory,
        mapTags,
        defaultPriceMin: null,
        defaultPriceMax: null,
        ageRestriction:  'all_ages',
      })
      if (!row || !row.start_at || !row.source_id) { counts.skipped++; continue }
      // Date-only VEVENT: honour a time stated in the description. Either
      // way the row is flagged for review, exactly as runIcsScraper feeds
      // do: noon is invented, and a description-derived time is inferred.
      if (applyExplicitTime(row, ev)) counts.retimed++
      applyNeedsReviewHook(row, ev, isDateOnlyIcsEvent)
      if (row.needs_review === true) counts.flagged++
      // Multi-day run (planDateOnlyRuns): the head spans the whole run and
      // stays published; every other day is still upserted under its own
      // UID, but held for review. A manual_overrides.status pin still wins
      // (upsertEventSafe strips pinned fields).
      const runRole = runPlan.get(String(ev.UID ?? ''))
      if (runRole?.role === 'head') {
        const endAt = easternToIso(ymdDash(runRole.lastYmd), '11:59 pm')
        if (endAt) { row.end_at = endAt; counts.ranged++ }
      } else if (runRole?.role === 'member') {
        row.status = 'pending_review'
        counts.held++
      }
      if (adoptExistingSourceId(row, existingByKey)) counts.adopted++

      // LOCATION wins; otherwise only the Administration Building
      // description match supplies a venue (see venueFromDescription).
      const locName = (ev.LOCATION || '').trim()
      const venueInfo = locName
        ? { name: locName, city: 'Akron', state: 'OH' }
        : venueFromDescription(ev)
      if (venueInfo) counts.venueLinks++
      if (dryRun) { counts.inserted++; continue }

      let venueId = null
      if (venueInfo) {
        if (venueCache.has(venueInfo.name)) {
          venueId = venueCache.get(venueInfo.name)
        } else {
          const { name, ...details } = venueInfo
          venueId = await writers.ensureVenue(name, details)
          venueCache.set(name, venueId)
        }
      }

      const enrichedRow = await writers.enrichWithImageDimensions(row)
      const { data: upserted, error } = await writers.upsertEventSafe(enrichedRow)
      if (error) { console.warn(`  ⚠ Upsert failed: ${error.message}`); counts.skipped++; continue }

      if (venueId)        await writers.linkEventVenue(upserted.id, venueId)
      if (organizationId) await writers.linkEventOrganization(upserted.id, organizationId)
      counts.inserted++
    } catch (err) {
      console.warn(`  ⚠ Error processing "${ev.SUMMARY}":`, err.message)
      counts.skipped++
    }
  }
  return counts
}

async function main() {
  console.log(`🚀  Starting Akron Public Schools scrape…${DRY_RUN ? ' (DRY RUN — no writes)' : ''}`)
  const start = Date.now()

  try {
    const feedUrls = resolveFeedUrls()

    // Fetch and merge every configured feed before filtering.
    const allEvents = []
    for (const url of feedUrls) {
      const icsText = await fetchIcsFeed(url)
      const events  = parseIcs(icsText)
      console.log(`  Parsed ${events.length} VEVENTs from ${url}`)
      allEvents.push(...events)
    }

    // Last resort: if the resolved feeds together produced no VEVENTs at all,
    // try discovering a feed URL from the calendar page and fetch it too.
    if (allEvents.length === 0) {
      console.log('  🔎  0 VEVENTs from resolved feeds — discovering ICS feed from district calendar page…')
      const discovered = await discoverIcsFeed(CALENDAR_PAGE)
      if (discovered && !feedUrls.includes(discovered)) {
        console.log(`  ✓ Discovered feed: ${discovered}`)
        const icsText = await fetchIcsFeed(discovered)
        const events  = parseIcs(icsText)
        console.log(`  Parsed ${events.length} VEVENTs from ${discovered}`)
        allEvents.push(...events)
      }
      if (allEvents.length === 0) {
        throw new Error(
          'No VEVENTs from resolved feeds and discovery found nothing new on the APS calendar page. ' +
          'Visit the district calendar in a browser, find the "Subscribe" or RSS/iCal link, ' +
          'and set AKRON_PUBLIC_SCHOOLS_ICS_URL in .env.'
        )
      }
    }

    const filtered = allEvents.filter(isPublicFacing)
    console.log(`  Filtered to ${filtered.length} public-facing events (dropped ${allEvents.length - filtered.length})`)
    const { events: publicEvents, dropped: twinsDropped } = collapseDateOnlyTwins(filtered)
    console.log(`  Collapsed ${twinsDropped} date-only twins of timed events`)
    const runPlan = planDateOnlyRuns(publicEvents)

    if (publicEvents.length === 0) {
      if (DRY_RUN) { console.log('  [dry-run] 0 public-facing events; would log an error run'); process.exit(0) }
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: 'error',
        errorMessage: 'Feed parsed but contained 0 public-facing events after filter',
        durationMs: Date.now() - start,
        eventsFound: allEvents.length,
      })
      process.exit(0)
    }

    const organizationId = DRY_RUN ? null : await ensureOrganization('Akron Public Schools', {
      website:     'https://www.akronschools.com',
      description: 'Akron Public Schools is the public school district serving Akron, Ohio.',
    })

    const existing = await loadExistingByKey()
    console.log(`  Loaded ${existing.map.size} existing upcoming ${SOURCE_KEY} keys for UID adoption (${existing.ambiguous} ambiguous)`)

    console.log(`\n📥  Processing ${publicEvents.length} events…`)
    const { inserted, skipped, retimed, adopted, venueLinks, flagged, ranged, held } = await processEvents(publicEvents, {
      dryRun: DRY_RUN, existingByKey: existing.map, organizationId, runPlan,
    })
    const summary = `adopted ${adopted}, venue links ${venueLinks}, needs_review ${flagged}, ambiguous keys ${existing.ambiguous}`

    if (DRY_RUN) {
      console.log(`\n[dry-run] ${inserted} rows would upsert, ${skipped} skipped`)
      console.log(`[dry-run] would adopt ${adopted}, would link venue ${venueLinks}, would flag needs_review ${flagged}, ambiguous keys ${existing.ambiguous}`)
      console.log(`[dry-run] would range ${ranged} heads, hold ${held} run members pending_review`)
      if (existing.readFailed) console.log(`[dry-run] would log errorMessage "degraded: existing-row read failed …"`)
      return
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: allEvents.length,
      durationMs:  Date.now() - start,
      // Degraded-but-working run (ics.js convention): status stays 'success',
      // error_message carries the 'degraded:' marker the health checks grep for.
      ...(existing.readFailed
        ? { errorMessage: `degraded: existing-row read failed, UID adoption disabled: ${existing.readError}` }
        : {}),
    })
    console.log(`  Re-issued UIDs: ${summary}`)
    console.log(`  Date-only twins dropped: ${twinsDropped}; date-only rows re-timed from description: ${retimed}`)
    console.log(`  Multi-day runs: ranged ${ranged} heads, held ${held} run members pending_review`)
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    if (DRY_RUN) { console.error('  [dry-run] failed:', err.message); process.exit(1) }
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly (`node scripts/scrape-akron-public-schools.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
