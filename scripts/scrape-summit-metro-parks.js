/**
 * scrape-summit-metro-parks.js
 *
 * Fetches upcoming events from Summit Metro Parks via their
 * WordPress / The Events Calendar (Tribe) REST API.
 *
 * Usage:
 *   node scripts/scrape-summit-metro-parks.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { logUpsertResult, logScraperError, stripHtml } from './lib/normalize.js'

const BASE_URL   = 'https://www.summitmetroparks.org/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180

// ── Category mapping ───────────────────────────────────────────────────────

function parseCategory(categories = [], tags = []) {
  const names = [
    ...categories.map(c => (c.name ?? c.slug ?? '').toLowerCase()),
    ...tags.map(t => (t.name ?? t.slug ?? '').toLowerCase()),
  ]
  if (names.some(n => n.includes('music') || n.includes('concert'))) return 'music'
  if (names.some(n => n.includes('sport') || n.includes('fitness') || n.includes('run') || n.includes('bike') || n.includes('paddle'))) return 'sports'
  if (names.some(n => n.includes('educat') || n.includes('program') || n.includes('class') || n.includes('workshop') || n.includes('learn'))) return 'education'
  return 'community'
}

function parseTags(categories = [], tags = []) {
  const all = [
    ...categories.map(c => c.name?.toLowerCase()).filter(Boolean),
    ...tags.map(t => t.name?.toLowerCase()).filter(Boolean),
    'parks', 'outdoors', 'nature',
  ]
  return [...new Set(all)]
}

function parseCost(cost = '', costDetails = {}) {
  const values = costDetails.values ?? []
  if (values.length) {
    const nums = values.map(Number).filter(n => !isNaN(n))
    if (nums.length) {
      const min = Math.min(...nums)
      const max = Math.max(...nums)
      return { price_min: min, price_max: max > min ? max : null }
    }
  }
  if (!cost || cost.toLowerCase().includes('free')) return { price_min: 0, price_max: null }
  const numbers = cost.match(/\d+(\.\d+)?/g)?.map(Number)
  if (!numbers?.length) return { price_min: 0, price_max: null }
  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  return { price_min: min, price_max: max > min ? max : null }
}

// ── Venue cache ────────────────────────────────────────────────────────────

const venueCache = new Map()

async function ensureOrgVenue() {
  if (venueCache.has('__org__')) return venueCache.get('__org__')

  const { data: existing } = await supabaseAdmin
    .from('venues').select('id').eq('name', 'Summit Metro Parks').maybeSingle()

  if (existing) { venueCache.set('__org__', existing.id); return existing.id }

  const { data, error } = await supabaseAdmin.from('venues').insert({
    name:          'Summit Metro Parks',
    address:       '975 Treaty Line Rd',
    city:          'Akron',
    state:         'OH',
    zip:           '44313',
    lat:           41.1567,
    lng:           -81.5940,
    parking_type:  'lot',
    parking_notes: 'Free parking available at most park trailheads.',
    website:       'https://www.summitmetroparks.org',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create Summit Metro Parks venue:', error.message); venueCache.set('__org__', null); return null }
  console.log('  ✚ Created venue: Summit Metro Parks')
  venueCache.set('__org__', data.id)
  return data.id
}

async function ensureEventVenue(tribeVenue, orgVenueId) {
  if (!tribeVenue?.venue) return orgVenueId

  const name = tribeVenue.venue.trim()
  if (!name) return orgVenueId
  if (venueCache.has(name)) return venueCache.get(name)

  const { data: existing } = await supabaseAdmin
    .from('venues').select('id').eq('name', name).maybeSingle()

  if (existing) { venueCache.set(name, existing.id); return existing.id }

  const { data, error } = await supabaseAdmin.from('venues').insert({
    name,
    address:      tribeVenue.address ?? null,
    city:         tribeVenue.city ?? 'Akron',
    state:        tribeVenue.stateprovince ?? 'OH',
    zip:          tribeVenue.zip ?? null,
    lat:          tribeVenue.geo_lat ? parseFloat(tribeVenue.geo_lat) : null,
    lng:          tribeVenue.geo_lng ? parseFloat(tribeVenue.geo_lng) : null,
    parking_type: 'lot',
    parking_notes:'Free parking available at most park trailheads.',
    website:      tribeVenue.website ?? 'https://www.summitmetroparks.org',
  }).select('id').single()

  if (error) { console.warn(`  ⚠ Could not create venue "${name}":`, error.message); venueCache.set(name, orgVenueId); return orgVenueId }
  console.log(`  ✚ Created venue: ${name}`)
  venueCache.set(name, data.id)
  return data.id
}

async function ensureOrganizer() {
  const { data: existing } = await supabaseAdmin
    .from('organizers').select('id').eq('name', 'Summit Metro Parks').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('organizers').insert({
    name:        'Summit Metro Parks',
    website:     'https://www.summitmetroparks.org',
    description: 'Summit Metro Parks is a system of parks and green spaces serving Summit County, Ohio, offering trails, nature programs, and outdoor recreation.',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create Summit Metro Parks organizer:', error.message); return null }
  console.log('  ✚ Created Summit Metro Parks organizer')
  return data.id
}

// ── Fetch ──────────────────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = new Date().toISOString().split('T')[0]
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]

  let page    = 1
  let hasMore = true
  const all   = []

  console.log('\n🔍  Fetching Summit Metro Parks events via Tribe REST API…')

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

    if (!res.ok) throw new Error(`Summit Metro Parks API error ${res.status}: ${await res.text()}`)

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
      const { price_min, price_max } = parseCost(ev.cost, ev.cost_details)
      const category = parseCategory(ev.categories, ev.tags)
      const tags     = parseTags(ev.categories, ev.tags)
      const imageUrl = ev.image?.url ?? null
      const descText = stripHtml(ev.description ?? '')

      const venueId = await ensureEventVenue(ev.venue, orgVenueId)

      const row = {
        title:           ev.title,
        description:     descText || null,
        start_at:        ev.utc_start_date ? ev.utc_start_date.replace(' ', 'T') + 'Z' : null,
        end_at:          ev.utc_end_date   ? ev.utc_end_date.replace(' ', 'T') + 'Z'   : null,
        venue_id:        venueId,
        organizer_id:    organizerId,
        category,
        tags,
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ev.website || ev.url || null,
        source:          'summit_metro_parks',
        source_id:       String(ev.id),
        status:          'published',
        featured:        ev.featured ?? false,
      }

      if (!row.start_at) { skipped++; continue }

      const { error } = await supabaseAdmin
        .from('events')
        .upsert(row, { onConflict: 'source,source_id', ignoreDuplicates: false })

      if (error) { console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message); skipped++ }
      else inserted++
    } catch (err) {
      console.warn(`  ⚠ Error processing "${ev.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Summit Metro Parks ingestion…')
  const start = Date.now()

  try {
    const [orgVenueId, organizerId] = await Promise.all([ensureOrgVenue(), ensureOrganizer()])
    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)

    const { inserted, skipped } = await processEvents(rawEvents, orgVenueId, organizerId)
    await logUpsertResult('summit_metro_parks', inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('summit_metro_parks', err, start)
    process.exit(1)
  }
}

main()
