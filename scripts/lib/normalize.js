/**
 * Shared normalization utilities for ingestion scripts.
 * Each source maps its raw data into this common shape before upsert.
 *
 * v2: Updated for junction-table schema (event_venues, event_organizations,
 *     event_areas) and manual_overrides protection.
 */

import { supabaseAdmin } from './supabase-admin.js'
import { screenEvent } from './content-moderation.js'
import { getImageDimensions } from './image-dimensions.js'
import { normalizeImageUrl } from './image-url-normalizer.js'
import { resolveNeighborhoodSlug } from './neighborhood-resolver.js'
import { inferCategories as _inferCategories } from './category-inference.js'
import { V1_TO_V2, CATEGORY_SLUGS } from '../../src/lib/categories.js'
import { defaultCategoryFor } from '../manifest.js'
import { fallbackImageFor } from './fallback-images.js'

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

// Numeric category_id → v2 slug. The search JSON rarely exposes category_id
// (the detail-page name map below is the workhorse), and several of the old
// entries disagreed with Eventbrite's published v3 taxonomy (104 = Film,
// Media & Entertainment; 109 = Travel & Outdoor; 111 = Charity & Causes;
// 112 = Government & Politics; 115 = Family & Education). Only IDs with an
// unambiguous v2 home are mapped; the rest fall through to the name map /
// inference. See docs/tagging-audit-2026-06.md (eventbrite section) — confirm
// assignments from logged (category_id, category_string) pairs before adding
// entries back.
export const EVENTBRITE_CATEGORY_MAP = {
  '101': 'learning',   // Business & Professional
  '102': 'learning',   // Science & Technology
  '103': 'music',      // Music
  '104': 'film',       // Film, Media & Entertainment
  '107': 'fitness',    // Health & Wellness
  '108': 'sports',     // Sports & Fitness
  '110': 'food',       // Food & Drink
  '112': 'civic',      // Government & Politics
  '115': 'learning',   // Family & Education
  // 105 (Performing & Visual Arts), 109 (Travel & Outdoor), 111 (Charity &
  // Causes), 113 (Community & Culture), 114 (Religion & Spirituality):
  // ambiguous or facet-shaped — defer to the name map and text inference.
}

/**
 * Map Eventbrite's human-readable category/subcategory strings (as they
 * appear on the public event detail page) to our taxonomy. The /v3/events
 * API requires auth, but the detail-page HTML exposes these strings for
 * free under `"category":"…","subcategory":"…"`. Subcategory is tried
 * first since it's more specific.
 */
export const EVENTBRITE_CATEGORY_NAME_MAP = {
  // Top-level. 'performing & visual arts' is deliberately ABSENT: it spans
  // theater, dance, opera, galleries — the subcategory (tried first) or text
  // inference decides; scrape-eventbrite falls back to visual-art only when
  // both come up empty. 'charity & causes' and 'community' are facet-shaped
  // rather than content categories: scrape-eventbrite derives is_fundraiser /
  // is_family from the raw strings and lets inference pick the content.
  'music':                     'music',
  'film, media & entertainment': 'film',
  'food & drink':              'food',
  'health':                    'fitness',
  'sports & fitness':          'sports',
  'family & education':        'learning',
  'science & technology':      'learning',
  'business':                  'learning',
  'travel & outdoor':          'outdoors',
  'government':                'civic',
  // A few common subcategories that disambiguate when top-level is generic
  'concerts':                  'music',
  'theatre':                   'theater',
  'comedy':                    'comedy',
  'visual arts':               'visual-art',
  'fine art':                  'visual-art',
  'dance':                     'theater',
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
  'opera':                     'theater',
  'fitness':                   'fitness',
  'yoga':                      'fitness',
  'running':                   'fitness',
  'cycling':                   'fitness',
  'outdoor & nature':          'outdoors',
  'hiking':                    'outdoors',
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
export { inferCategory, inferCategories, scoreCategories } from './category-inference.js'

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
  // Sources whose platform structurally can't supply a per-event photo get a
  // curated static fallback (scripts/lib/fallback-images.js) — a no-op until
  // Byron fills one in. Never overrides a real image_url from the scraper.
  const sourceImageUrl = row.image_url || fallbackImageFor(row.source)
  if (!sourceImageUrl) {
    return { ...row, image_width: null, image_height: null, image_file_size: null }
  }
  const normalizedUrl = normalizeImageUrl(sourceImageUrl, row.source)
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
 * Parse a clock token into { hour, minute, second }, or null if no time is found.
 * Accepts 24-hour ("19:30:00", "19:30") and 12-hour ("7:30 pm", "7:30pm",
 * "7 pm", "10 a.m.") formats. Returns null for empty/timeless input so callers
 * can default deliberately rather than silently landing on midnight.
 */
function parseClockToken(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  const nums = s.match(/(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?/)
  if (!nums) return null
  let hour = parseInt(nums[1], 10)
  const minute = nums[2] != null ? parseInt(nums[2], 10) : 0
  const second = nums[3] != null ? parseInt(nums[3], 10) : 0
  if (Number.isNaN(hour)) return null
  const ampm = s.match(/(a\.?m\.?|p\.?m\.?)/i)
  if (ampm) {
    const isPm = /^p/i.test(ampm[1])
    if (isPm && hour !== 12) hour += 12
    if (!isPm && hour === 12) hour = 0
  }
  return { hour, minute, second }
}

/**
 * Convert an Eastern-local datetime to ISO 8601 UTC, correctly handling
 * EST (UTC-5) vs EDT (UTC-4) transitions.
 *
 * Two equivalent call forms are supported:
 *   easternToIso('2026-06-13 10:00:00')   // combined "YYYY-MM-DD HH:MM[:SS]"
 *   easternToIso('2026-06-13', '10:00:00') // separate date + time args
 *
 * The time portion accepts 24-hour or 12-hour (am/pm) formats. A second
 * argument is REQUIRED to be honored — historically passing a 2nd arg was
 * silently ignored, which dropped the time and produced midnight timestamps.
 * Missing/blank time defaults to midnight (date-only behavior).
 */
export function easternToIso(dateInput, timeInput) {
  if (!dateInput) return null

  let datePart, timeToken
  if (timeInput != null && String(timeInput).trim() !== '') {
    // Two-arg form: take the date portion of arg1, time from arg2.
    datePart  = String(dateInput).trim().split(/[ T]/)[0]
    timeToken = String(timeInput).trim()
  } else {
    // Combined form: split date from an optional trailing time.
    const combined = String(dateInput).trim()
    const sep = combined.search(/[ T]/)
    datePart  = sep === -1 ? combined : combined.slice(0, sep)
    timeToken = sep === -1 ? '' : combined.slice(sep + 1).trim()
  }

  const [year, month, day] = datePart.split('-').map(Number)
  if (!year || !month || !day) return null

  const clock = parseClockToken(timeToken) ?? { hour: 0, minute: 0, second: 0 }
  const { hour, minute, second } = clock

  const localUtcMs = Date.UTC(year, month - 1, day, hour, minute, second)
  if (Number.isNaN(localUtcMs)) return null
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
  const trimmed = decodeEntities(name.trim())
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
// ADDRESS NORMALIZATION & VENUE-BY-ADDRESS RESOLUTION
// ════════════════════════════════════════════════════════════════════════════
//
// Several feeds (Better Kenmore's Events Manager, Tribe Events, etc.) expose a
// venue as a free-text location string that is often a bare street address —
// "943 Kenmore Blvd.", "1000 Kenmore Blvd". When such a string didn't match an
// existing venue NAME, ensureVenue used to mint a new venue literally NAMED
// after the address (address column left null). Those junk rows can never
// dedupe against the real, named venue at that address (First Glance, The
// Rialto Theatre), so the same place showed up twice on the site. The helpers
// below let ensureVenue recognize an address-shaped string and route it to the
// canonical venue by matching on the normalized `address` column instead.

/** Recognized US street-type suffixes (normalized to their abbreviation). */
const STREET_SUFFIX_MAP = {
  boulevard: 'blvd', blvd: 'blvd',
  street: 'st', st: 'st', str: 'st',
  avenue: 'ave', ave: 'ave', av: 'ave',
  road: 'rd', rd: 'rd',
  drive: 'dr', dr: 'dr',
  lane: 'ln', ln: 'ln',
  court: 'ct', ct: 'ct',
  place: 'pl', pl: 'pl',
  parkway: 'pkwy', pkwy: 'pkwy',
  highway: 'hwy', hwy: 'hwy',
  terrace: 'ter', ter: 'ter',
  circle: 'cir', cir: 'cir',
  square: 'sq', sq: 'sq',
  trail: 'trl', trl: 'trl',
  way: 'way',
}
const STREET_SUFFIXES = new Set(Object.values(STREET_SUFFIX_MAP))

/** Directional words → single-letter abbreviation, so "134 East Tallmadge Ave"
 *  and "134 E Tallmadge Ave" canonicalize identically. Spelled-out directionals
 *  are a common cross-source cause of duplicate venue records (e.g. Eventbrite
 *  writes "East" where the venue's own feed writes "E"). */
const DIRECTIONAL_MAP = {
  north: 'n', n: 'n', south: 's', s: 's', east: 'e', e: 'e', west: 'w', w: 'w',
  northeast: 'ne', ne: 'ne', northwest: 'nw', nw: 'nw',
  southeast: 'se', se: 'se', southwest: 'sw', sw: 'sw',
}

/**
 * Canonicalize a street-address string for equality comparison. Takes only the
 * street line (text before the first comma — drops any ", Akron, OH 44314" tail
 * that free-text location fields carry), lowercases, strips punctuation,
 * collapses whitespace, and maps street suffixes to a single abbreviation
 * ("Boulevard"/"Blvd." → "blvd"). Returns null for empty input.
 *
 *   "943 Kenmore Blvd."            → "943 kenmore blvd"
 *   "1000 Kenmore Boulevard, Akron"→ "1000 kenmore blvd"
 *
 * Single source of truth for address canonicalization across BOTH ingestion
 * (this file's ensureVenue / resolveVenueByAddress) and the post-ingest
 * dedupe pass (dedupe-cross-source.js imports this). Exported for tests and
 * reuse by any scraper with free-text location fields.
 */
export function normalizeStreetAddress(value) {
  if (!value || typeof value !== 'string') return null
  const streetLine = decodeEntities(value).split(',')[0]
  const cleaned = streetLine.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')
  const words = cleaned.split(/\s+/).filter(Boolean).map((w) => STREET_SUFFIX_MAP[w] ?? DIRECTIONAL_MAP[w] ?? w)
  const out = words.join(' ').trim()
  return out || null
}

/**
 * Heuristic: does this string look like a bare street address rather than a
 * venue name? Requires BOTH a leading house number AND a recognized street-type
 * suffix token, so legitimate number-led venue names ("1865 Brewing", "16-Bit
 * Bar+Arcade") are NOT misclassified. Exported for tests.
 */
export function looksLikeStreetAddress(value) {
  const n = normalizeStreetAddress(value)
  if (!n) return false
  const words = n.split(' ')
  if (words.length < 2) return false
  if (!/^\d+[a-z]?$/.test(words[0])) return false
  return words.some((w) => STREET_SUFFIXES.has(w))
}

// normalizedAddress → venueId, built once per process from the venues table.
let _venueAddressIndex = null

/**
 * Build (once) and return a Map of every venue's normalized address → id.
 * Loaded lazily on first use so env-less test imports never touch the DB. On a
 * lookup error the index stays empty and cached, which makes
 * resolveVenueByAddress fail safe (returns null → caller skips, never dupes).
 */
async function _getVenueAddressIndex() {
  if (_venueAddressIndex) return _venueAddressIndex
  _venueAddressIndex = new Map()
  const { data, error } = await supabaseAdmin
    .from('venues')
    .select('id, address')
    .not('address', 'is', null)
  if (error) {
    console.warn(`  ⚠ Could not load venue address index: ${error.message}`)
    return _venueAddressIndex
  }
  for (const v of data) {
    const key = normalizeStreetAddress(v.address)
    // First writer wins — venues are ordered by the DB's default; an exact
    // address collision across two venues is itself a data-quality issue, but
    // we don't want this index to be the thing that picks between them.
    if (key && !_venueAddressIndex.has(key)) _venueAddressIndex.set(key, v.id)
  }
  return _venueAddressIndex
}

/**
 * Resolve a free-text location string to an existing venue by matching its
 * normalized street address. Returns the venue id, or null when the string
 * isn't address-shaped or no venue carries that address. Exported so any
 * scraper with free-text location fields can reuse it.
 */
export async function resolveVenueByAddress(location) {
  if (!looksLikeStreetAddress(location)) return null
  const key = normalizeStreetAddress(location)
  if (!key) return null
  const index = await _getVenueAddressIndex()
  return index.get(key) ?? null
}

/** Test-only: reset the cached address index between cases. */
export function _resetVenueAddressIndex() {
  _venueAddressIndex = null
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

// Known venue-name aliases: a variant label → the canonical venue name. Some
// feeds name the same physical place differently and arrive WITHOUT a matching
// address, so ensureVenue's exact-name lookup mints a second venue row and that
// place's events split across two venues — which silently breaks cross-source
// dedupe (it buckets by venue). Resolving the alias to the canonical name before
// the lookup keeps every feed on one row. Keys are matched case-insensitively
// with collapsed whitespace. Add an entry whenever you merge two venue records
// so the split can't reappear on the next scrape.
const VENUE_NAME_ALIASES = new Map([
  ['e.j. thomas hall - the university of akron', 'E.J. Thomas Performing Arts Hall'],
  ['lock 3 live',                                'Lock 3'],
  ['first and main green',                       'First & Main Green - First Street Hudson'],
  ['the nightlight',                             'The Nightlight Cinema'],
  // The RubberDucks' Duck Club is a room inside the ballpark. Feeds that name it
  // (Habitat's "Bourbon Build", Leadership Akron) minted a separate, address-less
  // venue that mis-geocoded ~360m off — fold them onto the stadium venue so all
  // events share the one pin at 300 S Main St.
  ['the akron rubberducks duck club',                      '7 17 Credit Union Park'],
  ['the duck club by firestone at 7 17 credit union park', '7 17 Credit Union Park'],
  ['the duck club',                                        '7 17 Credit Union Park'],
])

/** Resolve a venue name to its canonical form via VENUE_NAME_ALIASES, or return
 *  the input unchanged. Pure + exported for tests. */
export function canonicalVenueName(name) {
  const key = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim()
  return VENUE_NAME_ALIASES.get(key) ?? name
}

export async function ensureVenue(name, details = {}, opts = {}) {
  if (!name) return null
  // Universal safeguard: a venue NAME must never contain HTML. Some feeds
  // (e.g. CivicPlus iCalendar LOCATION fields) wrap the value in stray tags
  // like "<p>Green Recycling Center</p>". stripHtml() removes tags, decodes
  // entities, and collapses whitespace; for a clean name it's a no-op. This is
  // defense-in-depth — scrapers should still parse their own location fields —
  // but it guarantees no `<p>…</p>` ever reaches the venues table.
  let trimmed = stripHtml(String(name))
  if (!trimmed) return null
  // Fold known name variants onto the canonical venue before any lookup, so a
  // second row is never minted for a place we already have (see VENUE_NAME_ALIASES).
  trimmed = canonicalVenueName(trimmed)

  // Drop malformed website strings before they reach the DB. See
  // sanitizeWebsite() for rationale.
  if (details.website !== undefined) {
    details = { ...details, website: sanitizeWebsite(details.website) }
  }

  if (_venueNameCache.has(trimmed)) return _venueNameCache.get(trimmed)

  // Guard: never mint a venue whose NAME is a bare street address. These come
  // from feeds that expose location as free text (e.g. Better Kenmore's "943
  // Kenmore Blvd."). Inserting them creates junk rows that can never dedupe
  // against the real, named venue at that address. Instead, route the string
  // to the canonical venue by matching on the normalized `address` column. If
  // no venue carries that address, SKIP creation and return null — a missing
  // venue link for one event is recoverable; a duplicate venue row is not (see
  // the Canton Civic Center runaway noted below).
  if (looksLikeStreetAddress(trimmed)) {
    const byAddress = await resolveVenueByAddress(trimmed)
    if (byAddress) {
      _venueNameCache.set(trimmed, byAddress)
      return byAddress
    }
    // opts.allowAddressName lets a caller mint a venue from a bare street
    // address when there's genuinely no formal venue name (e.g. a race start
    // location). Such venues are created UNLISTED (listed:false) so they never
    // clutter the public venues index — they remain directly navigable from the
    // event they belong to. Without this flag the guard still refuses, which is
    // the default that keeps junk address rows out (see the First Glance dup).
    if (!opts.allowAddressName) {
      console.warn(
        `  ⚠ Refusing to create address-named venue "${trimmed}" — no existing venue has this address. ` +
        `Event left venue-less; add a named venue with this address to capture it.`,
      )
      _venueNameCache.set(trimmed, null)
      return null
    }
  }

  // neighborhood_slug is pulled into the existing-venue query so we
  // can decide whether to backfill it without overwriting a manual
  // admin classification. The polygon-based resolver runs at insert
  // time and on existing-but-unclassified rows whenever new lat/lng
  // arrive — same behavior as scripts/classify-venues-by-polygon.js
  // gets us, just spread across the live ingest path.
  //
  // Lookup uses order+limit(1) rather than maybeSingle(): maybeSingle()
  // ERRORS when more than one row matches, and a silently-discarded
  // error here used to read as "no existing venue" → insert another
  // copy. That runaway produced 72 duplicate "Canton Civic Center"
  // rows (deduped 2026-06-09; see venues_dedup_backup_20260609 and
  // migration 035's unique index). On any lookup error we now skip
  // venue creation entirely — a missing venue link for one run is
  // recoverable; a duplicate venue row is not.
  const { data: existingRows, error: lookupError } = await supabaseAdmin
    .from('venues')
    .select('id, neighborhood_slug')
    .eq('name', trimmed)
    .order('created_at', { ascending: true })
    .limit(1)

  if (lookupError) {
    console.warn(`  ⚠ Venue lookup failed for "${trimmed}":`, lookupError.message)
    _venueNameCache.set(trimmed, null)
    return null
  }
  const existing = existingRows?.[0] ?? null

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

    // Backfill the neighborhood slug only when the venue isn't already
    // classified — this protects manual admin classifications (once an admin
    // sets a slug, scrapers won't change it). An EXPLICIT slug from the caller
    // (a curated KNOWN_VENUES entry) wins over the polygon resolver, which is
    // necessary where the GeoJSON is wrong — e.g. the resolver places the
    // entire Kenmore Blvd corridor in 'summit-lake'. Otherwise fall back to the
    // polygon answer when fresh coordinates make it reachable.
    if (!existing.neighborhood_slug) {
      if (details.neighborhood_slug) {
        updates.neighborhood_slug = details.neighborhood_slug
      } else if (details.lat != null && details.lng != null) {
        const slug = await resolveNeighborhoodSlug(details.lat, details.lng)
        if (slug) updates.neighborhood_slug = slug
      }
    }

    if (Object.keys(updates).length) {
      await supabaseAdmin.from('venues').update(updates).eq('id', existing.id)
    }
    _venueNameCache.set(trimmed, existing.id)
    return existing.id
  }

  // Before minting a new venue, check whether one already exists at this street
  // address under a DIFFERENT name. The exact-name lookup above matches on name
  // only, so the same place arriving from two feeds with slightly different
  // names ("The Posh" vs "Posh", "Lock 3" vs "Lock 3 Live", "Reservoir Park" vs
  // "Reservoir Park Community Center") used to create duplicate rows. Reuse the
  // canonical row instead. Fail-safe: resolveVenueByAddress returns null when
  // the address index can't load (env-less tests), so behavior is unchanged.
  if (details.address) {
    const byAddress = await resolveVenueByAddress(details.address)
    if (byAddress) {
      _venueNameCache.set(trimmed, byAddress)
      return byAddress
    }
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
  // Unlisted venues (opts.listed === false) are hidden from the public /venues
  // index + sitemap but stay navigable from their event. Column defaults to true.
  if (opts.listed === false) row.listed = false

  // An explicit slug from a curated KNOWN_VENUES entry wins (and is required
  // where the polygon GeoJSON is wrong — see the Kenmore Blvd corridor note
  // above). Otherwise auto-classify by polygon when coordinates are present.
  // The resolver returns null for venues outside Akron city limits (Cuyahoga
  // Falls, Stow, etc.) — those rows correctly leave the column null.
  if (details.neighborhood_slug) {
    row.neighborhood_slug = details.neighborhood_slug
  } else if (details.lat != null && details.lng != null) {
    const slug = await resolveNeighborhoodSlug(details.lat, details.lng)
    if (slug) row.neighborhood_slug = slug
  }

  const { data, error } = await supabaseAdmin
    .from('venues').insert(row).select('id').single()

  if (error) {
    console.warn(`  ⚠ Could not create venue "${trimmed}":`, error.message)
    _venueNameCache.set(trimmed, null)
    return null
  }

  console.log(`  ✚ Created venue: ${trimmed}`)
  _venueNameCache.set(trimmed, data.id)
  // Keep the address index fresh within a run so a later program at the same
  // address dedupes onto this brand-new venue instead of minting another.
  if (row.address && _venueAddressIndex) {
    const key = normalizeStreetAddress(row.address)
    if (key && !_venueAddressIndex.has(key)) _venueAddressIndex.set(key, data.id)
  }
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
// Small connector words stay lowercase in title case, except as the first or
// last word. Standard title-case style guide list, kept short/uncontroversial.
const TITLE_CASE_MINOR_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into',
  'nor', 'of', 'on', 'onto', 'or', 'over', 'per', 'the', 'to', 'vs', 'vs.',
  'via', 'with',
])

// Short tokens that are almost always acronyms/initialisms rather than a
// word that happens to be shouted — kept fully uppercase rather than
// title-cased into "Dj", "Bbq", etc. Not exhaustive; a deliberately small,
// low-risk list rather than a general acronym detector.
const TITLE_CASE_KEEP_UPPER = new Set([
  'DJ', 'DJS', 'MC', 'BBQ', 'VIP', 'EDM', 'TV', 'CD', 'USA', 'OH', 'NYE',
  'LGBTQ', 'LGBTQ+', 'Q&A', 'ASL', 'ID',
])

/**
 * Convert an ALL-CAPS title to standard title case (2026-07-02 data-quality
 * plan, task 7 — 28 shouted titles across eventbrite/rialto/killbox_comedy).
 * Only fires when the title has no lowercase letters at all and is longer
 * than 25 characters, so normal mixed-case titles (the vast majority) are
 * never touched. Small connector words are lowercased except at the ends; a
 * short allowlist of common acronyms stays uppercase. Exported for tests.
 */
export function titleCaseIfShouting(title) {
  if (!title || title.length <= 25) return title
  if (/[a-z]/.test(title)) return title // already has lowercase — not shouting
  if (!/[A-Z]/.test(title)) return title // no letters at all (pure punctuation/numbers)

  const words = title.split(/(\s+)/) // keep whitespace runs so spacing is preserved exactly
  let seenWord = false
  const wordCount = words.filter((w) => !/^\s+$/.test(w)).length
  let wordIndex = 0

  return words
    .map((chunk) => {
      if (/^\s+$/.test(chunk) || chunk === '') return chunk
      wordIndex++
      const isFirst = !seenWord
      seenWord = true
      const isLast = wordIndex === wordCount

      // Hyphenated compounds ("STATE-OF-THE-ART") — title-case each segment.
      // isFirst/isLast only apply to the outer segment at that edge (e.g. the
      // "ART" in a first-word "STATE-OF-THE-ART" isn't the title's last word,
      // so "of"/"the" inside it still lowercase per the minor-word rule).
      const segments = chunk.split('-')
      return segments
        .map((segment, segIdx) => {
          if (!segment) return segment
          if (TITLE_CASE_KEEP_UPPER.has(segment)) return segment
          const lower = segment.toLowerCase()
          const isSegFirst = isFirst && segIdx === 0
          const isSegLast  = isLast && segIdx === segments.length - 1
          if (!isSegFirst && !isSegLast && TITLE_CASE_MINOR_WORDS.has(lower)) return lower
          // Preserve a leading apostrophe/quote, then capitalize the first letter.
          return lower.replace(/^([^a-z0-9]*)([a-z])/, (_m, pre, c) => pre + c.toUpperCase())
        })
        .join('-')
    })
    .join('')
}

/**
 * Sanitize text fields on an event row before upsert.
 * Decodes HTML entities and strips stray tags from title and description.
 * Exported so tests can verify the same logic without hitting the DB.
 */
export function sanitizeEventText(row) {
  return {
    ...row,
    title:       row.title       ? titleCaseIfShouting(stripHtml(row.title)) : row.title,
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

// ── Ingestion data contract ───────────────────────────────────────────────────

const CONTRACT_PAST_LIMIT_MS   = 2 * 365 * 86_400_000 // 2 years back
const CONTRACT_FUTURE_LIMIT_MS = 3 * 365 * 86_400_000 // 3 years ahead

/**
 * Validate an event row against the ingestion data contract.
 *
 * This is the single gate between all 50+ scrapers and the events table:
 * upsertEventSafe calls it before any write, turning malformed rows into
 * loud, countable skips instead of silent data corruption (the zoo-midnight
 * and Eventbrite-geo incidents both shipped through this seam unchecked).
 *
 * Returns null when the row is valid, otherwise a human-readable reason.
 * Date-range bounds are deliberately generous — they exist to catch parser
 * bugs (year 1970/2126 artifacts), not to police editorial freshness.
 */
export function validateEvent(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 'row is not an object'

  if (typeof row.title !== 'string' || !row.title.trim()) return 'missing or blank title'
  if (row.title.length > 500) return `title exceeds 500 chars (${row.title.length})`

  if (typeof row.source !== 'string' || !row.source.trim()) return 'missing source key'

  if (!row.start_at) return 'missing start_at'
  const start = Date.parse(row.start_at)
  if (Number.isNaN(start)) return `unparseable start_at: ${JSON.stringify(row.start_at)}`
  const now = Date.now()
  if (start < now - CONTRACT_PAST_LIMIT_MS) return `start_at implausibly old: ${row.start_at}`
  if (start > now + CONTRACT_FUTURE_LIMIT_MS) return `start_at implausibly far out: ${row.start_at}`

  if (row.end_at != null && row.end_at !== '') {
    const end = Date.parse(row.end_at)
    if (Number.isNaN(end)) return `unparseable end_at: ${JSON.stringify(row.end_at)}`
    if (end < start) return `end_at precedes start_at (${row.end_at} < ${row.start_at})`
  }

  return null
}

/** Log-only contract advisories — suspicious but storable. */
function warnEventAdvisories(row) {
  // NULLs are distinct in the (source, source_id) unique constraint, so a row
  // without source_id cannot dedupe across runs. A few Squarespace/ICS items
  // legitimately lack stable ids today, so this warns instead of rejecting.
  if (row.source_id == null || row.source_id === '') {
    console.warn(`  ⚠ contract: "${row.title}" has no source_id — it cannot dedupe across runs`)
  }

  // Midnight-ET start with no end time is the classic dropped-time signature
  // (the old two-arg easternToIso bug). Legitimate all-day events trip this
  // too, so it stays a warning — but a scraper logging this for EVERY row is
  // almost certainly losing its time component.
  const d = new Date(row.start_at)
  const utcH = d.getUTCHours()
  if ((utcH === 4 || utcH === 5) && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && !row.end_at) {
    console.warn(`  ⚠ contract: "${row.title}" starts at midnight ET with no end_at — dropped time component?`)
  }
}

/**
 * Resolve an event's v2 content categories (1–2 slugs) from what the scraper
 * passed plus text inference. Pure — exported for tests.
 *
 * Sources may pass any of:
 *   • categories: ['music','food']  — explicit v2 list (preferred)
 *   • category:   'music' | 'art'   — a single hint (v2 OR legacy v1 slug)
 *   • nothing                       — inference alone decides
 * Inference always runs, so a single source hint still gets enriched toward
 * multi-category when the text clearly supports a second one.
 *
 * 'other' is a fallback, never a peer: it survives only when it is the ONLY
 * candidate. Before the June 2026 tagging audit this function's inline
 * predecessor kept inference's ['other'] next to a real source hint, writing
 * junk pairs like ['music','other'] to 750 live events — and when a legacy
 * hint itself mapped to 'other' (e.g. v1 'community'), it could even land as
 * the PRIMARY badge ahead of a real inferred category. See
 * docs/tagging-audit-2026-06.md (Bug 1).
 *
 * @param {{categories?: string[], category?: string}} source — scraper input
 * @param {string[]} inferredCategories — inferCategories().categories
 * @param {string|null} defaultCategory — per-source fallback (manifest
 *   `defaultCategory`). Applied ONLY when native+inference resolve to a bare
 *   ['other']; it is a last-resort prior, never an override, so a confident
 *   source/text classification always wins. This is the mechanism that keeps
 *   a source's unlabelled long tail (bare band names, committee meetings) in
 *   the right bucket on every re-scrape instead of decaying to 'other'.
 * @returns {string[]} 1–2 valid v2 slugs, primary first
 */
export function resolveEventCategories(source = {}, inferredCategories = ['other'], defaultCategory = null) {
  let categories
  if (Array.isArray(source.categories) && source.categories.length) {
    categories = source.categories.slice()
  } else {
    categories = inferredCategories.slice()
    const hint = source.category
    if (hint) {
      const mapped = CATEGORY_SLUGS.includes(hint)
        ? hint
        : (V1_TO_V2[hint]?.categories?.[0] ?? null)
      if (mapped && !categories.includes(mapped)) categories = [mapped, ...categories]
    }
  }
  categories = [...new Set(categories.filter((c) => CATEGORY_SLUGS.includes(c)))]
  if (categories.length > 1) categories = categories.filter((c) => c !== 'other')
  categories = categories.slice(0, 2)
  if (categories.length === 0) categories = ['other']
  // Source-default fallback: only rescue a bare ['other'], never override a
  // real classification. `other` itself is not a valid default.
  if (
    categories.length === 1 && categories[0] === 'other' &&
    defaultCategory && defaultCategory !== 'other' && CATEGORY_SLUGS.includes(defaultCategory)
  ) {
    categories = [defaultCategory]
  }
  return categories
}

export async function upsertEventSafe(row) {
  // ── Data contract gate ──────────────────────────────────────────────────
  // Reject malformed rows before any write. Violations come back in the
  // standard { data, error } shape, so every caller already treats them as a
  // skipped upsert and they appear in the per-run skip counts.
  const violation = validateEvent(row)
  if (violation) {
    return { data: null, error: { message: `data contract: ${violation}` }, isNew: false }
  }
  warnEventAdvisories(row)

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

  // ── Resolve the v2 content categories (array) + facet flags ───────────────
  const inferred = _inferCategories(sanitized.title, sanitized.description)
  const categories = resolveEventCategories(
    sanitized, inferred.categories, defaultCategoryFor(sanitized.source)
  )

  // Facet flags: honor explicit source flags, else inference. Legacy 'nonprofit'
  // hint implies fundraiser.
  const isFamily = sanitized.is_family ?? inferred.family
  let isFundraiser = sanitized.is_fundraiser ?? inferred.fundraiser
  if (sanitized.category === 'nonprofit') isFundraiser = true

  // Auto-flag low-confidence categorizations: only 'other' matched AND no facet
  // flag gave us a useful signal. A storytime (family) or a gala (fundraiser)
  // that lands on 'other' content is still classified enough to skip review.
  if (sanitized.needs_review === undefined) {
    sanitized.needs_review =
      categories.length === 1 && categories[0] === 'other' && !isFamily && !isFundraiser
  }

  // The single-value `category` column is gone in v2 — strip the category hints
  // off the events payload and persist the facet flags as real columns.
  delete sanitized.category
  delete sanitized.categories
  sanitized.is_family = isFamily
  sanitized.is_fundraiser = isFundraiser

  // ── Content moderation ────────────────────────────────────────────────────
  // Screen offensive/hateful content and route it out of the public feed before
  // it is written. Matches set status to 'pending_review' (or 'cancelled' for the
  // extreme tier) — both hidden from the front end by RLS. Wrapped so a fault in
  // moderation can never take down ingestion: on error we log and proceed.
  // _stripOverriddenFields runs next, so an admin who locks `status` (via
  // manual_overrides) keeps their decision on re-scrape.
  try {
    const screen = screenEvent(sanitized)
    if (screen.flagged) {
      sanitized.status = screen.status
      sanitized.needs_review = true
      const terms = screen.matches.map((m) => m.term).join(', ')
      if (screen.severity === 'extreme') {
        console.error(`  🚨 ESCALATE — extreme content in "${sanitized.title}" → ${screen.status} (matched: ${terms})`)
      } else {
        console.warn(`  🚩 Flagged for review — "${sanitized.title}" → ${screen.status} (${screen.severity}: ${terms})`)
      }
    }
  } catch (err) {
    console.warn(`  ⚠ content moderation skipped (non-fatal): ${err.message}`)
  }

  const safeRow = await _stripOverriddenFields('events', sanitized)
  const { data, error } = await supabaseAdmin
    .from('events')
    .upsert(safeRow, { onConflict: 'source,source_id', ignoreDuplicates: false })
    .select('id')
    .single()

  // Sync the content axis into the event_categories join table, unless an admin
  // has manually locked categories on this event.
  if (!error && data?.id) {
    await syncEventCategories(data.id, categories)
  }

  return { data, error, isNew: !error && !!data }
}

/**
 * Replace an event's content categories in the join table to match `categories`
 * (1–2 slugs). Skips entirely when the event has a manual category override, so
 * admin edits aren't clobbered by a re-scrape. Idempotent.
 */
export async function syncEventCategories(eventId, categories) {
  if (!eventId || !Array.isArray(categories) || categories.length === 0) return
  try {
    const { data: existing } = await supabaseAdmin
      .from('events')
      .select('manual_overrides')
      .eq('id', eventId)
      .maybeSingle()
    const ov = existing?.manual_overrides
    if (ov && ('categories' in ov || 'category' in ov)) return // admin-locked

    await supabaseAdmin.from('event_categories').delete().eq('event_id', eventId)
    const rows = categories.map((category) => ({ event_id: eventId, category }))
    const { error } = await supabaseAdmin.from('event_categories').insert(rows)
    if (error) console.warn(`  ⚠ syncEventCategories failed: ${error.message}`)
  } catch (err) {
    console.warn(`  ⚠ syncEventCategories exception: ${err.message}`)
  }
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
 * Set an event's venue to EXACTLY `venueId`, removing any other venue links.
 * linkEventVenue only ever adds rows, so a scraper that corrects an event's
 * venue (e.g. rec-parks moving a program off the generic department address
 * onto its real community center) would otherwise leave the event pointing at
 * both. Use this for sources where one event has exactly one venue.
 */
export async function setEventVenue(eventId, venueId) {
  if (!eventId || !venueId) return
  const { error: delErr } = await supabaseAdmin
    .from('event_venues')
    .delete()
    .eq('event_id', eventId)
    .neq('venue_id', venueId)
  if (delErr) console.warn(`  ⚠ setEventVenue cleanup failed: ${delErr.message}`)
  await linkEventVenue(eventId, venueId)
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
