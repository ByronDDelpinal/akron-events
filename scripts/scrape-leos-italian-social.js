/**
 * scrape-leos-italian-social.js
 *
 * Fetches live-music events from Leo's Italian Social via their Squarespace
 * "Music" Events collection JSON endpoint.
 *
 * Platform: Squarespace (native Events collection — ?format=json&view=upcoming)
 * Site:     https://www.leositaliansocial.com/music
 *
 * MULTI-LOCATION CHAIN — geography quirk (important):
 *   Leo's Italian Social is a small restaurant chain. A SINGLE Squarespace
 *   "Music" collection lists live-music nights across ALL its locations
 *   (Cuyahoga Falls OH, plus Crocker Park/Westlake OH and out-of-state
 *   rooms). Only the Cuyahoga Falls location is in Summit County, so only
 *   its events may publish — the rest are known out-of-county and are
 *   dropped outright (not queued for review).
 *
 *   Per-event geography lives in the Squarespace `location` object, BUT the
 *   pin fields are inconsistent:
 *     - `markerLat`/`markerLng` are a single site-wide DEFAULT (they are the
 *       exact same value on every event ~41.4324,-81.3933) — useless for
 *       per-event gating. The shared `parseSquarespaceLocation()` helper
 *       PREFERS marker coords, which would misclassify every event, so we do
 *       NOT use it here.
 *     - `mapLat`/`mapLng` carry the REAL per-event pin (Cuyahoga Falls =
 *       41.1376,-81.4824; Crocker Park = 41.4599,-81.9524). We parse those,
 *       plus the city from `addressLine2`, and gate hard with
 *       classifySummitLocation() — only 'in' publishes; everything else is
 *       skipped (see PARSE + GATE below).
 *
 * Dates/times: Squarespace `startDate`/`endDate` are absolute epoch ms, so
 *   normaliseSquarespaceEvent()'s toISOString() is correct — no time is ever
 *   synthesized (every item carries a real start/end).
 *
 * Venue dedupe: the Cuyahoga Falls room already exists as venue "Leo's Italian
 *   Social" (2251 Front St, Cuyahoga Falls) from the akron_life feed.
 *   ensureVenue() matches on the exact (stripHtml-decoded) name, so this
 *   scraper reuses that canonical row rather than minting a duplicate.
 *
 * Usage:
 *   node scripts/scrape-leos-italian-social.js
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
  linkEventOrganization,
  linkEventVenue,
  linkOrganizationVenue,
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
} from './lib/summit-county.js'

// ── Configuration ─────────────────────────────────────────────────────────

const SITE_BASE_URL   = 'https://www.leositaliansocial.com'
const COLLECTION_URLS = [`${SITE_BASE_URL}/music`]
const SOURCE_KEY      = 'leos_italian_social'

// Canonical Summit-County venue (already in the DB from akron_life). ensureVenue
// dedupes on the exact name; these fields backfill/refresh the row.
const VENUE_NAME     = "Leo's Italian Social"
const VENUE_FALLBACK = {
  address: '2251 Front St',
  city:    'Cuyahoga Falls',
  state:   'OH',
  website: SITE_BASE_URL,
}

// ── Location parsing + Summit gate ──────────────────────────────────────────

/**
 * Parse the Squarespace `location` object into flat venue fields, using the
 * REAL per-event pin (`mapLat`/`mapLng`). Deliberately ignores
 * `markerLat`/`markerLng` — on this multi-location site those are a single
 * site-wide default that is identical on every event and would defeat the
 * per-event Summit gate.
 *
 * @param {object|null} loc — Squarespace location object
 * @returns {{name,address,city,state,zip,lat,lng}|null}
 */
export function parseLeosLocation(loc) {
  if (!loc) return null

  const name = stripHtml(loc.addressTitle || '') || null
  // Drop a trailing period/space so "2251 Front St." folds onto the canonical
  // "2251 Front St" row instead of churning the address on every run.
  const address = (loc.addressLine1 || '').trim().replace(/\.\s*$/, '').trim() || null

  // addressLine2 is "City, ST" or "City, ST, ZIP" or "City, ST ZIP".
  let city = null, state = null, zip = null
  if (loc.addressLine2) {
    const parts = loc.addressLine2.split(',').map((s) => s.trim()).filter(Boolean)
    if (parts.length >= 1) city = parts[0] || null
    const stateZip = parts.slice(1).join(' ').trim()
    const szMatch  = stateZip.match(/^([A-Z]{2})\s*,?\s*(\d{5})?/)
    if (szMatch) {
      state = szMatch[1]
      zip   = szMatch[2] || null
    }
  }

  const lat = loc.mapLat ?? null
  const lng = loc.mapLng ?? null

  return { name, address, city, state, zip, lat, lng }
}

/**
 * Three-way Summit classification for a raw event item: 'in' | 'out' |
 * 'unknown'. Uses the real per-event pin; falls back to the city name when a
 * future item ships without coords.
 */
export function classifyEventLocation(item) {
  const loc = parseLeosLocation(item.location)
  if (!loc) return 'unknown'
  return classifySummitLocation({ lat: loc.lat, lng: loc.lng, city: loc.city })
}

// ── Title cleanup ───────────────────────────────────────────────────────────

/**
 * Strip the trailing "+ $8 Martinis" promo that Leo's appends to every music
 * title, leaving just the performer name. Handles the missing-space variant
 * ("Danny Christian+ $8 Martinis") and any dollar amount.
 * e.g. "Brent Kirby + $8 Martinis" → "Brent Kirby"
 */
export function cleanTitle(raw) {
  return (raw ?? '')
    .replace(/\s*\+\s*\$\d+\s+martinis\s*$/i, '')
    .trim()
}

// Cancelled/postponed shows are left in the Squarespace collection with a title
// marker rather than removed. Title-scoped (never description) per the shared
// convention.
export const CANCELLED_RE = /\bcancel?led\b|\bpostponed\b/i

// ── Category / tag mapping ──────────────────────────────────────────────────

/**
 * Every entry in the "Music" collection is a live-music night, so force the
 * music category unconditionally. (Text inference can't be trusted here — the
 * titles are bare performer names and the body is boilerplate, so inference
 * wanders to 'learning'/'other'.) Returned as an explicit single-element list
 * because resolveEventCategories() uses a `categories` array verbatim and skips
 * the inference merge, giving a clean ['music'] instead of ['music','learning'].
 */
export function mapCategories() {
  return ['music']
}

export function mapTags() {
  return ['live-music', 'cuyahoga-falls', 'martinis', 'akron']
}

// ── Process events ──────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId, venueId) {
  let inserted = 0, skippedOut = 0, skippedNoData = 0

  for (const item of rawEvents) {
    try {
      // Hard geography gate FIRST: only the Cuyahoga Falls room may publish.
      // Every other location is known out-of-county — drop it outright (not
      // review-worthy per the strict Summit mandate for this source).
      if (classifyEventLocation(item) !== 'in') { skippedOut++; continue }

      const row = normaliseSquarespaceEvent(item, {
        source:          SOURCE_KEY,
        mapTags,
        defaultPriceMin: null,   // $8 martinis is a drink special, not admission
        defaultPriceMax: null,
      })
      row.categories = mapCategories()   // explicit list → clean, single 'music'
      row.title      = cleanTitle(row.title)
      row.ticket_url = buildSquarespaceEventUrl(SITE_BASE_URL, item) || row.ticket_url

      if (!row.title || !row.start_at) { skippedNoData++; continue }
      if (CANCELLED_RE.test(row.title)) { skippedNoData++; continue }   // scratched — drop

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skippedNoData++
      } else {
        if (venueId) await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${item.title}":`, err.message)
      skippedNoData++
    }
  }

  return { inserted, skippedOut, skippedNoData }
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log("🍸  Starting Leo's Italian Social (Cuyahoga Falls) ingestion…")
  const start = Date.now()

  try {
    await preloadSummitCountyBoundary()

    const organizerId = await ensureOrganization(VENUE_NAME, {
      website:     SITE_BASE_URL,
      description: "Leo's Italian Social is a restaurant in Cuyahoga Falls hosting live acoustic music several nights a week.",
    })

    const venueId = await ensureVenue(VENUE_NAME, {
      address: VENUE_FALLBACK.address,
      city:    VENUE_FALLBACK.city,
      state:   VENUE_FALLBACK.state,
      website: VENUE_FALLBACK.website,
    })

    if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)

    const allEvents = []
    for (const collectionUrl of COLLECTION_URLS) {
      console.log(`\n🔍  Fetching events from ${collectionUrl}…`)
      const events = await fetchSquarespaceEvents(collectionUrl)
      console.log(`  Found ${events.length} upcoming events (all locations)`)
      allEvents.push(...events)
    }

    console.log(`\n📥  Processing ${allEvents.length} events…`)
    const { inserted, skippedOut, skippedNoData } =
      await processEvents(allEvents, organizerId, venueId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skippedOut + skippedNoData, {
      eventsFound: allEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(
      `\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ` +
      `${inserted} upserted, ${skippedOut} out-of-county, ${skippedNoData} skipped`,
    )
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly; importing for tests exposes pure parsers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

export { SITE_BASE_URL, SOURCE_KEY, VENUE_NAME }
