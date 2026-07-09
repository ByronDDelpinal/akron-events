/**
 * scrape-village-of-richfield.js
 *
 * Village of Richfield, Ohio (Summit County) — CivicPlus (CivicEngage) site.
 * Three category calendars (verified 2026-07-09):
 *
 *   14  Main Calendar — the aggregate of everything on the site: governance
 *       rows (council, zoning, cemetery board, building closures, holiday
 *       observances — all dropped by the shared admin filter) PLUS the public
 *       lineup: Fall Fest, Summer Concerts on the Green, Community Days, the
 *       Senior Center's Luau Party, Magical Butterfly Camp, police blood
 *       drives, the Fourth of July symphonic-winds concert.
 *   28  Parks & Recreation Calendar — Fall Fest, Summer Concerts on the
 *       Green, Magical Butterfly Camp. A subset of 14, included defensively
 *       (the runner merges + dedupes by UID) in case Parks & Rec posts
 *       something that never reaches the Main Calendar.
 *   30  Senior Center — Luau Party, Tribute to Jan Weber Dedication. Also a
 *       subset of 14, included for the same defensive reason.
 *
 * Deliberately EXCLUDED (governance-only calendars, nothing public):
 *   31 Service Department (cemetery board meetings), 33 Village Council,
 *   34 Planning & Zoning. A sweep of catIDs 1–40 found no other calendars
 *   carrying events.
 *
 * Data quirk: Richfield's LOCATION values arrive as rich-text HTML with the
 * venue name and street address in separate <p> blocks (e.g. "<p><span
 * style=…>Village Green Pavilion</span></p><p>Corner of Route 303 &amp;
 * Broadview Rd</p>"); lib/civicplus.js cleanLocationName splits on block
 * boundaries so only the name reaches venue resolution.
 *
 * Calendar → catID:  14 Main, 28 Parks & Recreation, 30 Senior Center
 *
 * Usage:   node scripts/scrape-village-of-richfield.js
 */

import { runCivicPlusScraper } from './lib/civicplus.js'

runCivicPlusScraper({
  source:    'village_of_richfield',
  origin:    'https://www.richfieldvillageohio.org',
  catIDs:    [14, 28, 30],
  cityLabel: 'Richfield',
  emoji:     '🌳',
  organization: {
    name: 'Village of Richfield',
    details: {
      website:     'https://www.richfieldvillageohio.org',
      description: 'Village of Richfield (Summit County, OH) municipal government — parks and recreation events, Senior Center programming, and village community celebrations.',
    },
  },
  defaultVenue: {
    name:    'Village Green Pavilion',
    address: 'Route 303 & Broadview Rd',
    zip:     '44286',
    website: 'https://www.richfieldvillageohio.org',
  },
  baseTags: ['village-of-richfield', 'summit-county', 'richfield'],
})
