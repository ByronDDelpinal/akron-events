/**
 * scrape-cascade-locks.js
 *
 * Fetches upcoming events from the Cascade Locks Park Association — a
 * nonprofit stewarding the historic Ohio & Erie Canal locks and the
 * Cascade Valley greenway just north of downtown Akron. They run a
 * mix of weekly programming (Free Lunch Fridays at Beech Street
 * Trailhead, history-of-the-canal walks) and seasonal community
 * events.
 *
 * Platform: cascadelocks.org is a Squarespace site with a native
 * Events collection at /events. We hit the standard
 * `?format=json&view=upcoming` JSON endpoint via the shared
 * lib/squarespace.js helpers — same pattern as Leadership Akron,
 * Rialto, and Crown Point Ecology.
 *
 * Why this scraper exists now: Cascade Locks events live in Akron's
 * canal corridor and historically only surfaced through Akron Life's
 * Evvnt feed, which carries the wrong category half the time. Direct
 * ingestion keeps the categorisation accurate and skips the Evvnt
 * copies via COVERED_BY_DIRECT_SCRAPER.
 *
 * Usage:
 *   node scripts/scrape-cascade-locks.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  enrichWithImageDimensions,
  ensureOrganization,
  ensureVenue,
  inferCategory,
  linkEventOrganization,
  linkEventVenue,
  linkOrganizationVenue,
  logScraperError,
  logUpsertResult,
  upsertEventSafe,
} from './lib/normalize.js'
import {
  fetchSquarespaceEvents,
  normaliseSquarespaceEvent,
  parseSquarespaceLocation,
  buildSquarespaceEventUrl,
} from './lib/squarespace.js'

// ── Configuration ─────────────────────────────────────────────────────────

const SITE_BASE_URL  = 'https://www.cascadelocks.org'
const COLLECTION_URL = `${SITE_BASE_URL}/events`

const SOURCE_KEY = 'cascade_locks'

// Headquarters / default venue. Events that don't carry a Squarespace
// location object inherit this — most CLPA programming happens along the
// canal corridor in Akron and the HQ address keeps them inside the
// 25-mile geo radius even when the per-event location is missing.
const DEFAULT_VENUE = {
  name:    'Cascade Locks Park Association',
  address: '57 W North St',
  city:    'Akron',
  state:   'OH',
  zip:     '44304',
  // Approximate coords for the canal-corridor offices in downtown Akron.
  lat:     41.0865,
  lng:     -81.5197,
  website: SITE_BASE_URL,
  description:
    "Nonprofit stewarding the historic Ohio & Erie Canal locks and the Cascade Valley " +
    "greenway just north of downtown Akron. Programs the Beech Street Trailhead (Lock 10), " +
    "Ferndale Street trailhead, and seasonal canal-corridor events.",
  parking_type:  'lot',
  parking_notes: 'Free parking at the Beech Street and Ferndale Street trailheads.',
}

// ── Category / tag mapping ────────────────────────────────────────────────

// Category: infer from title + excerpt; canal/park events default to 'outdoors'.
function mapCategory(item) {
  const cat = inferCategory(item.title || '', item.excerpt || '')
  return cat === 'other' ? 'outdoors' : cat
}

function mapTags(item) {
  const text = `${item.title ?? ''} ${item.excerpt ?? ''}`.toLowerCase()
  const tags = ['canal', 'akron', 'ohio-erie-canal']
  if (/\bfree lunch friday\b/.test(text))         tags.push('free-lunch-friday', 'free')
  if (/\b(lock 10|beech street)\b/.test(text))    tags.push('beech-trailhead', 'lock-10')
  if (/\bferndale\b/.test(text))                  tags.push('ferndale-trailhead')
  if (/\b(walk|hike|trail|towpath)\b/.test(text)) tags.push('walk')
  if (/\bhistory\b/.test(text))                   tags.push('history')
  return [...new Set(tags)]
}

// ── Venue cache ───────────────────────────────────────────────────────────

const venueCache = new Map()

async function ensureEventVenue(item, defaultVenueId, organizerId) {
  const loc = parseSquarespaceLocation(item.location)
  // Most CLPA events have no Squarespace location set — they happen on
  // the canal trail with the HQ as the canonical address. When a per-
  // event location IS present and isn't a stripped-down restatement of
  // the HQ, route it to its own venue record.
  if (!loc?.name || /cascade locks|park association/i.test(loc.name)) {
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
        source:           SOURCE_KEY,
        mapCategory,
        mapTags,
        defaultPriceMin:  null,
        defaultPriceMax:  null,
        ageRestriction:   'all_ages',
      })

      row.ticket_url = buildSquarespaceEventUrl(SITE_BASE_URL, item) || row.ticket_url

      if (!row.start_at) { skipped++; continue }

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
  console.log('🚣  Starting Cascade Locks Park Association ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization('Cascade Locks Park Association', {
      website:     SITE_BASE_URL,
      description: DEFAULT_VENUE.description,
    })

    const defaultVenueId = await ensureVenue(DEFAULT_VENUE.name, {
      address:       DEFAULT_VENUE.address,
      city:          DEFAULT_VENUE.city,
      state:         DEFAULT_VENUE.state,
      zip:           DEFAULT_VENUE.zip,
      lat:           DEFAULT_VENUE.lat,
      lng:           DEFAULT_VENUE.lng,
      website:       DEFAULT_VENUE.website,
      description:   DEFAULT_VENUE.description,
      parking_type:  DEFAULT_VENUE.parking_type,
      parking_notes: DEFAULT_VENUE.parking_notes,
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
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly (`node scripts/scrape-cascade-locks.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
