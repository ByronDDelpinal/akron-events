/**
 * scrape-cvnp-conservancy.js
 *
 * Fetches upcoming events from the Conservancy for Cuyahoga Valley National Park
 * via their WordPress / The Events Calendar (Tribe) REST API.
 *
 * Usage:
 *   node scripts/scrape-cvnp-conservancy.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import {
  logUpsertResult, logScraperError, stripHtml, enrichWithImageDimensions, upsertEventSafe,
  linkEventVenue, linkEventOrganization, ensureVenue, linkOrganizationVenue,
  parseCostFromTribe, parseTagsFromTribe, ensureOrganization,
} from './lib/normalize.js'

const BASE_URL   = 'https://www.conservancyforcvnp.org/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180

// ── Category mapping ───────────────────────────────────────────────────────

function parseCategory(categories = [], tags = []) {
  const names = [
    ...categories.map(c => (c.name ?? c.slug ?? '').toLowerCase()),
    ...tags.map(t => (t.name ?? t.slug ?? '').toLowerCase()),
  ]
  if (names.some(n => n.includes('music') || n.includes('concert') || n.includes('performance'))) return 'music'
  if (names.some(n => n.includes('art') || n.includes('photo'))) return 'art'
  if (names.some(n => n.includes('sport') || n.includes('fitness') || n.includes('run') || n.includes('bike') || n.includes('paddle') || n.includes('kayak'))) return 'sports'
  if (names.some(n => n.includes('educat') || n.includes('workshop') || n.includes('program') || n.includes('class'))) return 'education'
  return 'community'
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
    city:          tribeVenue.city ?? 'Peninsula',
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
  const startDate = new Date().toISOString().split('T')[0]
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]

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
  let inserted = 0, skipped = 0

  for (const ev of rawEvents) {
    try {
      const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
      const category = parseCategory(ev.categories, ev.tags)
      const tags     = parseTagsFromTribe(ev.categories, ev.tags, ['national-park', 'cvnp', 'outdoors'])
      const imageUrl = ev.image?.url ?? null
      const descText = stripHtml(ev.description ?? '')

      const venueId = await ensureEventVenue(ev.venue, orgVenueId)

      const row = {
        title:           ev.title,
        description:     descText || null,
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
        status:          'published',
        featured:        ev.featured ?? false,
      }

      if (!row.start_at) { skipped++; continue }

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
      console.warn(`  ⚠ Error processing "${ev.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting CVNP Conservancy ingestion…')
  const start = Date.now()

  try {
    const orgVenueId = await ensureOrgVenue()
    const organizerId = await ensureOrganization('Conservancy for Cuyahoga Valley National Park', {
      website:     'https://www.conservancyforcvnp.org',
      description: 'The Conservancy for Cuyahoga Valley National Park supports, promotes, and enhances Cuyahoga Valley National Park through education, recreation, and stewardship.',
    })

    await linkOrganizationVenue(organizerId, orgVenueId)

    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)

    const { inserted, skipped } = await processEvents(rawEvents, orgVenueId, organizerId)
    await logUpsertResult('cvnp_conservancy', inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('cvnp_conservancy', err, start)
    process.exit(1)
  }
}

main()
