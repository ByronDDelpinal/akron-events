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
import { runIcsScraper } from './lib/ics.js'

const SOURCE_KEY = 'north_hill_cdc'

function mapCategory(ev) {
  const text = [(ev.SUMMARY || ''), (ev.DESCRIPTION || ''), (ev.CATEGORIES || '')]
    .join(' ').toLowerCase()
  if (/\b(maker|craft|workshop|class)\b/.test(text))    return 'education'
  if (/\b(market|vendor|shop)\b/.test(text))            return 'community'
  if (/\b(food|meal|dinner|lunch)\b/.test(text))        return 'food'
  if (/\b(music|concert|band)\b/.test(text))            return 'music'
  if (/\b(art|gallery|exhibit)\b/.test(text))           return 'art'
  return 'community'
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
