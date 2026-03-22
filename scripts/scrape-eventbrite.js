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

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import {
  EVENTBRITE_CATEGORY_MAP,
  parseEventbritePrice,
  logUpsertResult,
  logScraperError,
  stripHtml,
  htmlToText,
} from './lib/normalize.js'

const DEBUG      = process.argv.includes('--debug')
const FORCE      = process.argv.includes('--force')
const NO_DETAILS = process.argv.includes('--no-details')

// ── Constants ────────────────────────────────────────────────────────────────

const SEARCH_PAGE    = 'https://www.eventbrite.com/d/oh--akron/events/'
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
const DETAIL_MIN_DESC_LEN  = 100   // skip detail fetch if existing desc is already this long

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

/**
 * Extract the first bucket that looks like a main "all events" result set —
 * the one with the largest results array. We use this for pagination.
 */
function findMainBucket(serverData) {
  if (!Array.isArray(serverData?.buckets)) return null
  let best = null
  for (const bucket of serverData.buckets) {
    const count = bucket?.events?.results?.length ?? 0
    if (!best || count > (best.events?.results?.length ?? 0)) best = bucket
  }
  return best
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
            start: { utc: item.startDate ? new Date(item.startDate).toISOString() : null },
            end:   { utc: item.endDate   ? new Date(item.endDate).toISOString()   : null },
            is_free: false,
            logo:  { url: typeof item.image === 'string' ? item.image : (item.image?.url ?? null) },
            venue: item.location ? {
              name:    item.location.name ?? null,
              address: {
                address_1:   item.location.address?.streetAddress ?? null,
                city:        item.location.address?.addressLocality ?? 'Akron',
                region:      item.location.address?.addressRegion ?? 'OH',
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

async function upsertVenue(ev) {
  const v = ev.primary_venue ?? ev.venue
  if (!v?.name) return null
  const addr = v.address ?? v.location ?? {}
  const row = {
    name:         v.name,
    address:      addr.address_1 ?? addr.localized_address_display ?? null,
    city:         addr.city ?? 'Akron',
    state:        addr.region ?? 'OH',
    zip:          addr.postal_code ?? null,
    lat:          v.latitude  ? parseFloat(v.latitude)  : null,
    lng:          v.longitude ? parseFloat(v.longitude) : null,
    parking_type: 'unknown',
  }
  const { data: existing } = await supabaseAdmin
    .from('venues').select('id').eq('name', row.name).eq('city', row.city).maybeSingle()
  if (existing) return existing.id
  const { data, error } = await supabaseAdmin.from('venues').insert(row).select('id').single()
  if (error) { console.warn(`  ⚠ Venue upsert "${row.name}":`, error.message); return null }
  return data.id
}

async function upsertOrganizer(ev) {
  const o = ev.primary_organizer ?? ev.organizer
  if (!o?.name) return null
  const row = { name: o.name, website: o.website ?? o.url ?? null }
  const { data: existing } = await supabaseAdmin
    .from('organizers').select('id').eq('name', row.name).maybeSingle()
  if (existing) return existing.id
  const { data, error } = await supabaseAdmin.from('organizers').insert(row).select('id').single()
  if (error) { console.warn(`  ⚠ Organizer upsert "${row.name}":`, error.message); return null }
  return data.id
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
    start_at = `${ev.start_date}T${ev.start_time}`
    end_at   = ev.end_date ? `${ev.end_date}T${ev.end_time ?? '23:59:00'}` : null
  } else if (ev.start_datetime) {
    start_at = ev.start_datetime; end_at = ev.end_datetime ?? null
  }

  if (!start_at) return null

  let price_min = 0, price_max = null
  const ta = ev.ticket_availability
  if (ev.is_free || ta?.is_free) {
    price_min = 0; price_max = 0
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

  const category = EVENTBRITE_CATEGORY_MAP[ev.category_id] ?? 'other'

  const rawImg =
    ev.image?.url ?? ev.logo?.url ?? ev.banner_url ?? ev.hero_image_url ??
    (typeof ev.logo === 'string' ? ev.logo : null)
  const image_url = rawImg && /^https?:\/\//i.test(rawImg) ? rawImg : null

  return {
    title,
    description,
    start_at,
    end_at,
    category,
    tags:            [],
    price_min,
    price_max,
    age_restriction: 'not_specified',
    image_url,
    ticket_url:      ev.url ?? ev.ticket_url ?? null,
    source:          'eventbrite',
    source_id:       String(ev.id),
    status:          'published',
    featured:        false,
  }
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
  let totalPages  = 1

  let session
  try {
    session = await getSession()
  } catch (err) {
    if (err instanceof BlockedError) throw err
    throw new Error(`Could not establish Eventbrite session: ${err.message}`)
  }

  console.log(`\n🔍  Fetching Eventbrite events for Akron, OH…`)

  // ── Page 1: Extract everything from the server-rendered HTML ──────────────
  const p1Result = extractFromHtml(session.html, 'page 1')
  if (p1Result) {
    for (const ev of p1Result.events) {
      const id = String(ev.id)
      if (!seenIds.has(id)) { seenIds.add(id); allEvents.push(ev) }
    }
    // Determine how many more pages exist
    if (p1Result.data) {
      totalPages = extractPageCount(p1Result.data)
      if (totalPages > 1) console.log(`  Total pages reported: ${totalPages} (cap: ${MAX_PAGES})`)
    }
  }

  // If HTML gave us nothing, try the POST API for page 1 too
  if (allEvents.length === 0) {
    const r = await tryInternalPostApi(1, session.cookie, session.csrfToken)
    if (r) {
      for (const ev of r.events) {
        const id = String(ev.id)
        if (!seenIds.has(id)) { seenIds.add(id); allEvents.push(ev) }
      }
      totalPages = extractPageCount(r.data)
    }
  }

  if (allEvents.length === 0) {
    console.warn('  ⚠ All extraction strategies returned 0 events on page 1.')
    if (!DEBUG) console.warn('  ℹ️  Run with --debug for detailed output to help diagnose the issue.')
    return allEvents
  }

  console.log(`  Page 1: ${allEvents.length} events`)

  // ── Pages 2+: Use POST API (more reliable than re-parsing HTML) ────────────
  for (let page = 2; page <= Math.min(totalPages, MAX_PAGES); page++) {
    await jitter()

    let pageEvents = []

    // Try POST API first
    const r = await tryInternalPostApi(page, session.cookie, session.csrfToken)
    if (r) pageEvents = r.events

    // If POST didn't work, try fetching the HTML page (slower but may work)
    if (pageEvents.length === 0) {
      try {
        const url = `${SEARCH_PAGE}?page=${page}`
        const res = await fetch(url, { headers: htmlHeaders(SEARCH_PAGE), redirect: 'follow' })
        if (res.ok) {
          const html = await res.text()
          const result = extractFromHtml(html, `page ${page}`)
          if (result) pageEvents = result.events
        }
      } catch (e) {
        console.warn(`  ⚠ HTML fetch failed for page ${page}: ${e.message}`)
      }
    }

    if (pageEvents.length === 0) {
      console.log(`  Page ${page}: 0 events — end of results`)
      break
    }

    let added = 0
    for (const ev of pageEvents) {
      const id = String(ev.id)
      if (!seenIds.has(id)) { seenIds.add(id); allEvents.push(ev); added++ }
    }
    console.log(`  Page ${page}: ${added} new events (${pageEvents.length - added} dupes skipped, total: ${allEvents.length})`)

    if (added === 0) {
      // All events on this page were already seen — we've cycled through everything
      console.log('  All events on this page were already collected — stopping.')
      break
    }
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

    // ── Strategy 1: window.__SERVER_DATA__ ───────────────────────────────────
    const serverData = extractWindowVar(html, '__SERVER_DATA__')
    if (serverData) {
      if (DEBUG) console.log(`  [debug]   __SERVER_DATA__ top-level keys: ${Object.keys(serverData).join(', ')}`)

      const ev = serverData.event ?? serverData.eventDetail ?? null
      if (DEBUG && ev) console.log(`  [debug]   event keys: ${Object.keys(ev).join(', ')}`)

      // Format 1a: legacy description object
      const legacyHtml = ev?.description?.html ?? ev?.description?.text ?? null
      if (legacyHtml && legacyHtml.trim().length > 10) {
        if (DEBUG) console.log(`  [debug]   → found via __SERVER_DATA__.event.description`)
        return { description: stripHtml(legacyHtml), summary: ev?.summary ?? null }
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
          return { description: combined, summary: ev?.summary ?? null }
        }
      }

      // Format 1c: summary from detail page
      const sdSummary = ev?.summary ?? null
      if (sdSummary && sdSummary.trim().length > 10) {
        if (DEBUG) console.log(`  [debug]   → found via __SERVER_DATA__.event.summary`)
        return { description: sdSummary, summary: sdSummary }
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

      // ── 2b: events API (accurate pricing) ───────────────────────────────
      let priceData = null
      const evUrl = `https://www.eventbrite.com/api/v3/events/${eventId}/?expand=ticket_availability,ticket_classes`
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
        } else {
          if (DEBUG) console.log(`  [debug]   Events API HTTP ${evRes.status}`)
        }
      } catch (e) {
        if (DEBUG) console.log(`  [debug]   Events API error: ${e.message}`)
      }

      if (description || priceData) {
        return { description, summary: null, priceData }
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
        return { description: stripHtml(ndDesc), summary: ndEv?.summary ?? null }
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
            return { description: stripHtml(item.description), summary: null }
          }
        }
      } catch {}
    }

    if (DEBUG) console.log(`  [debug]   → all strategies exhausted, no description found`)
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
      if (detail?.description || detail?.priceData) {
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
      const { error } = await supabaseAdmin
        .from('events')
        .upsert({ ...row, venue_id: venueId, organizer_id: organizerId },
                 { onConflict: 'source,source_id', ignoreDuplicates: false })
      if (error) {
        console.warn(`  ⚠ Upsert failed "${ev.name?.text ?? ev.name}":`, error.message)
        skipped++
      } else {
        inserted++
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

    const rawEvents = await fetchAllEvents()

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

main()
