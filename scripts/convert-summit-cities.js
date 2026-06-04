#!/usr/bin/env node
/**
 * convert-summit-cities.js
 *
 * Extract Summit County, Ohio's major places (the 14 individual
 * cities AND three regional rollups for the rest of the county)
 * from US Census TIGER/Line shapefiles and emit a web-ready WGS-84
 * GeoJSON that SummitCountyMap renders at runtime.
 *
 * Output features:
 *   - 14 individual city polygons (Akron, Cuyahoga Falls, …)
 *   - 3 regional MultiPolygons that fold every remaining Summit
 *     County township and village into Northwest / Northeast /
 *     Southeast Summit County. Those three regions fill in the gaps
 *     so the map shows the complete county shape rather than islands
 *     of incorporated places floating in empty space.
 *
 * Two source shapefiles, both pulled from Census TIGER/Line:
 *
 *   1. PLACE   — incorporated cities + villages. Most of our 14
 *                canonical cities live here, and so do the small
 *                villages (Peninsula, Northfield, Boston Heights,
 *                Reminderville, Silver Lake, Lakemore, Mogadore, etc.)
 *                that aggregate into regions.
 *      Source:  data/gis/ohio_places/tl_2025_39_place.{shp,dbf,prj,…}
 *      Download:
 *        mkdir -p data/gis/ohio_places
 *        curl -L -o data/gis/ohio_places/tl_2025_39_place.zip \
 *          https://www2.census.gov/geo/tiger/TIGER2025/PLACE/tl_2025_39_place.zip
 *        unzip data/gis/ohio_places/tl_2025_39_place.zip \
 *          -d data/gis/ohio_places/
 *
 *   2. COUSUB  — county subdivisions / townships. Copley is
 *                administered as a township and only appears here.
 *                Other Summit County townships (Bath, Boston,
 *                Richfield, Sagamore Hills, Northfield Center,
 *                Springfield, Twinsburg) feed the regional rollups.
 *      Source:  data/gis/ohio_county_subs/tl_2025_39_cousub.{shp,dbf,prj,…}
 *      Download:
 *        mkdir -p data/gis/ohio_county_subs
 *        curl -L -o data/gis/ohio_county_subs/tl_2025_39_cousub.zip \
 *          https://www2.census.gov/geo/tiger/TIGER2025/COUSUB/tl_2025_39_cousub.zip
 *        unzip data/gis/ohio_county_subs/tl_2025_39_cousub.zip \
 *          -d data/gis/ohio_county_subs/
 *
 * Both shapefile directories are gitignored — the GeoJSON we ship
 * is the (~hundreds of KB) output file at
 * public/summit-county-cities.geojson.
 *
 * Filtering:
 *   PLACE shapefiles carry NAME but no county code (places can
 *   cross county lines). We name-match against the canonical city
 *   list and the village list, which are unique enough within Ohio
 *   to be safe.
 *
 *   COUSUB shapefiles include STATEFP + COUNTYFP, so we restrict to
 *   STATEFP=39 (Ohio) + COUNTYFP=153 (Summit County). For township
 *   matches we also require NAMELSAD to end in "township" so a
 *   township doesn't collide with a city of the same NAME (e.g.
 *   COUSUB has both "Twinsburg" the city and "Twinsburg" the
 *   township; we only want the township here).
 *
 * Regional aggregation:
 *   Each township/village in {TOWNSHIP,VILLAGE}_REGION is added to
 *   its region's polygon bag (one bag per region). Once both
 *   shapefiles are read, we emit one MultiPolygon feature per
 *   region. Overlapping polygons (a village nested inside its
 *   parent township) are kept — SVG's default nonzero fill rule
 *   renders the overlap as solid fill and the boundary lines
 *   between township and village are informative.
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as shapefile from 'shapefile'
import proj4 from 'proj4'

import { CITIES, REGIONS } from '../src/lib/cities.js'

const REPO_ROOT  = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLACE_BASE = resolve(REPO_ROOT, 'data/gis/ohio_places/tl_2025_39_place')
const COUSUB_BASE = resolve(REPO_ROOT, 'data/gis/ohio_county_subs/tl_2025_39_cousub')
const OUT_PATH   = resolve(REPO_ROOT, 'public/summit-county-cities.geojson')

// Summit County, OH = STATEFP=39 + COUNTYFP=153.
const SUMMIT_STATEFP  = '39'
const SUMMIT_COUNTYFP = '153'

// ── Slugs that live in COUSUB rather than PLACE ─────────────────────
//
// City hubs whose canonical entity is administered as a township and
// thus only appears in COUSUB. Append when adding future
// township-administered cities to CITIES.
//
// Empty today — Copley used to live here before it was folded into
// the Fairlawn hub. Its COUSUB polygon now routes through
// MERGE_INTO_SLUG below.
const COUSUB_FALLBACK_SLUGS = new Set()

// ── Region assignments — townships ──────────────────────────────────
//
// Each Summit County township that DOESN'T have its own city hub
// gets folded into one of the three regional rollups. Copley is
// excluded because it's already a city hub.
//
// Coventry Township was largely absorbed into the City of New
// Franklin in 2003; if a sliver still appears in TIGER it falls
// into the southeast region with Springfield.
const TOWNSHIP_REGION = {
  'Bath':              'northwest-summit-county',
  'Boston':            'northwest-summit-county',
  'Richfield':         'northwest-summit-county',
  'Sagamore Hills':    'northeast-summit-county',
  'Northfield Center': 'northeast-summit-county',
  'Twinsburg':         'northeast-summit-county',
  'Springfield':       'southeast-summit-county',
  'Coventry':          'southeast-summit-county',
}

// ── Region assignments — places that aggregate into a region ────────
//
// Summit County places (villages OR cities) that don't merit their
// own hub fold into one of the three regional rollups instead.
// "Richfield" appears here as a village AND in TOWNSHIP_REGION as a
// township; they're separate polygons in different shapefiles, both
// correctly route to the northwest region.
//
// Twinsburg and Macedonia were previously standalone city hubs but
// were folded into the northeast region after coverage proved thin —
// their PLACE polygons land in the NE bag, and their venue.city
// values surface via the NE hub's cityMatch.
const PLACE_REGION = {
  'Richfield':      'northwest-summit-county',
  'Peninsula':      'northwest-summit-county',
  'Northfield':     'northeast-summit-county',
  'Boston Heights': 'northeast-summit-county',
  'Reminderville':  'northeast-summit-county',
  'Twinsburg':      'northeast-summit-county',
  'Macedonia':      'northeast-summit-county',
  'Lakemore':       'southeast-summit-county',
  'Mogadore':       'southeast-summit-county',
}

// ── PLACE / COUSUB → city slug merges ───────────────────────────────
//
// Small Summit County places that should be visually and functionally
// folded into a neighboring city hub rather than rendering as their
// own polygon or a regional rollup contributor. Each entry maps a
// TIGER NAME (from EITHER shapefile) to the city slug whose
// MultiPolygon should absorb its geometry; the absorbing hub's
// cityMatch already covers the place's venue.city values.
//
//   Silver Lake (~2,500 residents, encircled by Stow)       → stow
//   Munroe Falls (~5,000 residents, river-adjacent to
//     Tallmadge, shares Stow's school district)             → tallmadge
//   Norton (~12,000 residents, west of Barberton, shares
//     the western industrial belt)                          → barberton
//   Copley Township (~17,000 residents, shares Copley-
//     Fairlawn schools and library with Fairlawn)           → fairlawn
const MERGE_INTO_SLUG = {
  'Silver Lake':  'stow',
  'Munroe Falls': 'tallmadge',
  'Norton':       'barberton',
  'Copley':       'fairlawn',
}

// ── Per-source slug maps for the individual city hubs ───────────────
const SLUG_FOR_NAME_PLACE = Object.fromEntries(
  CITIES.filter((c) => !COUSUB_FALLBACK_SLUGS.has(c.slug))
        .map((c) => [c.label, c.slug]),
)
const SLUG_FOR_NAME_COUSUB = Object.fromEntries(
  CITIES.filter((c) => COUSUB_FALLBACK_SLUGS.has(c.slug))
        .map((c) => [c.label, c.slug]),
)

// ── Projection setup ────────────────────────────────────────────────
proj4.defs('EPSG:4269', '+proj=longlat +datum=NAD83 +no_defs')
const SRC = 'EPSG:4269'
const DST = 'EPSG:4326'
const reproject = (xy) => proj4(SRC, DST, xy)

function reprojectGeometry(geom) {
  if (!geom) return geom
  const walk = (coords) =>
    typeof coords[0] === 'number'
      ? reproject([coords[0], coords[1]])
      : coords.map(walk)
  return { ...geom, coordinates: walk(geom.coordinates) }
}

/**
 * Normalize any GeoJSON polygon geometry to an array of polygon
 * coordinate arrays (the inner shape of a MultiPolygon). Lets us
 * mix Polygon and MultiPolygon features into one MultiPolygon bag
 * without special-casing.
 */
function toMultiPolygonCoords(geom) {
  if (!geom) return []
  if (geom.type === 'MultiPolygon') return geom.coordinates
  if (geom.type === 'Polygon')      return [geom.coordinates]
  throw new Error(`Unexpected geometry type: ${geom.type}`)
}

// ── Source readers ─────────────────────────────────────────────────
const SOURCES = [
  {
    label:    'PLACE',
    base:     PLACE_BASE,
    slugMap:  SLUG_FOR_NAME_PLACE,
    regionMap: PLACE_REGION,
    isTownship: false,
    matches:  () => true,
    download: 'https://www2.census.gov/geo/tiger/TIGER2025/PLACE/tl_2025_39_place.zip',
    destDir:  'data/gis/ohio_places',
  },
  {
    label:    'COUSUB',
    base:     COUSUB_BASE,
    slugMap:  SLUG_FOR_NAME_COUSUB,
    regionMap: TOWNSHIP_REGION,
    isTownship: true,
    matches:  (props) =>
      props?.STATEFP === SUMMIT_STATEFP && props?.COUNTYFP === SUMMIT_COUNTYFP,
    download: 'https://www2.census.gov/geo/tiger/TIGER2025/COUSUB/tl_2025_39_cousub.zip',
    destDir:  'data/gis/ohio_county_subs',
  },
]

/**
 * Read one shapefile and route every matched feature into the right
 * accumulator. Mutates the accumulators in place. Three kinds of
 * matches per feature, in priority order:
 *
 *   1. Slug match (a canonical city) — its polygons become the
 *      primary geometry for that slug.
 *   2. Merge-into match (Silver Lake → stow) — its polygons get
 *      appended to a city slug that's already (or about to be)
 *      populated by its own primary match.
 *   3. Region match (a township or village in PLACE_REGION /
 *      TOWNSHIP_REGION) — its polygons fill in a regional rollup.
 *
 * Each feature can only match one category — once we've routed it,
 * we move on.
 */
async function readSource(source, cityPolys, cityPrimary, regionPolys) {
  const wantsCities  = Object.keys(source.slugMap).length > 0
  const wantsRegions = Object.keys(source.regionMap).length > 0
  // MERGE_INTO_SLUG is global — both PLACE and COUSUB can contribute
  // merged polygons (Copley's NAME is in COUSUB; Silver Lake / Munroe
  // Falls / Norton come from PLACE). The match is by NAME so any
  // source with the matching key fires.
  const wantsMerge   = true
  if (!wantsCities && !wantsRegions && !wantsMerge) return

  try {
    await stat(`${source.base}.shp`)
  } catch {
    console.error(
      `\nCensus TIGER/Line ${source.label} shapefile not found at:\n` +
      `   ${source.base}.shp\n\n` +
      `Download it (one-time) and unzip into ${source.destDir}/  :\n\n` +
      `   mkdir -p ${source.destDir}\n` +
      `   curl -L -o ${source.destDir}/${source.label.toLowerCase()}.zip \\\n` +
      `     ${source.download}\n` +
      `   unzip ${source.destDir}/${source.label.toLowerCase()}.zip -d ${source.destDir}/\n\n` +
      `Then re-run \`npm run gis:convert-cities\`.\n`,
    )
    process.exit(2)
  }

  const shpBuf = await readFile(`${source.base}.shp`)
  const dbfBuf = await readFile(`${source.base}.dbf`)
  const reader = await shapefile.open(shpBuf, dbfBuf, { encoding: 'utf-8' })

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await reader.read()
    if (result.done) break
    const { properties, geometry } = result.value

    if (!source.matches(properties)) continue

    const name = properties?.NAME?.trim()
    if (!name) continue

    // For COUSUB we need to distinguish townships from cities of the
    // same NAME (Twinsburg, etc.). NAMELSAD ends with "township" for
    // township features.
    const isTownshipFeature =
      typeof properties?.NAMELSAD === 'string' &&
      /\btownship\b/i.test(properties.NAMELSAD)

    // 1. City-hub match (Copley, Akron, Cuyahoga Falls, …).
    //    For COUSUB we require the feature to actually BE a township
    //    when our city hub is the township flavor (Copley).
    const citySlug = source.slugMap[name]
    if (citySlug && (!source.isTownship || isTownshipFeature)) {
      if (cityPrimary[citySlug]) {
        throw new Error(
          `Duplicate NAME match "${name}" → "${citySlug}" in ${source.label}.`,
        )
      }
      const polys = toMultiPolygonCoords(reprojectGeometry(geometry))
      cityPolys[citySlug].push(...polys)
      cityPrimary[citySlug] = { name, source: source.label }
      continue
    }

    // 2. Merge-into match (Silver Lake → stow, Copley → fairlawn,
    //    etc.). Appends to a city slug's polygon bag without claiming
    //    the slug — the primary city polygon still has to come from a
    //    slugMap match elsewhere. For COUSUB merges we require
    //    township flavor (same gate as the region path) so a same-NAME
    //    city COUSUB doesn't double-merge alongside its PLACE feature.
    const mergeTargetSlug = MERGE_INTO_SLUG[name]
    if (mergeTargetSlug && (!source.isTownship || isTownshipFeature)) {
      const polys = toMultiPolygonCoords(reprojectGeometry(geometry))
      cityPolys[mergeTargetSlug].push(...polys)
      continue
    }

    // 3. Regional rollup match. For COUSUB regions we require
    //    township flavor to avoid scooping up the city features
    //    (which have the same NAME).
    const regionSlug = source.regionMap[name]
    if (regionSlug && (!source.isTownship || isTownshipFeature)) {
      const polys = toMultiPolygonCoords(reprojectGeometry(geometry))
      regionPolys[regionSlug].push(...polys)
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  // One polygon-array accumulator per city slug, so a single city
  // can absorb extras from MERGE_INTO_SLUG (Silver Lake → stow) and
  // still emit one Feature at the end.
  const cityPolys = Object.fromEntries(
    CITIES.map((c) => [c.slug, []]),
  )
  // Records the primary match for each slug — its NAME (for the
  // emitted feature's properties.name) and source label (for the
  // run summary). Stays empty for slugs that haven't been matched
  // yet, which the post-load validator below relies on.
  const cityPrimary = {}

  // One polygon-array accumulator per region. We emit a single
  // MultiPolygon Feature per region at the end.
  const regionPolys = Object.fromEntries(
    REGIONS.map((r) => [r.slug, []]),
  )

  for (const source of SOURCES) {
    await readSource(source, cityPolys, cityPrimary, regionPolys)
  }

  // Validate city coverage — every canonical slug needs a primary
  // match. Merge-only matches don't count.
  const expectedCities = new Set(CITIES.map((c) => c.slug))
  const missing = [...expectedCities].filter((s) => !cityPrimary[s])
  if (missing.length > 0) {
    console.error(
      `\nMissing ${missing.length} canonical Summit County cities after ` +
      `searching ${SOURCES.map((s) => s.label).join(' + ')}:`,
    )
    for (const slug of missing) {
      const label = CITIES.find((c) => c.slug === slug).label
      console.error(`   - ${slug.padEnd(18)} (NAME would be "${label}")`)
    }
    process.exit(1)
  }

  // Build one Feature per city slug. Polygons come from cityPolys —
  // which may include merged sources like Silver Lake — emitted as
  // a MultiPolygon so the consumer doesn't have to branch by type.
  const cityFeatures = CITIES.map((c) => ({
    type: 'Feature',
    properties: {
      slug:   c.slug,
      name:   cityPrimary[c.slug].name,
      source: cityPrimary[c.slug].source,
    },
    geometry: { type: 'MultiPolygon', coordinates: cityPolys[c.slug] },
  }))

  // Validate region coverage — at least one polygon per region.
  // Empty regions usually mean a NAME drift in TIGER (e.g. a township
  // was renamed) or that the COUSUB shapefile isn't filtered to
  // Summit County. Better to fail loud than ship an invisible region.
  const emptyRegions = REGIONS.filter((r) => regionPolys[r.slug].length === 0)
  if (emptyRegions.length > 0) {
    console.error(
      `\nMissing geometry for ${emptyRegions.length} regional rollup(s):`,
    )
    for (const r of emptyRegions) {
      console.error(`   - ${r.slug}  (${r.label})`)
    }
    console.error(
      `\nCheck the TOWNSHIP_REGION / PLACE_REGION maps in this\n` +
      `script — TIGER may have renamed or restructured a township\n` +
      `or village.\n`,
    )
    process.exit(1)
  }

  const regionFeatures = REGIONS.map((r) => ({
    type: 'Feature',
    properties: { slug: r.slug, name: r.label, source: 'REGION' },
    geometry: { type: 'MultiPolygon', coordinates: regionPolys[r.slug] },
  }))

  const features = [...cityFeatures, ...regionFeatures]

  const fc = {
    type: 'FeatureCollection',
    name: 'summit-county-cities',
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    features,
  }

  await mkdir(dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, JSON.stringify(fc))
  const { size } = await stat(OUT_PATH)
  console.log(
    `wrote ${OUT_PATH} (${size.toLocaleString()} bytes, ${features.length} features)`,
  )

  // Per-source breakdown so the operator can confirm the right
  // sources contributed to the right hubs.
  const bySource = {}
  for (const f of features) {
    bySource[f.properties.source] = (bySource[f.properties.source] ?? 0) + 1
  }
  for (const [src, count] of Object.entries(bySource)) {
    console.log(`  ${src.padEnd(8)} ${count} features`)
  }
  for (const r of REGIONS) {
    console.log(`  region   ${r.slug.padEnd(26)} ${regionPolys[r.slug].length} polygons aggregated`)
  }
}

main().catch((err) => {
  console.error('convert-summit-cities.js failed:', err)
  process.exit(1)
})
