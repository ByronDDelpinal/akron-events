/**
 * scrape-crown-point-ecology.js
 *
 * Fetches upcoming events from Crown Point Ecology Center — a 115-acre
 * regenerative farm and nature center in Bath/Akron offering farm-based
 * education, monthly nature walks, the Meadow Music concert series, the
 * Rooted Conversations speaker series, and signature fundraisers.
 *
 * Platform: Squarespace native Events collection at `/calendar`. The shared
 * Squarespace helper hits `?format=json&view=upcoming` and returns
 * structured event items with start/end dates, body HTML, image, and
 * location.
 *
 * Usage:
 *   node scripts/scrape-crown-point-ecology.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
} from './lib/normalize.js'
import {
  fetchSquarespaceEvents,
  normaliseSquarespaceEvent,
  parseSquarespaceLocation,
  buildSquarespaceEventUrl,
} from './lib/squarespace.js'

// ── Configuration ─────────────────────────────────────────────────────────

const SITE_BASE_URL  = 'https://www.crownpointecology.org'
const COLLECTION_URL = `${SITE_BASE_URL}/calendar`

const SOURCE_KEY = 'crown_point_ecology'

// Default venue (used when an event has no Squarespace location attached)
const DEFAULT_VENUE = {
  name:    'Crown Point Ecology Center',
  address: '3220 Ira Rd',
  city:    'Akron',
  state:   'OH',
  zip:     '44333',
  // Coordinates of the main farm campus (Bath Township, Summit County)
  lat:     41.1812,
  lng:     -81.6447,
  website: 'https://www.crownpointecology.org',
  parking_type:  'lot',
  parking_notes: 'Free on-site parking at the farm and event spaces.',
  description:   '115-acre regenerative farm and nature center offering CSA, farmers market, public trails, weddings, and seasonal programming.',
}

// ── Category / tag mapping ────────────────────────────────────────────────

function mapCategory(item) {
  const text = `${item.title ?? ''} ${item.excerpt ?? ''}`.toLowerCase()
  if (/\b(concert|music|band|meadow music)\b/.test(text))      return 'music'
  if (/\b(walk|hike|trail|nature|wildlife)\b/.test(text))      return 'nature'
  if (/\b(fundraiser|taste of earth|gala|benefit)\b/.test(text)) return 'community'
  if (/\b(workshop|class|education|speaker|conversation|series|rise and shine)\b/.test(text)) return 'education'
  if (/\b(market|sale|plant sale|farmstand)\b/.test(text))     return 'community'
  if (/\b(murder mystery|theater|performance|prohibition)\b/.test(text)) return 'art'
  return 'nature'
}

function mapTags(item) {
  const text = `${item.title ?? ''} ${item.excerpt ?? ''}`.toLowerCase()
  const tags = ['crown-point', 'ecology', 'farm', 'akron']
  if (/\bmeadow music\b/.test(text))                  tags.push('meadow-music', 'concert', 'outdoors')
  if (/\brooted conversations\b/.test(text))          tags.push('speaker-series')
  if (/\brise and shine\b/.test(text))                tags.push('youth', 'family')
  if (/\bseasons on the land|monthly walk\b/.test(text)) tags.push('nature-walk')
  if (/\btaste of earth\b/.test(text))                tags.push('fundraiser')
  if (/\bplant sale\b/.test(text))                    tags.push('plant-sale')
  if (/\bmurder mystery|dead at harvest\b/.test(text)) tags.push('immersive', 'fundraiser')
  return [...new Set(tags)]
}

// ── Venue cache ───────────────────────────────────────────────────────────

const venueCache = new Map()

async function ensureEventVenue(item, defaultVenueId, organizerId) {
  const loc = parseSquarespaceLocation(item.location)
  // Crown Point hosts almost everything on its own grounds. If Squarespace
  // returns the main address (3220 Ira Rd) or no location at all, fall back
  // to the default venue to avoid creating per-event duplicate venues.
  if (!loc?.name || /crown point/i.test(loc.name) || !loc.address) {
    return defaultVenueId
  }

  if (venueCache.has(loc.name)) return venueCache.get(loc.name)

  const venueId = await ensureVenue(loc.name, {
    address: loc.address,
    city:    loc.city  ?? 'Akron',
    state:   loc.state ?? 'OH',
    zip:     loc.zip,
    lat:     loc.lat,
    lng:     loc.lng,
    website: null,
  })

  if (venueId && organizerId) {
    await linkOrganizationVenue(organizerId, venueId)
  }

  venueCache.set(loc.name, venueId)
  return venueId ?? defaultVenueId
}

// ── Process events ────────────────────────────────────────────────────────

async function processEvents(rawEvents, defaultVenueId, organizerId) {
  let inserted = 0, skipped = 0

  for (const item of rawEvents) {
    try {
      const row = normaliseSquarespaceEvent(item, {
        source:      SOURCE_KEY,
        mapCategory,
        mapTags,
        defaultPriceMin: null,
        defaultPriceMax: null,
        ageRestriction:  'all_ages',
      })

      // Override ticket_url with the full public URL for browsing
      row.ticket_url = buildSquarespaceEventUrl(SITE_BASE_URL, item) || row.ticket_url

      if (!row.start_at) {
        skipped++
        continue
      }

      const venueId = await ensureEventVenue(item, defaultVenueId, organizerId)

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${item.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ───────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Crown Point Ecology Center ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization('Crown Point Ecology Center', {
      website:     'https://www.crownpointecology.org',
      description: 'Crown Point Ecology Center is a nonprofit regenerative farm and nature center on 115 acres in Bath Township, offering CSA produce, farmer training, public trails, environmental education, and seasonal events.',
    })

    const defaultVenueId = await ensureVenue(DEFAULT_VENUE.name, {
      address:       DEFAULT_VENUE.address,
      city:          DEFAULT_VENUE.city,
      state:         DEFAULT_VENUE.state,
      zip:           DEFAULT_VENUE.zip,
      lat:           DEFAULT_VENUE.lat,
      lng:           DEFAULT_VENUE.lng,
      website:       DEFAULT_VENUE.website,
      parking_type:  DEFAULT_VENUE.parking_type,
      parking_notes: DEFAULT_VENUE.parking_notes,
      description:   DEFAULT_VENUE.description,
    })

    if (organizerId && defaultVenueId) {
      await linkOrganizationVenue(organizerId, defaultVenueId)
    }

    console.log(`\n🔍  Fetching events from ${COLLECTION_URL}…`)
    const rawEvents = await fetchSquarespaceEvents(COLLECTION_URL)
    console.log(`  Found ${rawEvents.length} upcoming events`)

    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skipped } = await processEvents(rawEvents, defaultVenueId, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

main()
