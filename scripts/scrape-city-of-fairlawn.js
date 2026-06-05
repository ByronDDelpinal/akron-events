/**
 * scrape-city-of-fairlawn.js
 *
 * City of Fairlawn, Ohio (Summit County) — CivicPlus (CivicEngage) site.
 * The Main Calendar (catID=14) is almost entirely Council / Civil Service
 * meetings, so the public programming comes from the Parks and Recreation
 * Calendar (catID=15) — Fairlawn Fest, community bingo at the Kiwanis
 * Community Center, and seasonal Parks & Rec events. We ingest both and let
 * the shared CivicPlus filter drop the governance rows from the Main
 * Calendar. This is a thinner source than the other Summit County cities;
 * zero-event runs between active programming windows are normal.
 *
 * Calendar → catID map (from /iCalendar.aspx):
 *   14 Main Calendar · 15 Parks and Recreation Calendar
 *
 * Usage:   node scripts/scrape-city-of-fairlawn.js
 */

import { runCivicPlusScraper } from './lib/civicplus.js'

runCivicPlusScraper({
  source:    'city_of_fairlawn',
  origin:    'https://www.cityoffairlawn.com',
  catIDs:    [14, 15],
  cityLabel: 'Fairlawn',
  emoji:     '🎡',
  organization: {
    name: 'City of Fairlawn',
    details: {
      website:     'https://www.cityoffairlawn.com',
      description: 'City of Fairlawn (Summit County, OH) Parks & Recreation — the Fairlawn Fest, community bingo at the Kiwanis Community Center, and seasonal recreation programming.',
    },
  },
  defaultVenue: {
    name:    'Fairlawn Kiwanis Community Center',
    address: '3486 S Smith Rd',
    zip:     '44333',
    website: 'https://www.cityoffairlawn.com/61/Parks-Recreation',
  },
  baseTags: ['city-of-fairlawn', 'fairlawn-ohio', 'summit-county'],
})
