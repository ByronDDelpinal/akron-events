/**
 * scrape-eventbrite.js
 *
 * Fetches Akron-area events from Eventbrite.
 *
 * Background: Eventbrite deprecated the public /v3/events/search/ API in 2020.
 * Their search pages embed event data in server-side window variables:
 *   • window.__SERVER_DATA__      — page metadata + initial results
 *   • window.__REACT_QUERY_STATE__ — React Query cache with full search results
 *
 * Strategy (tried in order):
 *   1. Fetch the search page HTML and extract window.__REACT_QUERY_STATE__
 *      (React Query's dehydrated cache — contains the raw API search results).
 *   2. Fall back to window.__SERVER_DATA__ if the query state has no events.
 *   3. Fall back to calling the internal /api/v3/destination/search/ as POST.
 *   4. Fall back to JSON-LD structured data on the page.
 *   5. If everything returns 0 events, exit gracefully (exit 0) so scrape:all
 *      continues to the next scraper.
 *
 * Anti-blocking:
 *   • Rotating realistic User-Agent strings
 *   • Full browser-like request headers on every call
 *   • 2–5 second randomised delay between pages
 *   • 12-hour cooldown guard (don't re-run if a successful run is recent)
 *   • Conservative MAX_PAGES cap
 *
 * Usage:
 *   node scripts/scrape-eventbrite.js
 *   node scripts/scrape-eventbrite.js --debug       # verbose JSON inspection
 *   node scripts/scrape-eventbrite.js --no-details  # skip the detail-fetch pass
 *   node scripts/scrape-eventbrite.js --force       # bypass 12h cooldown
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { preloadSummitCountyBoundary, classifySummitLocation } from './lib/summit-county.js'
import {
  EVENTBRITE_CATEGORY_MAP,
  categoryFromEventbriteNames,
  easternToIso,
  inferCategory,
  parseEventbritePrice,
  logUpsertResult,
  logScraperError,
  stripHtml,
  htmlToText,
  decodeEntities,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
} from './lib/normalize.js'
import { isSelfCredit } from './lib/source-tiers.js'

const DEBUG      = process.argv.includes('--debug')
const FORCE      = process.argv.includes('--force')
const NO_DETAILS = process.argv.includes('--no-details')

// ── Constants ────────────────────────────────────────────────────────────────

// All Eventbrite feed URLs to scrape. The general /events/ feed is first and
// doubles as the session bootstrap URL. The category-specific feeds surface
// community events that Eventbrite's ranking algorithm buries in the general
// feed — each has its own page-1 HTML pass; pages 2+ fall back to the POST API.
const SEARCH_PAGES = [
  'https://www.eventbrite.com/d/oh--akron/events/',
  'https://www.eventbrite.com/d/oh--akron/food-and-drink/',
  'https://www.eventbrite.com/d/oh--akron/music/',
  'https://www.eventbrite.com/d/oh--akron/community/',
  'https://www.eventbrite.com/d/oh--akron/family-entertainment/',
]
const SEARCH_PAGE    = SEARCH_PAGES[0]   // session bootstrap + Referer header
const INTERNAL_API   = 'https://www.eventbrite.com/api/v3/destination/search/'

const MAX_PAGES      = 15     // ~20 events/page → up to 300 events
const MIN_DELAY_MS   = 2000
const MAX_DELAY_MS   = 5000
const COOLDOWN_HOURS = 12

// Detail-fetch pass — individual event pages for full descriptions
const DETAIL_BATCH_SIZE    = 3     // concurrent fetches per batch
const DETAIL_MIN_MS        = 1500  // jitter between batches
const DETAIL_MAX_MS        = 3000
const DETAIL_TIMEOUT_MS    = 12000 // per-request timeout

const AKRON_LAT = 41.0814
const AKRON_LNG = -81.5190

// ── User-Agent pool ──────────────────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
]
function randomUA()      { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)] }
function jitter()        { return new Promise(r => setTimeout(r, MIN_DELAY_MS    + Math.random() * (MAX_DELAY_MS    - MIN_DELAY_MS))) }
function detailJitter()  { return new Promise(r => setTimeout(r, DETAIL_MIN_MS   + Math.random() * (DETAIL_MAX_MS   - DETAIL_MIN_MS))) }

/**
 * Pick the highest-resolution image URL from an Eventbrite image object.
 *
 * Eventbrite's API returns image-shaped objects like:
 *   { url: 'https://img.evbuc.com/...?w=400&h=200', original: { url: 'https://cdn.evbuc.com/...' } }
 *
 * `.url` is a pre-resized listing-page thumbnail optimized for their grid
 * (typically 400×200). `.original.url` is the full-resolution source.
 * Always prefer original. Accepts a string URL too, for JSON-LD payloads.
 */
function pickBestImageUrl(img) {
  if (!img) return null
  if (typeof img === 'string') return img
  return img.original?.url ?? img.url ?? null
}

// ── Sentinel errors ──────────────────────────────────────────────────────────
class BlockedError extends Error {
  constructor(msg) { super(msg); this.name = 'BlockedError' }
}

// ── Request headers ──────────────────────────────────────────────────────────
function htmlHeaders(referer = null) {
  return {
    'User-Agent':                randomUA(),
    'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language':           'en-US,en;q=0.9',
    'Accept-Encoding':           'gzip, deflate, br',
    'Cache-Control':             'no-cache',
    'Pragma':                    'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest':            'document',
    'Sec-Fetch-Mode':            'navigate',
    'Sec-Fetch-Site':            referer ? 'same-origin' : 'none',
    ...(referer ? { 'Referer': referer } : {}),
  }
}

function apiHeaders(cookie, csrfToken, referer) {
  return {
    'User-Agent':       randomUA(),
    'Accept':           'application/json, text/plain, */*',
    'Accept-Language':  'en-US,en;q=0.9',
    'Content-Type':     'application/json',
    'Referer':          referer,
    'Origin':           'https://www.eventbrite.com',
    'x-eb-accept':      'application/json',
    'x-requested-with': 'XMLHttpRequest',
    ...(cookie     ? { 'Cookie':      cookie     } : {}),
    ...(csrfToken  ? { 'x-csrftoken': csrfToken  } : {}),
  }
}

// ── Session management ───────────────────────────────────────────────────────
let _session = null   // { cookie, csrfToken, html }

async function getSession() {
  if (_session) return _session

  console.log('  Fetching session cookies from Eventbrite…')
  const res = await fetch(SEARCH_PAGE, { headers: htmlHeaders(), redirect: 'follow' })

  if (!res.ok) throw new BlockedError(`Session page returned HTTP ${res.status}`)

  const html = await res.text()

  // Cloudflare detection
  if (html.includes('cf-browser-verification') || html.includes('cf_clearance') ||
      (html.includes('Just a moment') && html.includes('cloudflare'))) {
    throw new BlockedError('Cloudflare challenge detected')
  }

  const rawCookies = res.headers.getSetCookie?.() ?? []
  const cookie     = rawCookies.map(c => c.split(';')[0]).filter(Boolean).join('; ')
  const csrfMatch  = cookie.match(/csrftoken=([^;]+)/)
  const csrfToken  = csrfMatch?.[1] ?? null

  if (DEBUG) {
    console.log('  [debug] session cookie:', cookie)
    console.log('  [debug] csrfToken:', csrfToken)
    console.log('  [debug] HTML length:', html.length)
  }

  _session = { cookie, csrfToken, html }
  return _session
}

// ── Balanced-brace JSON extractor ────────────────────────────────────────────
/**
 * Extract a window.VAR_NAME assignment from HTML.
 *
 * Regex-based extraction fails on large JSON blobs because non-greedy matching
 * stops at the first closing brace. This parser tracks nesting depth and
 * handles quoted strings/escapes correctly, so it always finds the real end.
 */
function extractWindowVar(html, varName) {
  const needle = `window.${varName} =`
  const idx = html.indexOf(needle)
  if (idx === -1) return null

  // Advance to the first { or [
  let start = idx + needle.length
  while (start < html.length && /\s/.test(html[start])) start++

  const opener = html[start]
  if (opener !== '{' && opener !== '[') return null
  const closer = opener === '{' ? '}' : ']'

  // Walk character by character tracking string/escape/nesting state
  let depth    = 0
  let inString = false
  let escape   = false

  for (let i = start; i < html.length; i++) {
    const ch = html[i]

    if (escape)                    { escape = false; continue }
    if (ch === '\\' && inString)   { escape = true;  continue }
    if (ch === '"')                { inString = !inString; continue }
    if (inString)                  { continue }

    if      (ch === opener) depth++
    else if (ch === closer) {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1))
        } catch (e) {
          if (DEBUG) console.log(`  [debug] JSON.parse failed for ${varName}:`, e.message.slice(0, 120))
          return null
        }
      }
    }
  }

  return null
}

// ── Next.js data extractor ────────────────────────────────────────────────────
/**
 * Next.js embeds its server data as a JSON script tag, NOT a window assignment:
 *   <script id="__NEXT_DATA__" type="application/json">{...}</script>
 * extractWindowVar() won't find it — this handles that format.
 */
function extractNextData(html) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/)
  if (!match) return null
  try { return JSON.parse(match[1]) } catch { return null }
}

// ── React Query state extractor ──────────────────────────────────────────────
/**
 * React Query's dehydrated state contains a `queries` array where each entry
 * has a `queryKey` and `state.data`. We walk them looking for any that contain
 * Eventbrite event objects.
 */
function extractFromReactQueryState(rqState) {
  if (!rqState?.queries || !Array.isArray(rqState.queries)) return []

  for (const query of rqState.queries) {
    const data = query?.state?.data
    if (!data) continue

    const events = extractEventsFromData(data)
    if (events.length > 0) {
      if (DEBUG) console.log(`  [debug] Found events in React Query key:`, JSON.stringify(query.queryKey).slice(0, 120))
      return events
    }
  }
  return []
}

// ── Generic event-array finder ────────────────────────────────────────────────
/**
 * Extract events from any data shape Eventbrite might use.
 *
 * Eventbrite's __SERVER_DATA__ organises results into "buckets" (sections like
 * "Events this weekend", "Music events", etc.). Each bucket has its own
 * events.results array. We aggregate across ALL buckets and deduplicate.
 *
 * __SERVER_DATA__ also embeds a `reactQueryData` field that is the React Query
 * initial hydration payload — check that too.
 */
function extractEventsFromData(data) {
  if (!data) return []

  // ── Eventbrite browse-page bucket structure ──────────────────────────────
  // data.buckets = [ { bucket_type, events: { results: [...] } }, ... ]
  if (Array.isArray(data.buckets) && data.buckets.length > 0) {
    const seen = new Set()
    const all  = []
    for (const bucket of data.buckets) {
      const results =
        bucket?.events?.results ??
        bucket?.results ??
        (Array.isArray(bucket?.events) ? bucket.events : [])
      for (const ev of results) {
        if (isEventLike(ev) && !seen.has(String(ev.id))) {
          seen.add(String(ev.id))
          all.push(ev)
        }
      }
    }
    if (DEBUG) console.log(`  [debug] buckets: ${data.buckets.length} buckets → ${all.length} unique events`)
    if (all.length > 0) return all
  }

  // ── reactQueryData nested inside __SERVER_DATA__ ─────────────────────────
  if (data.reactQueryData) {
    const rqEvents = extractEventsFromData(data.reactQueryData)
    if (rqEvents.length > 0) return rqEvents
  }

  // ── Known flat structural paths ──────────────────────────────────────────
  const PATHS = [
    ['events', 'results'],
    ['events'],
    ['search_data', 'events', 'results'],
    ['search_data', 'events'],
    ['data', 'events', 'results'],
    ['data', 'events'],
    ['results'],
    // React Query infinite-query shape
    ['pages', 0, 'events', 'results'],
    ['pages', 0, 'events'],
    ['pages', 0, 'results'],
  ]

  for (const path of PATHS) {
    const val = path.reduce((cur, key) => cur?.[key], data)
    if (Array.isArray(val) && val.length > 0 && isEventLike(val[0])) return val
  }

  return recursiveFindEvents(data, 0) ?? []
}

function isEventLike(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false
  const hasId   = typeof obj.id === 'string' || typeof obj.id === 'number'
  const hasName = !!(obj.name || obj.title)
  const hasDate = !!(obj.start || obj.start_date || obj.start_datetime || obj.start_time)
  return hasId && hasName && hasDate
}

function recursiveFindEvents(obj, depth) {
  if (depth > 8 || obj == null || typeof obj !== 'object') return null
  if (Array.isArray(obj)) {
    if (obj.length >= 2 && isEventLike(obj[0])) return obj
    for (const item of obj.slice(0, 50)) {
      const found = recursiveFindEvents(item, depth + 1)
      if (found) return found
    }
  } else {
    for (const key of Object.keys(obj).slice(0, 60)) {
      const found = recursiveFindEvents(obj[key], depth + 1)
      if (found) return found
    }
  }
  return null
}

function extractPageCount(data) {
  if (!data) return 1

  // Look inside each bucket's pagination for the largest page_count
  if (Array.isArray(data.buckets)) {
    let max = 1
    for (const bucket of data.buckets) {
      const pc = bucket?.events?.pagination?.page_count
      if (typeof pc === 'number' && pc > max) max = pc
    }
    if (max > 1) return max
  }

  const PATHS = [
    ['pagination', 'page_count'],
    ['events', 'pagination', 'page_count'],
    ['search_data', 'events', 'pagination', 'page_count'],
    ['search_data', 'pagination', 'page_count'],
  ]
  for (const path of PATHS) {
    const val = path.reduce((c, k) => c?.[k], data)
    if (typeof val === 'number' && val > 0) return val
  }
  try {
    const m = JSON.stringify(data).match(/"page_count"\s*:\s*(\d+)/)
    if (m) return parseInt(m[1], 10)
  } catch {}
  return 1
}

// ── JSON-LD fallback ─────────────────────────────────────────────────────────
/**
 * Convert an Eventbrite datetime string to a UTC ISO string.
 *
 * Eventbrite emits two shapes: with an explicit offset ("2026-06-24T20:00:00-04:00",
 * "...Z") and without ("2026-06-24T20:00:00"). `new Date()` parses the offset-less
 * shape as ENVIRONMENT-local time, which is UTC in CI — that stored 8 PM ET events
 * as 20:00 UTC (4 PM ET). Offset-less Eventbrite times for Akron events are
 * Eastern wall-clock times, so route them through easternToIso().
 */
function eventbriteToUtcIso(dt) {
  if (!dt) return null
  const s = String(dt).trim()
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
    const parsed = new Date(s)
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
  }
  return easternToIso(s)
}

function extractJsonLdEvents(html) {
  const events = []
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1])
      const items = Array.isArray(data) ? data : [data]
      for (const item of items) {
        if (item['@type'] === 'Event' && item.name) {
          events.push({
            id:    item.url?.match(/(\d{10,})/)?.[1] ?? String(Math.random()),
            name:  item.name,
            url:   item.url ?? null,
            start: { utc: eventbriteToUtcIso(item.startDate) },
            end:   { utc: eventbriteToUtcIso(item.endDate) },
            is_free: false,
            logo:  { url: pickBestImageUrl(item.image) },
            venue: item.location ? {
              name:    item.location.name ?? null,
              address: {
                // Do NOT default city/region to Akron/OH. Eventbrite occasionally
                // returns international events with no address (online webinars,
                // foreign events). Falsifying their city as "Akron" causes them
                // to slip past the locality filter in isAkronEvent().
                address_1:   item.location.address?.streetAddress ?? null,
                city:        item.location.address?.addressLocality ?? null,
                region:      item.location.address?.addressRegion ?? null,
                postal_code: item.location.address?.postalCode ?? null,
              },
            } : null,
          })
        }
      }
    } catch {}
  }
  return events
}

// ── Internal POST API ────────────────────────────────────────────────────────
/**
 * Try Eventbrite's internal destination search as a POST request.
 * The 405 from GET confirms this endpoint expects POST.
 * We send search parameters as a JSON body along with the CSRF token.
 */
async function tryInternalPostApi(page, cookie, csrfToken) {
  const body = {
    event_search: {
      dates:               'current_future',
      dedup:               true,
      places:              [{ place_id: 'oh--akron' }],
      page:                page,
      page_size:           20,
      online_events_only:  false,
      tags:                [],
    },
    'expand.destination_profile': true,
  }

  // Also try with lat/lng body shape
  const bodyVariants = [
    body,
    {
      page_size:           20,
      page:                page,
      online_events_only:  false,
      'location.latitude': AKRON_LAT,
      'location.longitude': AKRON_LNG,
      'location.within':   '40km',
    },
  ]

  for (const variant of bodyVariants) {
    if (DEBUG) console.log('  [debug] POST body:', JSON.stringify(variant).slice(0, 200))

    try {
      const res = await fetch(INTERNAL_API, {
        method:  'POST',
        headers: apiHeaders(cookie, csrfToken, SEARCH_PAGE),
        body:    JSON.stringify(variant),
        redirect: 'follow',
      })

      if (DEBUG) console.log(`  [debug] POST status: ${res.status}, content-type: ${res.headers.get('content-type')}`)

      if (!res.ok) {
        if (DEBUG) console.log('  [debug] POST error body:', (await res.text()).slice(0, 300))
        continue
      }

      const ct = res.headers.get('content-type') ?? ''
      if (!ct.includes('json')) continue

      const data = await res.json()
      if (DEBUG) console.log('  [debug] POST response keys:', Object.keys(data))

      const events = extractEventsFromData(data)
      if (events.length > 0) {
        console.log(`    Internal POST API: ${events.length} events`)
        return { events, data }
      }
    } catch (e) {
      if (DEBUG) console.log('  [debug] POST fetch error:', e.message)
    }
  }

  return null
}

// ── HTML page extraction ─────────────────────────────────────────────────────
function extractFromHtml(html, label = '') {
  // Priority 1: React Query dehydrated state (most complete data)
  const rqState = extractWindowVar(html, '__REACT_QUERY_STATE__')
  if (rqState) {
    if (DEBUG) console.log(`  [debug] ${label} __REACT_QUERY_STATE__ keys:`, Object.keys(rqState))
    const events = extractFromReactQueryState(rqState)
    if (events.length > 0) {
      console.log(`    HTML __REACT_QUERY_STATE__: ${events.length} events`)
      return { events, data: rqState }
    }
    if (DEBUG) console.log(`  [debug] ${label} React Query had 0 event-like queries`)
  } else {
    if (DEBUG) console.log(`  [debug] ${label} __REACT_QUERY_STATE__ not found`)
  }

  // Priority 2: Server data blob
  const serverData = extractWindowVar(html, '__SERVER_DATA__')
  if (serverData) {
    if (DEBUG) {
      console.log(`  [debug] ${label} __SERVER_DATA__ keys:`, Object.keys(serverData))
      if (Array.isArray(serverData.buckets)) {
        console.log(`  [debug] ${label} buckets (${serverData.buckets.length}):`,
          serverData.buckets.map(b => `${b.bucket_type ?? b.type ?? '?'}(${b?.events?.results?.length ?? 0})`).join(', '))
      }
    }
    const events = extractEventsFromData(serverData)
    if (events.length > 0) {
      console.log(`    HTML __SERVER_DATA__: ${events.length} events`)
      return { events, data: serverData }
    }
    if (DEBUG) {
      const str = JSON.stringify(serverData)
      const eventIdx = str.indexOf('"events"')
      if (eventIdx !== -1) console.log(`  [debug] __SERVER_DATA__ "events" context:`, str.slice(eventIdx, eventIdx + 300))
    }
  } else {
    if (DEBUG) console.log(`  [debug] ${label} __SERVER_DATA__ not found`)
  }

  // Priority 3: JSON-LD
  const ldEvents = extractJsonLdEvents(html)
  if (ldEvents.length > 0) {
    console.log(`    HTML JSON-LD: ${ldEvents.length} events`)
    return { events: ldEvents, data: null }
  }

  return null
}

// ── Venue / Organizer upsert ─────────────────────────────────────────────────
// Uses shared ensureVenue/ensureOrganization from normalize.js for consistent
// name-based deduplication across all scrapers.

async function upsertVenue(ev) {
  const v = ev.primary_venue ?? ev.venue
  if (!v?.name) return null
  const addr = v.address ?? v.location ?? {}
  return ensureVenue(v.name, {
    address:      addr.address_1 ?? addr.localized_address_display ?? null,
    // No silent 'Akron' default — a fabricated city would let a venue dodge
    // the Summit County gate and corrupts the venue directory.
    city:         addr.city ?? null,
    state:        addr.region ?? 'OH',
    zip:          addr.postal_code ?? null,
    lat:          v.latitude  ? parseFloat(v.latitude)  : null,
    lng:          v.longitude ? parseFloat(v.longitude) : null,
    parking_type: 'unknown',
  })
}

async function upsertOrganizer(ev) {
  const o = ev.primary_organizer ?? ev.organizer
  if (!o?.name) return null
  return ensureOrganization(o.name, {
    website: o.website ?? o.url ?? null,
  })
}

// ── Organizer extraction (detail page) ───────────────────────────────────────
/**
 * Normalise an organizer name/website pair into the shape upsertOrganizer
 * consumes, or null if it isn't usable.
 *
 * Self-credit is rejected HERE, not left to linkEventOrganization's guard.
 * That guard blocks the LINK, but only after ensureOrganization has already
 * minted the row — which would litter the organizations directory with an
 * "Eventbrite" record nothing ever points at. Cheaper and cleaner to never
 * mint it. See AGGREGATOR_SELF_ORG in src/lib/sourceTiers.js for the policy.
 */
export function cleanOrganizer(name, website = null) {
  if (!name || typeof name !== 'string') return null
  const trimmed = decodeEntities(name.trim())
  if (!trimmed) return null
  if (isSelfCredit('eventbrite', trimmed)) return null
  const site = website && typeof website === 'string' ? website.trim() : null
  return { name: trimmed, website: site || null }
}

/**
 * Pull the real organizer off an Eventbrite detail page's HTML.
 *
 * Why this exists: Eventbrite's SEARCH payload almost never carries an
 * organizer (only ~5% of scraped rows had one), so we published EB events with
 * no presenter and the site fell back to a "Listed on Eventbrite" provenance
 * line. The organizer is right there on the detail page — we simply never
 * asked for it. The events API `expand=organizer` in fetchEventDetail is the
 * authoritative path; this is the fallback for when that call fails or is
 * skipped (several detail strategies return before ever reaching it).
 *
 * Shapes are tried in order of trustworthiness: JSON-LD is schema.org-
 * structured and unambiguous, while the *_organizer JSON forms are
 * Eventbrite-internal shapes that have churned over the years. A shape that
 * yields only a self-credit falls through to the next rather than giving up,
 * since a page can name Eventbrite in one blob and the real host in another.
 */
export function extractOrganizer(html) {
  if (!html || typeof html !== 'string') return null

  // 1. JSON-LD (schema.org Event.organizer)
  const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let ldMatch
  while ((ldMatch = ldRe.exec(html)) !== null) {
    try {
      const ld = JSON.parse(ldMatch[1])
      for (const item of Array.isArray(ld) ? ld : [ld]) {
        const org = Array.isArray(item?.organizer) ? item.organizer[0] : item?.organizer
        const got = cleanOrganizer(org?.name, org?.url)
        if (got) return got
      }
    } catch { /* malformed ld+json block — try the next one */ }
  }

  // 2. Eventbrite-internal JSON shapes. Bounded to a single object body
  //    ([^{}]*) so a nested object can't let the "name" key drift to some
  //    unrelated entity further down the payload.
  const forms = [
    /"primary_organizer"\s*:\s*\{[^{}]*?"name"\s*:\s*"([^"]+)"/,
    /"organizer"\s*:\s*\{[^{}]*?"name"\s*:\s*"([^"]+)"/,
    /"organizer_name"\s*:\s*"([^"]+)"/,
  ]
  for (const re of forms) {
    const got = cleanOrganizer(html.match(re)?.[1])
    if (got) return got
  }

  return null
}

// ── Locality filter ──────────────────────────────────────────────────────────
/**
 * Reject events that aren't actually local to the Akron / Summit County area.
 *
 * Background: Eventbrite's Akron place search bleeds in online webinars from
 * around the world (Germany, Italy, UK, Singapore, etc.) because passing
 * `online_events_only: false` does NOT exclude online events — it only means
 * "don't restrict to only online events." Eventbrite then surfaces popular
 * online events globally as filler in the Akron results.
 *
 * We reject on four signals (any one is sufficient):
 *   1. Ticket URL host is not eventbrite.com. Localized TLDs (.de, .it, .at,
 *      .co.uk, .sg, .ca, .fr) are used exclusively for non-US events on
 *      Eventbrite — none of our legit Akron events ever appear on these.
 *   2. The event is explicitly flagged as online-only (no physical venue).
 *   3. There's no venue attached at all, OR the attached venue is outside
 *      Ohio. Online events have no venue; foreign events have foreign venues.
 *   4. The venue is outside Summit County (see isInSummitCounty below).
 *
 * History — why check 4 exists (2026-06-10 incident): this filter used to
 * trust Eventbrite's "oh--akron" place search to do the geographic scoping
 * and only enforced state == OH here. On 2026-06-10 Eventbrite shipped a
 * destination-search redesign that replaced the Akron-bounded result list
 * with distance-ranked results spanning all of Northeast Ohio. One run
 * published 734 out-of-county events (Cleveland, Parma, Youngstown, ...)
 * before the gap was caught. We now do our own county-level gate and never
 * again delegate locality to the source.
 */

// SUMMIT_COUNTY_CITIES now lives in lib/summit-county.js (shared with the
// meetup scraper and any future locality-gated source).

/**
 * County-level locality gate — classifySummitLocation from lib/summit-county
 * is the single source of truth (strict Summit mandate, 2026-07-14):
 *   'in'      → coords in-polygon or city on the Summit allowlist → publish.
 *   'out'     → coords out-of-polygon or city on the non-Summit blocklist →
 *               reject; never trust the feed's own scoping (2026-06-10).
 *   'unknown' → neither signal usable → keep, but ingest as pending_review
 *               so a real Summit event with sloppy geo lands in the admin
 *               queue rather than silently vanishing — and never publishes
 *               unreviewed.
 *
 * Requires preloadSummitCountyBoundary() to have been awaited at startup.
 */
function classifyEventLocality(venue, addr) {
  return classifySummitLocation({ lat: venue.latitude, lng: venue.longitude, city: addr.city })
}
function isAkronEvent(ev) {
  // 1. Ticket URL must be on eventbrite.com (not .de/.it/.at/.co.uk/.sg/.ca/.fr)
  const url = ev.url ?? ev.ticket_url ?? ''
  if (url) {
    let host = ''
    try { host = new URL(url).hostname.toLowerCase() } catch {}
    if (host && !/(^|\.)eventbrite\.com$/.test(host)) {
      if (DEBUG) console.log(`  [filter] rejected (non-.com host ${host}): ${ev.name?.text ?? ev.name}`)
      return false
    }
  }

  // 2. Explicit online-only flag
  if (ev.is_online_event === true || ev.online_event === true) {
    if (DEBUG) console.log(`  [filter] rejected (online_event=true): ${ev.name?.text ?? ev.name}`)
    return false
  }

  // 3. Physical venue presence and locality
  const venue = ev.primary_venue ?? ev.venue
  if (!venue?.name) {
    if (DEBUG) console.log(`  [filter] rejected (no venue): ${ev.name?.text ?? ev.name}`)
    return false
  }
  const addr    = venue.address ?? venue.location ?? {}
  const country = addr.country ?? addr.country_code ?? null
  if (country && country !== 'US' && country !== 'USA' && country !== 'United States') {
    if (DEBUG) console.log(`  [filter] rejected (country=${country}): ${ev.name?.text ?? ev.name}`)
    return false
  }
  const region = addr.region ?? addr.state ?? null
  if (region && region !== 'OH' && region !== 'Ohio') {
    if (DEBUG) console.log(`  [filter] rejected (region=${region}): ${ev.name?.text ?? ev.name}`)
    return false
  }

  // 4. County-level gate — never trust the feed's geographic scoping.
  const locality = classifyEventLocality(venue, addr)
  if (locality === 'out') {
    if (DEBUG) console.log(`  [filter] rejected (outside Summit County: ${addr.city ?? 'no city'}): ${ev.name?.text ?? ev.name}`)
    return false
  }
  if (locality === 'unknown') {
    // Kept, but flagged: mapEvent() routes it to the review queue instead of
    // publishing. See classifyEventLocality above.
    ev._geoUnknown = true
    if (DEBUG) console.log(`  [filter] unknown locality → review queue (${addr.city ?? 'no city'}): ${ev.name?.text ?? ev.name}`)
  }

  return true
}

// ── Event normalisation ──────────────────────────────────────────────────────
function normaliseEvent(ev) {
  const title = stripHtml(
    typeof ev.name === 'string' ? ev.name : ev.name?.text ?? ev.title ?? 'Untitled'
  )

  const rawDesc = ev.description?.text ?? ev.summary ??
    (typeof ev.description === 'string' ? ev.description : null)
  const description = rawDesc ? stripHtml(rawDesc).slice(0, 5000) || null : null

  let start_at = null, end_at = null
  if (ev.start?.utc) {
    start_at = ev.start.utc; end_at = ev.end?.utc ?? null
  } else if (ev.start_date && ev.start_time) {
    // Naked date+time strings are Eastern wall-clock — convert, don't pass
    // through, or Postgres interprets them as UTC (the 4-hour-shift bug).
    start_at = eventbriteToUtcIso(`${ev.start_date}T${ev.start_time}`)
    end_at   = ev.end_date ? eventbriteToUtcIso(`${ev.end_date}T${ev.end_time ?? '23:59:00'}`) : null
  } else if (ev.start_datetime) {
    start_at = eventbriteToUtcIso(ev.start_datetime); end_at = eventbriteToUtcIso(ev.end_datetime)
  }

  if (!start_at) return null

  let price_min = null, price_max = null
  const ta = ev.ticket_availability
  // Only assert definitively free (price_max=0) when we have confirming data.
  // Search results sometimes set is_free=true incorrectly; the detail-fetch pass
  // patches ev.is_free with accurate Events API data, but if that fails we'd
  // propagate the wrong value. Require ticket_availability or ticket_classes
  // confirmation before marking as free.
  const hasPricingData = ta?.minimum_ticket_price != null || ev.ticket_classes?.length > 0
  if ((ev.is_free || ta?.is_free) && hasPricingData) {
    price_min = 0; price_max = 0
  } else if (ev.is_free && !hasPricingData) {
    // is_free flag without backing data — treat as unknown rather than asserting free
    price_min = null; price_max = null
  } else if (ta?.minimum_ticket_price?.major_value != null) {
    // ticket_availability is the most reliable pricing source in search results
    price_min = parseFloat(ta.minimum_ticket_price.major_value) || 0
    const taMax = ta.maximum_ticket_price?.major_value
    price_max = taMax != null && parseFloat(taMax) > price_min ? parseFloat(taMax) : null
  } else if (ev.ticket_classes?.length) {
    ;({ price_min, price_max } = parseEventbritePrice(ev.ticket_classes, ev.is_free))
  } else if (ev.min_price != null) {
    price_min = parseFloat(ev.min_price) || 0
    price_max = ev.max_price != null && ev.max_price !== ev.min_price
      ? parseFloat(ev.max_price) : null
  }

  // Category resolution, in priority order:
  //   1. Eventbrite's numeric category_id mapping (most reliable — when
  //      the search-result JSON exposes it, which it rarely does).
  //   2. category/subcategory strings scraped from the detail-page HTML —
  //      the detail-fetch pass attaches these as ev._categoryName /
  //      ev._subcategoryName when found.
  //   3. Text inference over title + description.
  //   4. For a bare "Performing & Visual Arts" top-level (no subcategory,
  //      inference empty), fall back to visual-art rather than 'other'.
  // Audit-recommended logging: record (category_id, category_string) pairs so
  // EVENTBRITE_CATEGORY_MAP assignments can be confirmed empirically.
  if (ev.category_id && (ev._categoryName || ev._subcategoryName)) {
    console.log(`  [category-id-pair] ${ev.category_id} → "${ev._categoryName ?? ''}" / "${ev._subcategoryName ?? ''}"`)
  }
  let category =
       EVENTBRITE_CATEGORY_MAP[ev.category_id]
    ?? categoryFromEventbriteNames(ev._categoryName, ev._subcategoryName)
    ?? inferCategory(title, description)
  if (category === 'other' && /performing & visual arts/i.test(ev._categoryName ?? '')) {
    category = 'visual-art'
  }

  // Facet-shaped Eventbrite categories: not content, but useful flags.
  const facetText = `${ev._categoryName ?? ''} ${ev._subcategoryName ?? ''}`.toLowerCase()
  // is_fundraiser requires an explicit "fundraising" category — NOT the broad
  // "Charity & Causes" bucket, which Eventbrite slaps on community orgs'
  // networking dinners, social clubs, etc. (a Comeunity Project "Girls Night
  // Out" was landing in Give Back, 2026-06-17). When this is undefined, the
  // strict text inference (FUNDRAISER_RE) decides instead.
  const is_fundraiser = /fundrais/.test(facetText) || undefined
  const is_family     = /family/.test(facetText) || undefined

  const rawImg =
    pickBestImageUrl(ev.image) ??
    pickBestImageUrl(ev.logo) ??
    ev.banner_url ?? ev.hero_image_url ?? null
  const image_url = rawImg && /^https?:\/\//i.test(rawImg) ? rawImg : null

  return {
    title,
    description,
    start_at,
    end_at,
    category,
    // undefined (not false) when no signal — upsertEventSafe's `??` then
    // lets text inference decide the facet.
    is_fundraiser,
    is_family,
    tags:            [],
    price_min,
    price_max,
    age_restriction: 'not_specified',
    image_url,
    ticket_url:      ev.url ?? ev.ticket_url ?? null,
    source:          'eventbrite',
    source_id:       String(ev.id),
    // Unknown locality (flagged in isAkronEvent) → review queue, never the
    // public calendar. Admin publish locks status via manual_overrides.
    status:          ev._geoUnknown ? 'pending_review' : 'published',
    needs_review:    ev._geoUnknown ? true : undefined,
    featured:        false,
  }
}

// ── Volume anomaly guard ─────────────────────────────────────────────────────
/**
 * Refuse to publish a run whose volume is wildly out of line with history.
 *
 * On 2026-06-10 an Eventbrite search redesign turned a ~50-event feed into a
 * 972-event NE-Ohio firehose and the run published all of it. A source-side
 * change should fail loudly, not bulk-publish. Returns null when the volume
 * is sane, or an error string describing the anomaly.
 *
 * Only enforced once we have 3+ successful runs of history; threshold is
 * 3× the trailing average with a 120-event floor so normal growth never trips.
 */
const VOLUME_GUARD_MULTIPLIER = 3
const VOLUME_GUARD_FLOOR      = 120
const VOLUME_GUARD_MIN_RUNS   = 3

async function volumeAnomaly(found) {
  try {
    const { data } = await supabaseAdmin
      .from('scraper_runs').select('events_found')
      .eq('scraper_name', 'eventbrite').eq('status', 'success')
      .order('ran_at', { ascending: false }).limit(5)
    if (!data || data.length < VOLUME_GUARD_MIN_RUNS) return null
    const avg = data.reduce((s, r) => s + (r.events_found ?? 0), 0) / data.length
    const cap = Math.max(Math.round(avg * VOLUME_GUARD_MULTIPLIER), VOLUME_GUARD_FLOOR)
    if (found > cap) {
      return `Volume anomaly: found ${found} events vs trailing avg ${Math.round(avg)} ` +
             `(cap ${cap}). Refusing to publish — inspect the feed before re-running with --force.`
    }
    return null
  } catch { return null } // guard must never break a healthy run
}

// ── Cooldown ─────────────────────────────────────────────────────────────────
async function isOnCooldown() {
  try {
    const cutoff = new Date(Date.now() - COOLDOWN_HOURS * 3600_000).toISOString()
    const { data } = await supabaseAdmin
      .from('scraper_runs').select('ran_at')
      .eq('scraper_name', 'eventbrite').eq('status', 'success')
      .gt('ran_at', cutoff).limit(1).maybeSingle()
    return !!data
  } catch { return false }
}

// ── Main fetch loop ──────────────────────────────────────────────────────────
/**
 * Pagination strategy:
 *
 * Page 1: Extract from __SERVER_DATA__.buckets in the HTML. This gives us
 *   every bucket (music, this weekend, community, etc.), each pre-loaded
 *   with their first batch of events. We aggregate all of them.
 *
 * Page 2+: The HTML ?page=N parameter only changes the "main" results bucket,
 *   not the whole page layout. We use the internal POST API for subsequent
 *   pages — it's cleaner than re-parsing full HTML.
 *
 * Deduplication is by source_id throughout so overlapping bucket results
 * don't cause duplicate DB rows.
 */
async function fetchAllEvents() {
  const allEvents = []
  const seenIds   = new Set()

  let session
  try {
    session = await getSession()
  } catch (err) {
    if (err instanceof BlockedError) throw err
    throw new Error(`Could not establish Eventbrite session: ${err.message}`)
  }

  console.log(`\n🔍  Fetching Eventbrite events for Akron, OH (${SEARCH_PAGES.length} feeds)…`)

  for (let feedIdx = 0; feedIdx < SEARCH_PAGES.length; feedIdx++) {
    const feedUrl   = SEARCH_PAGES[feedIdx]
    const feedLabel = feedUrl.replace('https://www.eventbrite.com/d/oh--akron/', '').replace(/\/$/, '') || 'events'
    let totalPages  = 1
    let feedNew     = 0

    console.log(`\n  📋  Feed ${feedIdx + 1}/${SEARCH_PAGES.length}: /${feedLabel}/`)

    // ── Page 1: Extract from server-rendered HTML ────────────────────────────
    //
    // Feed 0 reuses the HTML already fetched during session establishment
    // (saves a round-trip). Category feeds require a separate page-1 fetch.
    let feedHtml = null
    if (feedIdx === 0) {
      feedHtml = session.html
    } else {
      try {
        await jitter()
        const res = await fetch(feedUrl, { headers: htmlHeaders(feedUrl), redirect: 'follow' })
        if (res.ok) feedHtml = await res.text()
      } catch (e) {
        console.warn(`  ⚠ Could not fetch page 1 HTML for /${feedLabel}/: ${e.message}`)
      }
    }

    let p1Added = 0
    if (feedHtml) {
      const p1Result = extractFromHtml(feedHtml, `${feedLabel} page 1`)
      if (p1Result) {
        for (const ev of p1Result.events) {
          const id = String(ev.id)
          if (!seenIds.has(id)) { seenIds.add(id); allEvents.push(ev); p1Added++ }
        }
        if (p1Result.data) {
          totalPages = extractPageCount(p1Result.data)
          if (totalPages > 1) console.log(`    Total pages: ${totalPages} (cap: ${MAX_PAGES})`)
        }
      }
    }

    // HTML fallback: if page 1 HTML yielded nothing, try the POST API
    if (p1Added === 0) {
      const r = await tryInternalPostApi(1, session.cookie, session.csrfToken)
      if (r) {
        for (const ev of r.events) {
          const id = String(ev.id)
          if (!seenIds.has(id)) { seenIds.add(id); allEvents.push(ev); p1Added++ }
        }
        totalPages = extractPageCount(r.data)
      }
    }

    // If the general feed (feed 0) has zero events, something is broken — bail early
    if (p1Added === 0 && feedIdx === 0) {
      console.warn('  ⚠ All extraction strategies returned 0 events on page 1.')
      if (!DEBUG) console.warn('  ℹ️  Run with --debug for detailed output to help diagnose the issue.')
      return allEvents
    }

    feedNew += p1Added
    console.log(`    Page 1: ${p1Added} new events`)

    // ── Pages 2+: POST API (more reliable than re-parsing HTML) ─────────────
    //
    // The POST API uses the general oh--akron place_id regardless of which
    // category feed we're on, so results may overlap with earlier feeds.
    // seenIds deduplication ensures each event is only collected once.
    for (let page = 2; page <= Math.min(totalPages, MAX_PAGES); page++) {
      await jitter()

      let pageEvents = []

      const r = await tryInternalPostApi(page, session.cookie, session.csrfToken)
      if (r) pageEvents = r.events

      if (pageEvents.length === 0) {
        try {
          const url = `${feedUrl}?page=${page}`
          const res = await fetch(url, { headers: htmlHeaders(feedUrl), redirect: 'follow' })
          if (res.ok) {
            const html = await res.text()
            const result = extractFromHtml(html, `${feedLabel} page ${page}`)
            if (result) pageEvents = result.events
          }
        } catch (e) {
          console.warn(`  ⚠ HTML fetch failed for /${feedLabel}/ page ${page}: ${e.message}`)
        }
      }

      if (pageEvents.length === 0) {
        console.log(`    Page ${page}: 0 events — end of results`)
        break
      }

      let added = 0
      for (const ev of pageEvents) {
        const id = String(ev.id)
        if (!seenIds.has(id)) { seenIds.add(id); allEvents.push(ev); added++ }
      }
      feedNew += added
      console.log(`    Page ${page}: ${added} new (${pageEvents.length - added} cross-feed dupes, total: ${allEvents.length})`)

      if (added === 0) {
        console.log('    All events on this page already collected — stopping.')
        break
      }
    }

    console.log(`    Feed total: ${feedNew} net-new events`)
  }

  return allEvents
}

// ── Detail-page description fetching ─────────────────────────────────────────
/**
 * Fetch one Eventbrite event detail page and return the full description text.
 *
 * Eventbrite uses two description formats:
 *   1. Legacy:            __SERVER_DATA__.event.description.{text|html}
 *   2. Structured content: __SERVER_DATA__.structured_content.modules[]
 *      where each module has data.body.{text|html}
 *
 * Returns { description, summary } or null on failure.
 */
async function fetchEventDetail(url, cookie) {
  try {
    const controller = new AbortController()
    const tid = setTimeout(() => controller.abort(), DETAIL_TIMEOUT_MS)

    const res = await fetch(url, {
      headers: {
        ...htmlHeaders(SEARCH_PAGE),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      redirect: 'follow',
      signal:   controller.signal,
    })
    clearTimeout(tid)

    if (!res.ok) {
      if (DEBUG) console.log(`\n  [debug] Detail HTTP ${res.status}: ${url}`)
      return null
    }

    const html = await res.text()

    if (DEBUG) {
      console.log(`\n  [debug] Detail page: ${url}`)
      console.log(`  [debug]   HTML length: ${html.length}`)
      console.log(`  [debug]   Has __SERVER_DATA__: ${html.includes('window.__SERVER_DATA__')}`)
      console.log(`  [debug]   Has __NEXT_DATA__: ${html.includes('__NEXT_DATA__')}`)
      console.log(`  [debug]   Has ld+json: ${html.includes('application/ld+json')}`)
      console.log(`  [debug]   Has cf-browser: ${html.includes('cf-browser-verification')}`)
    }

    // Bot-detection bail-out
    if (html.includes('cf-browser-verification') || html.includes('cf_clearance')) {
      if (DEBUG) console.log(`  [debug]   → Blocked by Cloudflare`)
      return null
    }

    // ── Extract category / subcategory strings from the page ────────────────
    // Eventbrite's detail page embeds the event's category in multiple
    // places — most reliably in the breadcrumb's
    //   "category_string":"Music"
    //   "format_string":"performances"
    // shape. Also appears as bare "category":"Music","subcategory":"Metal" in
    // server data. We try the breadcrumb form first (event-specific), then
    // fall back to the bare form (filtering out "Any category" noise that
    // shows up in the page's filter UI).
    let categoryName = null, subcategoryName = null
    const bcCat = html.match(/"category_string":"([^"]+)"/)
    if (bcCat?.[1] && !/^any /i.test(bcCat[1])) categoryName = bcCat[1]
    if (!categoryName) {
      // Pick the first non-"Any …" category match
      const all = [...html.matchAll(/"category":"([^"]+)"/g)].map(m => m[1])
      categoryName = all.find(s => s && !/^any /i.test(s)) ?? null
    }
    const subMatch = html.match(/"subcategory":"([^"]+)"/)
    if (subMatch?.[1] && !/^any /i.test(subMatch[1])) subcategoryName = subMatch[1]
    if (DEBUG && (categoryName || subcategoryName)) {
      console.log(`  [debug]   category: ${categoryName} / subcategory: ${subcategoryName}`)
    }

    // ── Extract og:image from HTML (works even when JS data is missing) ──────
    let ogImageUrl = null
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ??
                    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
    if (ogMatch?.[1] && /^https?:\/\//i.test(ogMatch[1])) {
      ogImageUrl = ogMatch[1]
      if (DEBUG) console.log(`  [debug]   og:image: ${ogImageUrl}`)
    }

    // ── Extract the organizer from the page ─────────────────────────────────
    // Computed up front, like categoryName/ogImageUrl above, because
    // fetchEventDetail returns from a half-dozen different strategy branches —
    // deriving it inside any one of them would silently miss the others.
    const htmlOrganizer = extractOrganizer(html)
    if (DEBUG && htmlOrganizer) console.log(`  [debug]   organizer (HTML): ${htmlOrganizer.name}`)

    // ── Strategy 1: window.__SERVER_DATA__ ───────────────────────────────────
    const serverData = extractWindowVar(html, '__SERVER_DATA__')
    if (serverData) {
      if (DEBUG) console.log(`  [debug]   __SERVER_DATA__ top-level keys: ${Object.keys(serverData).join(', ')}`)

      const ev = serverData.event ?? serverData.eventDetail ?? null
      if (DEBUG && ev) console.log(`  [debug]   event keys: ${Object.keys(ev).join(', ')}`)

      // Try to get image from __SERVER_DATA__ event object too
      const sdImage = pickBestImageUrl(ev?.image) ?? pickBestImageUrl(ev?.logo)
      const imageUrl = ogImageUrl ?? sdImage ?? null

      // Format 1a: legacy description object
      const legacyHtml = ev?.description?.html ?? ev?.description?.text ?? null
      if (legacyHtml && legacyHtml.trim().length > 10) {
        if (DEBUG) console.log(`  [debug]   → found via __SERVER_DATA__.event.description`)
        return { description: stripHtml(legacyHtml), summary: ev?.summary ?? null, imageUrl, categoryName, subcategoryName, organizer: htmlOrganizer }
      }

      // Format 1b: structured_content modules (newer Eventbrite editor)
      const modules =
        serverData.structured_content?.modules ??
        ev?.structured_content?.modules ?? []

      if (Array.isArray(modules) && modules.length > 0) {
        if (DEBUG) console.log(`  [debug]   structured_content has ${modules.length} modules`)
        const parts = []
        for (const mod of modules) {
          const bodyHtml = mod?.data?.body?.html ?? mod?.data?.body?.text ?? null
          if (bodyHtml && bodyHtml.trim()) { parts.push(stripHtml(bodyHtml).trim()); continue }
          const textHtml = mod?.data?.text?.html ?? mod?.data?.text ?? null
          if (textHtml && typeof textHtml === 'string' && textHtml.trim()) {
            parts.push(stripHtml(textHtml).trim())
          }
        }
        const combined = parts.filter(Boolean).join('\n\n')
        if (combined.length > 10) {
          if (DEBUG) console.log(`  [debug]   → found via structured_content modules`)
          return { description: combined, summary: ev?.summary ?? null, imageUrl, categoryName, subcategoryName, organizer: htmlOrganizer }
        }
      }

      // Format 1c: summary from detail page
      const sdSummary = ev?.summary ?? null
      if (sdSummary && sdSummary.trim().length > 10) {
        if (DEBUG) console.log(`  [debug]   → found via __SERVER_DATA__.event.summary`)
        return { description: sdSummary, summary: sdSummary, imageUrl, categoryName, subcategoryName, organizer: htmlOrganizer }
      }
    }

    // ── Strategy 2: Structured content API + Events API (description + price) ─
    // /api/v3/events/{id}/structured_content/ → full description modules
    // /api/v3/events/{id}/?expand=ticket_availability,ticket_classes → real price
    const eventIdMatch = url.match(/tickets-(\d+)\/?$/)
    if (eventIdMatch) {
      const eventId = eventIdMatch[1]

      // ── 2a: structured content (description) ────────────────────────────
      let description = null
      const scUrl = `https://www.eventbrite.com/api/v3/events/${eventId}/structured_content/?purpose=listing&expand=none`
      try {
        const scCtrl = new AbortController()
        const scTid  = setTimeout(() => scCtrl.abort(), DETAIL_TIMEOUT_MS)
        const scRes  = await fetch(scUrl, {
          headers: apiHeaders(cookie, null, url),
          redirect: 'follow',
          signal:   scCtrl.signal,
        })
        clearTimeout(scTid)

        if (scRes.ok) {
          const scData = await scRes.json()
          if (DEBUG) console.log(`  [debug]   SC API keys: ${Object.keys(scData).join(', ')}`)
          const modules = scData.modules ?? []
          const parts = []
          for (const mod of modules) {
            const bodyHtml = mod?.data?.body?.html ?? mod?.data?.body?.text ?? null
            if (bodyHtml?.trim()) { parts.push(htmlToText(bodyHtml).trim()); continue }
            const textHtml = mod?.data?.text?.html ?? mod?.data?.text ?? null
            if (textHtml && typeof textHtml === 'string' && textHtml.trim()) {
              parts.push(htmlToText(textHtml).trim())
            }
          }
          const combined = parts.filter(Boolean).join('\n\n')
          if (combined.length > 10) {
            description = combined
            if (DEBUG) console.log(`  [debug]   → SC API description: ${combined.length} chars`)
          }
        } else {
          if (DEBUG) console.log(`  [debug]   SC API HTTP ${scRes.status}`)
        }
      } catch (e) {
        if (DEBUG) console.log(`  [debug]   SC API error: ${e.message}`)
      }

      // ── 2b: events API (accurate pricing + authoritative organizer) ─────
      let priceData = null
      let apiOrganizer = null
      const evUrl = `https://www.eventbrite.com/api/v3/events/${eventId}/?expand=organizer,ticket_availability,ticket_classes`
      try {
        const evCtrl = new AbortController()
        const evTid  = setTimeout(() => evCtrl.abort(), DETAIL_TIMEOUT_MS)
        const evRes  = await fetch(evUrl, {
          headers: apiHeaders(cookie, null, url),
          redirect: 'follow',
          signal:   evCtrl.signal,
        })
        clearTimeout(evTid)

        if (evRes.ok) {
          const evData = await evRes.json()
          if (DEBUG) console.log(`  [debug]   Events API is_free=${evData.is_free}, ta=${JSON.stringify(evData.ticket_availability?.minimum_ticket_price)}`)
          priceData = {
            is_free:              evData.is_free ?? false,
            ticket_availability:  evData.ticket_availability  ?? null,
            ticket_classes:       evData.ticket_classes        ?? [],
          }
          // The expanded organizer is the authoritative answer — prefer it
          // over anything scraped out of the page HTML below.
          apiOrganizer = cleanOrganizer(evData.organizer?.name, evData.organizer?.url ?? evData.organizer?.website)
          if (DEBUG && apiOrganizer) console.log(`  [debug]   organizer (API): ${apiOrganizer.name}`)
        } else {
          if (DEBUG) console.log(`  [debug]   Events API HTTP ${evRes.status}`)
        }
      } catch (e) {
        if (DEBUG) console.log(`  [debug]   Events API error: ${e.message}`)
      }

      const organizer = apiOrganizer ?? htmlOrganizer
      if (description || priceData || ogImageUrl || categoryName || organizer) {
        return { description, summary: null, priceData, imageUrl: ogImageUrl, categoryName, subcategoryName, organizer }
      }
    }

    // ── Strategy 3: __NEXT_DATA__ script tag (Next.js format) ──────────────
    // Eventbrite event detail pages use Next.js. The data is embedded as:
    //   <script id="__NEXT_DATA__" type="application/json">{...}</script>
    // NOT as window.__NEXT_DATA__ = {...}, so extractWindowVar misses it.
    const nextData = extractNextData(html)
    if (nextData) {
      if (DEBUG) {
        console.log(`  [debug]   __NEXT_DATA__ found`)
        console.log(`  [debug]   props keys: ${Object.keys(nextData?.props ?? {}).join(', ')}`)
        const pp = nextData?.props?.pageProps ?? {}
        console.log(`  [debug]   pageProps keys: ${Object.keys(pp).join(', ')}`)
        const ev2 = pp?.event ?? pp?.eventData?.event ?? null
        if (ev2) console.log(`  [debug]   event keys: ${Object.keys(ev2).join(', ')}`)
      }
      // Walk common pageProps shapes Eventbrite has used
      const ndEv =
        nextData?.props?.pageProps?.event ??
        nextData?.props?.pageProps?.eventData?.event ??
        nextData?.props?.pageProps?.data?.event ?? null

      const ndDesc =
        ndEv?.description?.text ??
        ndEv?.description?.html ??
        ndEv?.summary ?? null

      if (ndDesc && ndDesc.trim().length > 10) {
        if (DEBUG) console.log(`  [debug]   → found via __NEXT_DATA__ (${ndDesc.length} chars)`)
        const ndImage = pickBestImageUrl(ndEv?.image) ?? pickBestImageUrl(ndEv?.logo)
        return { description: stripHtml(ndDesc), summary: ndEv?.summary ?? null, imageUrl: ogImageUrl ?? ndImage, categoryName, subcategoryName, organizer: htmlOrganizer }
      }
      if (DEBUG) console.log(`  [debug]   __NEXT_DATA__ had no usable description`)
    }

    // ── Strategy 3: JSON-LD <script type="application/ld+json"> ─────────────
    // Eventbrite embeds structured event data for SEO — sometimes includes description.
    const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    let ldMatch
    while ((ldMatch = ldRe.exec(html)) !== null) {
      try {
        const ld = JSON.parse(ldMatch[1])
        const items = Array.isArray(ld) ? ld : [ld]
        for (const item of items) {
          if (DEBUG) console.log(`  [debug]   ld+json @type=${item['@type']} keys: ${Object.keys(item).join(', ')}`)
          // Match any schema.org event subtype (Event, SocialEvent, MusicEvent, Festival, etc.)
          // by checking for description + startDate rather than enumerating every @type value.
          if (item.startDate && item.description && item.description.trim().length > 10) {
            if (DEBUG) console.log(`  [debug]   → found via JSON-LD @type=${item['@type']} (${item.description.length} chars)`)
            const ldImage = pickBestImageUrl(item.image)
            return { description: stripHtml(item.description), summary: null, imageUrl: ogImageUrl ?? ldImage, categoryName, subcategoryName, organizer: htmlOrganizer }
          }
        }
      } catch {}
    }

    if (DEBUG) console.log(`  [debug]   → all strategies exhausted, no description found`)
    // Even without a description, return og:image / category / organizer if we
    // found them — an organizer alone is worth the round trip, since it's the
    // difference between "Presented by X" and a bare "Listed on Eventbrite".
    if (ogImageUrl || categoryName || htmlOrganizer) {
      return { description: null, summary: null, imageUrl: ogImageUrl, categoryName, subcategoryName, organizer: htmlOrganizer }
    }
    return null

  } catch (err) {
    if (DEBUG) console.log(`  [debug] Detail fetch exception (${url}): ${err.message}`)
    return null
  }
}

/**
 * Enrich raw events in-place with full descriptions and accurate pricing.
 *
 * We fetch details for ALL events, not just those missing descriptions, because:
 *   1. Pricing from the events API is always more accurate than search results
 *   2. Search-result summaries can be 100+ chars yet still lack the full description
 *
 * Runs in small parallel batches with jitter to stay polite.
 */
async function enrichWithDetails(rawEvents, cookie) {
  console.log(`\n📄  Fetching details for all ${rawEvents.length} events…`)

  let enriched = 0
  let failed   = 0

  for (let i = 0; i < rawEvents.length; i += DETAIL_BATCH_SIZE) {
    const batch = rawEvents.slice(i, i + DETAIL_BATCH_SIZE)

    await Promise.all(batch.map(async (ev) => {
      const url = ev.url ?? ev.ticket_url
      if (!url) { failed++; return }

      const detail = await fetchEventDetail(url, cookie)
      if (detail?.description || detail?.priceData || detail?.imageUrl || detail?.categoryName || detail?.organizer) {
        // Patch description
        if (detail.description) {
          if (!ev.description || typeof ev.description !== 'object') ev.description = {}
          ev.description.text = detail.description
          if (detail.summary && !ev.summary) ev.summary = detail.summary
        }
        // Patch price — overwrite search-result pricing with the accurate events API data
        if (detail.priceData) {
          ev.is_free             = detail.priceData.is_free
          ev.ticket_availability = detail.priceData.ticket_availability
          ev.ticket_classes      = detail.priceData.ticket_classes
        }
        // Patch image — fill in from detail page when search result had none
        if (detail.imageUrl && !ev.image?.url && !ev.logo?.url && !ev.banner_url && !ev.hero_image_url) {
          ev.image = { url: detail.imageUrl }
        }
        // Patch organizer — the search payload carries one for only ~5% of
        // events, which is why EB events used to publish with no presenter at
        // all. Fill only when the search gave us nothing: a value already on
        // the event came from Eventbrite's own payload and is no worse than
        // ours, and overwriting it would churn organizations for no gain.
        // (upsertOrganizer reads primary_organizer first, so an existing one
        // still wins regardless.)
        if (detail.organizer && !ev.primary_organizer?.name && !ev.organizer?.name) {
          ev.organizer = { name: detail.organizer.name, website: detail.organizer.website }
        }
        // Attach category strings for normaliseEvent() to consume
        if (detail.categoryName)    ev._categoryName    = detail.categoryName
        if (detail.subcategoryName) ev._subcategoryName = detail.subcategoryName
        enriched++
      } else {
        failed++
      }
    }))

    const done = Math.min(i + DETAIL_BATCH_SIZE, rawEvents.length)
    process.stdout.write(`\r  Details: ${done} / ${rawEvents.length} (${enriched} enriched, ${failed} failed)   `)

    // Jitter between batches — skip delay after the last one
    if (i + DETAIL_BATCH_SIZE < rawEvents.length) await detailJitter()
  }

  console.log(`\n  ✓ Detail pass complete: ${enriched} enriched, ${failed} without description`)
}

// ── Process + upsert ─────────────────────────────────────────────────────────
async function processEvents(rawEvents) {
  let inserted = 0, updated = 0, skipped = 0
  for (const ev of rawEvents) {
    try {
      const row = normaliseEvent(ev)
      if (!row) { skipped++; continue }
      const venueId     = await upsertVenue(ev)
      const organizerId = await upsertOrganizer(ev)
      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error, isNew } = await upsertEventSafe(enrichedRow)
      if (error) {
        console.warn(`  ⚠ Upsert failed "${ev.name?.text ?? ev.name}":`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        if (isNew) inserted++
        else updated++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing event ${ev.id}:`, err.message)
      skipped++
    }
  }
  return { inserted, updated, skipped }
}

// ── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀  Starting Eventbrite scrape…')
  const start = Date.now()

  try {
    if (!FORCE && await isOnCooldown()) {
      console.log(`ℹ️   Eventbrite: last run was within ${COOLDOWN_HOURS}h — skipping.`)
      console.log('   Run with --force to override the cooldown.')
      process.exit(0)
    }

    // Summit County polygon for the locality gate; pointInSummitCounty()
    // is synchronous after this.
    await preloadSummitCountyBoundary()

    const rawEventsAll = await fetchAllEvents()

    // Filter out non-Akron / online / international events BEFORE the detail
    // pass so we don't burn detail-fetch quota on events we'll throw away.
    // See isAkronEvent() for rationale.
    const rawEvents   = rawEventsAll.filter(isAkronEvent)
    const filteredOut = rawEventsAll.length - rawEvents.length
    if (filteredOut > 0) {
      console.log(`\n🧹  Filtered out ${filteredOut} non-local event(s) ` +
                  `(international/online/no-venue/out-of-county) — ${rawEvents.length} remain`)
    }

    // Refuse to publish a run whose volume is wildly out of line with history
    // (source-side feed changes should fail loudly, not bulk-publish).
    if (!FORCE) {
      const anomaly = await volumeAnomaly(rawEvents.length)
      if (anomaly) {
        console.error(`\n🛑  ${anomaly}`)
        await logUpsertResult('eventbrite', 0, 0, 0, {
          status:       'error',
          errorMessage: anomaly,
          durationMs:   Date.now() - start,
          eventsFound:  rawEvents.length,
        })
        process.exit(1)
      }
    }

    if (rawEvents.length === 0) {
      // fall through to zero-event log below
    } else if (NO_DETAILS) {
      console.log('\n⏩  Skipping detail pass (--no-details)')
    } else {
      const { cookie } = await getSession()  // already cached — no extra request
      await enrichWithDetails(rawEvents, cookie)
    }

    if (rawEvents.length === 0) {
      await logUpsertResult('eventbrite', 0, 0, 0, {
        status:       'error',
        errorMessage: 'Zero events extracted — all strategies returned nothing',
        durationMs:   Date.now() - start,
        eventsFound:  0,
      })
      process.exit(0)
    }

    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, updated, skipped } = await processEvents(rawEvents)
    await logUpsertResult('eventbrite', inserted, updated, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)

  } catch (err) {
    if (err instanceof BlockedError) {
      console.warn(`\n⚠  Eventbrite scraper blocked: ${err.message}`)
      await logUpsertResult('eventbrite', 0, 0, 0, {
        status:       'error',
        errorMessage: err.message,
        durationMs:   Date.now() - start,
        eventsFound:  0,
      })
      process.exit(0)
    }
    await logScraperError('eventbrite', err, start)
    process.exit(1)
  }
}

// Run only when invoked directly (`node scripts/scrape-eventbrite.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
