/**
 * Shared Wix Events module.
 *
 * Wix sites running the Wix Events app don't expose JSON-LD, but they
 * server-render a `<script id="wix-warmup-data">` JSON blob that contains the
 * full event objects (title, scheduling.config start/end as ISO, location,
 * description, slug). Parsing that blob is far more robust than Wix's hashed,
 * build-specific CSS class names.
 *
 * Mirrors lib/squarespace.js so a Wix-based org scraper only supplies
 * configuration (events URL, source key, category/tag logic).
 *
 * Usage:
 *   import { fetchWixEvents, normaliseWixEvent, parseWixLocation } from './lib/wix-events.js'
 *   const raw = await fetchWixEvents('https://example.com/events')
 *   for (const ev of raw) {
 *     const row   = normaliseWixEvent(ev, { source: 'my_org', siteBaseUrl: 'https://example.com' })
 *     const venue = parseWixLocation(ev.location)
 *     // upsert row + ensure venue …
 *   }
 */

import { stripHtml } from './normalize.js'

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

// ── Warmup-data extraction ───────────────────────────────────────────────────

/**
 * Pull Wix Events objects out of the #wix-warmup-data JSON blob in page HTML.
 * Walks the (undocumented, version-specific) blob structurally rather than by
 * key path: any object carrying title + scheduling + slug is an event. De-duped
 * by slug. Returns [] when there's no blob or it isn't valid JSON (→ caller
 * posts nothing rather than guessing).
 *
 * @param {string} html — raw HTML of a Wix /events page
 * @returns {object[]}  — raw Wix event objects
 */
export function parseWixWarmupEvents(html) {
  const m = String(html || '').match(/<script[^>]*id="wix-warmup-data"[^>]*>([\s\S]*?)<\/script>/i)
  if (!m) return []
  let data
  try { data = JSON.parse(m[1]) } catch { return [] }

  const found = []
  const seen = new Set()
  function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 10) return
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return }
    if (typeof o.title === 'string' && o.scheduling && typeof o.slug === 'string') {
      if (!seen.has(o.slug)) { seen.add(o.slug); found.push(o) }
    }
    for (const k of Object.keys(o)) walk(o[k], depth + 1)
  }
  walk(data, 0)
  return found
}

// ── Location parsing ──────────────────────────────────────────────────────────

/**
 * Flatten a Wix event `location` object into the venue fields we use.
 * Wix shape: { name, address, coordinates:{lat,lng},
 *              fullAddress:{ city, subdivision, postalCode, … } }
 *
 * @param {object|null} loc
 * @returns {object|null} — { name, address, city, state, zip, lat, lng }
 */
export function parseWixLocation(loc) {
  if (!loc || typeof loc !== 'object') return null
  const fa = loc.fullAddress || {}
  return {
    name:    loc.name || null,
    address: loc.address || fa.formattedAddress || null,
    city:    fa.city || null,
    state:   fa.subdivision || null,
    zip:     fa.postalCode || null,
    lat:     loc.coordinates?.lat ?? null,
    lng:     loc.coordinates?.lng ?? null,
  }
}

/** Resolve a Wix media reference to a public URL, or null. */
function parseWixImage(mainImage) {
  if (!mainImage) return null
  if (typeof mainImage === 'string') {
    if (/^https?:\/\//.test(mainImage)) return mainImage
    if (/~mv2/.test(mainImage)) return `https://static.wixstatic.com/media/${mainImage}`
    return null
  }
  if (typeof mainImage === 'object') {
    if (typeof mainImage.url === 'string') return mainImage.url
    if (typeof mainImage.id === 'string' && /~mv2/.test(mainImage.id)) {
      return `https://static.wixstatic.com/media/${mainImage.id}`
    }
  }
  return null
}

// ── URL + normalisation ─────────────────────────────────────────────────────

/** Public detail URL for a Wix event: {site}/event-details/{slug}. */
export function buildWixEventUrl(siteBaseUrl, ev) {
  if (!ev?.slug || !siteBaseUrl) return null
  return `${String(siteBaseUrl).replace(/\/$/, '')}/event-details/${ev.slug}`
}

/**
 * Convert a raw Wix event object into the common row shape.
 *
 * @param {object} ev      — raw Wix event from parseWixWarmupEvents()
 * @param {object} config
 *   @param {string}   config.source            — scraper source key
 *   @param {Function} [config.mapCategory]      — (ev) → v2 category or null (default null → inference)
 *   @param {Function} [config.mapTags]          — (ev) → string[] (default [])
 *   @param {number|null} [config.defaultPriceMin] — default price_min (default null — never assume free)
 *   @param {number|null} [config.defaultPriceMax] — default price_max (default null)
 *   @param {string}   [config.ageRestriction]   — default age_restriction (default 'not_specified')
 *   @param {string}   [config.siteBaseUrl]      — origin used to build the ticket_url
 * @returns {object} — row for upsertEventSafe(); start_at is null for TBD events
 */
export function normaliseWixEvent(ev, config = {}) {
  const {
    source           = 'wix',
    mapCategory      = () => null,
    mapTags          = () => [],
    defaultPriceMin  = null,
    defaultPriceMax  = null,
    ageRestriction   = 'not_specified',
    siteBaseUrl      = null,
  } = config

  const cfg = ev?.scheduling?.config
  const start_at = cfg && !cfg.scheduleTbd && cfg.startDate ? new Date(cfg.startDate).toISOString() : null
  const end_at   = cfg && cfg.endDate && !cfg.endDateHidden ? new Date(cfg.endDate).toISOString() : null

  const rawDesc = typeof ev.description === 'string' ? ev.description
    : typeof ev.about === 'string' ? ev.about : null
  const description = rawDesc ? stripHtml(rawDesc).slice(0, 5000) || null : null

  return {
    title:           typeof ev.title === 'string' ? ev.title.trim() : null,
    description,
    start_at,
    end_at,
    category:        mapCategory(ev),
    tags:            mapTags(ev),
    price_min:       defaultPriceMin,
    price_max:       defaultPriceMax,
    age_restriction: ageRestriction,
    image_url:       parseWixImage(ev.mainImage),
    ticket_url:      buildWixEventUrl(siteBaseUrl, ev),
    source,
    source_id:       ev.slug || ev.id || null,
    status:          'published',
    featured:        false,
  }
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

/**
 * Fetch a Wix /events page and return its raw event objects.
 * @param {string} eventsPageUrl
 * @param {object} opts — { userAgent }
 * @returns {object[]}
 */
export async function fetchWixEvents(eventsPageUrl, opts = {}) {
  const { userAgent = DEFAULT_USER_AGENT } = opts
  const res = await fetch(eventsPageUrl, {
    headers: { Accept: 'text/html', 'User-Agent': userAgent },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`Wix events page HTTP ${res.status} at ${eventsPageUrl}`)
  return parseWixWarmupEvents(await res.text())
}
