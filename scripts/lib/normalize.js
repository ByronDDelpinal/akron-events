/**
 * Shared normalization utilities for ingestion scripts.
 * Each source maps its raw data into this common shape before upsert.
 *
 * v2: Updated for junction-table schema (event_venues, event_organizations,
 *     event_areas) and manual_overrides protection.
 */

import { supabaseAdmin } from './supabase-admin.js'
import { getImageDimensions } from './image-dimensions.js'
import { normalizeImageUrl } from './image-url-normalizer.js'

// ════════════════════════════════════════════════════════════════════════════
// HTML / TEXT UTILITIES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Strip HTML tags and decode ALL HTML entities from a string.
 */
/** Map of common named HTML entities to their characters. */
const NAMED_ENTITIES = {
  amp: '&', nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'",
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', lsquo: '\u2018',
  rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D', bull: '\u2022',
  copy: '\u00A9', reg: '\u00AE', trade: '\u2122', deg: '\u00B0',
  times: '\u00D7', divide: '\u00F7', rarr: '\u2192', larr: '\u2190',
  frac12: '\u00BD', frac14: '\u00BC', frac34: '\u00BE',
}

/**
 * Decode HTML character entities — numeric (`&#39;`), hex (`&#x27;`),
 * and named (`&amp;`, `&nbsp;`, etc.) — back to their literal
 * characters. Exported because tags (which are not HTML-stripped)
 * still benefit from entity decoding so values like "health &amp;
 * fitness" land in the DB as "health & fitness".
 */
export function decodeEntities(str) {
  if (!str) return str
  return String(str)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (match, name) => NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

/**
 * Remove HTML constructs whose *contents* are not human-readable text:
 * <style>, <script>, <noscript> blocks, and HTML comments. The naive
 * /<[^>]*>/ tag stripper used below only removes delimiters and would
 * otherwise leak inline CSS rules and JS code into descriptions.
 * Run this BEFORE the tag stripper, not after.
 */
function stripDangerousBlocks(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(style|script|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
}

export function stripHtml(html = '') {
  return decodeEntities(
    stripDangerousBlocks(html).replace(/<[^>]*>/g, ' ')
  )
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Convert HTML to structured plain text, preserving paragraph breaks and lists.
 */
export function htmlToText(html = '') {
  return decodeEntities(
    stripDangerousBlocks(html)
      .replace(/<br\s*\/?>/gi,   '\n')
      .replace(/<\/p>/gi,        '\n\n')
      .replace(/<\/h[1-6]>/gi,   '\n\n')
      .replace(/<\/li>/gi,       '\n')
      .replace(/<li[^>]*>/gi,    '\n• ')
      .replace(/<\/ul>/gi,       '\n')
      .replace(/<\/ol>/gi,       '\n')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[ \t]+/g,   ' ')
    .replace(/\n{3,}/g,   '\n\n')
    .replace(/^ +| +$/gm, '')
    .trim()
}

// ════════════════════════════════════════════════════════════════════════════
// EVENTBRITE HELPERS
// ════════════════════════════════════════════════════════════════════════════

export const EVENTBRITE_CATEGORY_MAP = {
  '103': 'music',
  '105': 'art',
  '110': 'food',
  '113': 'community',
  '115': 'nonprofit',
  '107': 'fitness',
  '102': 'education',
  '101': 'education',
  '108': 'fitness',
  '104': 'art',
  '109': 'community',
  '111': 'community',
  '112': 'education',
  '114': 'community',
}

/**
 * Map Eventbrite's human-readable category/subcategory strings (as they
 * appear on the public event detail page) to our taxonomy. The /v3/events
 * API requires auth, but the detail-page HTML exposes these strings for
 * free under `"category":"…","subcategory":"…"`. Subcategory is tried
 * first since it's more specific.
 */
export const EVENTBRITE_CATEGORY_NAME_MAP = {
  // Top-level
  'music':                     'music',
  'performing & visual arts':  'art',
  'film, media & entertainment': 'art',
  'food & drink':              'food',
  'health':                    'fitness',
  'sports & fitness':          'fitness',
  'family & education':        'education',
  'science & technology':      'education',
  'business':                  'education',
  'travel & outdoor':          'nature',
  'community':                 'community',
  'charity & causes':          'nonprofit',
  'religion & spirituality':   'community',
  'government':                'community',
  // A few common subcategories that disambiguate when top-level is generic
  'concerts':                  'music',
  'theatre':                   'art',
  'comedy':                    'art',
  'visual arts':               'art',
  'fine art':                  'art',
  'dance':                     'art',
  'metal':                     'music',
  'rock':                      'music',
  'jazz':                      'music',
  'classical':                 'music',
  'country':                   'music',
  'r&b':                       'music',
  'hip hop / rap':             'music',
  'electronic':                'music',
  'indie':                     'music',
  'folk':                      'music',
  'blues':                     'music',
  'pop':                       'music',
  'opera':                     'art',
  'fitness':                   'fitness',
  'yoga':                      'fitness',
  'running':                   'fitness',
  'cycling':                   'fitness',
  'outdoor & nature':          'nature',
  'hiking':                    'nature',
}

/**
 * Pick a valid event category from raw Eventbrite category / subcategory
 * strings. Returns null when neither maps cleanly so the caller can fall
 * back to text inference.
 */
export function categoryFromEventbriteNames(categoryName, subcategoryName) {
  const norm = s => (s || '').toLowerCase().trim()
  return EVENTBRITE_CATEGORY_NAME_MAP[norm(subcategoryName)]
      ?? EVENTBRITE_CATEGORY_NAME_MAP[norm(categoryName)]
      ?? null
}

// ════════════════════════════════════════════════════════════════════════════
// TEXT-BASED CATEGORY INFERENCE
// ════════════════════════════════════════════════════════════════════════════
//
// Many event sources (Eventbrite's search-result JSON, some ICS feeds) don't
// give us a category. This heuristic reads the title + description and picks
// the best match. Returns 'other' when nothing matches, so callers can
// distinguish "we tried and don't know" from "we know it's miscellaneous."
//
// Pattern order matters: specific signals (concert/tribute/EP release) win
// over generic ones (band/tour/show). Calibrated against ~250 already-
// labeled Akron events and ~250 currently-'other' Eventbrite events.

// The text→category classifier moved to its own pure module (no DB/env deps)
// and was rebuilt from a first-match-wins regex cascade into a SCORED
// classifier. Re-exported here so the many `import { inferCategory } from
// './lib/normalize.js'` call sites across the scrapers keep working unchanged.
// See scripts/lib/category-inference.js for the signal table and weights.
export { inferCategory, scoreCategories } from './category-inference.js'

export function parseEventbritePrice(ticketClasses = [], isFree = false) {
  if (isFree) return { price_min: 0, price_max: 0 }
  const prices = ticketClasses
    .filter(tc => !tc.free && tc.cost?.major_value != null)
    .map(tc => parseFloat(tc.cost.major_value))
    .filter(p => !isNaN(p) && p > 0)
  if (prices.length === 0) return { price_min: null, price_max: null }
  const min = Math.min(...prices)
  const max = Math.max(...prices)
  return { price_min: min, price_max: max > min ? max : null }
}

// ════════════════════════════════════════════════════════════════════════════
// IMAGE DIMENSION ENRICHMENT
// ════════════════════════════════════════════════════════════════════════════

/**
 * Enriches a row with image metadata: width, height, file size.
 *
 * Also runs the per-source URL normalizer first, so the URL we probe AND
 * the URL we store is the highest-resolution variant the source serves.
 * Sources without a known transform are pass-through (the normalizer
 * just returns the original URL).
 *
 * Probe-failure recovery: some origins (e.g. Cloudflare-protected
 * akronsymphony.org) block our datacenter-IP probes with HTTP 403 even
 * though a browser can load the image fine. If the probe fails AND the
 * image_url hasn't changed since the previous scrape, we preserve the
 * dimensions already stored in the DB rather than overwriting them with
 * null. Without this, a single Cloudflare challenge would erase good
 * dimension data captured from a friendlier IP on a prior run.
 */
/**
 * Fetch an event detail page and pull a usable description out of any
 * Schema.org Event JSON-LD block embedded in the HTML.
 *
 * Why centralized: many of our sources (Eventbrite, museum CMSes, the
 * University of Akron's LiveWhale calendar, WordPress sites with the
 * "Events Schema" plugin) ship with `<script type="application/ld+json">
 * { "@type": "Event", "description": "..." }` even when their listing-
 * API descriptions are empty. This single helper lets any scraper say
 * "if the listing didn't give me a description, ask the detail page"
 * without each one re-implementing the same JSON-LD walk + try/catch.
 *
 * Returns the trimmed plain-text description, or null if the fetch
 * fails, no Event schema is present, or the field is empty. Never
 * throws — callers can safely `?? ''` the result.
 */
export async function fetchSchemaDescription(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; AkronEventsBot/1.0)' },
      redirect: 'follow',
    })
    if (!res.ok) return null
    const html = await res.text()
    const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    let m
    while ((m = scriptRe.exec(html)) !== null) {
      try {
        const parsed = JSON.parse(m[1].trim())
        const schemas = Array.isArray(parsed) ? parsed : [parsed]
        for (const s of schemas) {
          // Handle both single objects and @graph arrays.
          const entries = s && s['@graph'] ? s['@graph']
            : Array.isArray(s) ? s : [s]
          for (const e of entries) {
            if (e && (e['@type'] === 'Event' || (Array.isArray(e['@type']) && e['@type'].includes('Event')))) {
              if (typeof e.description === 'string' && e.description.trim()) {
                return stripHtml(e.description).trim()
              }
            }
          }
        }
      } catch { /* invalid JSON, keep scanning */ }
    }
    return null
  } catch {
    return null
  }
}

export async function enrichWithImageDimensions(row) {
  if (!await _hasImageDimensionColumns()) return row
  if (!row.image_url) {
    return { ...row, image_width: null, image_height: null, image_file_size: null }
  }
  const normalizedUrl = normalizeImageUrl(row.image_url, row.source)
  const meta = await getImageDimensions(normalizedUrl)

  if (meta) {
    return {
      ...row,
      image_url:       normalizedUrl,
      image_width:     meta.width    ?? null,
      image_height:    meta.height   ?? null,
      image_file_size: meta.fileSize ?? null,
    }
  }

  // Probe failed — try to keep previously-captured dimensions if the URL
  // is unchanged for this (source, source_id). This guards against bot
  // detection / transient origin errors silently degrading our data.
  const existing = await _getExistingImageMeta(row.source, row.source_id)
  if (existing && existing.image_url === normalizedUrl) {
    return {
      ...row,
      image_url:       normalizedUrl,
      image_width:     existing.image_width,
      image_height:    existing.image_height,
      image_file_size: existing.image_file_size,
    }
  }

  return {
    ...row,
    image_url:       normalizedUrl,
    image_width:     null,
    image_height:    null,
    image_file_size: null,
  }
}

/**
 * Fetch the previously-stored image fields for a (source, source_id) tuple.
 * Returns null if the event doesn't exist yet or on query failure.
 */
async function _getExistingImageMeta(source, sourceId) {
  if (!source || !sourceId) return null
  try {
    const { data, error } = await supabaseAdmin
      .from('events')
      .select('image_url, image_width, image_height, image_file_size')
      .eq('source', source)
      .eq('source_id', String(sourceId))
      .maybeSingle()
    if (error || !data) return null
    return data
  } catch {
    return null
  }
}

// Cache for the column-existence probe. We're checking both image_width
// (the original gate) and image_file_size (new) — they were added in
// separate migrations so either may be missing in older deployments.
let _dimColumnsCache = null
async function _hasImageDimensionColumns() {
  if (_dimColumnsCache !== null) return _dimColumnsCache
  try {
    const { error } = await supabaseAdmin.from('events').select('image_width').limit(1)
    _dimColumnsCache = !error
  } catch { _dimColumnsCache = false }
  return _dimColumnsCache
}

// ════════════════════════════════════════════════════════════════════════════
// EASTERN TIMEZONE CONVERSION
// ════════════════════════════════════════════════════════════════════════════

/** Get the nth occurrence of dayOfWeek (0=Sun) in a given month. */
function nthWeekdayOfMonth(year, month, dayOfWeek, n) {
  const first = new Date(Date.UTC(year, month, 1))
  const offset = (dayOfWeek - first.getUTCDay() + 7) % 7
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7))
}

/** Returns true if the given UTC date falls during Eastern Daylight Time. */
function isEasternDST(utcDate) {
  const y = utcDate.getUTCFullYear()
  const dstStart = nthWeekdayOfMonth(y, 2, 0, 2)  // 2nd Sunday in March
  const dstEnd   = nthWeekdayOfMonth(y, 10, 0, 1) // 1st Sunday in November
  return utcDate >= dstStart && utcDate < dstEnd
}

/**
 * Convert an Eastern-local time string ("YYYY-MM-DD HH:MM:SS") to ISO 8601 UTC.
 * Correctly handles EST (UTC-5) vs EDT (UTC-4) transitions.
 */
export function easternToIso(localDateStr) {
  if (!localDateStr) return null
  const [datePart, timePart = '00:00:00'] = localDateStr.split(' ')
  const [year, month, day]        = datePart.split('-').map(Number)
  const [hour, minute, second = 0] = timePart.split(':').map(Number)
  if (!year || !month || !day) return null
  const localUtcMs = Date.UTC(year, month - 1, day, hour, minute, second)
  const approxUtc = new Date(localUtcMs + 5 * 3600_000)
  const offsetHours = isEasternDST(approxUtc) ? 4 : 5
  return new Date(localUtcMs + offsetHours * 3600_000).toISOString()
}

// ════════════════════════════════════════════════════════════════════════════
// TRIBE EVENTS CALENDAR (WordPress) — SHARED PARSERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse a cost string/details object from a Tribe Events Calendar API response.
 * Returns { price_min, price_max }.
 */
export function parseCostFromTribe(cost = '', costDetails = {}) {
  const values = costDetails.values ?? []
  if (values.length) {
    const nums = values.map(Number).filter(n => !isNaN(n))
    if (nums.length) {
      const min = Math.min(...nums)
      const max = Math.max(...nums)
      return { price_min: min, price_max: max > min ? max : null }
    }
  }
  if (cost && cost.toLowerCase().includes('free')) return { price_min: 0, price_max: null }
  if (!cost) return { price_min: null, price_max: null }
  const numbers = cost.match(/\d+(\.\d+)?/g)?.map(Number)
  if (!numbers?.length) return { price_min: null, price_max: null }
  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  return { price_min: min, price_max: max > min ? max : null }
}

/**
 * Build a tags array from Tribe Events Calendar categories and tags arrays.
 * Optionally appends extra static tags (e.g. ['parks','outdoors']).
 */
export function parseTagsFromTribe(categories = [], tags = [], extraTags = []) {
  const all = [
    ...categories.map(c => c.name?.toLowerCase()).filter(Boolean),
    ...tags.map(t => t.name?.toLowerCase()).filter(Boolean),
    ...extraTags,
  ]
  return [...new Set(all)]
}

// ════════════════════════════════════════════════════════════════════════════
// SHARED ORGANIZATION LOOKUP / CREATION
// ════════════════════════════════════════════════════════════════════════════

const _orgNameCache = new Map() // name → orgId

/**
 * Find or create an organization by name. Uses exact name match.
 *
 * @param {string} name     — Organization name (required)
 * @param {object} details  — Optional org fields: website, description, image_url,
 *                            address, city, state, zip
 * @returns {string|null}   — organization UUID or null on failure
 */
export async function ensureOrganization(name, details = {}) {
  if (!name) return null
  const trimmed = name.trim()
  if (!trimmed) return null

  // Drop malformed website strings before they reach the DB. See
  // sanitizeWebsite() in this file for rationale.
  if (details.website !== undefined) {
    details = { ...details, website: sanitizeWebsite(details.website) }
  }

  if (_orgNameCache.has(trimmed)) return _orgNameCache.get(trimmed)

  const { data: existing } = await supabaseAdmin
    .from('organizations').select('id, website, description, image_url, address, city, state, zip').eq('name', trimmed).maybeSingle()

  if (existing) {
    // Non-destructively update null fields on the existing org record.
    // Only sets a field if the incoming details have a value AND the DB row is currently empty.
    // This mirrors the same pattern used in ensureVenue.
    const updates = {}
    if (details.website     && !existing.website)     updates.website     = details.website
    if (details.description && !existing.description) updates.description = details.description
    if (details.image_url   && !existing.image_url)   updates.image_url   = details.image_url
    if (details.address     && !existing.address)     updates.address     = details.address
    if (details.city        && !existing.city)        updates.city        = details.city
    if (details.state       && !existing.state)       updates.state       = details.state
    if (details.zip         && !existing.zip)         updates.zip         = details.zip
    if (Object.keys(updates).length) {
      await supabaseAdmin.from('organizations').update(updates).eq('id', existing.id)
    }
    _orgNameCache.set(trimmed, existing.id)
    return existing.id
  }

  // Build insert payload, omitting null/undefined values so Postgres
  // uses column defaults (city NOT NULL DEFAULT 'Akron', etc.)
  const row = { name: trimmed }
  if (details.website)     row.website     = details.website
  if (details.description) row.description = details.description
  if (details.image_url)   row.image_url   = details.image_url
  if (details.address)     row.address     = details.address
  if (details.city)        row.city        = details.city
  if (details.state)       row.state       = details.state
  if (details.zip)         row.zip         = details.zip

  const { data, error } = await supabaseAdmin
    .from('organizations').insert(row).select('id').single()

  if (error) {
    console.warn(`  ⚠ Could not create organization "${trimmed}":`, error.message)
    _orgNameCache.set(trimmed, null)
    return null
  }

  console.log(`  ✚ Created organization: ${trimmed}`)
  _orgNameCache.set(trimmed, data.id)
  return data.id
}

// ════════════════════════════════════════════════════════════════════════════
// SHARED VENUE LOOKUP / CREATION
// ════════════════════════════════════════════════════════════════════════════

const _venueNameCache = new Map() // name → venueId

/**
 * Find or create a venue by name. Uses exact name match.
 * If the venue doesn't exist, creates a minimal record with only the info
 * supplied — no org-specific defaults are injected.
 *
 * @param {string} name    — Venue name (required)
 * @param {object} details — Optional venue fields: address, city, state, zip,
 *                           lat, lng, parking_type, parking_notes, website, description, tags
 * @returns {string|null}  — venue UUID or null on failure
 */
/**
 * Defensive URL-shape check used by ensureVenue/ensureOrganization.
 *
 * Several upstream feeds (notably Simpleview's "hostname" field and
 * Tribe Events Calendar's user-editable venue.website) routinely
 * deliver freeform text where a URL is expected. Past versions of the
 * scrapers blindly wrapped that text with "https://" and persisted
 * rows like `website = "https://Bath Business Association"` — which
 * then rendered as broken links on event detail pages. We accept a
 * value only when it parses as a URL whose host has at least one dot
 * and contains no whitespace. Everything else is silently dropped to
 * null so the scrapers can keep passing whatever shape the source
 * gives us without re-implementing this check at each call site.
 */
function sanitizeWebsite(value) {
  if (value == null) return null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  // Require http(s) prefix; if missing, try prepending https:// before validating
  // so user-entered "example.com" still passes.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let host
  try {
    host = new URL(withScheme).hostname
  } catch {
    return null
  }
  // Hostnames must contain a dot, no whitespace, and only valid label chars.
  if (!host || /\s/.test(host) || !host.includes('.')) return null
  if (!/^[a-z0-9.-]+$/i.test(host)) return null
  return withScheme
}

export async function ensureVenue(name, details = {}) {
  if (!name) return null
  const trimmed = name.trim()
  if (!trimmed) return null

  // Drop malformed website strings before they reach the DB. See
  // sanitizeWebsite() for rationale.
  if (details.website !== undefined) {
    details = { ...details, website: sanitizeWebsite(details.website) }
  }

  if (_venueNameCache.has(trimmed)) return _venueNameCache.get(trimmed)

  const { data: existing } = await supabaseAdmin
    .from('venues').select('id').eq('name', trimmed).maybeSingle()

  if (existing) {
    // Update details on existing venue (e.g. corrected coordinates)
    const updates = {}
    if (details.address)       updates.address       = details.address
    if (details.city)          updates.city          = details.city
    if (details.state)         updates.state         = details.state
    if (details.zip)           updates.zip           = details.zip
    if (details.lat != null)   updates.lat           = details.lat
    if (details.lng != null)   updates.lng           = details.lng
    if (details.parking_type)  updates.parking_type  = details.parking_type
    if (details.parking_notes) updates.parking_notes = details.parking_notes
    if (details.website)       updates.website       = details.website
    if (details.description)   updates.description   = details.description
    if (details.tags?.length)  updates.tags          = details.tags
    if (Object.keys(updates).length) {
      await supabaseAdmin.from('venues').update(updates).eq('id', existing.id)
    }
    _venueNameCache.set(trimmed, existing.id)
    return existing.id
  }

  // Build insert payload, omitting null/undefined values so Postgres
  // uses column defaults (city NOT NULL DEFAULT 'Akron', etc.)
  const row = { name: trimmed }
  if (details.address)       row.address       = details.address
  if (details.city)          row.city          = details.city
  if (details.state)         row.state         = details.state
  if (details.zip)           row.zip           = details.zip
  if (details.lat != null)   row.lat           = details.lat
  if (details.lng != null)   row.lng           = details.lng
  if (details.parking_type)  row.parking_type  = details.parking_type
  if (details.parking_notes) row.parking_notes = details.parking_notes
  if (details.website)       row.website       = details.website
  if (details.description)   row.description   = details.description
  if (details.tags?.length)  row.tags          = details.tags

  const { data, error } = await supabaseAdmin
    .from('venues').insert(row).select('id').single()

  if (error) {
    console.warn(`  ⚠ Could not create venue "${trimmed}":`, error.message)
    _venueNameCache.set(trimmed, null)
    return null
  }

  console.log(`  ✚ Created venue: ${trimmed}`)
  _venueNameCache.set(trimmed, data.id)
  return data.id
}

// ════════════════════════════════════════════════════════════════════════════
// MANUAL OVERRIDES — SCRAPER-SAFE UPSERT
// ════════════════════════════════════════════════════════════════════════════

/**
 * Upsert an event row while respecting manual_overrides.
 *
 * 1. Check if a row with this (source, source_id) already exists.
 * 2. If it does, read its manual_overrides and strip any overridden fields
 *    from the incoming data so the scraper doesn't clobber manual edits.
 * 3. Upsert the (possibly reduced) row.
 *
 * @param {object} row — full event row (without venue_id/organizer_id — those
 *                       are now in junction tables)
 * @returns {{ data, error, isNew: boolean }}
 */
/**
 * Sanitize text fields on an event row before upsert.
 * Decodes HTML entities and strips stray tags from title and description.
 * Exported so tests can verify the same logic without hitting the DB.
 */
export function sanitizeEventText(row) {
  return {
    ...row,
    title:       row.title       ? stripHtml(row.title)       : row.title,
    // Use htmlToText for descriptions so paragraph breaks (\n\n) and list
    // markers are preserved. stripHtml collapses all whitespace to a single
    // space, which flattens multi-paragraph descriptions into one long string.
    description: row.description ? htmlToText(row.description) : row.description,
    // Tags come from source `categories` arrays and aren't HTML, but
    // some upstream feeds emit values like "health &amp; fitness" with
    // entities intact. Decode each entry so the DB never stores
    // entity-encoded text.
    tags: Array.isArray(row.tags)
      ? row.tags
          .map(t => (typeof t === 'string' ? decodeEntities(t).trim() : t))
          .filter(Boolean)
      : row.tags,
  }
}

export async function upsertEventSafe(row) {
  // Sanitize text fields — decode HTML entities and strip any stray tags.
  // This catches cases where scrapers pass raw API titles containing entities
  // like &#8217; or &amp; that would otherwise appear verbatim in the DB.
  const sanitized = sanitizeEventText(row)

  // Default `source_url` to `ticket_url` so every event has at least one
  // canonical outbound link on the source's site. The frontend prefers
  // ticket_url for the primary "Get Tickets / Register" CTA and falls
  // back to source_url when no direct ticketing link exists — many
  // sources publish events with registration details inline rather than
  // a separate purchase URL, and without this guarantee those events
  // would render with no actionable link at all. Scrapers can still set
  // source_url explicitly when the source page and ticket page differ
  // (e.g. visit_akron_cvb, where the CVB detail page lives on
  // visitakron-summit.org but the registration link points elsewhere).
  if (sanitized.source_url == null && sanitized.ticket_url) {
    sanitized.source_url = sanitized.ticket_url
  }

  // Auto-flag low-confidence categorizations for admin review.
  // If the scraper didn't already set needs_review and the final category is
  // 'other' (meaning nothing in the source map or inferCategory matched), mark
  // it for the review queue so a human can correct it before users see it.
  if (sanitized.needs_review === undefined && sanitized.category === 'other') {
    sanitized.needs_review = true
  }
  // Explicit non-'other' category → confident, clear any stale flag.
  if (sanitized.needs_review === undefined && sanitized.category !== 'other') {
    sanitized.needs_review = false
  }

  const safeRow = await _stripOverriddenFields('events', sanitized)
  const { data, error } = await supabaseAdmin
    .from('events')
    .upsert(safeRow, { onConflict: 'source,source_id', ignoreDuplicates: false })
    .select('id')
    .single()
  return { data, error, isNew: !error && !!data }
}

/**
 * After upserting an event, link it to a venue via the event_venues junction.
 * Idempotent — uses ON CONFLICT DO NOTHING.
 */
export async function linkEventVenue(eventId, venueId) {
  if (!eventId || !venueId) return
  const { error } = await supabaseAdmin
    .from('event_venues')
    .upsert({ event_id: eventId, venue_id: venueId }, { onConflict: 'event_id,venue_id', ignoreDuplicates: true })
  if (error) console.warn(`  ⚠ linkEventVenue failed: ${error.message}`)
}

/**
 * After upserting an event, link it to an organization via event_organizations.
 * Idempotent.
 */
export async function linkEventOrganization(eventId, organizationId) {
  if (!eventId || !organizationId) return
  const { error } = await supabaseAdmin
    .from('event_organizations')
    .upsert({ event_id: eventId, organization_id: organizationId }, { onConflict: 'event_id,organization_id', ignoreDuplicates: true })
  if (error) console.warn(`  ⚠ linkEventOrganization failed: ${error.message}`)
}

/**
 * After upserting an event, link it to an area via event_areas.
 * Idempotent.
 */
export async function linkEventArea(eventId, areaId) {
  if (!eventId || !areaId) return
  const { error } = await supabaseAdmin
    .from('event_areas')
    .upsert({ event_id: eventId, area_id: areaId }, { onConflict: 'event_id,area_id', ignoreDuplicates: true })
  if (error) console.warn(`  ⚠ linkEventArea failed: ${error.message}`)
}

/**
 * Set the organization_id on a venue to express ownership.
 * Only sets if the venue's organization_id is currently null (doesn't overwrite
 * an existing ownership claim).
 */
export async function linkOrganizationVenue(organizationId, venueId) {
  if (!organizationId || !venueId) return
  const { error } = await supabaseAdmin
    .from('venues')
    .update({ organization_id: organizationId })
    .eq('id', venueId)
    .is('organization_id', null)
  if (error) console.warn(`  ⚠ linkOrganizationVenue failed: ${error.message}`)
}

/**
 * Internal: fetch the existing row's manual_overrides and strip any
 * overridden fields from the incoming scraper data.
 */
async function _stripOverriddenFields(table, row) {
  // Only events have source/source_id for lookup
  if (table !== 'events' || !row.source || !row.source_id) return row

  try {
    const { data: existing } = await supabaseAdmin
      .from('events')
      .select('manual_overrides')
      .eq('source', row.source)
      .eq('source_id', row.source_id)
      .maybeSingle()

    if (!existing?.manual_overrides) return row

    const overrides = existing.manual_overrides
    const filtered = { ...row }
    for (const field of Object.keys(overrides)) {
      if (field in filtered && field !== 'source' && field !== 'source_id') {
        delete filtered[field]
      }
    }
    return filtered
  } catch {
    // If lookup fails, proceed with full row (safe default)
    return row
  }
}

// ════════════════════════════════════════════════════════════════════════════
// HEALTH LOGGING
// ════════════════════════════════════════════════════════════════════════════

/**
 * Log a summary of an upsert result to the console AND write a row to
 * the scraper_runs table for health monitoring.
 */
export async function logUpsertResult(source, inserted, updated, skipped, opts = {}) {
  const {
    status       = 'success',
    errorMessage = null,
    durationMs   = null,
  } = opts

  const eventsFound = opts.eventsFound ?? (inserted + updated + skipped)

  const icon = status === 'error' ? '❌' : '✓'
  console.log(
    `[${source}] ${icon}  ${inserted} inserted  ${updated} updated  ${skipped} skipped` +
    (eventsFound !== inserted + updated + skipped ? `  (${eventsFound} total from source)` : '') +
    (durationMs != null ? `  [${(durationMs / 1000).toFixed(1)}s]` : '')
  )

  try {
    const { error } = await supabaseAdmin
      .from('scraper_runs')
      .insert({
        scraper_name:    source,
        status,
        events_found:    eventsFound,
        events_inserted: inserted,
        events_updated:  updated,
        events_skipped:  skipped,
        error_message:   errorMessage,
        duration_ms:     durationMs,
      })
    if (error) console.warn(`  ⚠ Health log write failed for ${source}:`, error.message)
  } catch (err) {
    console.warn(`  ⚠ Health log exception for ${source}:`, err.message)
  }
}

/**
 * Convenience wrapper for fatal scraper errors.
 */
export async function logScraperError(source, err, startMs = null) {
  console.error(`\n❌  Fatal error [${source}]:`, err.message)
  const durationMs = startMs != null ? Date.now() - startMs : null
  await logUpsertResult(source, 0, 0, 0, {
    status:       'error',
    errorMessage: err.message,
    durationMs,
    eventsFound:  0,
  })
}
