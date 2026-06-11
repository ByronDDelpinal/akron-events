/**
 * scrape-visit-akron-cvb.js
 *
 * Ingests events from Visit Akron / Summit County (the regional CVB) via
 * their Simpleview REST API.
 *
 * Endpoint:  /includes/rest_v2/plugins_events_events_by_date/find/
 * Auth:      a long-lived public token from /plugins/core/get_simple_token/
 *            — same token the browser app uses.
 * Query:     MongoDB-style filter ($and / $in / $date / $gte / $lte) wrapped
 *            in {filter, options, sort, fields}.
 *
 * API quirks worth knowing:
 *   • `date_range.start` and `date_range.end` MUST be at 00:00 in the
 *     client timezone — the API rejects anything else with HTTP 500.
 *     For an Akron-based scraper that means 04:00 UTC during EDT or
 *     05:00 UTC during EST.  We compute the right offset per call.
 *   • Response shape is double-nested: `{ docs: { count, docs: [...] } }`.
 *   • One row per event-occurrence-in-window: a recurring event surfaces
 *     once with `date` set to the next occurrence inside the queried range.
 *     `recid` is stable across runs so we use it as source_id.
 *   • Same Simpleview install also fronts the John S. Knight Center —
 *     JSK events surface in this feed automatically.
 *
 * Geographic scope: we keep every city returned (the CVB is Summit-County
 * scoped already).  Client-side source filtering handles "Akron only" UX.
 *
 * Usage:
 *   node scripts/scrape-visit-akron-cvb.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  htmlToText,
  inferCategory,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
} from './lib/normalize.js'

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_KEY    = 'visit_akron_cvb'
const BASE_URL      = 'https://www.visitakron-summit.org'
const TOKEN_PATH    = '/plugins/core/get_simple_token/'
const EVENTS_PATH   = '/includes/rest_v2/plugins_events_events_by_date/find/'

const DAYS_AHEAD    = 180
const PAGE_SIZE     = 200
const MAX_PAGES     = 20      // hard ceiling — sanity guard against runaway pagination
const PAGE_DELAY_MS = 300     // be nice to the CVB

// ── Eastern-midnight ISO helper ────────────────────────────────────────────
//
// The Simpleview events_by_date endpoint validates that date_range bounds
// fall on 00:00 in the requester's local timezone.  We pick the right
// UTC offset based on whether the date falls in Eastern Daylight Time
// (UTC-4, March → November) or Eastern Standard Time (UTC-5).  The DST
// boundary check mirrors the one in lib/normalize.js#isEasternDST.

function nthWeekdayOfMonth(year, month, dayOfWeek, n) {
  const first  = new Date(Date.UTC(year, month, 1))
  const offset = (dayOfWeek - first.getUTCDay() + 7) % 7
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7))
}

function isEDT(date) {
  const y = date.getUTCFullYear()
  const dstStart = nthWeekdayOfMonth(y, 2,  0, 2)  // 2nd Sunday in March
  const dstEnd   = nthWeekdayOfMonth(y, 10, 0, 1)  // 1st Sunday in November
  return date >= dstStart && date < dstEnd
}

/**
 * Return an ISO timestamp that represents 00:00 ET on the *calendar date*
 * of `local`.  Example: midnight ET on 2026-06-15 (EDT) → "2026-06-15T04:00:00.000Z".
 */
function easternMidnightUtcIso(local) {
  const probe = new Date(Date.UTC(
    local.getFullYear(), local.getMonth(), local.getDate(), 12, 0, 0
  ))
  const offsetHrs = isEDT(probe) ? 4 : 5
  const pad = n => String(n).padStart(2, '0')
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}T${pad(offsetHrs)}:00:00.000Z`
}

// ── HTTP ───────────────────────────────────────────────────────────────────

async function fetchToken() {
  const res = await fetch(BASE_URL + TOKEN_PATH, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AkronEventsBot/1.0)' },
  })
  if (!res.ok) throw new Error(`Token fetch failed: HTTP ${res.status}`)
  const token = (await res.text()).trim()
  if (!token || token.length < 16) throw new Error(`Token response unexpected: "${token.slice(0, 40)}"`)
  return token
}

/**
 * Fetch a single page of events from the Simpleview rest_v2 endpoint.
 * Returns `{ count, docs }`.
 */
async function fetchEventsPage(token, startIso, endIso, skip) {
  const query = {
    filter: {
      active: true,
      date_range: {
        start: { '$date': startIso },
        end:   { '$date': endIso },
      },
    },
    options: {
      limit:    PAGE_SIZE,
      skip,
      count:    true,
      castDocs: false,
      sort:     { date: 1, rank: 1, title_sort: 1 },
      fields:   {
        _id: 1, recid: 1, cms_title: 1, title: 1,
        date: 1, startDate: 1, endDate: 1, nextDate: 1,
        startTime: 1, endTime: 1, recurrence: 1,
        location: 1, address1: 1, city: 1, region: 1, postalCode: 1,
        loc: 1, latitude: 1, longitude: 1,
        linkUrl: 1, hostname: 1, admission: 1,
        description: 1, categories: 1, filter_tags: 1,
        media_raw: 1, accountId: 1,
      },
    },
  }
  const url = BASE_URL + EVENTS_PATH + '?json=' + encodeURIComponent(JSON.stringify(query)) + '&token=' + encodeURIComponent(token)
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronEventsBot/1.0)',
      'Accept':     'application/json',
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Events fetch failed: HTTP ${res.status} ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  if (!data || !data.docs) throw new Error(`Unexpected response shape: top-level keys=${Object.keys(data || {}).join(',')}`)
  return data.docs
}

async function fetchAllEvents() {
  const token   = await fetchToken()
  const today   = new Date();              today.setHours(0, 0, 0, 0)
  const horizon = new Date(today);         horizon.setDate(horizon.getDate() + DAYS_AHEAD)
  const startIso = easternMidnightUtcIso(today)
  const endIso   = easternMidnightUtcIso(horizon)

  console.log(`\n🔍  Querying Visit Akron CVB for events ${today.toISOString().slice(0,10)} → ${horizon.toISOString().slice(0,10)}…`)

  const all = []
  let skip = 0
  let reportedCount = null

  for (let page = 0; page < MAX_PAGES; page++) {
    const { count, docs } = await fetchEventsPage(token, startIso, endIso, skip)
    if (reportedCount === null) reportedCount = count

    if (!docs || docs.length === 0) break
    all.push(...docs)
    console.log(`  Page ${page + 1}: ${docs.length} events (total: ${all.length} of ${reportedCount})`)

    if (docs.length < PAGE_SIZE) break
    skip += PAGE_SIZE
    if (page + 1 < MAX_PAGES) await new Promise(r => setTimeout(r, PAGE_DELAY_MS))
  }

  if (reportedCount != null && all.length < reportedCount) {
    console.warn(`  ⚠ Pagination short by ${reportedCount - all.length} of ${reportedCount}; consider raising MAX_PAGES.`)
  }
  return all
}

// ── Field mapping ──────────────────────────────────────────────────────────

const CATEGORY_OVERRIDES = {
  // Simpleview top-level catNames → v2 slugs.
  // We prefer text-based inferCategory(); these are fallbacks when nothing
  // matches the title. 'family' is an audience, not content — it feeds the
  // is_family facet (pickIsFamily) instead of a category.
  'eat':            'food',
  'drink':          'food',
  'annual events':  'festival',      // CVB's bucket for recurring signature events
  'to do':          null,            // too generic — defer to text inference
  'stay':           null,            // hotel packages, not really events
  'arts & culture': 'visual-art',
  'music':          'music',
  'family':         null,
  'outdoors':       'outdoors',
  'sports':         'sports',
}

/** is_family facet from Simpleview catNames; undefined (not false) when absent. */
function pickIsFamily(doc) {
  return (doc.categories || []).some((c) => /family/i.test(c.catName || '')) || undefined
}

function pickCategory(doc) {
  const text = (doc.description || '')
  const fromText = inferCategory(doc.cms_title || doc.title || '', text)
  if (fromText !== 'other') return fromText
  for (const cat of doc.categories || []) {
    const mapped = CATEGORY_OVERRIDES[(cat.catName || '').toLowerCase().trim()]
    if (mapped) return mapped
  }
  return 'other'
}

function buildTags(doc) {
  const tags = []
  for (const cat of doc.categories || []) {
    const name = (cat.catName || '').toLowerCase().trim()
    if (name && name.length < 30) tags.push(name)
  }
  for (const t of doc.filter_tags || []) {
    if (typeof t === 'string' && t.length < 30) tags.push(t.toLowerCase())
  }
  tags.push('visit-akron')
  return [...new Set(tags)]
}

function parseAdmission(admission) {
  if (!admission) return { price_min: null, price_max: null }
  const s = String(admission).trim().toLowerCase()
  if (/^free\b/.test(s) || s === '0' || s === '$0') return { price_min: 0, price_max: 0 }
  const nums = s.match(/\d+(?:\.\d+)?/g)?.map(Number).filter(n => !isNaN(n))
  if (!nums?.length) return { price_min: null, price_max: null }
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  return { price_min: min, price_max: max > min ? max : null }
}

/**
 * Resolve a Simpleview date field to its **Eastern calendar date** (yyyy-mm-dd).
 *
 * The rest_v2 feed mixes two timestamp conventions for the same calendar day
 * (verified live against recid 1231 on 2026-06-11):
 *
 *   • `startDate`              — midnight ET at the START of the day:
 *                                 "2026-06-20T04:00:00.000Z"  (= Jun 20 00:00 EDT)
 *   • `date`/`nextDate`/`endDate` — one second before midnight at the END of
 *                                 the day: "2026-06-21T03:59:59.000Z"
 *                                 (= Jun 20 23:59:59 EDT — still June 20!)
 *
 * A naive `iso.slice(0, 10)` on the end-of-day shape reads the *UTC* date and
 * lands one calendar day late — that bug shifted every visit_akron_cvb event
 * +1 day. Converting the instant to Eastern time first yields the correct
 * calendar date for BOTH shapes, in both EDT and EST.
 */
function etCalendarDate(iso) {
  if (!iso || typeof iso !== 'string') return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  const offsetHrs = isEDT(d) ? 4 : 5
  return new Date(d.getTime() - offsetHrs * 3600_000).toISOString().slice(0, 10)
}

/**
 * Combine the event occurrence's Eastern calendar date (see etCalendarDate)
 * with `doc.startTime`/`doc.endTime` (local HH:MM:SS) into proper UTC ISO
 * timestamps for storage.
 */
function buildStartEnd(doc) {
  const occurrenceIso = doc.date || doc.nextDate || doc.startDate
  const datePart = etCalendarDate(occurrenceIso)
  if (!datePart) return { start_at: null, end_at: null }

  const startTime = /^\d{2}:\d{2}:\d{2}$/.test(doc.startTime || '') ? doc.startTime : '09:00:00'
  const endTime   = /^\d{2}:\d{2}:\d{2}$/.test(doc.endTime   || '') ? doc.endTime   : null

  const start_at = easternLocalToUtcIso(`${datePart} ${startTime}`)
  const end_at   = endTime
    ? easternLocalToUtcIso(`${useEndDatePart(doc, datePart)} ${endTime}`)
    : null
  return { start_at, end_at }
}

/**
 * Multi-day events have `endDate` set; use that as the end-side date so the
 * stored end_at reflects the final day's endTime rather than wrapping back.
 * `endDate` uses the end-of-day timestamp shape, so it goes through
 * etCalendarDate like everything else.
 */
function useEndDatePart(doc, fallbackDate) {
  return etCalendarDate(doc.endDate) || fallbackDate
}

/**
 * Convert "YYYY-MM-DD HH:MM:SS" interpreted as Eastern local time to
 * a UTC ISO string. Local copy of easternToIso so this file is self-contained
 * for the Simpleview-specific code path.
 */
function easternLocalToUtcIso(localStr) {
  const [datePart, timePart = '00:00:00'] = localStr.split(' ')
  const [yr, mo, dy] = datePart.split('-').map(Number)
  const [hr, mn, sc] = timePart.split(':').map(Number)
  if (!yr || !mo || !dy) return null
  const localUtcMs = Date.UTC(yr, mo - 1, dy, hr, mn, sc || 0)
  const probe = new Date(localUtcMs + 5 * 3600_000)
  const offsetHrs = isEDT(probe) ? 4 : 5
  return new Date(localUtcMs + offsetHrs * 3600_000).toISOString()
}

function bestImage(media) {
  if (!Array.isArray(media) || !media.length) return null
  // Prefer image mediatype, then lowest sortorder
  const sorted = media
    .filter(m => m && m.mediaurl)
    .sort((a, b) => {
      const aIsImg = (a.mediatype || '').toLowerCase() === 'image'
      const bIsImg = (b.mediatype || '').toLowerCase() === 'image'
      if (aIsImg !== bIsImg) return aIsImg ? -1 : 1
      return (a.sortorder ?? 999) - (b.sortorder ?? 999)
    })
  return sorted[0]?.mediaurl ?? null
}

// ── Venue / Organizer ──────────────────────────────────────────────────────

const venueCache = new Map()

async function ensureEventVenue(doc) {
  const name = (doc.location || '').trim()
  if (!name) return null
  const cacheKey = `${name}|${(doc.city || '').trim()}`
  if (venueCache.has(cacheKey)) return venueCache.get(cacheKey)

  // GeoJSON coordinates are [lng, lat]; latitude/longitude are also returned
  // as separate strings on the doc — fall back to those if loc is missing.
  let lat = null, lng = null
  if (doc.loc?.coordinates?.length === 2) {
    [lng, lat] = doc.loc.coordinates
  } else if (doc.latitude && doc.longitude) {
    lat = parseFloat(doc.latitude) || null
    lng = parseFloat(doc.longitude) || null
  }

  // doc.hostname in Simpleview's payload is the partner-listing's
  // *name* (e.g. "Bath Business Association"), NOT a URL hostname,
  // despite the field name. Past versions of this scraper trusted
  // it as a domain and wrote rows like website="https://All Forward"
  // into the venues table. Only honor doc.hostname when it actually
  // looks like a hostname (has a dot, no whitespace, valid label
  // characters), otherwise leave website unset.
  const candidateWebsite = typeof doc.hostname === 'string'
    ? doc.hostname.replace(/^https?:\/\//, '').trim()
    : ''
  const isRealHostname = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(candidateWebsite)
  const website = isRealHostname ? `https://${candidateWebsite}` : undefined

  const venueId = await ensureVenue(name, {
    address: doc.address1 || undefined,
    city:    doc.city     || undefined,
    state:   doc.region   || 'OH',
    zip:     doc.postalCode || undefined,
    lat:     typeof lat === 'number' ? lat : null,
    lng:     typeof lng === 'number' ? lng : null,
    website,
  })
  venueCache.set(cacheKey, venueId)
  return venueId
}

async function ensureCvbOrganization() {
  return ensureOrganization('Visit Akron / Summit County', {
    website:     'https://www.visitakron-summit.org',
    description: 'The destination marketing organization for Akron and Summit County, Ohio. Aggregates events from partner venues, hotels, and attractions across the region.',
  })
}

// ── Title normalization ────────────────────────────────────────────────────

/**
 * Clean up CVB titles before insert.
 *
 *   1. Strip the trailing " (NNN)" recid suffix that Simpleview's CMS
 *      bakes into cms_title — pure noise for end users.
 *   2. De-shout titles that arrive in ALL CAPS. The CVB feed mixes
 *      cased and shouted titles inconsistently ("ART AND JEWELRY
 *      FUSION EXPERIENCE" vs. "Roast Battle Cleveland"); we Title-Case
 *      the screamers and leave normal titles alone so we never
 *      down-case a legitimate proper-noun title.
 *
 * Heuristic: a title is "shouted" if at least 6 of its letters are
 * uppercase and ALL letters are uppercase. Single short tokens like
 * "EJ" or "OH" don't trip the threshold.
 */
function normalizeCvbTitle(raw) {
  if (!raw) return ''
  let t = raw.trim().replace(/\s+/g, ' ')
  // Drop the recid suffix: "Art Show (263)" → "Art Show".
  t = t.replace(/\s*\(\d+\)\s*$/, '').trim()
  // De-shout: only if EVERY letter is uppercase and we have enough
  // letters to be confident. Preserves acronyms like "BBQ" inside an
  // otherwise mixed-case title.
  const letters = t.replace(/[^A-Za-z]/g, '')
  if (letters.length >= 6 && letters === letters.toUpperCase()) {
    t = t.toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase())
  }
  return t
}

// ── Process ────────────────────────────────────────────────────────────────

async function processEvents(docs, orgId) {
  let inserted = 0, skipped = 0

  for (const doc of docs) {
    try {
      const title = normalizeCvbTitle(doc.cms_title || doc.title || '')
      if (!title || title.length < 3) { skipped++; continue }

      const { start_at, end_at } = buildStartEnd(doc)
      if (!start_at) { skipped++; continue }

      // Filter out occurrences that have already passed.  We compare against
      // end_at if set (multi-day events stay surfaced through their last day),
      // otherwise start_at + 24h grace so same-day events stay visible.
      const endMs   = end_at ? new Date(end_at).getTime() : new Date(start_at).getTime() + 86_400_000
      if (endMs < Date.now()) { skipped++; continue }

      const { price_min, price_max } = parseAdmission(doc.admission)
      const description = doc.description ? htmlToText(doc.description) : null

      const sourceId = doc.recid ? String(doc.recid) : (doc._id ? String(doc._id) : null)
      if (!sourceId) { skipped++; continue }

      // CVB detail page lives at /event/{slug}/{recid}/. The slug is a
      // lowercased, hyphenated form of the title — but the server
      // redirects on any slug as long as the recid is correct, so the
      // exact slug only matters for prettier URLs in the address bar.
      const titleSlug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      const detailUrl = `${BASE_URL}/event/${titleSlug || 'event'}/${sourceId}/`

      const row = {
        title,
        description,
        start_at,
        end_at,
        category:        pickCategory(doc),
        is_family:       pickIsFamily(doc),
        tags:            buildTags(doc),
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       bestImage(doc.media_raw),
        // Direct ticketing/registration link advertised by the source.
        // Many CVB listings omit this; the source_url fallback below
        // guarantees the event page always has at least one outbound
        // CTA so users can finish the action they came for.
        ticket_url:      doc.linkUrl || null,
        source_url:      detailUrl,
        source:          SOURCE_KEY,
        source_id:       sourceId,
        status:          'published',
        featured:        false,
      }

      const venueId    = await ensureEventVenue(doc)
      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${title}":`, error.message)
        skipped++
      } else {
        if (venueId) await linkEventVenue(upserted.id, venueId)
        if (orgId)   await linkEventOrganization(upserted.id, orgId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${doc.cms_title ?? doc.title ?? '(no title)'}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Visit Akron / Summit County CVB ingestion…')
  const start = Date.now()

  try {
    const orgId = await ensureCvbOrganization()
    const docs  = await fetchAllEvents()
    console.log(`\n📥  Processing ${docs.length} events…`)

    const { inserted, skipped } = await processEvents(docs, orgId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: docs.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Pure parsers exported for unit tests (scripts/tests/test-visit-akron-cvb.js).
export {
  etCalendarDate,
  buildStartEnd,
  useEndDatePart,
  easternLocalToUtcIso,
  easternMidnightUtcIso,
  normalizeCvbTitle,
  parseAdmission,
  isEDT,
}

// Run only when invoked directly (`node scripts/scrape-visit-akron-cvb.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
