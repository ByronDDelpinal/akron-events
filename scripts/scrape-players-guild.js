/**
 * scrape-players-guild.js
 *
 * Fetches upcoming events from Players Guild Theatre (Canton, OH)
 * via their WordPress / The Events Calendar (Tribe) REST API.
 *
 * Usage:
 *   node scripts/scrape-players-guild.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { logUpsertResult, logScraperError, stripHtml } from './lib/normalize.js'

const BASE_URL   = 'https://playersguildtheatre.com/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 365   // theatre seasons are planned well in advance

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

// ── Venue / Organizer ──────────────────────────────────────────────────────

async function ensureVenue() {
  const { data: existing } = await supabaseAdmin
    .from('venues').select('id').eq('name', 'Players Guild Theatre').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('venues').insert({
    name:          'Players Guild Theatre',
    address:       '1001 Market Ave N',
    city:          'Canton',
    state:         'OH',
    zip:           '44702',
    lat:           40.8020,
    lng:           -81.3764,
    parking_type:  'lot',
    parking_notes: 'Free parking available in adjacent lots.',
    website:       'https://www.playersguildtheatre.com',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create Players Guild venue:', error.message); return null }
  console.log('  ✚ Created venue: Players Guild Theatre')
  return data.id
}

async function ensureOrganizer() {
  const { data: existing } = await supabaseAdmin
    .from('organizers').select('id').eq('name', 'Players Guild Theatre').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('organizers').insert({
    name:        'Players Guild Theatre',
    website:     'https://www.playersguildtheatre.com',
    description: 'Players Guild Theatre is a community theatre in Canton, Ohio, producing live theatre since 1932.',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create Players Guild organizer:', error.message); return null }
  console.log('  ✚ Created Players Guild Theatre organizer')
  return data.id
}

// ── Fetch ──────────────────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = new Date().toISOString().split('T')[0]
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]

  let page    = 1
  let hasMore = true
  const all   = []

  console.log('\n🔍  Fetching Players Guild Theatre events via Tribe REST API…')

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

    if (!res.ok) throw new Error(`Players Guild API error ${res.status}: ${await res.text()}`)

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

async function processEvents(rawEvents, venueId, organizerId) {
  let inserted = 0, skipped = 0

  for (const ev of rawEvents) {
    try {
      const { price_min, price_max } = parseCost(ev.cost, ev.cost_details)
      const imageUrl = ev.image?.url ?? null
      const descText = stripHtml(ev.description ?? '')

      const row = {
        title:           ev.title,
        description:     descText || null,
        start_at:        ev.utc_start_date ? ev.utc_start_date.replace(' ', 'T') + 'Z' : null,
        end_at:          ev.utc_end_date   ? ev.utc_end_date.replace(' ', 'T') + 'Z'   : null,
        venue_id:        venueId,
        organizer_id:    organizerId,
        category:        'art',
        tags:            ['theatre', 'live-theatre', 'canton', 'performance'],
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ev.website || ev.url || null,
        source:          'players_guild',
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
  console.log('🚀  Starting Players Guild Theatre ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([ensureVenue(), ensureOrganizer()])
    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)

    const { inserted, skipped } = await processEvents(rawEvents, venueId, organizerId)
    await logUpsertResult('players_guild', inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('players_guild', err, start)
    process.exit(1)
  }
}

main()
