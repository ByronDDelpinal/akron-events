/**
 * fetch-ticketmaster.js
 *
 * Pulls upcoming events in the Akron / Summit County area from the
 * Ticketmaster Discovery API and upserts them into the events table.
 *
 * Usage:
 *   node scripts/fetch-ticketmaster.js
 *
 * Required .env vars:
 *   TICKETMASTER_API_KEY      — your Ticketmaster consumer key
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { logUpsertResult, enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization } from './lib/normalize.js'

const TM_KEY = process.env.TICKETMASTER_API_KEY
if (!TM_KEY) {
  console.error('❌  Missing TICKETMASTER_API_KEY in .env')
  process.exit(1)
}

const BASE_URL    = 'https://app.ticketmaster.com/discovery/v2'
const RADIUS_MILES = 25
const DAYS_AHEAD   = 90
const PAGE_SIZE    = 50   // TM max per page

// ── Akron, OH coordinates ──────────────────────────────────────────
const AKRON_LAT = 41.0814
const AKRON_LNG = -81.5190

// ── Ticketmaster segment/genre → our category ─────────────────────
const TM_SEGMENT_MAP = {
  'Music':                'music',
  'Sports':               'sports',
  'Arts & Theatre':       'art',
  'Film':                 'art',
  'Miscellaneous':        'community',
  'Family':               'community',
}

// ── Helpers ───────────────────────────────────────────────────────

async function tm(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`)
  url.searchParams.set('apikey', TM_KEY)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)))

  const res = await fetch(url.toString())

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Ticketmaster API error ${res.status}: ${body}`)
  }

  return res.json()
}

function parsePrice(priceRanges = []) {
  if (!priceRanges.length) return { price_min: null, price_max: null }
  const mins = priceRanges.map(p => p.min).filter(p => p != null)
  const maxs = priceRanges.map(p => p.max).filter(p => p != null)
  // If every range reports 0, it's genuinely free
  const min  = mins.length ? Math.min(...mins) : null
  const max  = maxs.length ? Math.max(...maxs) : null
  return {
    price_min: min,
    price_max: max && max > min ? max : null,
  }
}

function parseCategory(classifications = []) {
  const segment = classifications[0]?.segment?.name
  return TM_SEGMENT_MAP[segment] ?? 'other'
}

function parseTags(classifications = []) {
  const tags = []
  const c = classifications[0]
  if (c?.genre?.name    && c.genre.name    !== 'Undefined') tags.push(c.genre.name.toLowerCase())
  if (c?.subGenre?.name && c.subGenre.name !== 'Undefined') tags.push(c.subGenre.name.toLowerCase())
  return tags
}

// ── Venue upsert ───────────────────────────────────────────────────

async function upsertVenue(tmVenue) {
  if (!tmVenue?.id) return null

  const row = {
    name:         tmVenue.name,
    address:      tmVenue.address?.line1 ?? null,
    city:         tmVenue.city?.name     ?? 'Akron',
    state:        tmVenue.state?.stateCode ?? 'OH',
    zip:          tmVenue.postalCode     ?? null,
    lat:          tmVenue.location?.latitude  ? parseFloat(tmVenue.location.latitude)  : null,
    lng:          tmVenue.location?.longitude ? parseFloat(tmVenue.location.longitude) : null,
    parking_type: 'unknown',
    website:      tmVenue.url ?? null,
  }

  const { data: existing } = await supabaseAdmin
    .from('venues')
    .select('id')
    .eq('name', row.name)
    .eq('city', row.city)
    .maybeSingle()

  if (existing) return existing.id

  const { data, error } = await supabaseAdmin
    .from('venues')
    .insert(row)
    .select('id')
    .single()

  if (error) {
    console.warn(`  ⚠ Could not upsert venue "${row.name}":`, error.message)
    return null
  }

  return data.id
}

// ── Organizer upsert (TM calls these "attractions") ────────────────

async function upsertOrganizer(attractions = []) {
  const attraction = attractions[0]
  if (!attraction?.name) return null

  const row = {
    name:      attraction.name,
    image_url: attraction.images?.find(i => i.ratio === '16_9' && i.width > 500)?.url ?? null,
  }

  const { data: existing } = await supabaseAdmin
    .from('organizations')
    .select('id')
    .eq('name', row.name)
    .maybeSingle()

  if (existing) return existing.id

  const { data, error } = await supabaseAdmin
    .from('organizations')
    .insert(row)
    .select('id')
    .single()

  if (error) {
    console.warn(`  ⚠ Could not upsert organizer "${row.name}":`, error.message)
    return null
  }

  return data.id
}

// ── Main ───────────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDateTime = new Date().toISOString().split('.')[0] + 'Z'
  const endDateTime   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('.')[0] + 'Z'

  let page     = 0
  let hasMore  = true
  const all    = []

  console.log(`\n🔍  Searching Ticketmaster within ${RADIUS_MILES} miles of Akron, OH…`)

  while (hasMore) {
    const data = await tm('/events.json', {
      latlong:           `${AKRON_LAT},${AKRON_LNG}`,
      radius:            RADIUS_MILES,
      unit:              'miles',
      countryCode:       'US',
      startDateTime,
      endDateTime,
      size:              PAGE_SIZE,
      page,
      sort:              'date,asc',
    })

    const events = data._embedded?.events ?? []
    all.push(...events)

    const totalPages = data.page?.totalPages ?? 1
    console.log(`  Page ${page + 1}/${totalPages}: ${events.length} events (total: ${all.length})`)

    hasMore = page + 1 < totalPages
    page++

    if (hasMore) await new Promise(r => setTimeout(r, 200))
  }

  return all
}

async function processEvents(rawEvents) {
  let inserted = 0
  let skipped  = 0

  for (const ev of rawEvents) {
    try {
      const venue     = ev._embedded?.venues?.[0]
      const venueId   = await upsertVenue(venue)
      const orgId     = await upsertOrganizer(ev._embedded?.attractions)

      const { price_min, price_max } = parsePrice(ev.priceRanges)
      const category = parseCategory(ev.classifications)
      const tags     = parseTags(ev.classifications)

      // Best available image (prefer 16:9 at reasonable size)
      const image = ev.images
        ?.filter(i => i.ratio === '16_9')
        ?.sort((a, b) => b.width - a.width)[0]?.url ?? null

      const row = {
        title:           ev.name,
        description:     ev.info ?? ev.pleaseNote ?? null,
        start_at:        ev.dates?.start?.dateTime ?? null,
        end_at:          null,   // TM rarely provides end times
        category,
        tags,
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       image,
        ticket_url:      ev.url ?? null,
        source:          'ticketmaster',
        source_id:       String(ev.id),
        status:          'published',
        featured:        false,
      }

      if (!row.start_at) { skipped++; continue }

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, orgId)
        inserted++
      }

    } catch (err) {
      console.warn(`  ⚠ Error processing "${ev.name}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

async function main() {
  console.log('🚀  Starting Ticketmaster ingestion…')
  const start = Date.now()

  try {
    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)

    const { inserted, skipped } = await processEvents(rawEvents)
    logUpsertResult('ticketmaster', inserted, 0, skipped)

    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    console.error('\n❌  Fatal error:', err.message)
    process.exit(1)
  }
}

main()
