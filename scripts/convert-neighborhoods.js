#!/usr/bin/env node
/**
 * convert-neighborhoods.js
 *
 * Convert the City of Akron neighborhood shapefile to a web-ready
 * WGS-84 GeoJSON, keyed by the canonical neighborhood slug used
 * throughout the codebase.
 *
 * Source:
 *   data/gis/akron-neighborhoods/Akron_Neighborhoods.{shp,dbf,prj,…}
 *
 * Output:
 *   public/akron-neighborhoods.geojson
 *
 * Why both this script and the file it produces are committed:
 *   - The frontend reads the GeoJSON directly (no client-side
 *     reprojection, no client-side shapefile parsing). Shipping the
 *     pre-converted output keeps the dev/CI build dependency-free.
 *   - The script is committed so the conversion is reproducible: if
 *     the City publishes an updated shapefile, drop it into
 *     data/gis/akron-neighborhoods/ and re-run `npm run gis:convert`.
 *
 * Dependencies (devDeps):
 *   - shapefile  — pure-JS .shp/.dbf reader
 *   - proj4      — coordinate reprojection
 *
 * Run:
 *   npm install   # one-time, picks up the two devDeps
 *   npm run gis:convert
 *
 * Slug map:
 *   The shapefile's NAME field maps 1:1 to the canonical slugs in
 *   src/lib/neighborhoods.js EXCEPT for one rename:
 *     "University of Akron" → "university-park"
 *   The City's GIS labels the area after the university; the Art × Love
 *   neighborhood poster (and our public-facing brand) calls it
 *   "University Park". We treat the poster as canonical. Any future
 *   discrepancies should be added to SLUG_FOR_NAME below.
 *
 * Projection:
 *   Source: NAD83 / Ohio North (ftUS), Lambert Conformal Conic
 *           — EPSG:3734, read off the included .prj.
 *   Target: WGS-84 lat/lon (EPSG:4326), the format every web map and
 *           PostGIS query expects.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as shapefile from 'shapefile'
import proj4 from 'proj4'

// ── Paths ──────────────────────────────────────────────────────────
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHP_BASE  = resolve(REPO_ROOT, 'data/gis/akron-neighborhoods/Akron_Neighborhoods')
const OUT_PATH  = resolve(REPO_ROOT, 'public/akron-neighborhoods.geojson')

// ── Canonical slug map ─────────────────────────────────────────────
// Keep keys EXACTLY as they appear in the shapefile NAME field — the
// build will throw if it sees a NAME that isn't in this table, which
// catches drift early (e.g. if the City renames or adds a polygon).
//
// Values must match src/lib/neighborhoods.js NEIGHBORHOODS[].slug AND
// the CHECK constraint in supabase/migrations/028_venue_neighborhood_slug.sql.
const SLUG_FOR_NAME = {
  'Chapel Hill':         'chapel-hill',
  'North Hill':          'north-hill',
  'Merriman Hills':      'merriman-hills',
  'West Hill':           'west-hill',
  'Highland Square':     'highland-square',
  'Wallhaven':           'wallhaven',
  'Downtown Akron':      'downtown-akron',
  'Goodyear Heights':    'goodyear-heights',
  'Sherbondy Hill':      'sherbondy-hill',
  'West Akron':          'west-akron',
  'Fairlawn Heights':    'fairlawn-heights',
  'Northwest Akron':     'northwest-akron',
  'East Akron':          'east-akron',
  'Ellet':               'ellet',
  'High Hampton':        'high-hampton',
  'Middlebury':          'middlebury',
  'Cascade Valley':      'cascade-valley',
  // The one and only rename — see header comment for the rationale.
  'University of Akron': 'university-park',
  'Summit Lake':         'summit-lake',
  'South Akron':         'south-akron',
  'Merriman Valley':     'merriman-valley',
  'Kenmore':             'kenmore',
  'Firestone Park':      'firestone-park',
  'Coventry Crossing':   'coventry-crossing',
}

// ── Projection setup ───────────────────────────────────────────────
// EPSG:3734 = NAD83 / Ohio North (ftUS). Definition pulled verbatim
// from spatialreference.org so we don't have to parse the included
// .prj at runtime. proj4 strings are stable across versions.
const NAD83_OH_N_FTUS =
  '+proj=lcc +lat_1=41.7 +lat_2=40.43333333333333 +lat_0=39.66666666666666 ' +
  '+lon_0=-82.5 +x_0=600000 +y_0=0 +ellps=GRS80 +datum=NAD83 +units=us-ft +no_defs'

proj4.defs('EPSG:3734', NAD83_OH_N_FTUS)
const SRC = 'EPSG:3734'
const DST = 'EPSG:4326'   // WGS-84 lat/lon — proj4's built-in default

const reproject = (xy) => proj4(SRC, DST, xy)

// ── Reproject every coordinate in a GeoJSON geometry ───────────────
// shapefile.read() yields GeoJSON-shaped geometries already; we just
// need to walk every [x, y] pair and swap it for [lon, lat].
function reprojectGeometry(geom) {
  if (!geom) return geom
  const walk = (coords) =>
    typeof coords[0] === 'number'
      ? reproject([coords[0], coords[1]])
      : coords.map(walk)
  return { ...geom, coordinates: walk(geom.coordinates) }
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  const shpBuf = await readFile(`${SHP_BASE}.shp`)
  const dbfBuf = await readFile(`${SHP_BASE}.dbf`)

  const source = await shapefile.open(shpBuf, dbfBuf, { encoding: 'utf-8' })

  const features = []
  const seenSlugs = new Set()

  // shapefile streams records one at a time so we can fail fast on
  // any record whose NAME isn't in our slug map.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await source.read()
    if (result.done) break
    const { properties, geometry } = result.value
    const name = properties?.NAME?.trim()
    const slug = SLUG_FOR_NAME[name]
    if (!slug) {
      throw new Error(
        `Unknown neighborhood NAME "${name}". Add it to SLUG_FOR_NAME ` +
        `in scripts/convert-neighborhoods.js AND src/lib/neighborhoods.js ` +
        `AND the CHECK constraint migration before re-running.`,
      )
    }
    if (seenSlugs.has(slug)) {
      throw new Error(`Duplicate slug "${slug}" — two NAMEs mapped to the same slug.`)
    }
    seenSlugs.add(slug)

    features.push({
      type: 'Feature',
      properties: { slug, name },
      geometry: reprojectGeometry(geometry),
    })
  }

  // Hard fail if the shapefile is missing any of the 24 canonical
  // slugs — that's a data regression we want to catch loudly.
  const expected = new Set(Object.values(SLUG_FOR_NAME))
  const missing = [...expected].filter((s) => !seenSlugs.has(s))
  if (missing.length > 0) {
    throw new Error(`Missing slugs in shapefile output: ${missing.join(', ')}`)
  }

  const fc = {
    type: 'FeatureCollection',
    name: 'akron-neighborhoods',
    // CRS84 is the WGS-84 long/lat convention RFC 7946 actually
    // wants; "EPSG:4326" technically has lat/lon order. They're the
    // same datum so any consumer accepts either, but we declare the
    // strict one explicitly.
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    features,
  }

  await mkdir(dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, JSON.stringify(fc))

  const { size } = await import('node:fs/promises').then((m) => m.stat(OUT_PATH))
  console.log(`wrote ${OUT_PATH} (${size.toLocaleString()} bytes, ${features.length} features)`)
}

main().catch((err) => {
  console.error('convert-neighborhoods.js failed:', err)
  process.exit(1)
})
