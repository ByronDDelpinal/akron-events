/**
 * scrape-fair-housing-akron.js
 *
 * Fair Housing Contact Service (fairhousingakron.org) — an Akron nonprofit that
 * runs free Renter's Rights and Landlord workshops plus an annual event, mostly
 * at The Well CDC and Akron-area libraries.
 *
 * Platform: Squarespace native Events collection (?format=json&view=upcoming),
 * consumed via the shared lib/squarespace.js.
 *
 * GEOGRAPHY (important — this source needs per-event gating):
 *   Most workshops are in Akron (Summit County), but the series also travels to
 *   Kent (Kent Free Library — Portage County, OUT of scope). Two quirks in the
 *   Squarespace location data:
 *     • `markerLat/markerLng` is a bogus site-wide default (~40.72,-74.00, i.e.
 *       New York) on every event — never trust it. The real pin is `mapLat/
 *       mapLng`; we only accept those coords when they fall in an Ohio bounding
 *       box (the NY default is rejected).
 *     • Some events (the Kent workshop, the annual event) ship with an EMPTY
 *       location object (the NY default coords, no address). For those we can't
 *       gate on coordinates, so we scan the title + description for a recognized
 *       city: a NOT_SUMMIT city ("Kent") → out (dropped); a Summit city
 *       ("Akron") → in; neither → unknown → pending_review.
 *
 * Usage:   node scripts/scrape-fair-housing-akron.js
 *          node scripts/scrape-fair-housing-akron.js --dry-run
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  enrichWithImageDimensions,
  ensureOrganization,
  ensureVenue,
  linkEventOrganization,
  linkEventVenue,
  logScraperError,
  logUpsertResult,
  stripHtml,
  upsertEventSafe,
} from './lib/normalize.js'
import {
  fetchSquarespaceEvents,
  normaliseSquarespaceEvent,
  buildSquarespaceEventUrl,
} from './lib/squarespace.js'
import {
  classifySummitLocation,
  preloadSummitCountyBoundary,
  SUMMIT_COUNTY_CITIES,
  NOT_SUMMIT_COUNTY_CITIES,
} from './lib/summit-county.js'

// ── Configuration ────────────────────────────────────────────────────────────

const SITE_BASE_URL = 'https://www.fairhousingakron.org'
const COLLECTION_URL = `${SITE_BASE_URL}/events`
const SOURCE_KEY = 'fair_housing_akron'
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'

// Ohio bounding box — used to reject the NY (~40.72,-74.00) Squarespace default
// pin that appears on every event's markerLat/markerLng and on the location-less
// events' mapLat/mapLng.
const OHIO_BBOX = { latMin: 38.3, latMax: 42.4, lngMin: -85.0, lngMax: -80.5 }

function isOhioCoord(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false
  return lat >= OHIO_BBOX.latMin && lat <= OHIO_BBOX.latMax
    && lng >= OHIO_BBOX.lngMin && lng <= OHIO_BBOX.lngMax
}

// ── Location parsing ─────────────────────────────────────────────────────────

/**
 * Parse the Squarespace `location` object into flat venue fields. Uses the real
 * `mapLat/mapLng` pin ONLY when it's an Ohio coordinate (the NY default is
 * dropped), and reads the city from addressLine2 ("City, ST, ZIP"). Returns null
 * for an empty/absent location. Exported for tests.
 */
export function parseFairHousingLocation(loc) {
  if (!loc) return null
  const name = stripHtml(loc.addressTitle || '').trim() || null
  const address = (loc.addressLine1 || '').trim() || null

  let city = null, state = null, zip = null
  if (loc.addressLine2) {
    const parts = String(loc.addressLine2).split(',').map((s) => s.trim()).filter(Boolean)
    if (parts.length) city = parts[0] || null
    const stateZip = parts.slice(1).join(' ').trim()
    const sz = stateZip.match(/^([A-Z]{2})\s*,?\s*(\d{5})?/)
    if (sz) { state = sz[1]; zip = sz[2] || null }
  }

  const lat = isOhioCoord(loc.mapLat, loc.mapLng) ? loc.mapLat : null
  const lng = isOhioCoord(loc.mapLat, loc.mapLng) ? loc.mapLng : null

  // A location with no name AND no city is effectively empty.
  if (!name && !city && lat == null) return null
  return { name, address, city, state, zip, lat, lng }
}

/** Find the first recognized city from `citySet` mentioned in `text` (word-bounded). */
function cityMentioned(text, citySet) {
  const t = ` ${String(text || '').toLowerCase()} `
  for (const c of citySet) {
    const re = new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    if (re.test(t)) return c
  }
  return null
}

/**
 * Classify an event 'in' | 'out' | 'unknown'. Prefers the structured location
 * (Ohio coords + city); when the location is empty, falls back to scanning the
 * title + description for a recognized city (NOT_SUMMIT → out, Summit → in).
 * Exported for tests.
 */
export function classifyEventLocation(item) {
  const loc = parseFairHousingLocation(item.location)
  if (loc && (loc.lat != null || loc.city)) {
    return classifySummitLocation({ lat: loc.lat, lng: loc.lng, city: loc.city })
  }
  // No usable structured location — decide from the text.
  const text = `${item.title || ''} ${stripHtml(item.body || '') || item.excerpt || ''}`
  if (cityMentioned(text, NOT_SUMMIT_COUNTY_CITIES)) return 'out'
  if (cityMentioned(text, SUMMIT_COUNTY_CITIES)) return 'in'
  return 'unknown'
}

/** True when the event is explicitly free (workshops all say "FREE"). */
export function isFreeEvent(item) {
  const text = `${item.title || ''} ${item.excerpt || ''} ${stripHtml(item.body || '')}`
  return /\bfree\b/i.test(text)
}

export function mapCategory() {
  return 'civic'
}

export function mapTags(item) {
  const tags = ['fair-housing', 'housing', 'akron']
  if (/workshop/i.test(item.title || '')) tags.push('workshop')
  return tags
}

// ── Process events ───────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId) {
  let inserted = 0, skippedOut = 0, skippedNoData = 0, review = 0
  const venueCache = new Map()

  for (const item of rawEvents) {
    try {
      const geo = classifyEventLocation(item)
      if (geo === 'out') { skippedOut++; continue }

      const row = normaliseSquarespaceEvent(item, { source: SOURCE_KEY, mapTags })
      row.category = mapCategory(item)
      row.ticket_url = buildSquarespaceEventUrl(SITE_BASE_URL, item) || row.ticket_url
      if (isFreeEvent(item)) { row.price_min = 0; row.price_max = 0 }
      if (geo === 'unknown') { row.status = 'pending_review'; row.needs_review = true }

      if (!row.title || !row.start_at) { skippedNoData++; continue }

      // Per-event venue from the structured location (Akron libraries / The Well
      // CDC). Location-less events publish without a venue.
      let venueId = null
      const loc = parseFairHousingLocation(item.location)
      if (loc && loc.name) {
        if (venueCache.has(loc.name)) {
          venueId = venueCache.get(loc.name)
        } else {
          venueId = await ensureVenue(loc.name, {
            address: loc.address || undefined,
            city: loc.city || 'Akron',
            state: loc.state || 'OH',
            zip: loc.zip || undefined,
          })
          venueCache.set(loc.name, venueId)
        }
      }

      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) { console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`); skippedNoData++; continue }
      if (venueId) await linkEventVenue(upserted.id, venueId)
      if (organizerId) await linkEventOrganization(upserted.id, organizerId)
      if (geo === 'unknown') review++
      inserted++
    } catch (err) {
      console.warn(`  ⚠ Error processing "${item.title}": ${err.message}`)
      skippedNoData++
    }
  }

  return { inserted, skippedOut, skippedNoData, review }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🏠  Starting Fair Housing Contact Service ingestion…')
  if (DRY_RUN) console.log('   [dry-run mode — fetch + parse only, no DB writes]')
  const start = Date.now()

  try {
    await preloadSummitCountyBoundary() // required before any coordinate-based gate

    console.log(`\n🔍  Fetching events from ${COLLECTION_URL}…`)
    const events = await fetchSquarespaceEvents(COLLECTION_URL)
    console.log(`  Found ${events.length} upcoming event(s)`)

    if (DRY_RUN) {
      for (const item of events) {
        const geo = classifyEventLocation(item)
        console.log(`     • [${geo}] ${item.title}  (${new Date(item.startDate).toISOString()})`)
      }
      console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s [dry-run]`)
      return
    }

    const organizerId = await ensureOrganization('Fair Housing Contact Service', {
      website: SITE_BASE_URL,
      description:
        'Fair Housing Contact Service is an Akron nonprofit providing housing ' +
        'discrimination assistance, counseling, and free tenant/landlord education workshops.',
    })

    const { inserted, skippedOut, skippedNoData, review } = await processEvents(events, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skippedOut + skippedNoData, {
      eventsFound: events.length,
      durationMs: Date.now() - start,
    })
    console.log(
      `\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ` +
      `${inserted} upserted (${review} to review), ${skippedOut} out-of-county, ${skippedNoData} skipped`,
    )
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

export { SITE_BASE_URL, SOURCE_KEY }
