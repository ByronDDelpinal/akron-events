/**
 * scrape-leadership-akron.js
 *
 * Fetches upcoming events from Leadership Akron via their Squarespace
 * Events Collection JSON endpoint.
 *
 * Platform: Squarespace (native Events collection — ?format=json&view=upcoming)
 *
 * Usage:
 *   node scripts/scrape-leadership-akron.js
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

const SITE_BASE_URL   = 'https://www.leadershipakron.org'
const COLLECTION_URLS = [
  `${SITE_BASE_URL}/lom-2026`,
]

const SOURCE_KEY = 'leadership_akron'

// ── Category / tag mapping ────────────────────────────────────────────────

function mapCategory(_item) {
  // Leadership on Main events are leadership/professional development
  return 'community'
}

function mapTags(item) {
  const tags = ['leadership', 'networking', 'professional-development', 'akron']
  if (item.title?.toLowerCase().includes('leadership on main')) {
    tags.push('leadership-on-main')
  }
  return [...new Set(tags)]
}

// ── Venue cache ───────────────────────────────────────────────────────────

const venueCache = new Map()

async function ensureEventVenue(item, organizerId) {
  const loc = parseSquarespaceLocation(item.location)
  if (!loc?.name) return null

  if (venueCache.has(loc.name)) return venueCache.get(loc.name)

  const venueId = await ensureVenue(loc.name, {
    address: loc.address,
    city:    loc.city   ?? 'Akron',
    state:   loc.state  ?? 'OH',
    zip:     loc.zip,
    lat:     loc.lat,
    lng:     loc.lng,
    website: null,
  })

  if (venueId && organizerId) {
    await linkOrganizationVenue(organizerId, venueId)
  }

  venueCache.set(loc.name, venueId)
  return venueId
}

// ── Process events ────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId) {
  let inserted = 0, skipped = 0

  for (const item of rawEvents) {
    try {
      const row = normaliseSquarespaceEvent(item, {
        source:      SOURCE_KEY,
        mapCategory,
        mapTags,
        defaultPriceMin: 0,
        defaultPriceMax: null,
        ageRestriction:  'all_ages',
      })

      // Override ticket_url with full public URL
      row.ticket_url = buildSquarespaceEventUrl(SITE_BASE_URL, item) || row.ticket_url

      if (!row.start_at) {
        skipped++
        continue
      }

      const venueId = await ensureEventVenue(item, organizerId)

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        if (venueId) await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
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
  console.log('🚀  Starting Leadership Akron ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization('Leadership Akron', {
      website:     'https://www.leadershipakron.org',
      description: 'Leadership Akron is a nonprofit leadership development organization that cultivates, connects, and inspires leaders to strengthen the greater Akron community.',
    })

    let allEvents = []
    for (const collectionUrl of COLLECTION_URLS) {
      console.log(`\n🔍  Fetching events from ${collectionUrl}…`)
      const events = await fetchSquarespaceEvents(collectionUrl)
      console.log(`  Found ${events.length} upcoming events`)
      allEvents.push(...events)
    }

    console.log(`\n📥  Processing ${allEvents.length} events…`)
    const { inserted, skipped } = await processEvents(allEvents, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: allEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

main()
