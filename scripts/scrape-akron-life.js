/**
 * scrape-akron-life.js
 *
 * Fetches Akron Life Magazine's community events calendar. Akron Life
 * advertises RSS + iCal subscription options on their calendar page.
 * We prefer the ICS feed (structured dates + times); the RSS feed is
 * harder to normalise and typically lacks end times.
 *
 * Usage:
 *   node scripts/scrape-akron-life.js
 *
 * Environment overrides:
 *   AKRON_LIFE_ICS_URL — direct ICS feed URL
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { runIcsScraper } from './lib/ics.js'

const SOURCE_KEY = 'akron_life'

function mapCategory(ev) {
  const text = [(ev.SUMMARY || ''), (ev.DESCRIPTION || ''), (ev.CATEGORIES || '')]
    .join(' ').toLowerCase()
  if (/\b(concert|music|band|show|performance)\b/.test(text))    return 'music'
  if (/\b(art|gallery|exhibit|opening)\b/.test(text))             return 'art'
  if (/\b(food|dining|tasting|brewery|wine|beer)\b/.test(text))   return 'food'
  if (/\b(theat(re|er)|play|musical|stage)\b/.test(text))         return 'art'
  if (/\b(class|workshop|seminar|lecture)\b/.test(text))          return 'education'
  if (/\b(run|race|fitness|yoga|hike)\b/.test(text))              return 'fitness'
  if (/\b(fair|festival|market|fundraiser|community)\b/.test(text)) return 'community'
  return 'community'
}

function mapTags(ev) {
  const categories = (ev.CATEGORIES || '').toLowerCase().split(',').map(t => t.trim()).filter(Boolean)
  return [...new Set(['akron-life', 'akron', ...categories])]
}

runIcsScraper({
  source: SOURCE_KEY,
  feedUrl:      process.env.AKRON_LIFE_ICS_URL || null,
  discoveryUrl: process.env.AKRON_LIFE_ICS_URL ? null : 'https://www.akronlife.com/events',
  organizationName: 'Akron Life Magazine',
  organizationDetails: {
    website:     'https://www.akronlife.com',
    description: 'Akron Life is a regional lifestyle magazine covering dining, arts, culture, and community events across Greater Akron.',
  },
  defaultVenueDetails: { city: 'Akron', state: 'OH' },
  mapCategory,
  mapTags,
  defaultPriceMin: 0,
  defaultPriceMax: null,
  ageRestriction:  'not_specified',
})
