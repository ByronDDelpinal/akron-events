/**
 * scrape-united-way-summit.js
 *
 * United Way of Summit & Medina (uwsummitmedina.org) — the Akron-based United
 * Way serving Summit and Medina counties. Their site runs WordPress + The Events
 * Calendar (Tribe), which publishes a clean all-events iCal feed. We consume it
 * via the shared lib/ics.js runIcsScraper.
 *
 * Feed: https://www.uwsummitmedina.org/events/?ical=1 (Tribe "?ical=1"). At the
 * time of build it carries a single upcoming VEVENT ("Bold Glow", a night-golf
 * fundraiser at J. E. Good Park Golf Course in Akron), emitted as a date-only
 * (VALUE=DATE) all-day event — so we flag those rows needs_review, because their
 * noon-ET start is the SANCTIONED-DEFAULT-TIME and not a confirmed time.
 *
 * Bi-county gate: the org explicitly serves BOTH Summit and Medina. Medina-county
 * events are out of Akron Pulse's scope, so summitGate() classifies each VEVENT
 * by the city in its Tribe LOCATION and drops anything confirmed out-of-county
 * (classifySummitLocation is the SSOT). A VEVENT with no LOCATION falls back to
 * the org's Akron default venue (in Summit) and is kept.
 *
 * The Tribe iCal LOCATION is "Name, Street, City, [ST], Zip, [Country]" (state
 * and country sometimes omitted); parseTribeLocation splits it into a clean
 * venue name + address so we never mint an address-in-name venue.
 *
 * Usage:   node scripts/scrape-united-way-summit.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { runIcsScraper, isDateOnlyIcsEvent } from './lib/ics.js'
import { classifySummitLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'united_way_summit'
const FEED_URL = 'https://www.uwsummitmedina.org/events/?ical=1'

/**
 * Parse a Tribe / Events-Calendar iCal LOCATION — "Name, Street, City, [ST],
 * Zip, [Country]" (state and country optional; the name may itself contain
 * commas) — into { name, details }. City defaults to Akron (the org's home).
 * Exported for tests.
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
  return { name, details: { address, city: city || 'Akron', state: state || 'OH', zip } }
}

/**
 * Bi-county Summit gate. classifySummitLocation is the SSOT: it returns 'out'
 * only for a city on the known-non-Summit blocklist (e.g. Medina, Wadsworth,
 * Brunswick — this org's Medina-county half). We drop only confirmed 'out'.
 *
 *   • No LOCATION       → keep. The event falls back to the org's Akron default
 *                         venue, which is in-county.
 *   • LOCATION present  → classify by its city; drop iff 'out'. 'in' and
 *                         'unknown' are kept — this is a trusted first-party
 *                         Summit-based org, so an unrecognized city is far more
 *                         likely a messy Akron-area address than a leak, and
 *                         silently dropping a first-party event is worse than
 *                         keeping an ambiguous one.
 *
 * Exported for tests.
 */
export function summitGate(ev) {
  const loc = (ev?.LOCATION || '').trim()
  if (!loc) return true
  const parsed = parseTribeLocation(loc)
  const city = parsed?.details?.city ?? null
  return classifySummitLocation({ city }) !== 'out'
}

export function mapTags() {
  return ['united-way', 'summit-county', 'nonprofit', 'fundraiser', 'community']
}

async function main() {
  await runIcsScraper({
    source: SOURCE_KEY,
    feedUrl: FEED_URL,
    organizationName: 'United Way of Summit & Medina',
    organizationDetails: {
      website: 'https://www.uwsummitmedina.org',
      description: 'United Way of Summit & Medina mobilizes the community to advance education, financial stability, and health across Summit and Medina counties, Ohio.',
    },
    // Fallback venue only if a VEVENT carries no LOCATION — the org's Akron home.
    defaultVenueName: 'United Way of Summit & Medina',
    defaultVenueDetails: {
      city: 'Akron', state: 'OH',
      website: 'https://www.uwsummitmedina.org',
    },
    includeEvent: summitGate,
    parseLocation: parseTribeLocation,
    // Category left to inference — a United Way calendar mixes fundraisers,
    // galas, and community events; blanket-tagging give-back would violate the
    // strict give-back gate.
    mapTags,
    // Date-only VEVENTs get the sanctioned noon-ET default; flag them so a human
    // confirms the invented time.
    flagNeedsReview: isDateOnlyIcsEvent,
    skipPast: true,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
