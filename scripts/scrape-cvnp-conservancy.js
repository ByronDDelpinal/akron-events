/**
 * scrape-cvnp-conservancy.js
 *
 * Fetches upcoming events from the Conservancy for Cuyahoga Valley National Park
 * via their WordPress / The Events Calendar (Tribe) REST API.
 *
 * Summit gate: CVNP straddles the Summit/Cuyahoga county line, and the
 * Conservancy programs both sides (Canal Exploration Center in Valley View,
 * Station Road Bridge in Brecksville). Each event's Tribe venue is classified
 * with classifySummitLocation — 'out' is skipped, 'unknown' publishes as
 * pending_review, exactly like every other straddling source. This scraper
 * being first-party does NOT exempt it: the kent_stage/players_guild/
 * southgate_farm retirements (2026-07-15) were this same hole.
 *
 * Usage:
 *   node scripts/scrape-cvnp-conservancy.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'

import {
  logUpsertResult, logScraperError, enrichWithImageDimensions, upsertEventSafe,
  linkEventVenue, linkEventOrganization, ensureVenue, linkOrganizationVenue,
  parseCostFromTribe, parseTagsFromTribe, ensureOrganization, easternTodayIso,
} from './lib/normalize.js'
import { preloadSummitCountyBoundary, classifySummitLocation } from './lib/summit-county.js'

const BASE_URL   = 'https://www.conservancyforcvnp.org/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180

// ── Category mapping ───────────────────────────────────────────────────────

function parseCategory(categories = [], tags = []) {
  const names = [
    ...categories.map(c => (c.name ?? c.slug ?? '').toLowerCase()),
    ...tags.map(t => (t.name ?? t.slug ?? '').toLowerCase()),
  ]
  const has = (kw) => names.some(n => n.includes(kw))
  const hasWord = (kw) => names.some(n => new RegExp(`\\b${kw}\\b`).test(n))

  if (has('music') || has('concert') || has('performance')) return 'music'
  if (has('art') || has('photo')) return 'visual-art'
  if (has('fitness') || hasWord('run') || hasWord('bike') || has('paddle') || has('kayak')) return 'fitness'
  if (hasWord('sport')) return 'sports'
  // CVNP events that aren't a specific music/art/sports/fitness type
  // are conservation, trails, naturalist programs, plant removal, etc.
  // The education branch and generic fallback both became 'nature' in
  // the May 2026 backfill; mirror that here so re-scrapes stay aligned.
  if (has('educat') || has('workshop') || has('program') || hasWord('class')) return 'outdoors'
  return 'outdoors'
}

// ── Venue cache ────────────────────────────────────────────────────────────

const venueCache = new Map()

async function ensureOrgVenue() {
  if (venueCache.has('__org__')) return venueCache.get('__org__')

  const venueId = await ensureVenue('Cuyahoga Valley National Park', {
    address:       '1550 Boston Mills Rd',
    city:          'Peninsula',
    state:         'OH',
    zip:           '44264',
    lat:           41.2609,
    lng:           -81.5696,
    parking_type:  'lot',
    parking_notes: 'Multiple free parking lots throughout the park.',
    website:       'https://www.conservancyforcvnp.org',
  })

  venueCache.set('__org__', venueId)
  return venueId
}

async function ensureEventVenue(tribeVenue, orgVenueId) {
  if (!tribeVenue?.venue) return orgVenueId

  const name = tribeVenue.venue.trim()
  if (!name) return orgVenueId
  if (venueCache.has(name)) return venueCache.get(name)

  const venueId = await ensureVenue(name, {
    address:       tribeVenue.address ?? null,
    // No blind 'Peninsula' default: a coord-less Cuyahoga-side venue would be
    // mislabeled AND the mislabel would flip the Summit gate to 'in'.
    city:          tribeVenue.city ?? null,
    state:         tribeVenue.stateprovince ?? 'OH',
    zip:           tribeVenue.zip ?? null,
    lat:           tribeVenue.geo_lat ? parseFloat(tribeVenue.geo_lat) : null,
    lng:           tribeVenue.geo_lng ? parseFloat(tribeVenue.geo_lng) : null,
    parking_type:  'lot',
    parking_notes: 'Multiple free parking lots throughout the park.',
    website:       tribeVenue.website ?? 'https://www.conservancyforcvnp.org',
  })

  venueCache.set(name, venueId ?? orgVenueId)
  return venueId ?? orgVenueId
}

// ── Fetch ──────────────────────────────────────────────────────────────────

async function fetchAllPages() {
  // ET-anchored "today": the UTC date is already tomorrow between 8pm and
  // midnight ET, which silently dropped the rest of today's events from
  // nightly runs in that window.
  const startDate = easternTodayIso()
  const endDate   = easternTodayIso(new Date(Date.now() + DAYS_AHEAD * 86400_000))

  let page    = 1
  let hasMore = true
  const all   = []

  console.log('\n🔍  Fetching CVNP Conservancy events via Tribe REST API…')

  while (hasMore) {
    const url = new URL(BASE_URL)
    url.searchParams.set('per_page',   PER_PAGE)
    url.searchParams.set('page',       page)
    url.searchParams.set('start_date', startDate)
    url.searchParams.set('end_date',   endDate)
    url.searchParams.set('status',     'publish')

    const res = await fetch(url.toString(), {
      headers: {
        Accept:       'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; The330-bot/1.0)',
      },
    })

    if (!res.ok) throw new Error(`CVNP Conservancy API error ${res.status}: ${await res.text()}`)

    const data   = await res.json()
    const events = data.events ?? []
    all.push(...events)
    console.log(`  Page ${page}/${data.total_pages ?? 1}: ${events.length} events (total: ${all.length})`)

    hasMore = events.length > 0 && page < (data.total_pages ?? 1)
    page++

    if (hasMore) await new Promise(r => setTimeout(r, 200))
  }

  return all
}

// ── Process ────────────────────────────────────────────────────────────────

async function processEvents(rawEvents, orgVenueId, organizerId) {
  let inserted = 0, updated = 0, skipped = 0

  for (const ev of rawEvents) {
    try {
      // ── Strict Summit gate ────────────────────────────────────────────────
      // Classify BEFORE ensureEventVenue so an out-of-county trailhead never
      // mints a venue row. Events with no Tribe venue fall back to the CVNP
      // org venue (Boston Mill Visitor Center, Peninsula — in-county).
      const geo = ev.venue?.venue
        ? classifySummitLocation({
            lat:  ev.venue.geo_lat,
            lng:  ev.venue.geo_lng,
            city: ev.venue.city,
          })
        : 'in'
      if (geo === 'out') {
        console.log(`  ⤷ Summit gate: skipping "${ev.title}" at ${ev.venue?.venue} (${ev.venue?.city ?? 'no city'})`)
        skipped++
        continue
      }

      const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
      const category = parseCategory(ev.categories, ev.tags)
      const tags     = parseTagsFromTribe(ev.categories, ev.tags, ['national-park', 'cvnp', 'outdoors'])
      const imageUrl = ev.image?.url ?? null

      const venueId = await ensureEventVenue(ev.venue, orgVenueId)

      const row = {
        title:           ev.title,
        // Raw HTML — upsertEventSafe's sanitizer uses htmlToText, which keeps
        // paragraph breaks. Pre-flattening with stripHtml here destroyed them.
        description:     ev.description || null,
        start_at:        ev.utc_start_date ? ev.utc_start_date.replace(' ', 'T') + 'Z' : null,
        end_at:          ev.utc_end_date   ? ev.utc_end_date.replace(' ', 'T') + 'Z'   : null,
        category,
        tags,
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ev.website || ev.url || null,
        source:          'cvnp_conservancy',
        source_id:       String(ev.id),
        status:          geo === 'unknown' ? 'pending_review' : 'published',
        ...(geo === 'unknown' ? { needs_review: true } : {}),
        featured:        ev.featured ?? false,
      }

      if (!row.start_at) { skipped++; continue }

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error, isNew } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        if (isNew) inserted++; else updated++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${ev.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, updated, skipped }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting CVNP Conservancy ingestion…')
  const start = Date.now()

  try {
    await preloadSummitCountyBoundary()
    const orgVenueId = await ensureOrgVenue()
    const organizerId = await ensureOrganization('Conservancy for Cuyahoga Valley National Park', {
      website:     'https://www.conservancyforcvnp.org',
      description: 'The Conservancy for Cuyahoga Valley National Park supports, promotes, and enhances Cuyahoga Valley National Park through education, recreation, and stewardship.',
    })

    await linkOrganizationVenue(organizerId, orgVenueId)

    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)

    const { inserted, updated, skipped } = await processEvents(rawEvents, orgVenueId, organizerId)
    await logUpsertResult('cvnp_conservancy', inserted, updated, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('cvnp_conservancy', err, start)
    process.exit(1)
  }
}

// Run only when invoked directly (`node scripts/scrape-cvnp-conservancy.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
