/**
 * neighborhood-resolver.js
 *
 * Resolve a (lat, lng) pair to a canonical Akron neighborhood slug.
 *
 * Used in two places:
 *   1. Backfill — scripts/classify-venues-by-polygon.js walks the
 *      venues table and stamps neighborhood_slug for everyone with
 *      coordinates.
 *   2. Live ingest — scripts/lib/normalize.js calls into here from
 *      ensureVenue so new scraped venues land pre-classified.
 *
 * The GeoJSON file (public/akron-neighborhoods.geojson) is loaded
 * lazily and cached at the module level — the polygons don't change
 * between calls in a single process. The file lives in public/ rather
 * than data/ because it doubles as a static asset the frontend
 * fetches; one source of truth is better than maintaining two copies.
 *
 * Point-in-polygon implementation:
 *   Plain ray-casting (Jordan curve theorem). No npm dep on Turf /
 *   point-in-polygon / polygon-clipping — those packages would have
 *   to be installed by anyone running scrapers, and the math here is
 *   ~25 lines and well-understood.
 *
 *   Holes work because we toggle the inside flag on every ring crossing
 *   — even-odd fill rule. A point inside an outer ring AND inside a
 *   hole counts as "outside", which matches GeoJSON's intent.
 *
 * Performance:
 *   24 polygons × ~150 points each = ~3,600 segment tests per query.
 *   That's fast enough we don't need a spatial index for the live
 *   ingest path. The backfill processes thousands of venues in seconds.
 *   If we ever need to scale (e.g. classifying millions of points),
 *   pre-build an R-tree of polygon bboxes and short-circuit the
 *   ray-cast when the point is outside the bbox — but not yet.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// Project root: scripts/lib/this-file.js → ../..
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GEOJSON_PATH = resolve(REPO_ROOT, 'public', 'akron-neighborhoods.geojson')

// Module-level cache: features array of { slug, name, bbox, polygons }.
// Each polygon is an array of rings; each ring is an array of [lng, lat].
let _features = null
let _loadPromise = null

/**
 * Load and prepare the neighborhood polygons. Concurrent callers share
 * the same promise so we never parse the JSON twice.
 */
async function load() {
  if (_features) return _features
  if (!_loadPromise) {
    _loadPromise = readFile(GEOJSON_PATH, 'utf-8').then((text) => {
      const fc = JSON.parse(text)
      _features = fc.features.map((f) => {
        // Normalize Polygon and MultiPolygon into one shape: an array
        // of polygons, each polygon = array of rings, each ring =
        // array of [lng, lat]. Saves a type check at query time.
        const polys = f.geometry.type === 'MultiPolygon'
          ? f.geometry.coordinates
          : [f.geometry.coordinates]
        // Per-feature bbox lets us short-circuit ray casting for
        // points clearly outside this neighborhood. Cheap to compute,
        // significant speedup on a tight loop.
        let minLng = Infinity, minLat = Infinity
        let maxLng = -Infinity, maxLat = -Infinity
        for (const poly of polys) {
          for (const ring of poly) {
            for (const [lng, lat] of ring) {
              if (lng < minLng) minLng = lng
              if (lng > maxLng) maxLng = lng
              if (lat < minLat) minLat = lat
              if (lat > maxLat) maxLat = lat
            }
          }
        }
        return {
          slug: f.properties.slug,
          name: f.properties.name,
          bbox: [minLng, minLat, maxLng, maxLat],
          polygons: polys,
        }
      })
      return _features
    })
  }
  return _loadPromise
}

/**
 * Test whether a point lies inside a single GeoJSON ring (array of
 * [lng, lat]). Classic ray casting — we shoot a horizontal ray east
 * from the point and count edge crossings.
 */
function pointInRing(lng, lat, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const intersect =
      ((yi > lat) !== (yj > lat)) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/**
 * Test whether a point lies inside a polygon (outer ring + holes).
 * GeoJSON convention: first ring is outer, subsequent rings are
 * holes. Even-odd rule: a point inside an odd number of rings is
 * inside the polygon.
 */
function pointInPolygon(lng, lat, polygon) {
  let inside = false
  for (const ring of polygon) {
    if (pointInRing(lng, lat, ring)) inside = !inside
  }
  return inside
}

/**
 * Resolve a coordinate to a canonical neighborhood slug, or null if
 * the point falls outside every Akron neighborhood (i.e. outside city
 * limits — Cuyahoga Falls, Stow, Fairlawn, Copley, etc.). Accepts
 * numeric or string inputs; returns null on missing / non-finite
 * values rather than throwing, so callers can chain it cheaply.
 *
 * @param {number|string} lat
 * @param {number|string} lng
 * @returns {Promise<string|null>}
 */
export async function resolveNeighborhoodSlug(lat, lng) {
  const latN = typeof lat === 'number' ? lat : parseFloat(lat)
  const lngN = typeof lng === 'number' ? lng : parseFloat(lng)
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) return null

  const feats = await load()
  for (const f of feats) {
    const [minLng, minLat, maxLng, maxLat] = f.bbox
    // bbox prefilter — skip the ~150 segment tests if the point is
    // clearly outside this neighborhood's bounding rectangle.
    if (lngN < minLng || lngN > maxLng || latN < minLat || latN > maxLat) continue
    for (const poly of f.polygons) {
      if (pointInPolygon(lngN, latN, poly)) return f.slug
    }
  }
  return null
}

/** Expose for tests / scripts that want the raw feature list. */
export async function loadNeighborhoodFeatures() {
  return load()
}
