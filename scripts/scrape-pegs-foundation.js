/**
 * scrape-pegs-foundation.js
 *
 * Peg's Foundation (pegs.org) — a Hudson, OH (Summit County) mental-health
 * philanthropy whose campus at 53 First Street houses Peg's Gallery. Its public
 * programming is art exhibits, artist talks / hands-on workshops, community
 * conversations on mental health, and a monthly NAMI Family Support Group.
 *
 * Platform: WordPress + The Events Calendar (Tribe), which publishes a clean
 * all-events iCal feed at /events/?ical=1 (RFC 5545, VTIMEZONE + TZID
 * America/New_York, structured LOCATION, per-event ATTACH image). We consume it
 * through the shared lib/ics.js runIcsScraper rather than the Tribe REST API
 * (/wp-json/tribe/events/v1/events), which on these sites is frequently
 * auth-gated / blocked — the iCal is the faithful, un-gated source.
 *
 * Geography gate: this is a first-party Hudson org, but the gallery occasionally
 * lists off-campus or partner locations, so every event carrying a LOCATION is
 * gated by its city through classifySummitLocation — anything resolving 'out'
 * (outside Summit County) is dropped. Events with no LOCATION are Peg's own
 * on-campus programming and fall back to the default Peg's Gallery venue.
 *
 * LOCATION shape: Tribe emits "Name, Street, City, State, Zip" where State is
 * the FULL word ("Ohio"), not a 2-letter code. parsePegsFoundationLocation()
 * handles the full state name (city_of_barberton's 2-letter-only parser would
 * mis-read "Ohio" as the city), splitting it into a clean venue name + address
 * so we never mint an address-in-name junk venue.
 *
 * Non-events: the feed carries administrative "Campus Closed" notices (staff
 * outings / holiday closures). Those aren't attendable events, so an includeEvent
 * filter drops them alongside the geo gate.
 *
 * Usage:   node scripts/scrape-pegs-foundation.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { runIcsScraper } from './lib/ics.js'
import {
  preloadSummitCountyBoundary,
  classifySummitLocation,
} from './lib/summit-county.js'

export const SOURCE_KEY = 'pegs_foundation'
const FEED_URL = 'https://pegs.org/events/?ical=1'

// Full US state name → USPS abbreviation. Tribe's iCal LOCATION spells the state
// out ("Hudson, Ohio, 44236"), so a 2-letter-only test (as in the Barberton
// parser) would fail to recognise it and swallow "Ohio" as the city. A complete
// map keeps the parser correct for any off-campus partner location the gallery
// might list, not just Ohio.
const STATE_ABBR = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL',
  indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI',
  minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC',
  'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY',
}

/** Normalise a LOCATION state token (2-letter code or full name) to USPS, or null. */
function normalizeState(token) {
  const t = String(token ?? '').trim()
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase()
  return STATE_ABBR[t.toLowerCase()] ?? null
}

/** True when a LOCATION token is a recognised state (2-letter code or full name). */
function isStateToken(token) {
  return normalizeState(token) != null
}

/**
 * Parse a Tribe / Events-Calendar iCal LOCATION — "Name, Street, City, State,
 * Zip" (State spelled out, e.g. "Ohio"; the name may itself contain commas) —
 * into { name, details }. Exported for tests.
 */
export function parsePegsFoundationLocation(loc) {
  if (!loc) return null
  const parts = String(loc).split(',').map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return null

  if (/^(united states|usa|us)$/i.test(parts[parts.length - 1] || '')) parts.pop()
  let zip = null, state = null, city = null
  if (/^\d{5}(-\d{4})?$/.test(parts[parts.length - 1] || '')) zip = parts.pop()
  if (isStateToken(parts[parts.length - 1] || '')) state = normalizeState(parts.pop())
  if (parts.length) city = parts.pop()

  let address = null, name = null
  if (parts.length >= 2) {
    address = parts.pop()          // Tribe puts the street address last, before the city
    name = parts.join(', ')
  } else {
    name = parts.join(', ') || city
  }
  if (!name) return null
  return { name, details: { address, city: city || 'Hudson', state: state || 'OH', zip } }
}

/**
 * Drop non-events and out-of-county events.
 *   • "Campus Closed" (and similar closure notices) aren't attendable programming.
 *   • Any LOCATION whose city resolves 'out' of Summit County is dropped; events
 *     with no LOCATION are Peg's own Hudson-campus programming and are kept
 *     ('in'/'unknown' both pass, matching the org's first-party geography).
 */
const NON_EVENT_RE = /\b(campus closed|closed for|holiday closure|office closed)\b/i
export function includeEvent(ev) {
  if (NON_EVENT_RE.test(ev?.SUMMARY || '')) return false
  const loc = (ev?.LOCATION || '').trim()
  if (!loc) return true
  const parsed = parsePegsFoundationLocation(loc)
  return classifySummitLocation({ city: parsed?.details?.city }) !== 'out'
}

/**
 * Map an event to a content category from its native CATEGORIES + title.
 * Peg's programming is gallery/art-forward with community + learning strands;
 * anything ambiguous returns null so text inference decides.
 */
export function mapCategory(ev) {
  const text = `${ev?.CATEGORIES || ''} ${ev?.SUMMARY || ''}`.toLowerCase()
  if (/exhibit|gallery|sculpture|stained glass|painting|\bart\b/.test(text)) return 'visual-art'
  if (/support group|\bnami\b/.test(text)) return 'civic'
  if (/panel|presentation|workshop|conversation|lecture|seminar/.test(text)) return 'learning'
  return null
}

export function mapTags(ev) {
  const text = `${ev?.CATEGORIES || ''} ${ev?.SUMMARY || ''}`.toLowerCase()
  const tags = ['pegs-foundation', 'hudson-ohio', 'summit-county', 'mental-health', 'nonprofit']
  if (/exhibit|gallery|sculpture|stained glass|painting|\bart\b/.test(text)) tags.push('art', 'gallery')
  if (/support group|\bnami\b/.test(text)) tags.push('support-group')
  if (/panel|presentation|workshop|conversation|lecture/.test(text)) tags.push('workshop')
  return [...new Set(tags)]
}

async function main() {
  // The geo gate is city-based (no coords in the feed), so the polygon check is
  // never hit — but preload defensively so any future coord-bearing LOCATION is
  // handled correctly rather than throwing.
  await preloadSummitCountyBoundary()

  await runIcsScraper({
    source: SOURCE_KEY,
    feedUrl: FEED_URL,
    organizationName: "Peg's Foundation",
    organizationDetails: {
      website: 'https://pegs.org',
      description:
        "Peg's Foundation is a Hudson, Ohio mental-health philanthropy whose " +
        "campus houses Peg's Gallery, presenting art exhibits, artist talks and " +
        'workshops, community conversations on mental health, and a monthly NAMI ' +
        'Family Support Group.',
    },
    defaultVenueName: "Peg's Gallery",
    defaultVenueDetails: {
      address: '53 First Street', city: 'Hudson', state: 'OH', zip: '44236',
      website: 'https://pegs.org',
    },
    includeEvent,
    parseLocation: parsePegsFoundationLocation,
    mapCategory,
    mapTags,
    ageRestriction: 'all_ages',
    skipPast: true,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
