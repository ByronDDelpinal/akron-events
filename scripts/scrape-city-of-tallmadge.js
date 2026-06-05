/**
 * scrape-city-of-tallmadge.js
 *
 * City of Tallmadge, Ohio (Summit County) — CivicPlus (CivicEngage) site.
 * Tallmadge splits content across many category calendars; the public events
 * live on Recreation Department Programs (catID=23) and Recreation Events
 * (catID=25), with the Main Calendar (catID=14) carrying the occasional
 * citywide special. We ingest all three and dedupe by UID. Surfaces the
 * Music on the Circle concert series, Touch a Truck, Bocce Ball Tournament,
 * and Recreation camps/lessons. Board and commission meetings are dropped by
 * the shared CivicPlus filter.
 *
 * Calendar → catID map (from /iCalendar.aspx):
 *   14 Main Calendar · 23 Recreation Department Programs · 25 Recreation Events
 *
 * Usage:   node scripts/scrape-city-of-tallmadge.js
 */

import { runCivicPlusScraper } from './lib/civicplus.js'

runCivicPlusScraper({
  source:    'city_of_tallmadge',
  origin:    'https://www.tallmadgeoh.gov',
  catIDs:    [14, 23, 25],
  cityLabel: 'Tallmadge',
  emoji:     '🎪',
  organization: {
    name: 'City of Tallmadge',
    details: {
      website:     'https://www.tallmadgeoh.gov',
      description: 'City of Tallmadge (Summit County, OH) Recreation Department — the Music on the Circle concert series at Tallmadge Circle Park, Touch a Truck, tournaments, camps, and seasonal community events.',
    },
  },
  defaultVenue: {
    name:    'Tallmadge Circle Park',
    address: '10 Tallmadge Circle',
    zip:     '44278',
    website: 'https://www.tallmadgeoh.gov/231/Parks-and-Recreation-Department',
  },
  baseTags: ['city-of-tallmadge', 'tallmadge-ohio', 'summit-county'],
})
