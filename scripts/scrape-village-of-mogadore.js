/**
 * scrape-village-of-mogadore.js
 *
 * Village of Mogadore, Ohio. The village runs its site on WordPress with The
 * Events Calendar (Tribe), which publishes a clean iCal feed at
 * /events/list/?ical=1 (the "Export .ics file" subscribe link on the calendar).
 * The good stuff is the village's community programming: the Mogadore Summer
 * Festival + Fireworks at Lions Park, the Memorial Day Parade & Cemetery
 * Ceremony, Trick-or-Treat, Christmas in the Village, the Holiday Bazaar, and
 * the Historical Society's Soup & Sandwich luncheons and Car Show. The feed
 * also carries governance rows (Council / Planning & Zoning / Records Commission
 * meetings, public hearings, Zoning Board of Appeals), which we drop
 * (isGovernanceMeeting).
 *
 * SUMMIT GATE — Mogadore straddles the Summit/Portage county line, so every
 * event is gated through classifySummitLocation (via isSummitCountyLocation).
 * 'mogadore' is on the Summit allowlist, so the village's own events pass; a
 * row that ever names a Portage-side city (Kent, Ravenna, Rootstown, …) lands
 * as 'out' and is dropped. LOCATION strings with no parseable city (the feed
 * emits a bare "LOCATION:OH" for some rows) default to Mogadore — this is the
 * village's own first-party calendar, so a city-less row is a village event.
 *
 * The Tribe iCal LOCATION is "Name, Street, City, [ST], Zip, Country" (the name
 * may itself contain commas; the street is sometimes absent);
 * parseTribeLocation splits it into a clean venue name + address so we never
 * mint an address-in-name junk venue.
 *
 * Usage:   node scripts/scrape-village-of-mogadore.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { runIcsScraper } from './lib/ics.js'
import { isSummitCountyLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'village_of_mogadore'
// Canonical "Export .ics file" subscribe link advertised on the calendar. The
// list view scopes to upcoming events, which is exactly what we want to ingest
// (skipPast drops anything stale that slips through).
const FEED_URL = 'https://mogadorevillage.org/events/list/?ical=1'

/**
 * Parse a Tribe / Events-Calendar iCal LOCATION — "Name, Street, City, [ST],
 * Zip, Country" (state optional; the name may itself contain commas) — into
 * { name, details }. Returns null when there is no venue name to salvage (e.g.
 * a bare "OH"), so the caller falls back to the default village venue. Exported
 * for tests.
 */
export function parseTribeLocation(loc) {
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
  return { name, details: { address, city: city || 'Mogadore', state: state || 'OH', zip } }
}

/**
 * The locality to gate on. Prefers the city parsed from the VEVENT LOCATION and
 * defaults to Mogadore for city-less rows — this is the village's own
 * first-party calendar, so an unparseable LOCATION is still a Mogadore event.
 * Exported for tests.
 */
export function eventCity(ev) {
  const parsed = parseTribeLocation(ev?.LOCATION)
  return parsed?.details?.city || 'Mogadore'
}

/** True iff the event's locality classifies as inside Summit County. */
export function isInSummitCounty(ev) {
  return isSummitCountyLocation({ city: eventCity(ev) })
}

/** Drop governance rows (council / committee / board meetings, hearings). */
const ADMIN_RE = /\b(meeting|council|committee|caucus|work session|board of|commission|hearing|zoning|trustees?)\b/i
export function isGovernanceMeeting(ev) {
  return ADMIN_RE.test(ev?.SUMMARY || '')
}

/**
 * Per-event include gate: keep only Summit-County community events, dropping
 * Portage-side rows (Summit gate) and municipal governance meetings. Exported
 * for tests.
 */
export function includeEvent(ev) {
  return isInSummitCounty(ev) && !isGovernanceMeeting(ev)
}

/** Fireworks/festivals/parades → festival; concerts → music; else inference. */
export function mapCategory(ev) {
  const s = (ev?.SUMMARY || '').toLowerCase()
  if (/concert|music|band|symphon/.test(s)) return 'music'
  if (/fireworks|festival|\bfest\b|parade|bazaar|car show|trick.?or.?treat|christmas/.test(s)) return 'festival'
  return null
}

export function mapTags(ev) {
  const s = (ev?.SUMMARY || '').toLowerCase()
  const tags = ['village-of-mogadore', 'mogadore-ohio', 'summit-county']
  if (/fireworks|festival|\bfest\b/.test(s)) tags.push('festival', 'community')
  if (/parade/.test(s)) tags.push('parade')
  if (/trick.?or.?treat|christmas|bazaar/.test(s)) tags.push('seasonal', 'family')
  return [...new Set(tags)]
}

async function main() {
  await runIcsScraper({
    source: SOURCE_KEY,
    feedUrl: FEED_URL,
    // The Tribe calendar serves an HTML "no upcoming events" page (not an empty
    // .ics) whenever the village hasn't posted anything, which is its normal
    // resting state. Treat that as a benign 0-event run, not a hard failure — a
    // real bot-challenge/error page still throws (see fetchIcsFeed/isBotChallenge).
    allowEmptyFeed: true,
    organizationName: 'Village of Mogadore',
    organizationDetails: {
      website: 'https://mogadorevillage.org',
      description: 'The Village of Mogadore (Summit County, OH) community calendar — the Mogadore Summer Festival & Fireworks at Lions Park, the Memorial Day Parade, Trick-or-Treat, Christmas in the Village, and the Historical Society Holiday Bazaar, Car Show, and Soup & Sandwich luncheons.',
    },
    defaultVenueName: 'Village of Mogadore',
    defaultVenueDetails: {
      city: 'Mogadore', state: 'OH', zip: '44260',
      website: 'https://mogadorevillage.org',
    },
    includeEvent,
    parseLocation: parseTribeLocation,
    mapCategory,
    mapTags,
    ageRestriction: 'all_ages',
    skipPast: true,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
