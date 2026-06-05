/**
 * scrape-city-of-new-franklin.js
 *
 * City of New Franklin, Ohio (Summit County) — CivicPlus (CivicEngage) site.
 * The home calendar pulls from catID 23 (Community Events / Sports) and 14
 * (Main Calendar). The public programming clusters around the Tudor House
 * Civic Center on Nimisila Reservoir: the Music by the Lake summer concert
 * series, Movies by the Lake, the Old Fashioned 4th of July, Lakeside
 * Oktoberfest, and the Tudor House Christmas Open House. City Council and
 * board meetings are dropped by the shared CivicPlus filter.
 *
 * Usage:   node scripts/scrape-city-of-new-franklin.js
 */

import { runCivicPlusScraper } from './lib/civicplus.js'

runCivicPlusScraper({
  source:    'city_of_new_franklin',
  origin:    'https://www.newfranklin.org',
  catIDs:    [14, 23],
  cityLabel: 'New Franklin',
  emoji:     '🎻',
  organization: {
    name: 'City of New Franklin',
    details: {
      website:     'https://www.newfranklin.org',
      description: 'City of New Franklin (Summit County, OH) — lakeside community programming at the Tudor House Civic Center: the Music by the Lake concert series, Movies by the Lake, the Old Fashioned 4th of July, Lakeside Oktoberfest, and seasonal events.',
    },
  },
  defaultVenue: {
    name:    'Tudor House Civic Center',
    address: '655 Latham Lane',
    zip:     '44319',
    website: 'https://www.newfranklin.org',
  },
  baseTags: ['city-of-new-franklin', 'new-franklin-ohio', 'summit-county'],
})
