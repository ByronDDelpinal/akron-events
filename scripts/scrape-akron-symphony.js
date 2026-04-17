/**
 * scrape-akron-symphony.js
 *
 * Fetches Akron Symphony Orchestra events from their iCalendar feed.
 *
 * Platform: Custom CMS (akronsymphony.org) with native iCalendar export.
 * The Symphony advertises Google / Outlook / iCal subscription on their
 * calendar page — the scraper either uses the URL set via env var, or
 * auto-discovers it by scanning the /event/ page for
 * <link rel="alternate" type="text/calendar">.
 *
 * Usage:
 *   node scripts/scrape-akron-symphony.js
 *
 * Environment overrides:
 *   AKRON_SYMPHONY_ICS_URL — direct ICS feed URL (skip discovery)
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { runIcsScraper } from './lib/ics.js'

const SOURCE_KEY = 'akron_symphony'

function mapCategory() { return 'music' }

function mapTags(ev) {
  const summary = (ev.SUMMARY || '').toLowerCase()
  const categories = (ev.CATEGORIES || '').toLowerCase().split(',').map(t => t.trim()).filter(Boolean)
  const tags = ['symphony', 'classical', 'music', 'akron']
  if (summary.includes('pops'))    tags.push('pops')
  if (summary.includes('family'))  tags.push('family')
  if (summary.includes('chamber')) tags.push('chamber')
  return [...new Set([...tags, ...categories])]
}

runIcsScraper({
  source: SOURCE_KEY,
  feedUrl:      process.env.AKRON_SYMPHONY_ICS_URL || null,
  discoveryUrl: process.env.AKRON_SYMPHONY_ICS_URL ? null : 'https://akronsymphony.org/event/',
  organizationName: 'Akron Symphony Orchestra',
  organizationDetails: {
    website:     'https://akronsymphony.org',
    description: 'The Akron Symphony Orchestra is a professional orchestra serving the greater Akron community with classical, pops, and family programming throughout the season.',
  },
  defaultVenueName:    'E.J. Thomas Performing Arts Hall',
  defaultVenueDetails: {
    address: '198 Hill St', city: 'Akron', state: 'OH', zip: '44325',
    lat: 41.0756, lng: -81.5113,
    website: 'https://www.ejthomashall.com',
    parking_type: 'garage',
    parking_notes: 'Parking garages available on campus.',
  },
  mapCategory,
  mapTags,
  defaultPriceMin: 0,
  defaultPriceMax: null,
  ageRestriction:  'all_ages',
})
