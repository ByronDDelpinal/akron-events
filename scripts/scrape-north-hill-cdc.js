/**
 * scrape-north-hill-cdc.js
 *
 * Fetches North Hill Community Development Corporation events from their
 * public iCalendar feed. NHCDC's events page exposes an ICS export link
 * (Google Calendar, iCalendar compatible) — the scraper tries the env
 * override first, then auto-discovers by scanning the /events/ page.
 *
 * Usage:
 *   node scripts/scrape-north-hill-cdc.js
 *
 * Environment overrides:
 *   NORTH_HILL_CDC_ICS_URL — direct ICS feed URL
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { inferCategory } from './lib/category-inference.js'
import { runIcsScraper } from './lib/ics.js'

const SOURCE_KEY = 'north_hill_cdc'

// Category: infer from event text.
function mapCategory(ev) {
  const text = `${ev.SUMMARY || ''} ${ev.DESCRIPTION || ''} ${ev.CATEGORIES || ''}`
  return inferCategory(text, '')
}

function mapTags(ev) {
  const summary = (ev.SUMMARY || '').toLowerCase()
  const tags = ['north-hill', 'community', 'akron']
  if (summary.includes('maker monday')) tags.push('maker-monday')
  return [...new Set(tags)]
}

runIcsScraper({
  source: SOURCE_KEY,
  feedUrl:      process.env.NORTH_HILL_CDC_ICS_URL || null,
  discoveryUrl: process.env.NORTH_HILL_CDC_ICS_URL ? null : 'https://northhillcdc.org/events/',
  organizationName: 'North Hill Community Development Corporation',
  organizationDetails: {
    website:     'https://northhillcdc.org',
    description: 'North Hill CDC is a neighborhood-based nonprofit supporting residents, small businesses, and civic engagement in the North Hill area of Akron.',
  },
  defaultVenueDetails: { city: 'Akron', state: 'OH' },
  mapCategory,
  mapTags,
  defaultPriceMin: null,
  defaultPriceMax: null,
  ageRestriction:  'all_ages',
})
