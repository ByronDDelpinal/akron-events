/**
 * scrape-russos.js
 *
 * Fetches upcoming events from Russo's Restaurant (Peninsula) via their
 * Squarespace Events Collection JSON endpoint. Russo's runs a weekly
 * Wednesday-evening live-music series on the Bacchus Bar Patio
 * (6–8 PM, no cover).
 *
 * Platform: Squarespace (native Events collection — ?format=json&view=upcoming)
 *
 * Single-venue source: every event is at the restaurant. The feed's location
 * object omits state/zip (addressLine2 is just "Peninsula"), so the venue is
 * pinned to verified constants; only lat/lng come from the feed.
 *
 * Usage:
 *   node scripts/scrape-russos.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  stripHtml,
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

const SITE_BASE_URL  = 'https://russosbacchus.com'
const COLLECTION_URL = `${SITE_BASE_URL}/events`
const SOURCE_KEY     = 'russos'

// Verified from the site footer (2026-07-09). Peninsula is Summit County.
const VENUE = {
  name:    "Russo's Restaurant",
  address: '4895 State Rd',
  city:    'Peninsula',
  state:   'OH',
  zip:     '44264',
}

const ORG_NAME        = "Russo's Restaurant"
const ORG_DESCRIPTION = "Russo's Restaurant is an Italian restaurant in Peninsula hosting a weekly live-music series on its Bacchus Bar Patio, plus wine tastings and seasonal dinners."

// ── Title / category / tag / price mapping ─────────────────────────────────

const MUSIC_RE = /\b(live|music|concert|band|acoustic|jazz|blues)\b/i
const FREE_RE  = /\b(?:no cover|free admission|admission is free|free to attend|free event)\b/i

/**
 * Squarespace page duplication leaves a trailing "(Copy)" on some titles
 * (e.g. "Jen Maurer Live on the Bacchus Patio  (Copy)") — strip it.
 */
function cleanTitle(title) {
  if (!title) return title
  return title.replace(/(\s*\(copy\))+\s*$/i, '').trim()
}

/**
 * The collection is a live-music series, so music-looking items get a
 * 'music' hint; anything else (wine tastings, seasonal dinners) defers
 * to inference.
 */
function mapCategory(item) {
  const text = `${item.title || ''} ${stripHtml(item.body || '')}`
  return MUSIC_RE.test(text) ? 'music' : null
}

function mapTags(item) {
  const tags = ['russos', 'peninsula', 'bacchus-patio', 'restaurant']
  if (mapCategory(item) === 'music') tags.push('live-music')
  return [...new Set(tags)]
}

/** "No cover" (stated in every series body) → free; otherwise unknown. */
function parsePrice(item) {
  const text = stripHtml(item.body || '')
  if (FREE_RE.test(text)) return { price_min: 0, price_max: null }
  return { price_min: null, price_max: null }
}

// ── Normalisation ───────────────────────────────────────────────────────────

/** Full per-item mapping: helper normalise + Russo's-specific fields. */
function normaliseRussosEvent(item) {
  const row = normaliseSquarespaceEvent(item, {
    source:         SOURCE_KEY,
    mapCategory,
    mapTags,
    ageRestriction: 'all_ages',
  })
  row.title      = cleanTitle(row.title)
  row.ticket_url = buildSquarespaceEventUrl(SITE_BASE_URL, item) || row.ticket_url
  Object.assign(row, parsePrice(item))
  return row
}

// ── Venue ───────────────────────────────────────────────────────────────────

let cachedVenueId

async function ensureRussosVenue(item, organizerId) {
  if (cachedVenueId !== undefined) return cachedVenueId

  // Single-venue source: pin name/address to verified constants (the feed
  // location lacks state/zip); take only the map pin from the feed.
  const loc = parseSquarespaceLocation(item?.location)

  cachedVenueId = await ensureVenue(VENUE.name, {
    address: VENUE.address,
    city:    VENUE.city,
    state:   VENUE.state,
    zip:     VENUE.zip,
    lat:     loc?.lat ?? null,
    lng:     loc?.lng ?? null,
    website: SITE_BASE_URL,
  })

  if (cachedVenueId && organizerId) await linkOrganizationVenue(organizerId, cachedVenueId)
  return cachedVenueId
}

// ── Process events ──────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId) {
  let inserted = 0, skipped = 0

  for (const item of rawEvents) {
    try {
      const row = normaliseRussosEvent(item)

      if (!row.start_at) { skipped++; continue }
      // The upcoming view should only return future events; guard anyway.
      if (new Date(row.start_at).getTime() < Date.now() - 24 * 60 * 60 * 1000) {
        skipped++
        continue
      }

      const venueId     = await ensureRussosVenue(item, organizerId)
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
  console.log("🚀  Starting Russo's Restaurant ingestion…")
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization(ORG_NAME, {
      website:     SITE_BASE_URL,
      description: ORG_DESCRIPTION,
    })

    console.log(`\n🔍  Fetching events from ${COLLECTION_URL}…`)
    const events = await fetchSquarespaceEvents(COLLECTION_URL)
    console.log(`  Found ${events.length} upcoming events`)

    console.log(`\n📥  Processing ${events.length} events…`)
    const { inserted, skipped } = await processEvents(events, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: events.length,
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

export {
  cleanTitle,
  mapCategory,
  mapTags,
  parsePrice,
  normaliseRussosEvent,
  SITE_BASE_URL,
  SOURCE_KEY,
  VENUE,
}
