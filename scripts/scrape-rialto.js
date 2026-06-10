/**
 * scrape-rialto.js
 *
 * Fetches upcoming events from The Rialto Theatre via their Squarespace
 * Events Collection JSON endpoint.
 *
 * Platform: Squarespace (native Events collection — ?format=json&view=upcoming)
 * Site:     https://www.therialtotheatre.com
 * Venue:    1000 Kenmore Boulevard, Akron, OH 44314
 *
 * Usage:
 *   node scripts/scrape-rialto.js
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
  buildSquarespaceEventUrl,
} from './lib/squarespace.js'

// ── Configuration ─────────────────────────────────────────────────────────

const SITE_BASE_URL   = 'https://www.therialtotheatre.com'
const COLLECTION_URLS = [
  `${SITE_BASE_URL}/calendar`,
]

const SOURCE_KEY = 'rialto'

// Fixed venue — every Rialto event is at the same address.
const VENUE_INFO = {
  name:    'The Rialto Theatre',
  address: '1000 Kenmore Boulevard',
  city:    'Akron',
  state:   'OH',
  zip:     '44314',
  website: SITE_BASE_URL,
}

// ── Title cleanup ─────────────────────────────────────────────────────────

/**
 * Strip the trailing date stamp Rialto appends to every title.
 * e.g. "Stay Gone / STMNTS / Bury The Pines - 05/27/2026" → "Stay Gone / STMNTS / Bury The Pines"
 */
function cleanTitle(raw) {
  return (raw ?? '')
    .replace(/\s*-\s*\d{2}\/\d{2}\/\d{4}\s*$/, '')
    .trim()
}

// ── Category / tag mapping ────────────────────────────────────────────────

/**
 * Infer category from event title.
 * The Rialto is primarily a music venue but also hosts poetry, improv, and trivia.
 */
// Category: infer from title; Rialto is a music venue so falls back to 'music'.
function mapCategory(item) {
  const cat = inferCategory(item.title || '', item.excerpt || '')
  return (cat === 'other' || cat === 'civic') ? 'music' : cat
}

function mapTags(item) {
  const t = (item.title ?? '').toLowerCase()
  const tags = ['kenmore', 'live-music', 'akron']

  if (/living room/i.test(t))                            tags.push('acoustic', 'intimate')
  if (/emerging sounds/i.test(t))                        tags.push('emerging-sounds', 'local-artists')
  if (/irish/i.test(t))                                  tags.push('irish', 'traditional')
  if (/poetry|spoken word|angry cow/i.test(t))           tags.push('poetry', 'spoken-word')
  if (/improv/i.test(t))                                 tags.push('improv', 'comedy')
  if (/trivia/i.test(t))                                 tags.push('trivia')
  if (/open mic/i.test(t))                               tags.push('open-mic')

  return [...new Set(tags)]
}

// ── Process events ────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId, venueId) {
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

      // Clean the trailing date stamp from titles
      row.title = cleanTitle(row.title)

      // Build full public URL for the event detail page
      row.ticket_url = buildSquarespaceEventUrl(SITE_BASE_URL, item) || row.ticket_url

      if (!row.title || !row.start_at) {
        skipped++
        continue
      }

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
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
  console.log('🎸  Starting Rialto Theatre ingestion…')
  const start = Date.now()

  try {
    // Ensure the organization record exists
    const organizerId = await ensureOrganization('The Rialto Theatre', {
      website:     SITE_BASE_URL,
      description: "The Rialto Theatre is Akron's home for live music — a community venue in the Kenmore neighborhood run by musicians for musicians and music fans.",
    })

    // The venue is fixed — every event happens here
    const venueId = await ensureVenue(VENUE_INFO.name, {
      address: VENUE_INFO.address,
      city:    VENUE_INFO.city,
      state:   VENUE_INFO.state,
      zip:     VENUE_INFO.zip,
      website: VENUE_INFO.website,
    })

    if (venueId && organizerId) {
      await linkOrganizationVenue(organizerId, venueId)
    }

    // Fetch all upcoming events
    const allEvents = []
    for (const collectionUrl of COLLECTION_URLS) {
      console.log(`\n🔍  Fetching events from ${collectionUrl}…`)
      const events = await fetchSquarespaceEvents(collectionUrl)
      console.log(`  Found ${events.length} upcoming events`)
      allEvents.push(...events)
    }

    console.log(`\n📥  Processing ${allEvents.length} events…`)
    const { inserted, skipped } = await processEvents(allEvents, organizerId, venueId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: allEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly (`node scripts/scrape-rialto.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
