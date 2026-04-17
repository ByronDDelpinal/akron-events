/**
 * Shared JSON-LD (schema.org) extraction utilities.
 *
 * Used by scrapers that pull structured data out of <script type="application/ld+json">
 * blocks — Nightlight Cinema's Movie pages, and future consumers like Akron
 * Symphony / Rialto / Akron Life.
 *
 * Usage:
 *   import { extractJsonLd, findSchemaObjects, isoDurationToMinutes } from './lib/json-ld.js'
 *
 *   const blocks = extractJsonLd(html)
 *   const movies = findSchemaObjects(blocks, 'Movie')
 *   const minutes = isoDurationToMinutes(movies[0].duration)  // "PT2H3M" → 123
 */

// ── Extraction ────────────────────────────────────────────────────────────

/**
 * Extract every JSON-LD block from an HTML string as a flat array of objects.
 *
 * Handles the three shapes we've seen in the wild:
 *   1. A single object:        {"@type": "Movie", ...}
 *   2. An array of objects:    [{"@type": "Movie"}, {"@type": "Person"}]
 *   3. A @graph wrapper:       {"@context": "...", "@graph": [...]}
 *
 * Parse failures on any individual block are silently skipped — a broken LD
 * block on one page shouldn't kill the whole scrape.
 */
export function extractJsonLd(html) {
  if (!html || typeof html !== 'string') return []
  const out = []
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match
  while ((match = re.exec(html)) !== null) {
    const raw = (match[1] || '').trim()
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        out.push(...parsed.filter(x => x && typeof x === 'object'))
      } else if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed['@graph'])) {
          out.push(...parsed['@graph'].filter(x => x && typeof x === 'object'))
        } else {
          out.push(parsed)
        }
      }
    } catch { /* skip malformed block */ }
  }
  return out
}

/**
 * Filter an array of JSON-LD objects by @type value(s).
 *
 * Accepts either a single type string or an array. Matches objects whose
 * @type either equals the given type OR is an array that includes it
 * (schema.org allows @type: ["Movie", "CreativeWork"]).
 */
export function findSchemaObjects(objects, types) {
  if (!Array.isArray(objects)) return []
  const wanted = Array.isArray(types) ? types : [types]
  return objects.filter(obj => {
    const t = obj?.['@type']
    if (!t) return false
    if (typeof t === 'string') return wanted.includes(t)
    if (Array.isArray(t)) return t.some(tt => wanted.includes(tt))
    return false
  })
}

/**
 * Parse an ISO 8601 duration string (e.g. "PT2H3M", "PT45M", "PT1H30M30S")
 * into total minutes. Seconds round down. Returns null for non-string or
 * unparseable input.
 *
 * Only accepts the time-component subset (PT…) that schema.org's Movie/Event
 * durations use. Full ISO 8601 durations with date components are not
 * supported — those don't occur for event/movie runtimes.
 */
export function isoDurationToMinutes(s) {
  if (!s || typeof s !== 'string') return null
  const m = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i)
  if (!m) return null
  // All three capture groups optional, but at least one must be present
  if (m[1] == null && m[2] == null && m[3] == null) return null
  const hours = parseInt(m[1] || '0', 10)
  const mins  = parseInt(m[2] || '0', 10)
  const secs  = parseFloat(m[3] || '0')
  if (!Number.isFinite(hours) || !Number.isFinite(mins) || !Number.isFinite(secs)) return null
  return hours * 60 + mins + Math.floor(secs / 60)
}

/**
 * Get a string URL from a schema.org image property. The spec allows the
 * property to be a string, an ImageObject with `.url`, or an array of either.
 * Returns the first URL found, or null.
 */
export function firstImageUrl(imageProp) {
  if (!imageProp) return null
  const items = Array.isArray(imageProp) ? imageProp : [imageProp]
  for (const item of items) {
    if (typeof item === 'string' && /^https?:\/\//i.test(item)) return item
    if (item && typeof item === 'object') {
      const url = item.url || item.contentUrl
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) return url
    }
  }
  return null
}
