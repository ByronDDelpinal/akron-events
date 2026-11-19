/**
 * scrape-maps-air-museum.js — MAPS Air Museum (mapsairmuseum.org), the
 * aviation museum on the west side of Akron-Canton Airport.
 *
 * SCOPE. The museum's mailing address is North Canton, which the Summit
 * County city check treats as outside the county. The building itself is in
 * Summit County: OpenStreetMap places it there (2260 International Parkway,
 * 40.9175, -81.4545; checked 2026-11-19). So every event is pinned to the
 * museum's own venue record and the city check is not applied. Nothing held
 * anywhere else is expected in this feed.
 *
 * The public events page runs on The Events Calendar with an open REST API.
 *
 * Usage:
 *   node scripts/scrape-maps-air-museum.js
 *   node scripts/scrape-maps-air-museum.js --dry-run
 */
import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'
import { collectTribe } from './lib/tribe-planned.js'

export const SOURCE_KEY = 'maps_air_museum'
const ORIGIN = 'https://mapsairmuseum.org'

const ORG = {
  name: 'MAPS Air Museum',
  details: { website: ORIGIN, description: 'Volunteer-run aviation museum at Akron-Canton Airport with restored aircraft and military history exhibits.' },
}

export const VENUE = {
  name: 'MAPS Air Museum',
  details: { address: '2260 International Parkway', city: 'North Canton', state: 'OH', zip: '44720', website: ORIGIN, lat: 40.9175382, lng: -81.4544641 },
}

export function categoriesFor(title = '') {
  if (/\b(market|mkt|shopping|craft show|vendor)\b/i.test(title)) return ['market']
  return ['learning']
}

export const config = {
  source: SOURCE_KEY,
  label: 'MAPS Air Museum',
  baseUrl: `${ORIGIN}/wp-json/tribe/events/v1/events`,
  daysAhead: 270,
  fixedVenue: VENUE,
  categories: categoriesFor,
  tags: ['aviation', 'museum', 'history', 'family'],
}

export const collect = (opts) => collectTribe(config, opts)

export function run({ dryRun = false, fetchImpl, now } = {}) {
  return runPlannedScraper({
    source: SOURCE_KEY, label: config.label, emoji: '✈️', org: ORG, homeVenue: VENUE,
    collect: () => collect({ fetchImpl, now }), dryRun, emptyIsError: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
