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
import { isAggregatorSelfOrgName, isSelfCredit, orgNameMatchKey } from './source-tiers.js'

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
  // fromCodePoint, not fromCharCode: astral entities (&#128512; — emoji,
  // some CJK) are above 0xFFFF; fromCharCode truncates them to a lone
  // garbage surrogate. Out-of-range references are left verbatim.
  const codePoint = (n) =>
    n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : null
  return String(str)
    .replace(/&#(\d+);/g, (match, n) => codePoint(parseInt(n, 10)) ?? match)
    .replace(/&#x([0-9a-fA-F]+);/g, (match, h) => codePoint(parseInt(h, 16)) ?? match)
    // Named entities can contain digits after the first letter (&frac12;).
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name) => NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? match)
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
 * Clamp a string to at most `max` UTF-16 code units, cutting only on a whole
 * CHARACTER boundary. No ellipsis: callers are enforcing a storage cap, not
 * signalling truncation to a reader.
 *
 * Why not a bare `s.slice(0, max)`: most emoji (plus every astral symbol and
 * some CJK) are a surrogate pair, two UTF-16 units for one character, so the
 * cut can land mid-pair and leave a lone surrogate. That string is not
 * well-formed UTF-16: it fails isWellFormed() and renders as U+FFFD. Same
 * defect and same fix as the Slack feedback-body clamp (commit 960c219).
 *
 * Why not a bare `[...s].slice(0, max).join('')` either: that counts CHARACTERS
 * against a cap the callers measure in `.length`, so a run of surrogate pairs
 * comes back up to twice `max` units long and quietly overruns the very cap it
 * was called to enforce. Accumulating instead gives both guarantees at once:
 * never longer than `max` by `.length`, never split through a character.
 *
 * A character that does not fit whole is dropped whole, so the result can be
 * one unit shorter than `max`. Returns the input unchanged when it already
 * fits, so the common path allocates nothing.
 */
export function clampChars(str, max) {
  if (str == null) return str
  const s = String(str)
  if (s.length <= max) return s
  const kept = []
  let used = 0
  // for...of over a string iterates by code point, not by code unit.
  for (const ch of s) {
    if (used + ch.length > max) break
    kept.push(ch)
    used += ch.length
  }
  return kept.join('')
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
export { inferCategory, inferCategories, scoreCategories, familySafetyVeto } from './category-inference.js'

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

/**
 * The organization photo that stands in for an image-less event: the FIRST
 * entry of `organizations.photos`, or null when the org has none.
 *
 * Pure and exported so the selection rule is unit-testable without a database.
 * First-wins rather than "best" because the admin editor renders photos in
 * stored order — the top of that list is the org's deliberate lead image.
 */
export function orgFallbackPhoto(photos) {
  return photos?.[0] ?? null
}

/**
 * Resolve the fallback image for an image-less row from its linked org, or
 * null.
 *
 * Attribution guard: linkEventOrganization refuses to credit an aggregator's
 * own org on an event that aggregator merely republishes. Borrowing that same
 * org's photo would stamp its branding on an event we deliberately will NOT
 * credit it for, so the fallback is skipped under exactly the same condition —
 * keeping one policy, not two that can drift apart. (No selfHostVerified
 * escape hatch here: that flag authorizes asserting a presenter, which is a
 * strictly different question from whose photo may represent the event.)
 *
 * Provenance gate: ONLY a `published` org may donate a photo. `organizations`
 * carries an RLS policy ("Anon can insert pending organizations") whose
 * `with check` is just `status = 'pending_review'` — no column allowlist — so
 * anyone holding the publishable key can insert an org row with an arbitrary
 * `photos` array. That was inert while `photos` was unused; making it a
 * public-facing image path (event pages, the email digest) turns it into an
 * unmoderated image channel. `organizations.name` has no unique index either,
 * so a planted duplicate-name row can win ensureOrganization's loose-name
 * probe. Requiring `published` — a status only an admin can set — closes both:
 * a pending_review row (the only status anon can create) and a cancelled row
 * are both refused. This is a code-side guard, not a substitute for narrowing
 * that policy.
 */
async function _orgFallbackImage(row, organizationId) {
  if (!organizationId) return null
  const orgName = await orgNameById(organizationId)
  if (isAggregatorSelfOrgName(orgName) && isSelfCredit(row.source, orgName)) return null
  const { photos, status } = await orgPhotoSourceById(organizationId)
  if (status !== 'published') return null
  return orgFallbackPhoto(photos)
}

/**
 * Attach image_width/height/file_size to a row, resolving a fallback image
 * from the linked organization when the scraper found none.
 *
 * @param {object} row                   — event row (image_url may be null)
 * @param {object} [opts]
 * @param {string} [opts.organizationId] — org this event will be linked to;
 *   its photos[0] becomes the image when the row has none. Omit it and the
 *   function behaves exactly as it did before org fallbacks existed.
 */
export async function enrichWithImageDimensions(row, opts = {}) {
  if (!await _hasImageDimensionColumns()) return row

  // A real scraped photo ALWAYS wins — the org fallback is only consulted for
  // a row that arrived with no image at all.
  const scrapedUrl = row.image_url || null
  const orgPhoto   = scrapedUrl ? null : await _orgFallbackImage(row, opts.organizationId)

  // normalizeImageUrl's per-source transforms are keyed on `source` alone and
  // are NOT hostname-guarded (drupalImageStyle, wordpressResizedSuffix in
  // image-url-normalizer.js would happily rewrite any URL containing their
  // patterns). They exist to un-resize what a specific SOURCE served us, so
  // they must never touch an admin-supplied org photo. Dimensions are still
  // probed for both — banner eligibility needs width/height/file size.
  const imageUrl = scrapedUrl ? normalizeImageUrl(scrapedUrl, row.source) : orgPhoto

  if (!imageUrl) {
    return { ...row, image_width: null, image_height: null, image_file_size: null }
  }
  const meta = await getImageDimensions(imageUrl)

  if (meta) {
    return {
      ...row,
      image_url:       imageUrl,
      image_width:     meta.width    ?? null,
      image_height:    meta.height   ?? null,
      image_file_size: meta.fileSize ?? null,
    }
  }

  // Probe failed — try to keep previously-captured dimensions if the URL
  // is unchanged for this (source, source_id). This guards against bot
  // detection / transient origin errors silently degrading our data.
  const existing = await _getExistingImageMeta(row.source, row.source_id)
  if (existing && existing.image_url === imageUrl) {
    return {
      ...row,
      image_url:       imageUrl,
      image_width:     existing.image_width,
      image_height:    existing.image_height,
      image_file_size: existing.image_file_size,
    }
  }

  return {
    ...row,
    image_url:       imageUrl,
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

/**
 * Convert a wall-clock instant expressed as a UTC-ms value (Date.UTC of the
 * LOCAL Y/M/D/h/m/s) in America/New_York to an ISO 8601 UTC string.
 *
 * Uses Intl to resolve the EST↔EDT offset, the same technique as
 * namedTzWallTimeToUtc in lib/ics.js. The previous arithmetic
 * "2nd Sunday in March at UTC midnight" approximation put the boundary
 * 5-7 hours early, so 00:00-01:59 ET on transition days converted with
 * the wrong offset (off by one hour).
 */
function easternWallMsToUtcIso(asIfUtcMs) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(new Date(asIfUtcMs))
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '00'
  const asTzMs = Date.UTC(
    parseInt(get('year'), 10),
    parseInt(get('month'), 10) - 1,
    parseInt(get('day'), 10),
    parseInt(get('hour'), 10) % 24,
    parseInt(get('minute'), 10),
    parseInt(get('second'), 10),
  )
  return new Date(asIfUtcMs + (asIfUtcMs - asTzMs)).toISOString()
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
  return easternWallMsToUtcIso(localUtcMs)
}

/**
 * Today's calendar date in Eastern time as "YYYY-MM-DD".
 *
 * Use this — never `new Date().toISOString().split('T')[0]` — when building
 * "events from today onward" API windows. Between 8pm and midnight ET the
 * UTC date is already tomorrow, so the UTC shortcut silently drops the rest
 * of today's events from any nightly run in that window.
 */
export function easternTodayIso(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
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
const _orgIdNameCache = new Map() // orgId → name (reverse; see orgNameById)
const _orgPhotoSourceCache = new Map() // orgId → { photos, status } (see orgPhotoSourceById)

/**
 * Organization name for an id, cached per run.
 *
 * Only used by the attribution guard in linkEventOrganization. Populated for
 * free by ensureOrganization (the path nearly every scraper takes), so in
 * practice this rarely issues a query.
 */
async function orgNameById(orgId) {
  if (!orgId) return null
  if (_orgIdNameCache.has(orgId)) return _orgIdNameCache.get(orgId)
  const { data } = await supabaseAdmin
    .from('organizations').select('name').eq('id', orgId).maybeSingle()
  const name = data?.name ?? null
  _orgIdNameCache.set(orgId, name)
  return name
}

/**
 * Organization photos AND status for an id, cached per run.
 *
 * Backs enrichWithImageDimensions' fallback image. Status rides along with
 * photos because _orgFallbackImage must never donate a photo from a row that
 * isn't `published` — fetching them together keeps that check free.
 *
 * Like orgNameById this is seeded for free by ensureOrganization, so the query
 * below only fires for org ids a scraper obtained some other way (a hardcoded
 * UUID, a venue's organization_id). Worst case that is ONE read per
 * organization per run — never one per event row.
 *
 * A missing row yields status null, which is not 'published', so an org id
 * that no longer resolves is refused rather than silently trusted.
 */
async function orgPhotoSourceById(orgId) {
  if (!orgId) return { photos: [], status: null }
  if (_orgPhotoSourceCache.has(orgId)) return _orgPhotoSourceCache.get(orgId)
  const { data } = await supabaseAdmin
    .from('organizations').select('photos, status').eq('id', orgId).maybeSingle()
  const entry = { photos: data?.photos ?? [], status: data?.status ?? null }
  _orgPhotoSourceCache.set(orgId, entry)
  return entry
}

const _eventSourceCache = new Map() // eventId → source

/** Source key for an event id, cached per run. See linkEventOrganization. */
async function eventSourceById(eventId) {
  if (!eventId) return null
  if (_eventSourceCache.has(eventId)) return _eventSourceCache.get(eventId)
  const { data } = await supabaseAdmin
    .from('events').select('source').eq('id', eventId).maybeSingle()
  const source = data?.source ?? null
  _eventSourceCache.set(eventId, source)
  return source
}

/**
 * Match key for an organization name: case-folded, with a leading "The"
 * dropped and whitespace collapsed.
 *
 * Exists because ensureOrganization matched on EXACT name, so the same org
 * arriving from two sources under trivially different spellings became two
 * rows: Eventbrite hands us "The Conservancy for Cuyahoga Valley National
 * Park" while our first-party scraper already created "Conservancy for
 * Cuyahoga Valley National Park". Same for "The Peninsula Foundation" and the
 * case-only pair "The Stray Cats" / "THE STRAY CATS".
 *
 * This is the org-side counterpart to canonicalVenueName(), but algorithmic
 * rather than an alias map: organizer names come from aggregators in unbounded
 * variety (142 new orgs from one Eventbrite run), so a hand-curated list would
 * never keep up.
 *
 * Deliberately conservative — it folds only the "The"/case/whitespace axes we
 * have actually observed splitting rows. It does NOT strip punctuation, so
 * "Art's Core" and "Arts Core" stay distinct: over-folding would silently
 * merge two genuinely different orgs, which is far worse than a duplicate.
 *
 * The fold itself (orgNameMatchKey) lives in src/lib/sourceTiers.js because
 * the aggregator self-credit guard must fold names IDENTICALLY to this
 * matcher — see the comment there. This wrapper only adds HTML-entity
 * decoding, which the guard never needs (its inputs are already decoded).
 */
export function orgNameKey(name) {
  return orgNameMatchKey(decodeEntities(String(name ?? '')))
}

/** Escape LIKE metacharacters so a name containing % or _ matches literally. */
function escapeLike(s) {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}

// `photos` and `status` ride along so ensureOrganization can seed
// _orgPhotoSourceCache without a second read — enrichWithImageDimensions needs
// photos[0] for every image-less row this org owns, and refuses to use it
// unless status is 'published'.
const ORG_SELECT = 'id, name, website, description, image_url, address, city, state, zip, photos, status'

/**
 * Look up an org by loose name (case-insensitive, optional leading "The",
 * whitespace-run tolerant).
 *
 * Bounded probes rather than fetching the table and matching in memory: the
 * org list grows with every aggregator run, and an in-process map would also
 * miss rows created by a concurrently running scraper.
 *
 * Probe order matters: the caller's own spelling is tried first
 * (case-insensitively), so when the DB holds BOTH "Stray Cats" and
 * "The Stray Cats" as distinct orgs, incoming "THE STRAY CATS" lands on the
 * "The"-form rather than being folded onto the wrong org.
 *
 * The loose probes join the key's tokens with `%` so whitespace-run variants
 * already in the DB ("Akron  Marathon") still match, then verify every hit
 * with orgNameKey() equality — the wildcard can fetch a superset ("Akron
 * City Marathon") but can never *return* one. This keeps the probe semantics
 * identical to orgNameKey(), which is the fold the unit tests pin.
 */
async function findOrgByLooseName(trimmed) {
  const key = orgNameKey(trimmed)
  if (!key) return null

  // 1. Exact-modulo-case match on the input's own shape.
  {
    const { data } = await supabaseAdmin
      .from('organizations')
      .select(ORG_SELECT)
      .ilike('name', escapeLike(trimmed))
      .limit(1)
    if (data?.[0]) return data[0]
  }

  // 2. Loose probes: bare form, then "The"-prefixed form.
  const tokens = key.split(' ').map(escapeLike).join('%')
  for (const pattern of [tokens, `the%${tokens}`]) {
    const { data } = await supabaseAdmin
      .from('organizations')
      .select(ORG_SELECT)
      .ilike('name', pattern)
      .order('name')
      .limit(10)
    const hit = data?.find((row) => orgNameKey(row.name) === key)
    if (hit) return hit
  }
  return null
}

/**
 * Find or create an organization by name.
 *
 * Matches on exact name first, then falls back to a loose match (see
 * orgNameKey) so "The X" and "X" resolve to one row. The FIRST spelling to
 * reach the DB wins the stored display name — we reuse the existing row rather
 * than renaming it, because a rename would rewrite an org's public name based
 * on nothing but scrape order.
 *
 * @param {string} name     — Organization name (required)
 * @param {object} details  — Optional org fields: website, description, image_url,
 *                            address, city, state, zip
 * @returns {string|null}   — organization UUID or null on failure
 */
export async function ensureOrganization(name, details = {}) {
  if (!name) return null
  // Collapse internal whitespace runs so a sloppy feed ("Akron  Marathon")
  // can never mint a row that only whitespace distinguishes from an existing
  // one — the same axis orgNameKey folds.
  const trimmed = decodeEntities(name.trim()).replace(/\s+/g, ' ').trim()
  if (!trimmed) return null

  // Drop malformed website strings before they reach the DB. See
  // sanitizeWebsite() in this file for rationale.
  if (details.website !== undefined) {
    details = { ...details, website: sanitizeWebsite(details.website) }
  }

  if (_orgNameCache.has(trimmed)) return _orgNameCache.get(trimmed)

  const { data: exact } = await supabaseAdmin
    .from('organizations').select('id, name, website, description, image_url, address, city, state, zip, photos, status').eq('name', trimmed).maybeSingle()

  // Fall back to a loose match ("The X" ↔ "X", case-insensitive) before
  // minting a second row for an org we already know about.
  const existing = exact ?? await findOrgByLooseName(trimmed)

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
    // Cache the incoming spelling → id, but map id → the name actually STORED
    // (which differs from `trimmed` on a loose match). linkEventOrganization's
    // self-credit guard reads this id→name cache, so caching the caller's
    // spelling here would let the guard evaluate a name that isn't in the DB.
    _orgNameCache.set(trimmed, existing.id)
    _orgIdNameCache.set(existing.id, existing.name ?? trimmed)
    _orgPhotoSourceCache.set(existing.id, {
      photos: existing.photos ?? [],
      status: existing.status ?? null,
    })
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

  // `status` comes back on the same round trip so the cache seed below records
  // what the DB actually assigned instead of assuming the column default.
  const { data, error } = await supabaseAdmin
    .from('organizations').insert(row).select('id, status').single()

  if (error) {
    console.warn(`  ⚠ Could not create organization "${trimmed}":`, error.message)
    _orgNameCache.set(trimmed, null)
    return null
  }

  console.log(`  ✚ Created organization: ${trimmed}`)
  _orgNameCache.set(trimmed, data.id)
  _orgIdNameCache.set(data.id, trimmed)
  // A row we just minted has the `photos` column default '{}' — the insert
  // payload above never sets photos — so there is nothing to donate and no
  // read to make. Its `status` is whatever the DB assigned; today that is the
  // column default 'published' (migration 006), which is DELIBERATE and safe:
  // eligibility is gated on status AND a non-empty photos array, and only an
  // admin editing the org can ever put a photo in that array. Caching the
  // returned status rather than hardcoding 'published' means a future default
  // change is tracked automatically instead of silently diverging.
  _orgPhotoSourceCache.set(data.id, { photos: [], status: data.status ?? null })
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

/** Bare US state names — a venue literally named "Ohio" is a feed's region
 *  field leaking into the location slot, never a real place. */
const US_STATE_NAMES = new Set([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho',
  'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine',
  'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi',
  'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey',
  'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina',
  'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington', 'west virginia', 'wisconsin', 'wyoming',
])

/** Placeholder "location" strings feeds use for online / unannounced events. */
const VIRTUAL_MARKERS = new Set([
  'virtual', 'online', 'virtual event', 'online event', 'webinar', 'zoom',
  'livestream', 'tbd', 'tba',
])

/**
 * Is this venue NAME junk that must never mint a new venues row? Three closed
 * families (nothing fuzzy — every rule is an exact-token match):
 *   1. a bare US state name ("Ohio")
 *   2. a virtual/placeholder marker ("Virtual", "Online Event", "TBD")
 *   3. a house-number-less street fragment: ≤3 digit-free tokens whose LAST
 *      token is a recognized street suffix ("Church Street", "Main St").
 *      Complements looksLikeStreetAddress, which requires a leading house
 *      number and so lets these through. Token-exact on the last word, so
 *      "Townhall" (substring only) and "Front Street Brewing" (suffix not
 *      last) never match.
 * Pure + exported for tests. Consumed by ensureVenue at MINT time only —
 * venues already in the DB under such a name keep resolving normally.
 */
export function isJunkVenueName(name) {
  if (!name || typeof name !== 'string') return false
  const key = decodeEntities(name).toLowerCase().replace(/\s+/g, ' ').trim()
  if (!key) return false
  if (US_STATE_NAMES.has(key)) return true
  if (VIRTUAL_MARKERS.has(key)) return true
  // Street fragments: digit-bearing strings are looksLikeStreetAddress's
  // territory (or legit number-led names like "Lock 3") — never ours.
  if (/\d/.test(key)) return false
  const tokens = key.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)
  if (tokens.length < 1 || tokens.length > 3) return false
  const last = tokens[tokens.length - 1]
  return STREET_SUFFIXES.has(STREET_SUFFIX_MAP[last] ?? last)
}

/**
 * True when a would-be venue NAME is really a prose contact string — an email
 * address, URL, phone number, "reach us / for more info" phrasing, or a full
 * sentence that leaked out of a description field (e.g. Eventbrite's "For
 * venue details reach us at: info@kogniora.com", which minted junk venue row
 * 2463e178). Kept SEPARATE from isJunkVenueName on purpose: that predicate's
 * contract is closed exact-token families (states, virtual markers, street
 * fragments); this one is pattern-shaped and open-ended.
 * Pure + exported for tests. Consumed by ensureVenue BEFORE any lookup —
 * a contact string is never a real venue's name, so it must not resolve to an
 * existing junk row either.
 */
export function isProseContactVenueName(name) {
  if (!name || typeof name !== 'string') return false
  const key = decodeEntities(name).toLowerCase().replace(/\s+/g, ' ').trim()
  if (!key) return false
  // Email address anywhere in the string
  if (/\S+@\S+\.\S{2,}/.test(key)) return true
  // URL (scheme or bare www.)
  if (/\bhttps?:\/\/|\bwww\./i.test(key)) return true
  // Phone number with separators — bare digit runs like "The 3-2-1 Club" don't match
  if (/\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/.test(key)) return true
  // Contact-us phrasing
  if (/\b(reach|contact|call|email|text)\s+us\b|\bfor\s+(venue|more)\s+(details|info(rmation)?)\b|\bplease\s+(call|contact|email)\b/i.test(key)) return true
  // Sentence-shaped: long AND internally punctuated. Both required, so short
  // punctuated names ("Mrs. B's", "R. Shea Brewing") never match.
  const tokens = key.split(/\s+/).filter(Boolean)
  if (tokens.length >= 8 && /[;:]|\. /.test(key)) return true
  // Terminal-period instructional sentences that lack internal punctuation
  // ("Homes wishing to participate should turn on their porch light.") —
  // modal/imperative phrasing is the tell, not punctuation density. Wordlist
  // is deliberately narrow (no "will"/"contact") to avoid flagging real
  // titles like "Will Smith Live at the Akron Civic Theatre." or org names
  // like "Church of the Nazarene Contact Center Building Inc." This predicate
  // runs in ensureVenue for every scraper, so false positives here silently
  // drop venues repo-wide — keep the wordlist tight, not broad.
  if (key.endsWith('.') && tokens.length >= 6 && /\b(should|must|please|wishing|participate|residents|register|turn on|bring|wear)\b/.test(key)) return true
  return false
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

// venueNameKey(name) → venueId, built once per process from the venues table.
let _venueNameIndex = null

/**
 * Build (once) and return a Map of every venue's normalized name key → id.
 * Mirrors _getVenueAddressIndex: loaded lazily on first use so env-less test
 * imports never touch the DB, and on a lookup error the index stays empty and
 * cached so the name-key fallback fails safe (returns nothing → caller falls
 * through, never dupes).
 */
async function _getVenueNameIndex() {
  if (_venueNameIndex) return _venueNameIndex
  _venueNameIndex = new Map()
  // try/catch on top of the error-object check: this load runs on EVERY
  // exact-name miss (unlike the address index, which only loads for
  // address-shaped strings), so an unexpected client shape must degrade to an
  // empty index, never throw out of ensureVenue.
  try {
    const { data, error } = await supabaseAdmin
      .from('venues')
      .select('id, name')
    if (error) {
      console.warn(`  ⚠ Could not load venue name index: ${error.message}`)
      return _venueNameIndex
    }
    for (const v of data ?? []) {
      const key = venueNameKey(v.name)
      // First writer wins — same posture as the address index: a name-key
      // collision across two venues is a data-quality issue this index must
      // not adjudicate.
      if (key && !_venueNameIndex.has(key)) _venueNameIndex.set(key, v.id)
    }
  } catch (err) {
    console.warn(`  ⚠ Could not load venue name index: ${err?.message ?? err}`)
  }
  return _venueNameIndex
}

/** Test-only: reset the cached name index between cases. */
export function _resetVenueNameIndex() {
  _venueNameIndex = null
}

/**
 * Resolve a venue id through venue_aliases: if the id is an alias row, return
 * its canonical venue id instead. Modeled on _resolveAliasCanonical for
 * events: fail-open to the matched id on any error, verify the canonical
 * still exists (a dead canonical means the alias is stale — keep the matched
 * id), and follow at most 3 hops with a visited set so a bad chain can never
 * loop. The DB-side chain-guard trigger (migration 050) makes chains
 * impossible going forward; the hop limit is defense-in-depth.
 */
async function _resolveVenueAliasCanonical(venueId) {
  if (!venueId) return venueId
  try {
    let current = venueId
    const visited = new Set([current])
    for (let hop = 0; hop < 3; hop++) {
      const { data: alias } = await supabaseAdmin
        .from('venue_aliases')
        .select('canonical_venue_id')
        .eq('alias_venue_id', current)
        .maybeSingle()
      if (!alias?.canonical_venue_id) return current
      const next = alias.canonical_venue_id
      if (visited.has(next)) return current
      // The canonical must still be a live venue — otherwise keep the row we
      // actually matched (fail-open, self-healing once the alias is cleaned).
      const { data: canonical } = await supabaseAdmin
        .from('venues')
        .select('id')
        .eq('id', next)
        .maybeSingle()
      if (!canonical?.id) return current
      visited.add(next)
      current = next
    }
    return current
  } catch {
    return venueId
  }
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

/**
 * Resolve a possibly-relative asset URL (image src, og:image, JSON-LD image)
 * against a base URL so we never persist site-relative paths like
 * "/uploads/poster.jpg" in image_url columns. Absolute http(s) URLs pass
 * through untouched, protocol-relative "//host/x" gets https:, and anything
 * else is resolved against `base` via the URL constructor. Returns null for
 * empty/non-string input or when resolution fails. Pure — exported for tests
 * and for any scraper that emits asset URLs scraped out of page HTML.
 */
export function absoluteUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null
  const t = value.trim()
  if (/^https?:\/\//i.test(t)) return t
  if (/^\/\//.test(t)) return 'https:' + t
  try {
    return new URL(t, base).href
  } catch {
    return null
  }
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
  // Every observed spelling of E.J. Thomas — 4 variant rows existed by
  // 2026-07-16 (uakron/symphony/TM feeds each spell it differently).
  ['e.j. thomas hall',                           'E.J. Thomas Performing Arts Hall'],
  ['e.j. thomas hall - university of akron',     'E.J. Thomas Performing Arts Hall'],
  ['ej thomas hall - university of akron',       'E.J. Thomas Performing Arts Hall'],
  ['ej thomas hall',                             'E.J. Thomas Performing Arts Hall'],
  ['the university of akron - e.j. thomas performing arts hall', 'E.J. Thomas Performing Arts Hall'],
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
  // The National Museum of Psychology lives inside the Cummings Center at
  // 73 S College St — uakron feeds name the building, the museum, or either
  // with a "The University of Akron:" prefix, which minted two extra venue
  // rows (merged 2026-08-10, partner-confirmed). Fold every spelling onto the
  // canonical Cummings Center row so the split can't reappear on re-scrape.
  ['the cummings center for the history of psychology',        'Cummings Center for the History of Psychology'],
  ['the university of akron: the national museum of psychology', 'Cummings Center for the History of Psychology'],
  ['national museum of psychology',                            'Cummings Center for the History of Psychology'],
  ['the national museum of psychology',                        'Cummings Center for the History of Psychology'],
  // The Knight Stage inside the Akron Civic Theatre split into 3 rows — the
  // scraper emits "The Knight Stage", but other feeds/older runs named it after
  // its donors ("John, James and Clara Knight Stage") or prefixed the building
  // ("Akron Civic Theatre - Knight Stage"). Merged 2026-08-20 (visitor feedback
  // #46); fold both spellings onto the canonical so the split can't reappear.
  ['john, james and clara knight stage',                       'The Knight Stage'],
  ['akron civic theatre - knight stage',                       'The Knight Stage'],
])

/**
 * Split a comma-joined "Venue Name, 123 Street St, City[, ST, ZIP, Country]"
 * location string into { name, address, city }, or return null when the
 * string doesn't follow that shape.
 *
 * Tribe/Events-Manager ICS feeds and prose "Location:" lines emit this format
 * routinely; minting it verbatim creates address-in-name junk venues like
 * "E.J. Thomas Hall, 198 Hill Street, Akron, OH, 44325, United States"
 * (akron_symphony, 2026-07-12) and "Summit Lake NorthShore Park, 540 W.
 * South Street, Akron" (ohio_erie_canalway) — rows that can never dedupe
 * against the real venue. The gate is the second segment starting with a
 * street number; venue names practically never contain ", <digits> " so
 * false splits are vanishingly rare. Pure + exported for tests.
 */
export function splitCommaLocation(raw) {
  const parts = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (parts.length < 3) return null
  if (!/^\d+\s+\S/.test(parts[1])) return null   // second segment must look like a street address
  if (/^\d/.test(parts[0])) return null           // first segment must be a name, not itself an address
  const city = parts[2] && !/^\d/.test(parts[2]) ? parts[2] : null
  return { name: parts[0], address: parts[1], city }
}

/** Resolve a venue name to its canonical form via VENUE_NAME_ALIASES, or return
 *  the input unchanged. Pure + exported for tests. */
export function canonicalVenueName(name) {
  const key = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim()
  return VENUE_NAME_ALIASES.get(key) ?? name
}

/**
 * Normalized lookup key for a venue name. Folds only the variations we have
 * seen split one real venue across two rows (People's Park arrived with a
 * curly apostrophe from Eventbrite while the DB row used a straight one, and
 * ensureVenue's one-sided normalization meant the exact-name lookup missed):
 *   • stripHtml first (tags, entities, smart quotes → ASCII, whitespace)
 *   • ʼ (U+02BC modifier letter apostrophe) → straight apostrophe
 *   • lowercase
 *   • a single trailing period/comma stripped
 *   • whitespace collapsed + trimmed
 * Deliberately NOTHING more — no punctuation stripping, no "The" folding, no
 * &-vs-and folding — so genuinely distinct punctuated names never collide
 * (see orgNameKey's "Art's Core" vs "Arts Core" rationale). Pure + exported
 * for tests.
 */
export function venueNameKey(name) {
  return stripHtml(String(name ?? ''))
    .replace(/ʼ/g, "'")
    .toLowerCase()
    .replace(/[.,]$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * `ensureVenue` for a single-venue scraper's `VENUE_INFO` constant.
 *
 * Eleven fixed-venue scrapers each hand-listed every `VENUE_INFO` field into an
 * `ensureVenue(VENUE_INFO.name, { address: VENUE_INFO.address, … })` call, so
 * adding a field to the constant meant remembering to add it to the call too.
 * Splitting `name` off and forwarding the rest is exactly what all eleven were
 * spelling out by hand.
 *
 * `details` keys with an `undefined` value behave the same as absent ones, so a
 * `VENUE_INFO` that omits `lat`/`lng` is unaffected.
 *
 * @param {object} venueInfo  `{ name, ...details }` — `name` is required.
 * @param {object} [opts]     Forwarded verbatim to `ensureVenue`.
 */
export async function ensureVenueFromInfo(venueInfo, opts = {}) {
  const { name, ...details } = venueInfo ?? {}
  return ensureVenue(name, details, opts)
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

  // Comma-joined "Venue Name, 123 Street St, City[, …]" location strings (Tribe
  // ICS, Eventbrite full-location, prose "Location:" lines) carry the address
  // INSIDE the name. Split them so the lookup runs on the bare venue name and
  // the address/city feed the guards and fallbacks below — the scraper's own
  // details win when present, the split only fills gaps.
  const split = splitCommaLocation(trimmed)
  if (split) {
    trimmed = split.name
    details = { ...details }
    if (!details.address && split.address) details.address = split.address
    if (!details.city && split.city) details.city = split.city
  }

  // Fold known name variants onto the canonical venue before any lookup, so a
  // second row is never minted for a place we already have (see VENUE_NAME_ALIASES).
  trimmed = canonicalVenueName(trimmed)

  // Guard: never treat a prose contact string as a venue name — not even for
  // LOOKUP. This runs before the cache and exact-name queries on purpose: a
  // contact string is never a real venue's name, and an early return stops
  // re-scrapes from resolving to an already-minted junk row by exact name.
  // opts.allowProseName mirrors allowGenericName as an escape hatch; no
  // caller passes it today.
  if (!opts.allowProseName && isProseContactVenueName(trimmed)) {
    console.warn(
      `  ⚠ Refusing to use prose contact string as venue name "${trimmed}". ` +
      `Event left venue-less; pass opts.allowProseName to override.`,
    )
    _venueNameCache.set(venueNameKey(trimmed), null)
    return null
  }

  // Drop malformed website strings before they reach the DB. See
  // sanitizeWebsite() for rationale.
  if (details.website !== undefined) {
    details = { ...details, website: sanitizeWebsite(details.website) }
  }

  // Cache keys on the normalized name key so curly-vs-straight-apostrophe
  // spellings of one venue share a single cache entry (and a single row).
  const cacheKey = venueNameKey(trimmed)
  if (_venueNameCache.has(cacheKey)) return _venueNameCache.get(cacheKey)

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
      const resolved = await _resolveVenueAliasCanonical(byAddress)
      _venueNameCache.set(cacheKey, resolved)
      return resolved
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
      _venueNameCache.set(cacheKey, null)
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
    _venueNameCache.set(cacheKey, null)
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
    // Resolve through venue_aliases before caching/returning: if the matched
    // row was merged away, hand back its canonical so events never re-attach
    // to an unlisted alias row.
    const resolved = await _resolveVenueAliasCanonical(existing.id)
    _venueNameCache.set(cacheKey, resolved)
    return resolved
  }

  // Exact-name miss: try the normalized name-key index. This catches spelling
  // variants the exact .eq('name') lookup can't — most concretely the
  // curly-vs-straight-apostrophe split ("People's Park" from Eventbrite vs the
  // DB's "People's Park") where one-sided normalization used to mint a
  // duplicate row on every scrape. Fail-safe: the index loads empty on error.
  const nameIndex = await _getVenueNameIndex()
  const byNameKey = nameIndex.get(cacheKey)
  if (byNameKey) {
    const resolved = await _resolveVenueAliasCanonical(byNameKey)
    _venueNameCache.set(cacheKey, resolved)
    return resolved
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
      const resolved = await _resolveVenueAliasCanonical(byAddress)
      _venueNameCache.set(cacheKey, resolved)
      return resolved
    }
  }

  // Guard: never MINT a venue from a junk generic name ("Virtual", "Ohio",
  // "Church Street" — see isJunkVenueName). Deliberately placed AFTER both the
  // exact-name lookup and the address fallback so any venue that already
  // exists in the DB under such a name keeps resolving; this gate only stops
  // NEW rows, which would otherwise land with city defaulting to 'Akron'.
  // opts.allowGenericName lets a curated caller opt out.
  if (!opts.allowGenericName && isJunkVenueName(trimmed)) {
    console.warn(
      `  ⚠ Refusing to create junk-named venue "${trimmed}" — bare state / virtual marker / street fragment. ` +
      `Event left venue-less; pass opts.allowGenericName to override.`,
    )
    _venueNameCache.set(cacheKey, null)
    return null
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
    _venueNameCache.set(cacheKey, null)
    return null
  }

  console.log(`  ✚ Created venue: ${trimmed}`)
  _venueNameCache.set(cacheKey, data.id)
  // Keep the address index fresh within a run so a later program at the same
  // address dedupes onto this brand-new venue instead of minting another.
  if (row.address && _venueAddressIndex) {
    const key = normalizeStreetAddress(row.address)
    if (key && !_venueAddressIndex.has(key)) _venueAddressIndex.set(key, data.id)
  }
  // Same freshness rule for the name index: a later spelling variant of this
  // brand-new venue must resolve to it, not mint another row.
  if (_venueNameIndex && cacheKey && !_venueNameIndex.has(cacheKey)) {
    _venueNameIndex.set(cacheKey, data.id)
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
 * @returns {{ data, error, isNew: boolean }} — isNew is true only when the
 *          upsert INSERTED a row (no prior (source, source_id) match), so
 *          callers' inserted/updated counters are real.
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
 * than `minLength` characters, so normal mixed-case titles (the vast majority)
 * are never touched. Small connector words are lowercased except at the ends; a
 * short allowlist of common acronyms stays uppercase. Exported for tests.
 *
 * Options (both default to the historical behaviour, so every existing caller
 * is unchanged):
 *
 *   minLength — the length floor. The 25-char default protects short titles
 *     that are plausibly one acronym ("LIVE MUSIC NIGHT" is left alone). A
 *     source whose feed is 100% shouted (workz) passes 0 so its SHORT titles
 *     are cased the same way as its long ones — otherwise one title in twelve
 *     gets de-shouted and the rest stay screaming.
 *
 *   keepShortInitialisms — keep 2–3 letter VOWEL-LESS tokens uppercase
 *     ("SB MUSIC" → "SB Music", not "Sb Music"; "DT & THE SHAKES" → "DT & the
 *     Shakes"). Shape-based, not a name list. Only useful together with a low
 *     minLength, where such a token is a large fraction of the whole title, so
 *     it is opt-in rather than the default. Y counts as a vowel, which keeps
 *     real words like "SKY"/"FLY"/"GYM" out of it.
 */
export function titleCaseIfShouting(title, { minLength = 25, keepShortInitialisms = false } = {}) {
  if (!title || title.length <= minLength) return title
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
          if (keepShortInitialisms && /^[A-Z]{2,3}$/.test(segment) && !/[AEIOUY]/.test(segment)) return segment
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
 * Remove the Unicode replacement character (U+FFFD, "�") that upstream feeds
 * leave behind when a byte failed to decode. It is never meaningful content,
 * so we drop it and collapse any resulting double space — but only runs of
 * spaces/tabs, never newlines, so multi-paragraph descriptions keep their
 * structure. (Seen 2026-07-25 in a main_street_barberton description:
 * "…July 25, 2026� 2:00 PM".) We do NOT touch literal "?" runs: a real title
 * can legitimately contain "???", so those are corrected per-row, not here.
 */
export function stripReplacementChar(s) {
  return typeof s === 'string' ? s.replace(/�/g, ' ').replace(/[ \t]{2,}/g, ' ') : s
}

/**
 * Sanitize text fields on an event row before upsert.
 * Decodes HTML entities and strips stray tags from title and description.
 * Exported so tests can verify the same logic without hitting the DB.
 */
export function sanitizeEventText(row) {
  return {
    ...row,
    title:       row.title       ? titleCaseIfShouting(stripReplacementChar(stripHtml(row.title))) : row.title,
    // Use htmlToText for descriptions so paragraph breaks (\n\n) and list
    // markers are preserved. stripHtml collapses all whitespace to a single
    // space, which flattens multi-paragraph descriptions into one long string.
    description: row.description ? stripReplacementChar(htmlToText(row.description)) : row.description,
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

/**
 * Resolve the final `is_family` boolean from a source's structured flag, text
 * inference, and the family safety veto (`familySafetyVeto` in
 * category-inference.js). Pure — exported for tests, extracted from
 * `upsertEventSafe` the same way `resolveEventCategories` was.
 *
 * The veto sits ABOVE the existing `sourceFlag ?? inferredFamily` resolve and
 * overrides a structured source signal too — a library Ages field or
 * Ticketmaster's Family segment can be just as wrong as inferred text (see the
 * "Baby Doe" incident and the design's §3a rationale: a structured field is
 * authoritative about WHO MAY ATTEND, not about whether a harm-bearing event
 * belongs under a family badge with no warning). The human escape hatch is
 * `manual_overrides.is_family`, which this function never sees or touches —
 * `_stripOverriddenFields` removes a locked `is_family` key from the payload
 * entirely before it ever reaches this resolve, so a human decision always
 * survives untouched.
 *
 * @param {boolean|undefined} sourceFlag — sanitized.is_family as passed by the
 *   scraper (undefined when the source has no structured signal)
 * @param {boolean} inferredFamily — inferFacets(...).family (already reflects
 *   the veto for the text-only case: family = positives && !veto)
 * @param {null|{rule: string, terms: string[], suppressed: boolean}} veto —
 *   inferFacets(...).familyVeto
 * @returns {boolean}
 */
export function resolveFamilyFacet(sourceFlag, inferredFamily, veto) {
  let isFamily = sourceFlag ?? inferredFamily
  if (veto && isFamily) isFamily = false
  return isFamily
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
  //
  // is_family additionally runs through the family safety veto
  // (resolveFamilyFacet, category-inference.js's familySafetyVeto) — a hard,
  // fail-safe guard against harm-bearing text (the "Baby Doe" incident) that
  // overrides even a STRUCTURED source-declared is_family: true. Logged, never
  // written to the row: see the two console.warn calls below. This is
  // LOG-ONLY — it never sets needs_review and never touches manual_overrides.
  const sourceFamily = sanitized.is_family
  const isFamily = resolveFamilyFacet(sourceFamily, inferred.family, inferred.familyVeto)
  if (inferred.familyVeto) {
    const { rule, terms, suppressed } = inferred.familyVeto
    const termList = terms.join(', ')
    if (sourceFamily === true) {
      // Louder: a curated, structured field (library Ages, Ticketmaster
      // Family segment, a scraper's hardcoded is_family) disagreed with the
      // veto. That is either a real save or a lexicon bug — exactly the
      // signal worth a human's attention.
      console.warn(`  🛡 family veto (source-declared) — "${sanitized.title}" [${rule}: ${termList}]`)
    } else if (suppressed) {
      console.warn(`  🛡 family veto (inferred) — "${sanitized.title}" [${rule}: ${termList}]`)
    }
  }
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

  const { row: safeRow, existed } = await _stripOverriddenFields('events', sanitized)

  // ── Alias enforcement (self-healing, kill-switched) ───────────────────────
  // A row that does NOT already exist under its own (source, source_id) might be
  // a duplicate that was hand-merged away in event_aliases. Consulting the alias
  // table stops a re-scrape from resurrecting that merged event. Only ever runs
  // for genuinely-new rows: a live event under its own id (existed === true) is
  // always a normal update and must never be suppressed. Exact-key, never fuzzy.
  // Falls through to a normal upsert when the alias is missing, has a null
  // canonical, or the canonical was since deleted — so a merged event whose
  // canonical later disappeared can still re-enter the feed (self-healing).
  if (!existed && !process.env.DISABLE_ALIAS_SKIP) {
    const canonicalId = await _resolveAliasCanonical(safeRow.source, safeRow.source_id)
    if (canonicalId) {
      // Shaped as an error result so the ~90 `if (error) { skip }` callers
      // handle it with no new branch. Mirrors this function's error shape.
      return {
        data: null,
        error: { message: `alias-skip: ${safeRow.source}/${safeRow.source_id} → canonical ${canonicalId}` },
        isNew: false,
      }
    }
  }

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

  // isNew distinguishes insert from update: the upsert returns the row either
  // way, so `!!data` alone would count every re-scrape as an insert and
  // fabricate scraper_runs insert counts (and everything downstream — the
  // health report, dwindle detection). `existed` comes from the row lookup
  // _stripOverriddenFields already performs.
  const isNew = !error && !!data && !existed

  // Record the observation for logUpsertResult to prefer over caller-passed
  // counts (see _recordUpsertObservation) — only for an actual successful
  // write, never for the alias-skip/validation-failure early returns above.
  if (!error && data) _recordUpsertObservation(safeRow.source, isNew)

  return { data, error, isNew }
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
export async function linkEventOrganization(eventId, organizationId, opts = {}) {
  if (!eventId || !organizationId) return

  // ── Attribution guard: an aggregator may never credit itself ─────────────
  //
  // The site renders event_organizations as "Presented by X", so linking an
  // aggregator's own org to an event it merely republishes tells the public
  // that org HOSTS the event. See AGGREGATOR_SELF_ORG in source-tiers.js for
  // the full rationale.
  //
  // Ordering matters for cost: check the ORG first (a pure in-memory set
  // lookup against 7 names). Only if the org is some aggregator's self-identity
  // do we pay for the event's source. For the ~99% of links whose org is an
  // ordinary venue/organizer this adds zero queries.
  const orgName = await orgNameById(organizationId)
  if (isAggregatorSelfOrgName(orgName)) {
    const source = opts.source ?? await eventSourceById(eventId)
    if (isSelfCredit(source, orgName)) {
      // selfHostVerified is the deliberate, auditable escape hatch for the
      // minority of events an aggregator genuinely DOES host (e.g. Downtown
      // Akron Partnership's own Summer on the Plaza series). It must be
      // opt-in per event: the default is always "don't assert a presenter we
      // can't back up". Grep for it to audit every self-credit on the site.
      if (!opts.selfHostVerified) {
        console.log(`  ⤷ Attribution guard: not crediting "${orgName}" on its own ${source} event`)
        return
      }
    }
  }

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
 *
 * Returns { row, existed }. `existed` reports whether a (source, source_id)
 * row was already present — upsertEventSafe derives its insert-vs-update
 * `isNew` flag from it, reusing this lookup rather than paying for a second
 * query. On lookup failure `existed` is false (degraded, matches the
 * "proceed with full row" posture below).
 */
/**
 * Resolve a (source, source_id) pair against event_aliases. Returns the
 * canonical event id ONLY when this exact pair was hand-merged away AND its
 * canonical still resolves to a live event. Returns null when there is no
 * alias, the alias' canonical is null, or the canonical event was since
 * deleted — all of which mean the row should re-enter the feed normally
 * (self-healing). Exact-key only. On any lookup failure returns null so
 * ingest falls through to a normal upsert (safe default).
 */
async function _resolveAliasCanonical(source, sourceId) {
  if (!source || sourceId == null) return null
  try {
    const { data: alias } = await supabaseAdmin
      .from('event_aliases')
      .select('canonical_event_id')
      .eq('duplicate_source', source)
      .eq('duplicate_source_id', sourceId)
      .maybeSingle()
    if (!alias?.canonical_event_id) return null
    // Lightweight existence check — the canonical must still be a live event.
    const { data: canonical } = await supabaseAdmin
      .from('events')
      .select('id')
      .eq('id', alias.canonical_event_id)
      .maybeSingle()
    return canonical?.id ?? null
  } catch {
    return null
  }
}

async function _stripOverriddenFields(table, row) {
  // Only events have source/source_id for lookup
  if (table !== 'events' || !row.source || !row.source_id) return { row, existed: false }

  try {
    const { data: existing } = await supabaseAdmin
      .from('events')
      .select('id, manual_overrides')
      .eq('source', row.source)
      .eq('source_id', row.source_id)
      .maybeSingle()

    const existed = !!existing
    if (!existing?.manual_overrides) return { row, existed }

    const overrides = existing.manual_overrides
    const filtered = { ...row }
    for (const field of Object.keys(overrides)) {
      if (field in filtered && field !== 'source' && field !== 'source_id') {
        delete filtered[field]
      }
    }
    return { row: filtered, existed }
  } catch {
    // If lookup fails, proceed with full row (safe default)
    return { row, existed: false }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// HEALTH LOGGING
// ════════════════════════════════════════════════════════════════════════════

// ── Observed insert/update tally (Commit A of the honest-counters fix) ───────
//
// upsertEventSafe already computes an honest `isNew` per row (from the same
// (source, source_id) lookup _stripOverriddenFields performs for
// manual-override stripping), but most of the ~154 logUpsertResult call sites
// across the scrapers discard it and pass hardcoded/approximate inserted /
// updated counts instead. Rewriting every call site is Commit B, deferred
// until after a full production run. This is the centralized Commit A fix:
// upsertEventSafe records what it actually did here, keyed by `row.source`
// (NOT a per-file counter — several scrapers write multiple source keys, or
// log per-source in a loop, from one process), and logUpsertResult prefers
// that observed tally over whatever the caller passed, so every call site
// becomes honest without being touched.
const _observedUpserts = new Map() // source → { inserted, updated }

function _recordUpsertObservation(source, isNew) {
  if (!source) return
  const tally = _observedUpserts.get(source) ?? { inserted: 0, updated: 0 }
  if (isNew) tally.inserted++
  else tally.updated++
  _observedUpserts.set(source, tally)
}

/** Test-only: clear all observed tallies between test cases. */
export function _resetUpsertObservations() {
  _observedUpserts.clear()
}

/** Test-only: snapshot the current observed tallies (does not consume them). */
export function _getUpsertObservations() {
  return new Map(_observedUpserts)
}

/**
 * Log a summary of an upsert result to the console AND write a row to
 * the scraper_runs table for health monitoring.
 *
 * If upsertEventSafe recorded an observed tally for `source` (the normal
 * case for any scraper that ran this call), the OBSERVED inserted/updated
 * counts are used instead of the caller's arguments — a call site passing a
 * stale/hardcoded value (e.g. a literal 0) no longer lies to scraper_runs.
 * A caller/observed mismatch is logged as a warning (naming the source and
 * both numbers) rather than silently overridden, so drift is discoverable.
 * The tally is deleted after being read so a second logUpsertResult call for
 * the same source (e.g. a scraper logging error + success rows) can't
 * double-count it. `eventsFound` is untouched — it stays derived from the
 * caller's own arguments, per the existing per-source baseline contract.
 */
export async function logUpsertResult(source, inserted, updated, skipped, opts = {}) {
  const {
    status       = 'success',
    errorMessage = null,
    durationMs   = null,
  } = opts

  const eventsFound = opts.eventsFound ?? (inserted + updated + skipped)

  let finalInserted = inserted
  let finalUpdated  = updated

  const observed = _observedUpserts.get(source)
  if (observed) {
    if (observed.inserted !== inserted || observed.updated !== updated) {
      console.warn(
        `  ⚠ [${source}] logUpsertResult argument mismatch — caller passed ${inserted} inserted / ${updated} updated, ` +
        `observed ${observed.inserted} inserted / ${observed.updated} updated from upsertEventSafe. Using observed counts.`
      )
    }
    finalInserted = observed.inserted
    finalUpdated  = observed.updated
    _observedUpserts.delete(source)
  }

  const icon = status === 'error' ? '❌' : '✓'
  console.log(
    `[${source}] ${icon}  ${finalInserted} inserted  ${finalUpdated} updated  ${skipped} skipped` +
    (eventsFound !== finalInserted + finalUpdated + skipped ? `  (${eventsFound} total from source)` : '') +
    (durationMs != null ? `  [${(durationMs / 1000).toFixed(1)}s]` : '')
  )

  try {
    const { error } = await supabaseAdmin
      .from('scraper_runs')
      .insert({
        scraper_name:    source,
        status,
        events_found:    eventsFound,
        events_inserted: finalInserted,
        events_updated:  finalUpdated,
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
