/**
 * scrape-musica.js
 *
 * Fetches upcoming shows from Musica — the Akron live-music venue — via its
 * Squarespace Events Collection JSON endpoint. Scraping the venue directly
 * gives us authoritative show times (the CVB/aggregator feeds often drop them).
 *
 * Platform: Squarespace (native Events collection — ?format=json&view=upcoming)
 *
 * NOTE: If this returns 0 events, the venue's events page is likely a
 * client-side embed (e.g. a Dice ticketing widget) rather than a native
 * Squarespace Events collection — in which case a Dice-based scraper is needed.
 *
 * Usage:
 *   node scripts/scrape-musica.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
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

const SITE_BASE_URL   = 'https://www.theofficialmusica.com'
const COLLECTION_URLS = [`${SITE_BASE_URL}/upcoming-events-`]
const SOURCE_KEY      = 'musica'

const VENUE_NAME     = 'Musica'
const VENUE_FALLBACK = {
  address: '51 E Market St',
  city:    'Akron',
  state:   'OH',
  zip:     '44308',
  website: SITE_BASE_URL,
}

// ── Tag mapping ─────────────────────────────────────────────────────────────

// Musica is a live-music venue; every listing is a show. Default the content
// category to 'music' and let inference add a second facet when the title
// clearly carries one (e.g. comedy nights).
function mapTags(item) {
  const t    = item.title || ''
  const tags = ['live-music', 'concert', 'music', 'akron', 'musica']
  if (/\b(comedy|stand-?up)\b/i.test(t)) tags.push('comedy')
  if (/\b(dj|dance|club)\b/i.test(t))    tags.push('dj')
  return [...new Set(tags)]
}

// ── Venue ───────────────────────────────────────────────────────────────────

const venueCache = new Map()

async function ensureEventVenue(item, organizerId) {
  const loc  = parseSquarespaceLocation(item.location)
  const name = loc?.name || VENUE_NAME
  if (venueCache.has(name)) return venueCache.get(name)

  const venueId = await ensureVenue(name, {
    address: loc?.address ?? VENUE_FALLBACK.address,
    city:    loc?.city    ?? VENUE_FALLBACK.city,
    state:   loc?.state   ?? VENUE_FALLBACK.state,
    zip:     loc?.zip     ?? VENUE_FALLBACK.zip,
    lat:     loc?.lat     ?? null,
    lng:     loc?.lng     ?? null,
    website: SITE_BASE_URL,
  })

  if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)
  venueCache.set(name, venueId)
  return venueId
}

// ── Process events ──────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId) {
  let inserted = 0, skipped = 0

  for (const item of rawEvents) {
    try {
      const row = normaliseSquarespaceEvent(item, {
        source:          SOURCE_KEY,
        mapCategory:     () => 'music',   // a live-music venue
        mapTags,
        defaultPriceMin: null,
        defaultPriceMax: null,
        ageRestriction:  'not_specified',
      })
      row.ticket_url = buildSquarespaceEventUrl(SITE_BASE_URL, item) || row.ticket_url

      if (!row.start_at) { skipped++; continue }

      const venueId     = await ensureEventVenue(item, organizerId)
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

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Musica ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization('Musica', {
      website:     SITE_BASE_URL,
      description: 'Musica is an independent live-music venue and bar in downtown Akron hosting touring and local acts.',
    })

    const allEvents = []
    for (const collectionUrl of COLLECTION_URLS) {
      console.log(`\n🔍  Fetching events from ${collectionUrl}…`)
      const events = await fetchSquarespaceEvents(collectionUrl)
      console.log(`  Found ${events.length} upcoming events`)
      allEvents.push(...events)
    }

    if (allEvents.length === 0) {
      console.warn('  ⚠ 0 events — Musica may embed a Dice widget rather than a native Squarespace Events collection. Verify and consider a Dice-based scraper.')
    }

    console.log(`\n📥  Processing ${allEvents.length} events…`)
    const { inserted, skipped } = await processEvents(allEvents, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: allEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

export { mapTags, ensureEventVenue, SITE_BASE_URL, SOURCE_KEY }
