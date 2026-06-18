/**
 * neighborhoodGeo.ts
 *
 * Loads Akron neighborhood boundary geometry (public/akron-neighborhoods.geojson)
 * and derives the pieces MapView needs to spotlight a single neighborhood:
 *   - its bounding box, to fit the camera onto the neighborhood, and
 *   - a "mask" polygon (the world with the neighborhood cut out as a hole) so the
 *     rest of the city can be dimmed with an on-theme tint.
 *
 * The GeoJSON is ~410 KB, so it's fetched lazily (only when an embed is scoped
 * to a neighborhood and the map view is opened) and the parse is memoized at
 * module scope to dedupe concurrent mounts. Features carry a `slug` property
 * matching the canonical slugs in lib/neighborhoods.
 */

type Position = [number, number]
type Ring = Position[]

type Geometry =
  | { type: 'Polygon'; coordinates: Ring[] }
  | { type: 'MultiPolygon'; coordinates: Ring[][] }

interface NeighborhoodFeature {
  type: 'Feature'
  geometry: Geometry
  properties: { slug?: string; name?: string }
}

interface FeatureCollection {
  type: 'FeatureCollection'
  features: NeighborhoodFeature[]
}

/** [west, south, east, north] */
export type BBox = [number, number, number, number]

export interface NeighborhoodGeo {
  slug: string
  name: string
  bbox: BBox
  /** The neighborhood boundary itself — data for a fill + line Source. */
  feature: GeoJSON.Feature
  /** World polygon with the neighborhood punched out, to dim everything else. */
  mask: GeoJSON.Feature
}

const GEOJSON_URL = '/akron-neighborhoods.geojson'

let cache: Promise<FeatureCollection> | null = null

function loadCollection(): Promise<FeatureCollection> {
  if (!cache) {
    cache = fetch(GEOJSON_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`neighborhood geojson ${r.status}`)
        return r.json() as Promise<FeatureCollection>
      })
      .catch((err) => {
        cache = null // allow a later retry rather than caching the failure
        throw err
      })
  }
  return cache
}

/** Outer ring of each polygon (the area), ignoring any inner holes. */
function outerRings(geometry: Geometry): Ring[] {
  return geometry.type === 'Polygon'
    ? [geometry.coordinates[0]]
    : geometry.coordinates.map((poly) => poly[0])
}

function computeBbox(geometry: Geometry): BBox {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
  for (const ring of outerRings(geometry)) {
    for (const [lon, lat] of ring) {
      if (lon < west) west = lon
      if (lon > east) east = lon
      if (lat < south) south = lat
      if (lat > north) north = lat
    }
  }
  return [west, south, east, north]
}

// A ring covering the whole map; Mapbox renders subsequent rings as holes, so
// filling this polygon paints everything EXCEPT the neighborhood.
const WORLD_RING: Ring = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]

function buildMask(geometry: Geometry): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [WORLD_RING, ...outerRings(geometry)] },
  }
}

/**
 * Resolve a neighborhood slug to its boundary geometry, bbox, and dimming mask.
 * Returns null if the geojson can't be loaded or the slug isn't found, so the
 * caller falls back to the default (un-scoped) map.
 */
export async function loadNeighborhoodGeo(slug: string): Promise<NeighborhoodGeo | null> {
  try {
    const fc = await loadCollection()
    const feature = fc.features.find((f) => f.properties?.slug === slug)
    if (!feature) return null
    return {
      slug,
      name: feature.properties?.name ?? slug,
      bbox: computeBbox(feature.geometry),
      feature: feature as unknown as GeoJSON.Feature,
      mask: buildMask(feature.geometry),
    }
  } catch {
    return null
  }
}
