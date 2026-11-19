/**
 * scrape-city-of-munroe-falls.js — City of Munroe Falls (munroefalls.com),
 * a CivicPlus (CivicEngage) site.
 *
 * Only the Main Calendar (catID=14) is read. The other feed, "Guise Park
 * Lodge" (catID=23), is the lodge's rental bookings, not public events.
 *
 * The Main Calendar is mostly council, planning, zoning and park board
 * meetings plus office-closure notices; the shared CivicPlus filter drops
 * those and keeps community events such as the Annual Tree Lighting and
 * Sparkle in the Park.
 *
 * Calendar → catID map (from /iCalendar.aspx, 2026-11-19):
 *   14 Main Calendar · 23 Guise Park Lodge
 *
 * Usage:   node scripts/scrape-city-of-munroe-falls.js
 */
import { pathToFileURL } from 'node:url'
import { runCivicPlusScraper } from './lib/civicplus.js'

export const SOURCE_KEY = 'city_of_munroe_falls'
const ORIGIN = 'https://www.munroefalls.com'

export const config = {
  source:    SOURCE_KEY,
  origin:    ORIGIN,
  catIDs:    [14],
  cityLabel: 'Munroe Falls',
  emoji:     '🏛️',
  organization: {
    name: 'City of Munroe Falls',
    details: {
      website:     ORIGIN,
      description: 'City government for Munroe Falls in Summit County, including its parks and community events.',
    },
  },
  defaultVenue: {
    name:    'Munroe Falls City Hall',
    address: '43 Munroe Falls Ave',
    zip:     '44262',
    website: ORIGIN,
  },
  baseTags: ['city-of-munroe-falls', 'munroe-falls-ohio', 'summit-county'],
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCivicPlusScraper(config)
}
