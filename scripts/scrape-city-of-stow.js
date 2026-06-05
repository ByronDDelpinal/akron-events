/**
 * scrape-city-of-stow.js
 *
 * City of Stow, Ohio (Summit County) — CivicPlus (CivicEngage) site. Stow
 * keeps its public programming on the Main Calendar (catID=14) alongside
 * board/commission meetings, so we ingest catID=14 and let the shared
 * CivicPlus admin/meeting filter drop the governance rows. Surfaces the
 * Fourth of July Parade, Firecracker Run, Joshua Stow Festival, The AMP
 * pop-up series, City-Wide Trick-or-Treat, and seasonal Parks & Rec events.
 *
 * Usage:   node scripts/scrape-city-of-stow.js
 */

import { runCivicPlusScraper } from './lib/civicplus.js'

runCivicPlusScraper({
  source:    'city_of_stow',
  origin:    'https://www.stowohio.gov',
  catIDs:    [14],
  cityLabel: 'Stow',
  emoji:     '🌳',
  organization: {
    name: 'City of Stow',
    details: {
      website:     'https://www.stowohio.gov',
      description: 'City of Stow (Summit County, OH) — municipal Parks & Recreation and community events: the Fourth of July Parade, Joshua Stow Festival, The AMP pop-up series, City-Wide Trick-or-Treat, and seasonal programming.',
    },
  },
  defaultVenue: {
    name:    'Stow City Hall',
    address: '3760 Darrow Rd',
    zip:     '44224',
    website: 'https://www.stowohio.gov',
  },
  baseTags: ['city-of-stow', 'stow-ohio', 'summit-county'],
})
