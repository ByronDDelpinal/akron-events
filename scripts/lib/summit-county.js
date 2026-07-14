/**
 * scripts/lib/summit-county.js
 *
 * Tiny no-deps geo helper: is a (lat, lng) point inside the Summit
 * County, Ohio boundary?
 *
 * Why this exists:
 *   The Akron Life Evvnt feed includes nationwide backfill — events
 *   from outside Summit County leak in at the edges of any radius
 *   gate (Strongsville at 22 mi). Town-name blocklists work but are
 *   finicky and never quite complete.
 *
 *   The authoritative answer is a polygon check against Summit
 *   County's actual boundary. The TIGER/Line polygon lives in
 *   `public/summit-county-boundary.geojson` (regenerated via
 *   `npm run gis:convert-summit`). This helper loads it once and
 *   exposes a synchronous `pointInSummitCounty(lat, lng)`.
 *
 * Algorithm:
 *   Classic crossing-number (ray casting). For each ring, walk every
 *   edge and count how many edges a horizontal ray from the test
 *   point crosses. Odd crossings → inside, even → outside.
 *
 *   Summit County's boundary is one outer ring with no holes, so we
 *   don't need to handle the MultiPolygon-with-holes XOR semantics.
 *   We support them defensively anyway in case Census ever publishes
 *   a multi-part feature.
 *
 * Usage:
 *   import { pointInSummitCounty } from './lib/summit-county.js'
 *   pointInSummitCounty(41.0814, -81.5190) // → true   (downtown Akron)
 *   pointInSummitCounty(41.3141, -81.8194) // → false  (Strongsville)
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const REPO_ROOT  = resolve(dirname(__filename), '..', '..')
const GEOJSON_PATH = resolve(REPO_ROOT, 'public/summit-county-boundary.geojson')

// ── Lazy load ─────────────────────────────────────────────────────
// Module-scope cache of the parsed polygon rings. Each ring is an
// array of [lng, lat] pairs (GeoJSON order). We normalise the
// shapefile's Polygon / MultiPolygon shapes into a flat list of
// rings; the crossing-number sum runs across all of them, which
// gives the right XOR-of-windings answer for any combination.
let RINGS = null

async function loadRings() {
  if (RINGS) return RINGS
  const raw = await readFile(GEOJSON_PATH, 'utf8')
  const fc  = JSON.parse(raw)
  const feature = fc.features?.[0]
  if (!feature) throw new Error(`No feature in ${GEOJSON_PATH}`)
  const geom = feature.geometry
  const rings = []
  if (geom.type === 'Polygon') {
    rings.push(...geom.coordinates)
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) rings.push(...poly)
  } else {
    throw new Error(`Unexpected geometry type "${geom.type}" in ${GEOJSON_PATH}`)
  }
  RINGS = rings
  return RINGS
}

/**
 * Eagerly load + cache the boundary GeoJSON. Call once at scraper
 * startup so the first `pointInSummitCounty()` call is synchronous.
 */
export async function preloadSummitCountyBoundary() {
  await loadRings()
}

/**
 * True iff (lat, lng) is inside the Summit County polygon.
 *
 * Requires `preloadSummitCountyBoundary()` to have been awaited first
 * (the helper is intentionally synchronous — call sites that don't
 * pre-load will throw rather than silently miss the polygon check).
 */
// ── City allowlist + combined locality gate ──────────────────────────────
// Postal city/township names whose addresses fall inside Summit County. Used
// when a venue has no coordinates to feed the polygon check. Uniontown (44685)
// and Mogadore (44260) straddle the county line; we accept them rather than
// drop legit Green/Springfield-edge events. Single source of truth shared by
// every scraper that gates on locality (eventbrite, meetup, …).
export const SUMMIT_COUNTY_CITIES = new Set([
  'akron', 'barberton', 'cuyahoga falls', 'fairlawn', 'green', 'hudson',
  'macedonia', 'munroe falls', 'new franklin', 'norton', 'stow', 'tallmadge',
  'twinsburg', 'boston heights', 'clinton', 'lakemore', 'mogadore',
  'northfield', 'northfield center', 'peninsula', 'reminderville',
  'richfield', 'silver lake', 'sagamore hills', 'bath', 'copley',
  'coventry township', 'boston township', 'uniontown',
])

// Known NON-Summit cities/townships that show up in regional feeds. Used by
// classifySummitLocation() to return a confident 'out' for coord-less venues
// instead of 'unknown'. Moved here 2026-07-14 from scrape-akron-life.js so
// every aggregator shares one list. Never treat absence from this list as
// in-county — it only upgrades 'unknown' to 'out'.
export const NOT_SUMMIT_COUNTY_CITIES = new Set([
  // Cuyahoga County (Cleveland metro)
  'cleveland', 'east cleveland', 'cleveland heights', 'shaker heights',
  'university heights', 'south euclid', 'lyndhurst', 'mayfield',
  'mayfield heights', 'gates mills', 'pepper pike', 'beachwood',
  'orange', 'moreland hills', 'hunting valley', 'chagrin falls',
  'solon', 'bedford', 'bedford heights', 'oakwood village',
  'walton hills', 'glenwillow', 'maple heights', 'garfield heights',
  'newburgh heights', 'cuyahoga heights', 'valley view', 'independence',
  'brecksville', 'broadview heights', 'north royalton', 'seven hills',
  'parma', 'parma heights', 'strongsville', 'brooklyn', 'brook park',
  'middleburg heights', 'berea', 'olmsted falls', 'north olmsted',
  'fairview park', 'rocky river', 'lakewood', 'bay village',
  'westlake', 'avon', 'avon lake', 'north ridgeville', 'euclid',
  'richmond heights', 'highland heights', 'willowick',
  // Portage / Medina / Stark / Lake / Lorain / Wayne
  'kent', 'aurora', 'streetsboro', 'ravenna', 'mantua', 'garrettsville',
  'hiram', 'rootstown', 'windham',
  'medina', 'wadsworth', 'brunswick', 'lodi', 'seville',
  'sharon center', 'rittman', 'spencer',
  'canton', 'north canton', 'massillon', 'alliance', 'louisville',
  'east canton', 'minerva', 'hartville', 'magnolia',
  'navarre', 'brewster',
  'mentor', 'painesville', 'willoughby', 'eastlake', 'wickliffe',
  'kirtland', 'lorain', 'elyria', 'amherst', 'wooster', 'orrville',
  // Trumbull / Mahoning (Youngstown metro) — added 2026-07 after Mahoning
  // Valley Scrappers games leaked through a coord-less Niles venue.
  'niles', 'warren', 'youngstown', 'boardman', 'austintown', 'canfield',
  'girard', 'hubbard', 'struthers', 'campbell', 'poland', 'cortland',
  'newton falls', 'mcdonald', 'mineral ridge', 'howland', 'vienna',
])

// NOTE: 'uniontown' straddles the county line and is deliberately in the
// ALLOWLIST (see SUMMIT_COUNTY_CITIES above), so it must never appear here.

/** Strip a trailing "Township"/"Twp." so 'coventry township' ≡ 'coventry'. */
function normalizeCity(city) {
  return String(city ?? '').toLowerCase().trim().replace(/\s+(township|twp\.?)$/i, '')
}

/**
 * Three-way locality classification — the primitive behind the strict
 * Summit County mandate (2026-07-14: "everything inside listed, nothing
 * outside, period"):
 *
 *   'in'      → coords inside the county polygon, or city on the allowlist.
 *   'out'     → coords outside the polygon, or city on the known-non-Summit
 *               blocklist. Never ingest.
 *   'unknown' → no coords and city missing/unrecognized. Callers on regional
 *               aggregators should ingest these as status 'pending_review' so
 *               real Summit events with sloppy geo data land in the admin
 *               queue instead of silently vanishing — and leaks never publish.
 *
 * Coords are only trusted when genuinely present (Number(null) is 0 —
 * finite!) and not the (0,0) placeholder some feeds emit.
 */
export function classifySummitLocation({ lat, lng, city } = {}) {
  const hasCoords = lat != null && lat !== '' && lng != null && lng !== ''
  const la = Number(lat), ln = Number(lng)
  if (hasCoords && Number.isFinite(la) && Number.isFinite(ln) && (la !== 0 || ln !== 0)) {
    return pointInSummitCounty(la, ln) ? 'in' : 'out'
  }
  const c = String(city ?? '').toLowerCase().trim()
  if (!c) return 'unknown'
  const base = normalizeCity(c)
  if (SUMMIT_COUNTY_CITIES.has(c) || SUMMIT_COUNTY_CITIES.has(base)) return 'in'
  if (NOT_SUMMIT_COUNTY_CITIES.has(c) || NOT_SUMMIT_COUNTY_CITIES.has(base)) return 'out'
  return 'unknown'
}

/**
 * Source-agnostic BOOLEAN locality gate (strict): only 'in' passes. Kept for
 * call sites where unknown locality is out-of-scope by policy rather than
 * reviewable — e.g. meetup (unknown = online/TBD sessions, not missing data)
 * and ohio_festivals (statewide guide where every row carries a real city, so
 * an off-allowlist city means genuinely out-of-county). Regional aggregators
 * with patchy geo data should prefer classifySummitLocation() and route
 * 'unknown' to the review queue.
 */
export function isSummitCountyLocation({ lat, lng, city } = {}) {
  return classifySummitLocation({ lat, lng, city }) === 'in'
}

export function pointInSummitCounty(lat, lng) {
  if (!RINGS) {
    throw new Error(
      'pointInSummitCounty called before preloadSummitCountyBoundary(); ' +
      'await preloadSummitCountyBoundary() once at scraper startup.',
    )
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false

  // Crossing-number / ray-casting. Cast a horizontal ray to the
  // east (positive lng direction); count edges crossed. Odd → in.
  let inside = false
  for (const ring of RINGS) {
    let crossings = 0
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]   // lng, lat
      const [xj, yj] = ring[j]
      // Does this edge straddle the horizontal line y = lat?
      const intersects = (yi > lat) !== (yj > lat)
      if (!intersects) continue
      // Compute the lng at which the edge crosses y = lat. If it's
      // east of our test point, the ray crosses this edge.
      const xCross = (xj - xi) * (lat - yi) / (yj - yi) + xi
      if (lng < xCross) crossings++
    }
    if (crossings % 2 === 1) inside = !inside
  }
  return inside
}
