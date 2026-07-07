/**
 * scrape-city-of-barberton.js
 *
 * City of Barberton, Ohio (Summit County). Barberton runs its site on WordPress
 * with The Events Calendar (Tribe), which publishes a clean all-events iCal feed
 * at /?post_type=tribe_events&ical=1&eventDisplay=list. The good stuff is the
 * Barberton Parks & Rec summer programming: the Friday & Wednesday Summer Concert
 * Series at the Lake Anna Gazebo, the Purple Paw Party pet event at Decker Park,
 * and the Labor Day Fireworks. The feed also carries City Council / Committee of
 * the Whole meetings, which we drop (includeEvent).
 *
 * The Tribe iCal LOCATION is "Name, Street, City, [ST], Zip, Country" (the state
 * is sometimes omitted); parseBarbertonLocation splits it into a clean venue.
 *
 * Usage:   node scripts/scrape-city-of-barberton.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { runIcsScraper } from './lib/ics.js'

export const SOURCE_KEY = 'city_of_barberton'
const FEED_URL = 'https://www.cityofbarberton.com/?post_type=tribe_events&ical=1&eventDisplay=list'

/**
 * Parse a Tribe / Events-Calendar iCal LOCATION — "Name, Street, City, [ST],
 * Zip, Country" (state optional; the name may itself contain commas) — into
 * { name, details }. Exported for tests.
 */
export function parseBarbertonLocation(loc) {
  if (!loc) return null
  const parts = String(loc).split(',').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return null

  if (/^(united states|usa|us)$/i.test(parts[parts.length - 1] || '')) parts.pop()
  let zip = null, state = null, city = null
  if (/^\d{5}(-\d{4})?$/.test(parts[parts.length - 1] || '')) zip = parts.pop()
  if (/^[A-Z]{2}$/.test(parts[parts.length - 1] || '')) state = parts.pop()
  if (parts.length) city = parts.pop()

  let address = null, name = null
  if (parts.length >= 2) {
    address = parts.pop()
    name = parts.join(', ')
  } else {
    name = parts.join(', ') || city
  }
  if (!name) return null
  return { name, details: { address, city: city || 'Barberton', state: state || 'OH', zip } }
}

/** Drop governance rows (council / committee / board meetings, hearings). */
const ADMIN_RE = /\b(meeting|council|committee|caucus|work session|board of|commission|hearing|zoning|trustees?)\b/i
export function includeEvent(ev) {
  return !ADMIN_RE.test(ev?.SUMMARY || '')
}

/** Concerts → music; fireworks/festivals/parties → festival; else inference. */
export function mapCategory(ev) {
  const s = (ev?.SUMMARY || '').toLowerCase()
  if (/concert|music|band|symphon/.test(s)) return 'music'
  if (/fireworks|festival|\bfest\b|parade|\bparty\b/.test(s)) return 'festival'
  return null
}

export function mapTags(ev) {
  const s = (ev?.SUMMARY || '').toLowerCase()
  const tags = ['city-of-barberton', 'barberton-ohio', 'summit-county']
  if (/concert|music|band|symphon/.test(s)) tags.push('music', 'outdoor', 'concert')
  if (/fireworks/.test(s)) tags.push('fireworks', 'seasonal')
  return [...new Set(tags)]
}

async function main() {
  await runIcsScraper({
    source: SOURCE_KEY,
    feedUrl: FEED_URL,
    organizationName: 'City of Barberton',
    organizationDetails: {
      website: 'https://www.cityofbarberton.com',
      description: 'City of Barberton (Summit County, OH) Parks & Recreation community events — the Summer Concert Series at Lake Anna Gazebo, the Purple Paw Party, and the Labor Day Fireworks.',
    },
    defaultVenueName: 'Lake Anna Park',
    defaultVenueDetails: {
      address: '615 W. Park Ave', city: 'Barberton', state: 'OH', zip: '44203',
      website: 'https://www.cityofbarberton.com',
    },
    includeEvent,
    parseLocation: parseBarbertonLocation,
    mapCategory,
    mapTags,
    ageRestriction: 'all_ages',
    skipPast: true,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
