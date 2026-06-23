/**
 * scrape-akron-pride.js
 *
 * Akron Pride Festival (akronpridefestival.org) — the LGBTQ+ Pride organization
 * behind the annual Akron Pride Festival & Equity March in downtown Akron.
 *
 * Platform: WordPress + the Events Manager plugin. Its REST API
 * (/wp-json/events-manager/v1/events) is auth-gated (401), but every event page
 * exposes an iCal export and there's a clean all-events feed at /events/ical/
 * (RFC 5545, TZID=America/New_York, structured LOCATION). We consume that via
 * the shared lib/ics.js runIcsScraper.
 *
 * Scope note: the org's "Akron Pride Festival 5K" is a RunSignup race that's
 * already ingested by scrape-runsignup.js + scrape-akron-promise.js (City
 * Series) — so we SKIP 5K events here (includeEvent) to avoid a triplicate, and
 * own the unique events: the Festival & Equity March.
 *
 * Events Manager's iCal LOCATION is "Name, Street, City, State, Zip, Country";
 * parseEventsManagerLocation() splits it into a clean venue name + address so we
 * don't mint an address-in-name venue.
 *
 * Usage:   node scripts/scrape-akron-pride.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { runIcsScraper } from './lib/ics.js'

export const SOURCE_KEY = 'akron_pride'
const FEED_URL = 'https://akronpridefestival.org/events/ical/'

/**
 * Parse an Events Manager iCal LOCATION — "Name, Street, City, State, Zip,
 * Country" (the name may itself contain commas) — into { name, details }.
 * Strips the trailing country/zip/state/city; the last remaining part is the
 * street address, the rest is the venue name. Exported for tests.
 */
export function parseEventsManagerLocation(loc) {
  if (!loc) return null
  const parts = String(loc).split(',').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return null

  if (/^(united states|usa|us)$/i.test(parts[parts.length - 1] || '')) parts.pop()
  let zip = null, state = null, city = null
  if (/^\d{5}(-\d{4})?$/.test(parts[parts.length - 1] || '')) zip = parts.pop()
  if (/^[A-Z]{2}$/.test(parts[parts.length - 1] || '')) state = parts.pop()
  if (parts.length) city = parts.pop()

  let address = null
  let name = null
  if (parts.length >= 2) {
    address = parts.pop()          // EM puts the street address last, before the city
    name = parts.join(', ')
  } else {
    name = parts.join(', ') || city
  }
  if (!name) return null
  return { name, details: { address, city: city || 'Akron', state: state || 'OH', zip } }
}

/** Skip the 5K race (owned by runsignup + akron_promise). */
export function includeEvent(ev) {
  return !/\b5k\b/i.test(ev?.SUMMARY || '')
}

export function mapTags() {
  return ['pride', 'lgbtq', 'festival', 'downtown-akron', 'community']
}

async function main() {
  await runIcsScraper({
    source: SOURCE_KEY,
    feedUrl: FEED_URL,
    organizationName: 'Akron Pride Festival',
    organizationDetails: {
      website: 'https://akronpridefestival.org',
      description: 'Akron Pride Festival unifies and affirms the LGBTQ+ community and its allies, celebrating diversity year-round and producing the annual Akron Pride Festival & Equity March in downtown Akron.',
    },
    includeEvent,
    parseLocation: parseEventsManagerLocation,
    mapCategory: () => 'festival',
    mapTags,
    ageRestriction: 'all_ages',
    skipPast: true,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
