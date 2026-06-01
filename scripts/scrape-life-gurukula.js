/**
 * scrape-life-gurukula.js
 *
 * Fetches upcoming events from Life Gurukula — a Vedanta retreat center and
 * residential community at 1230 W. Market St in Akron.
 *
 * Platform: WordPress + The Events Calendar (Tribe). The events page exposes
 * the standard Tribe ICS feed (?ical=1), so we route through the shared
 * runIcsScraper pipeline. Pointing the feedUrl at the `list` view ensures
 * all upcoming events are emitted (the month view's ?ical=1 only returns the
 * currently displayed month).
 *
 * Usage:
 *   node scripts/scrape-life-gurukula.js
 *
 * Environment overrides:
 *   LIFE_GURUKULA_ICS_URL — direct ICS feed URL (skip default)
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { runIcsScraper } from './lib/ics.js'

const SOURCE_KEY = 'life_gurukula'

const DEFAULT_ICS_URL =
  'https://lifegurukula.org/?post_type=tribe_events&ical=1&eventDisplay=list'

function mapCategory(ev) {
  const text = [(ev.SUMMARY || ''), (ev.DESCRIPTION || ''), (ev.CATEGORIES || '')]
    .join(' ').toLowerCase()
  if (/\b(yoga|meditat|pranayama|asana|chant|kirtan)\b/.test(text))      return 'fitness'
  if (/\b(class|workshop|discourse|lecture|study|course)\b/.test(text))  return 'education'
  if (/\b(festival|celebration|puja|prayer)\b/.test(text))                return 'community'
  if (/\b(food|meal|dinner|lunch|brunch)\b/.test(text))                   return 'food'
  // Retreats — the most common event type — sit at the intersection of
  // education, community, and wellness; bucket them under 'community' so they
  // surface broadly rather than being hidden under a single specialty.
  return 'community'
}

function mapTags(ev) {
  const text = `${ev.SUMMARY || ''} ${ev.DESCRIPTION || ''}`.toLowerCase()
  const tags = ['vedanta', 'spiritual', 'akron']
  if (/\bretreat\b/.test(text))                  tags.push('retreat')
  if (/\byoga\b/.test(text))                     tags.push('yoga')
  if (/\bmeditat/.test(text))                    tags.push('meditation')
  if (/\b(youth|chyk|chysk|teen|kids|children)\b/.test(text)) tags.push('youth')
  if (/\bfamily\b/.test(text))                   tags.push('family')
  return [...new Set(tags)]
}

runIcsScraper({
  source:  SOURCE_KEY,
  feedUrl: process.env.LIFE_GURUKULA_ICS_URL || DEFAULT_ICS_URL,
  organizationName: 'Life Gurukula',
  organizationDetails: {
    website:     'https://lifegurukula.org',
    description: 'Life Gurukula is a Vedanta-rooted retreat center and residential community in Akron offering retreats, classes, and workshops focused on meditation, yoga, and contemplative living.',
  },
  defaultVenueName: 'Life Gurukula',
  defaultVenueDetails: {
    address: '1230 W Market St',
    city:    'Akron',
    state:   'OH',
    zip:     '44313',
    website: 'https://lifegurukula.org',
    parking_type:  'lot',
    parking_notes: 'On-site parking available for retreat guests.',
    description:   'Vedanta retreat center and residential ashrama with a mandir, library, reflection room, dining area, dormitory rooms, and outdoor field.',
  },
  mapCategory,
  mapTags,
  defaultPriceMin: 0,
  defaultPriceMax: null,
  ageRestriction:  'all_ages',
})
