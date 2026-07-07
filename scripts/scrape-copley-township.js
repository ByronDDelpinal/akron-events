/**
 * scrape-copley-township.js
 *
 * Copley Township, Ohio (Summit County) — CivicPlus (CivicEngage) site. Copley
 * runs everything through its Main Calendar (catID=14), which mixes governance
 * (zoning commission, board of trustees, architectural review, office closures)
 * with the public community events we want: Copley Heritage Days, the Food
 * Truck Festival, the Copley Car Show, and the fire association's Pancake
 * Breakfast. The shared CivicPlus filter drops the meetings/closures, and most
 * community events carry a real LOCATION (Copley Community Park, 3232 Copley
 * Road) so they resolve to the right venue; the default is a fallback.
 *
 * Calendar → catID:  14 Main Calendar
 *
 * Usage:   node scripts/scrape-copley-township.js
 */

import { runCivicPlusScraper } from './lib/civicplus.js'

runCivicPlusScraper({
  source:    'copley_township',
  origin:    'https://www.copley.oh.us',
  catIDs:    [14],
  cityLabel: 'Copley',
  emoji:     '🥞',
  organization: {
    name: 'Copley Township',
    details: {
      website:     'https://www.copley.oh.us',
      description: 'Copley Township (Summit County, OH) community events — Heritage Days, the Food Truck Festival, the Copley Car Show, and community pancake breakfasts.',
    },
  },
  defaultVenue: {
    name:    'Copley Community Park',
    address: '3232 Copley Road',
    zip:     '44321',
    website: 'https://www.copley.oh.us',
  },
  baseTags: ['copley-township', 'copley-ohio', 'summit-county'],
})
