#!/usr/bin/env node
/**
 * convert-summit-county.js
 *
 * Extracts the Summit County, Ohio outer boundary from the US Census
 * TIGER/Line 2025 county shapefile and writes a tiny WGS-84 GeoJSON
 * the scrapers + frontend can import directly.
 *
 * Source:
 *   data/gis/us_county_boundaries/tl_2025_us_county.{shp,dbf,prj}
 *   (US Census Bureau TIGER/Line — every US county as a polygon.
 *    NAD83 geographic — EPSG:4269.)
 *
 * Output:
 *   public/summit-county-boundary.geojson  (FeatureCollection with the
 *   single Summit County polygon feature in WGS-84 lon/lat.)
 *
 * Why both this script and the file it produces are committed:
 *   - The scraper and the frontend read the GeoJSON directly. Shipping
 *     the pre-converted output keeps the scrape:all run dependency-free
 *     and avoids a 132 MB shapefile parse on every invocation.
 *   - The script is committed so the conversion is reproducible. If
 *     Census publishes a newer county shapefile (or Summit County's
 *     boundary changes), drop the new files into
 *     data/gis/us_county_boundaries/ and re-run `npm run gis:convert-summit`.
 *
 * Selection:
 *   STATEFP="39" (Ohio) + COUNTYFP="153" (Summit) — combined GEOID
 *   "39153". The script throws if exactly one match isn't found, so a
 *   schema or data regression fails the build loudly.
 *
 * Projection:
 *   Source: EPSG:4269 (NAD83 geographic). TIGER files store coords
 *   as decimal degrees on NAD83.
 *   Target: EPSG:4326 (WGS-84 geographic). The datum shift between
 *   NAD83 and WGS-84 in CONUS is sub-metre, which is well below the
 *   accuracy a county-boundary check cares about. Passing the points
 *   through proj4 anyway keeps us strictly correct.
 *
 * Dependencies (devDeps — already present for convert-neighborhoods.js):
 *   - shapefile  — pure-JS .shp/.dbf reader
 *   - proj4      — coordinate reprojection
 *
 * Run:
 *   npm install                     # one-time, picks up the devDeps
 *   npm run gis:convert-summit
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as shapefile from 'shapefile'
import proj4 from 'proj4'

// ── Paths ──────────────────────────────────────────────────────────
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHP_BASE  = resolve(REPO_ROOT, 'data/gis/us_county_boundaries/tl_2025_us_county')
const OUT_PATH  = resolve(REPO_ROOT, 'public/summit-county-boundary.geojson')

// FIPS codes for the target county. Strings because the shapefile
// stores them with leading zeros where applicable.
const STATE_FP  = '39'   // Ohio
const COUNTY_FP = '153'  // Summit

// ── Projection setup ───────────────────────────────────────────────
// TIGER/Line counties are NAD83 geographic — confirmed by the
// included .prj ("GCS_North_American_1983"). proj4 ships WGS-84 by
// default; NAD83 needs to be declared.
proj4.defs(
  'EPSG:4269',
  '+proj=longlat +datum=NAD83 +no_defs',
)
const SRC = 'EPSG:4269'
const DST = 'EPSG:4326' // WGS-84 lon/lat

const reproject = (xy) => proj4(SRC, DST, xy)

// ── Reproject every coordinate in a GeoJSON geometry ───────────────
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

  let match = null

  // shapefile streams records one at a time — sweep the whole file
  // (~3.2k US counties), pick up the single Summit, OH record.
   
  while (true) {
    const result = await source.read()
    if (result.done) break
    const { properties, geometry } = result.value
    if (properties?.STATEFP === STATE_FP && properties?.COUNTYFP === COUNTY_FP) {
      if (match) {
        throw new Error(`Found a second STATEFP=${STATE_FP}/COUNTYFP=${COUNTY_FP} feature — schema drift`)
      }
      match = { properties, geometry }
    }
  }

  if (!match) {
    throw new Error(
      `Summit County (STATEFP=${STATE_FP}/COUNTYFP=${COUNTY_FP}) not found in shapefile. ` +
      `Verify data/gis/us_county_boundaries/ contains a current TIGER/Line counties shapefile.`,
    )
  }

  const reprojected = reprojectGeometry(match.geometry)

  const fc = {
    type: 'FeatureCollection',
    name: 'summit-county-boundary',
    // CRS84 is RFC 7946's preferred declaration for WGS-84 lon/lat.
    crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
    features: [{
      type: 'Feature',
      properties: {
        statefp:  match.properties.STATEFP,
        countyfp: match.properties.COUNTYFP,
        geoid:    match.properties.GEOID,
        name:     match.properties.NAME,
        namelsad: match.properties.NAMELSAD,
      },
      geometry: reprojected,
    }],
  }

  await mkdir(dirname(OUT_PATH), { recursive: true })
  await writeFile(OUT_PATH, JSON.stringify(fc))

  const { size } = await import('node:fs/promises').then((m) => m.stat(OUT_PATH))
  // Quick stats so a re-run shows the polygon hasn't accidentally
  // collapsed to a single ring.
  let ringCount = 0
  const countRings = (coords) => {
    if (typeof coords[0] === 'number') return
    if (typeof coords[0][0] === 'number') { ringCount++; return }
    coords.forEach(countRings)
  }
  countRings(reprojected.coordinates)
  console.log(`wrote ${OUT_PATH} (${size.toLocaleString()} bytes, ${ringCount} ring(s), GEOID ${match.properties.GEOID})`)
}

main().catch((err) => {
  console.error('convert-summit-county.js failed:', err)
  process.exit(1)
})
