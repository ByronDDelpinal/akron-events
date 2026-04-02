/**
 * fetch-eventbrite.js
 *
 * Pulls upcoming events in the Akron / Summit County area from the
 * Eventbrite API and upserts them into the events table.
 *
 * Usage:
 *   node scripts/fetch-eventbrite.js
 *
 * Required .env vars:
 *   EVENTBRITE_API_KEY        — your Eventbrite private token
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { EVENTBRITE_CATEGORY_MAP, parseEventbritePrice, logUpsertResult, logScraperError, stripHtml, enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization } from './lib/normalize.js'

const EVENTBRITE_TOKEN = process.env.EVENTBRITE_API_KEY
if (!EVENTBRITE_TOKEN) {
  console.error('❌  Missing EVENTBRITE_API_KEY in .env')
  process.exit(1)
}

const BASE_URL     = 'https://www.eventbriteapi.com/v3'
const SEARCH_RADIUS = '40km'   // ~25 miles — covers greater Akron / Summit County
const DAYS_AHEAD    = 90       // pull events up to 90 days out
const PAGE_SIZE     = 50       // max Eventbrite allows per page

// ── Akron, OH coordinates ──────────────────────────────────────────
const AKRON_LAT = 41.0814
const AKRON_LNG = -81.5190

// ── Helpers ───────────────────────────────────────────────────────

// Attach status to errors so the caller can distinguish auth failures
// (which should surface as "blocked" rather than crashes) from genuine bugs.
class EventbriteApiError extends Error {
  constructor(status, body) {
    super(`Eventbrite API error ${status}: ${body}`)
    this.status = status
  }
}

async function eb(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${EVENTBRITE_TOKEN}` },
  })

  if (!res.ok) {
    const body = await res.text()
    throw new EventbriteApiError(res.status, body)
  }

  return res.json()
}

// ── Venue upsert ───────────────────────────────────────────────────

async function upsertVenue(ebVenue) {
  if (!ebVenue?.id) return null

  const row = {
    name:         ebVenue.name,
    address:      ebVenue.address?.address_1 ?? null,
    city:         ebVenue.address?.city ?? 'Akron',
    state:        ebVenue.address?.region ?? 'OH',
    zip:          ebVenue.address?.postal_code ?? null,
    lat:          ebVenue.latitude  ? parseFloat(ebVenue.latitude)  : null,
    lng:          ebVenue.longitude ? parseFloat(ebVenue.longitude) : null,
    parking_type: 'unknown',
  }

  // Use name + city as natural key since Eventbrite venue IDs aren't stable across events
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

// ── Organizer upsert ───────────────────────────────────────────────

async function upsertOrganizer(ebOrganizer) {
  if (!ebOrganizer?.id) return null

  const row = {
    name:        ebOrganizer.name,
    website:     ebOrganizer.website ?? null,
    description: ebOrganizer.description?.text ?? null,
    image_url:   ebOrganizer.logo?.url ?? null,
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
  const startDate = new Date().toISOString()
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString()

  let page       = 1
  let hasMore    = true
  const allEvents = []

  console.log(`\n🔍  Searching Eventbrite within ${SEARCH_RADIUS} of Akron, OH…`)

  while (hasMore) {
    const data = await eb('/events/search/', {
      'location.latitude':        AKRON_LAT,
      'location.longitude':       AKRON_LNG,
      'location.within':          SEARCH_RADIUS,
      'start_date.range_start':   startDate,
      'start_date.range_end':     endDate,
      'expand':                   'venue,organizer,ticket_classes,logo',
      'status':                   'live',
      'page_size':                PAGE_SIZE,
      'page':                     page,
    })

    const events = data.events ?? []
    allEvents.push(...events)

    console.log(`  Page ${page}: ${events.length} events (total so far: ${allEvents.length})`)

    hasMore = data.pagination?.has_more_items ?? false
    page++

    // Polite rate limiting — Eventbrite allows ~1000 req/hour on free tier
    if (hasMore) await new Promise(r => setTimeout(r, 300))
  }

  return allEvents
}

async function processEvents(rawEvents) {
  let inserted = 0
  let updated  = 0
  let skipped  = 0

  for (const ev of rawEvents) {
    try {
      // ── Venue + organizer ──────────────────────────────────────
      const venueId     = await upsertVenue(ev.venue)
      const organizerId = await upsertOrganizer(ev.organizer)

      // ── Pricing ────────────────────────────────────────────────
      const { price_min, price_max } = parseEventbritePrice(
        ev.ticket_classes,
        ev.is_free
      )

      // ── Category ───────────────────────────────────────────────
      const category = EVENTBRITE_CATEGORY_MAP[ev.category_id] ?? 'other'

      // ── Build event row ────────────────────────────────────────
      const row = {
        title:           stripHtml(ev.name?.text ?? 'Untitled Event'),
        description:     ev.description?.text ? stripHtml(ev.description.text) : null,
        start_at:        ev.start?.utc ?? null,
        end_at:          ev.end?.utc   ?? null,
        category,
        tags:            [],   // Eventbrite tags aren't reliable; we rely on category
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       ev.logo?.url ?? null,
        ticket_url:      ev.url ?? null,
        source:          'eventbrite',
        source_id:       String(ev.id),
        status:          'published',   // Eventbrite events are live, trust them directly
        featured:        false,
      }

      if (!row.start_at) { skipped++; continue }

      // ── Upsert (insert or update on source+source_id conflict) ─
      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        // We can't easily tell insert vs update from upsert, so count as inserted
        inserted++
      }

    } catch (err) {
      console.warn(`  ⚠ Error processing event "${ev.name?.text}":`, err.message)
      skipped++
    }
  }

  return { inserted, updated, skipped }
}

// ── Entry point ────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Eventbrite ingestion…')
  const start = Date.now()

  try {
    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)

    const { inserted, updated, skipped } = await processEvents(rawEvents)
    await logUpsertResult('eventbrite', inserted, updated, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })

    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    console.log(`\n✅  Done in ${elapsed}s`)
  } catch (err) {
    // 401 / 403 = auth or permissions problem — log as blocked, don't crash scrape:all
    if (err instanceof EventbriteApiError && (err.status === 401 || err.status === 403)) {
      console.warn(`\n⚠  Eventbrite access denied (${err.status}) — API key may need expanded permissions.`)
      console.warn('   Apply at: https://www.eventbrite.com/platform/api')
      await logUpsertResult('eventbrite', 0, 0, 0, {
        status:       'error',
        errorMessage: err.message,
        durationMs:   Date.now() - start,
        eventsFound:  0,
      })
      process.exit(0)  // exit 0 so scrape:all continues to next scraper
    }

    await logScraperError('eventbrite', err, start)
    process.exit(1)
  }
}

main()
