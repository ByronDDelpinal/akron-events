/**
 * scrape-city-of-norton.js
 *
 * City of Norton, Ohio (Summit County) — CivicPlus (CivicEngage) site. Norton
 * keeps its public community events on a dedicated "Event Calendar" (catID=30),
 * cleanly separated from the governance calendars (council, boards, service
 * dept). That one feed carries the good stuff: the Summer Concert Series of
 * tribute bands, the Norton Cider Festival, Touch-A-Truck, the Classic Car
 * Show, Family Fun Day, and Historical Society events. The feed's LOCATION
 * field is empty, so events fall back to the default venue (the city's
 * community park / municipal complex on Columbia Woods Dr).
 *
 * Calendar → catID:  30 Event Calendar
 *
 * Usage:   node scripts/scrape-city-of-norton.js
 */

import { runCivicPlusScraper } from './lib/civicplus.js'

runCivicPlusScraper({
  source:    'city_of_norton',
  origin:    'https://cityofnorton.org',
  catIDs:    [30],
  cityLabel: 'Norton',
  emoji:     '🍎',
  organization: {
    name: 'City of Norton',
    details: {
      website:     'https://cityofnorton.org',
      description: 'City of Norton (Summit County, OH) community events — the Summer Concert Series, Norton Cider Festival, Touch-A-Truck, Classic Car Show, and family events.',
    },
  },
  defaultVenue: {
    name:    'Norton Community Park',
    address: '4060 Columbia Woods Dr',
    zip:     '44203',
    website: 'https://cityofnorton.org/222/City-Parks',
  },
  baseTags: ['city-of-norton', 'norton-ohio', 'summit-county'],
})
