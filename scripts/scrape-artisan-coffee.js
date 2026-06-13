/**
 * scrape-artisan-coffee.js
 *
 * Fetches upcoming events from Artisan Coffee (Akron) via their Squarespace
 * Events Collection JSON endpoint. Artisan Coffee is an Ellet-neighborhood
 * coffee shop that hosts live music, open mic nights, and author talks.
 *
 * Platform: Squarespace (native Events collection — ?format=json&view=upcoming)
 *
 * Usage:
 *   node scripts/scrape-artisan-coffee.js
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

const SITE_BASE_URL   = 'https://artisancoffee.us'
const COLLECTION_URLS = [`${SITE_BASE_URL}/events`]
const SOURCE_KEY      = 'artisan_coffee'

// Fallback venue details (every event is at the shop). The Squarespace
// `location` object is preferred at runtime; this backs it up if a feed item
// omits the address.
const VENUE_NAME     = 'Artisan Coffee'
const VENUE_FALLBACK = {
  address: '662 Canton Rd',
  city:    'Akron',
  state:   'OH',
  zip:     '44312',
  website: SITE_BASE_URL,
}

// ── Category / tag mapping ──────────────────────────────────────────────────

const MUSIC_RE  = /\b(open mic|live music|concert|music|jam session|acoustic)\b/i
const AUTHOR_RE = /\b(author|book|poetry|reading|novel|writer)\b/i

/** Music programming gets a 'music' hint; everything else defers to inference. */
function mapCategory(item) {
  return MUSIC_RE.test(item.title || '') ? 'music' : null
}

function mapTags(item) {
  const t    = item.title || ''
  const tags = ['coffee-shop', 'artisan-coffee', 'akron']
  if (/\bopen mic\b/i.test(t)) tags.push('open-mic', 'live-music')
  else if (MUSIC_RE.test(t))   tags.push('live-music')
  if (AUTHOR_RE.test(t))       tags.push('author-talk')
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
        mapCategory,
        mapTags,
        defaultPriceMin: null,
        defaultPriceMax: null,
        ageRestriction:  'all_ages',
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
  console.log('🚀  Starting Artisan Coffee ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization('Artisan Coffee', {
      website:     SITE_BASE_URL,
      description: 'Artisan Coffee is a coffee shop in the Ellet neighborhood of Akron hosting live music, open mic nights, and author talks.',
    })

    const allEvents = []
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
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly; importing for tests exposes pure parsers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

export { mapCategory, mapTags, ensureEventVenue, SITE_BASE_URL, SOURCE_KEY }
