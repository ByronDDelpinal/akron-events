/**
 * scrape-city-of-hudson.js
 *
 * City of Hudson, Ohio (Summit County) — CivicPlus (CivicEngage) site.
 * Hudson's Community Events Calendar (catID=14) is rich and public-facing:
 * the Hudson Farmers Market, Hudson Bandstand and Summer Music Nights concert
 * series, Screen on the Green movie nights, Art on the Green, the Landsberg
 * Biergarten, and seasonal festivals. The same calendar carries a few city
 * meetings, which the shared CivicPlus filter drops.
 *
 * Usage:   node scripts/scrape-city-of-hudson.js
 */

import { runCivicPlusScraper } from './lib/civicplus.js'

runCivicPlusScraper({
  source:    'city_of_hudson',
  origin:    'https://www.hudson.oh.us',
  catIDs:    [14],
  cityLabel: 'Hudson',
  emoji:     '🎶',
  organization: {
    name: 'City of Hudson',
    details: {
      website:     'https://www.hudson.oh.us',
      description: 'City of Hudson (Summit County, OH) Community Events Calendar — the Hudson Farmers Market, Hudson Bandstand and Summer Music Nights concert series, Screen on the Green, Art on the Green, and seasonal community festivals on and around the First & Main district and Hudson Green.',
    },
  },
  defaultVenue: {
    name:    'Hudson Green',
    address: '1 Clinton St',
    zip:     '44236',
    website: 'https://www.hudson.oh.us',
  },
  baseTags: ['city-of-hudson', 'hudson-ohio', 'summit-county'],
})
