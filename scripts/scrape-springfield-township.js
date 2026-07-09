/**
 * scrape-springfield-township.js
 *
 * Springfield Township, Ohio (Summit County) — CivicPlus (CivicEngage) site.
 * Two category calendars (verified 2026-07-08):
 *
 *   23  Center on the Lake — the township's community/senior center at
 *       Springfield Lake (2491 Canfield Rd): a dense weekly grid of public
 *       programming — community meal program, bingo, line dancing, euchre,
 *       coin club, exercise classes — plus seasonal specials. This is the
 *       volume calendar (~150 VEVENTs incl. recurrences).
 *   14  Town Hall Calendar — mostly trustees/zoning meetings (dropped by the
 *       shared admin filter) with the occasional public item (shred days,
 *       community cleanups) that should flow through.
 *
 * Most Center on the Lake entries carry no LOCATION, so the default venue
 * covers them; Town Hall entries with a real LOCATION resolve normally.
 * Note: centeronthelake.com (the center's own site) carries no feed — this
 * CivicPlus calendar is the authoritative source for its programming.
 *
 * Calendar → catID:  23 Center on the Lake, 14 Town Hall Calendar
 *
 * Usage:   node scripts/scrape-springfield-township.js
 */

import { runCivicPlusScraper } from './lib/civicplus.js'

runCivicPlusScraper({
  source:    'springfield_township',
  origin:    'https://www.springfieldtownship.us',
  catIDs:    [23, 14],
  cityLabel: 'Akron',   // township postal addresses are Akron 44312
  emoji:     '🌊',
  organization: {
    name: 'Springfield Township',
    details: {
      website:     'https://www.springfieldtownship.us',
      description: 'Springfield Township (Summit County, OH) community programming — Center on the Lake senior and community events, plus township public events.',
    },
  },
  defaultVenue: {
    name:    'Center on the Lake',
    address: '2491 Canfield Rd',
    zip:     '44312',
    website: 'https://www.springfieldtownship.us',
  },
  baseTags: ['springfield-township', 'summit-county'],
})
