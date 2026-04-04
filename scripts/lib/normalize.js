/**
 * Shared normalization utilities for ingestion scripts.
 * Each source maps its raw data into this common shape before upsert.
 *
 * v2: Updated for junction-table schema (event_venues, event_organizations,
 *     event_areas) and manual_overrides protection.
 */

import { supabaseAdmin } from './supabase-admin.js'
import { getImageDimensions } from './image-dimensions.js'

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

function decodeEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&([a-zA-Z]+);/g, (match, name) => NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

export function stripHtml(html = '') {
  return decodeEntities(
    html.replace(/<[^>]*>/g, ' ')
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
    html
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

export async function enrichWithImageDimensions(row) {
  if (!await _hasImageDimensionColumns()) return row
  if (!row.image_url) return { ...row, image_width: null, image_height: null }
  const dims = await getImageDimensions(row.image_url)
  return {
    ...row,
    image_width:  dims?.width  ?? null,
    image_height: dims?.height ?? null,
  }
}

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

  if (_orgNameCache.has(trimmed)) return _orgNameCache.get(trimmed)

  const { data: existing } = await supabaseAdmin
    .from('organizations').select('id').eq('name', trimmed).maybeSingle()

  if (existing) {
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
export async function ensureVenue(name, details = {}) {
  if (!name) return null
  const trimmed = name.trim()
  if (!trimmed) return null

  if (_venueNameCache.has(trimmed)) return _venueNameCache.get(trimmed)

  const { data: existing } = await supabaseAdmin
    .from('venues').select('id').eq('name', trimmed).maybeSingle()

  if (existing) {
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
    description: row.description ? stripHtml(row.description) : row.description,
  }
}

export async function upsertEventSafe(row) {
  // Sanitize text fields — decode HTML entities and strip any stray tags.
  // This catches cases where scrapers pass raw API titles containing entities
  // like &#8217; or &amp; that would otherwise appear verbatim in the DB.
  const sanitized = sanitizeEventText(row)
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
