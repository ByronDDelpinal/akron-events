/**
 * Shared Squarespace Events Collection module.
 *
 * Squarespace sites that use the native "Events" collection expose structured
 * JSON via `?format=json&view=upcoming`.  This module handles the common
 * fetch → normalise → upsert pipeline so individual org scrapers only need
 * to supply configuration (URLs, org details, category/tag logic).
 *
 * Usage:
 *   import { fetchSquarespaceEvents, normaliseSquarespaceEvent } from './lib/squarespace.js'
 *
 *   const raw = await fetchSquarespaceEvents('https://example.com/events')
 *   for (const item of raw) {
 *     const row = normaliseSquarespaceEvent(item, { source: 'my_org', ... })
 *     // upsert row …
 *   }
 */

import { stripHtml } from './normalize.js'

// ── Fetch ─────────────────────────────────────────────────────────────────

/**
 * Fetch all upcoming (and optionally past) events from a Squarespace
 * Events Collection page.
 *
 * @param {string}  collectionUrl — Full URL of the events collection page
 *                                   e.g. "https://example.com/lom-2026"
 * @param {object}  opts
 * @param {boolean} opts.includePast — Also return past events (default false)
 * @param {string}  opts.userAgent   — User-Agent header
 * @returns {object[]} — Array of raw Squarespace event item objects
 */
export async function fetchSquarespaceEvents(collectionUrl, opts = {}) {
  const {
    includePast = false,
    userAgent   = 'Mozilla/5.0 (compatible; The330-bot/1.0)',
  } = opts

  const url = new URL(collectionUrl)
  url.searchParams.set('format', 'json')
  url.searchParams.set('view', 'upcoming')

  const res = await fetch(url.toString(), {
    headers: {
      Accept:       'application/json',
      'User-Agent': userAgent,
    },
  })

  if (!res.ok) {
    throw new Error(`Squarespace API error ${res.status}: ${await res.text()}`)
  }

  const data = await res.json()
  const upcoming = data.upcoming ?? []
  const past     = data.past ?? []

  return includePast ? [...upcoming, ...past] : upcoming
}

// ── Location parsing ──────────────────────────────────────────────────────

/**
 * Parse a Squarespace location object into the flat venue fields we use.
 *
 * Squarespace location shape:
 *   { addressTitle, addressLine1, addressLine2, mapLat, mapLng,
 *     markerLat, markerLng, addressCountry }
 *
 * @param {object|null} loc — Squarespace location object
 * @returns {object}        — { name, address, city, state, zip, lat, lng }
 */
export function parseSquarespaceLocation(loc) {
  if (!loc) return null

  const name    = loc.addressTitle?.trim() || null
  const address = loc.addressLine1?.trim() || null

  // addressLine2 is typically "City, ST, ZIP" or "City, ST ZIP"
  let city = null, state = null, zip = null
  if (loc.addressLine2) {
    const parts = loc.addressLine2.split(',').map(s => s.trim())
    if (parts.length >= 2) {
      city = parts[0] || null
      // Second part may be "OH, 44308" or "OH 44308"
      const stateZip = parts.slice(1).join(' ').trim()
      const szMatch  = stateZip.match(/^([A-Z]{2})\s*,?\s*(\d{5})?/)
      if (szMatch) {
        state = szMatch[1]
        zip   = szMatch[2] || null
      }
    }
  }

  // Prefer markerLat/markerLng (actual pin) over mapLat/mapLng (viewport center)
  const lat = loc.markerLat ?? loc.mapLat ?? null
  const lng = loc.markerLng ?? loc.mapLng ?? null

  return { name, address, city, state, zip, lat, lng }
}

// ── Event normalisation ───────────────────────────────────────────────────

/**
 * Convert a raw Squarespace event item into the common row shape used
 * by our upsert pipeline.
 *
 * @param {object} item    — Raw item from fetchSquarespaceEvents()
 * @param {object} config  — Per-org configuration:
 *   @param {string}   config.source       — scraper source key (e.g. 'leadership_akron')
 *   @param {Function} [config.mapCategory]— (item) → category string  (default: 'community')
 *   @param {Function} [config.mapTags]    — (item) → string[]          (default: [])
 *   @param {number}   [config.defaultPriceMin] — fallback price_min   (default: 0)
 *   @param {number|null} [config.defaultPriceMax] — fallback price_max (default: null)
 *   @param {string}   [config.ageRestriction]  — default age_restriction (default: 'not_specified')
 * @returns {object}       — Event row ready for upsertEventSafe()
 */
export function normaliseSquarespaceEvent(item, config = {}) {
  const {
    source            = 'squarespace',
    mapCategory       = () => 'community',
    mapTags           = () => [],
    defaultPriceMin   = 0,
    defaultPriceMax   = null,
    ageRestriction    = 'not_specified',
  } = config

  // Squarespace dates are epoch milliseconds
  const startAt = item.startDate ? new Date(item.startDate).toISOString() : null
  const endAt   = item.endDate   ? new Date(item.endDate).toISOString()   : null

  // Body is HTML; excerpt is plain text
  const description = item.body
    ? stripHtml(item.body)
    : item.excerpt?.trim() || null

  // Image URL
  const imageUrl = item.assetUrl || null

  // Ticket / detail URL
  const baseUrl   = item.fullUrl || null
  const sourceUrl = item.sourceUrl || null

  return {
    title:           item.title?.trim() || null,
    description,
    start_at:        startAt,
    end_at:          endAt,
    category:        mapCategory(item),
    tags:            mapTags(item),
    price_min:       defaultPriceMin,
    price_max:       defaultPriceMax,
    age_restriction: ageRestriction,
    image_url:       imageUrl,
    ticket_url:      sourceUrl || baseUrl,
    source,
    source_id:       item.id || item.urlId || null,
    status:          'published',
    featured:        item.starred ?? false,
  }
}

/**
 * Build the full public URL for a Squarespace event item.
 *
 * @param {string} siteBaseUrl — e.g. "https://www.leadershipakron.org"
 * @param {object} item        — Raw Squarespace event item
 * @returns {string|null}
 */
export function buildSquarespaceEventUrl(siteBaseUrl, item) {
  if (!item.fullUrl) return null
  return `${siteBaseUrl.replace(/\/$/, '')}${item.fullUrl}`
}
