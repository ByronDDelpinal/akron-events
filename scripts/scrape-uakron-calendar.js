/**
 * scrape-uakron-calendar.js
 *
 * Fetches upcoming events from the University of Akron's LiveWhale calendar API.
 * Splits events into two sources:
 *   - 'ejthomas_hall'    — events from the EJ Thomas Hall group (gid=5)
 *   - 'uakron_calendar'  — all other University of Akron events
 *
 * Usage:
 *   node scripts/scrape-uakron-calendar.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  stripHtml,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue as ensureVenueGeneric,
  ensureOrganization,
} from './lib/normalize.js'

const API_URL   = 'https://calendar.uakron.edu/live/json/events?days=90&user_tz=America/New_York'
const EJ_THOMAS_GROUP = 'EJ Thomas Hall'

// ── Category mapping ───────────────────────────────────────────────────────

function parseCategory(ev) {
  const group  = (ev.group_title ?? '').toLowerCase()
  const types  = (ev.event_types ?? []).map(t => (t.name ?? '').toLowerCase())
  const tags   = ev.tags ? (Array.isArray(ev.tags) ? ev.tags.map(t => (t.name ?? '').toLowerCase()) : []) : []
  const all    = [...types, ...tags, group]

  if (group.includes('ej thomas') || group.includes('performing arts')) return 'art'
  if (group.includes('music') || group.includes('school of music')) return 'music'
  if (group.includes('art') || group.includes('school of art')) return 'art'
  if (all.some(s => s.includes('athletic') || s.includes('sport'))) return 'sports'
  if (all.some(s => s.includes('recreation'))) return 'fitness'
  if (all.some(s => s.includes('lecture') || s.includes('seminar') || s.includes('workshop') || s.includes('class'))) return 'education'
  if (all.some(s => s.includes('performance') || s.includes('recital') || s.includes('concert'))) {
    if (group.includes('music') || group.includes('school of music')) return 'music'
    return 'art'
  }
  return 'education'
}

function parseTags(ev) {
  const group = ev.group_title?.toLowerCase()
  const tags  = ev.tags ? (Array.isArray(ev.tags) ? ev.tags.map(t => t.name?.toLowerCase()).filter(Boolean) : []) : []
  const all   = [...tags, 'university', 'uakron']
  if (group) all.push(group)
  return [...new Set(all)]
}

function parsePrice(costStr) {
  if (!costStr) return 0
  const s = costStr.trim().toLowerCase()
  if (!s || s === 'free' || s === 'no charge') return 0
  const m = s.match(/\d+(\.\d+)?/)
  return m ? parseFloat(m[0]) : 0
}

// ── Venue cache ────────────────────────────────────────────────────────────

const venueCache = new Map()

const KNOWN_VENUES = {
  'E.J. Thomas Performing Arts Hall': {
    address: '198 Hill St', city: 'Akron', state: 'OH', zip: '44325', lat: 41.0756, lng: -81.5113,
    website: 'https://www.ejthomashall.com', parking_type: 'garage',
    parking_notes: 'Parking garages available on campus.',
  },
  'University of Akron': {
    address: '302 Buchtel Common', city: 'Akron', state: 'OH', zip: '44325', lat: 41.0756, lng: -81.5106,
    website: 'https://www.uakron.edu', parking_type: 'garage',
    parking_notes: 'Parking garages available on campus.',
  },
}

async function ensureVenue(locationTitle, lat, lng) {
  const name = locationTitle ?? 'University of Akron'
  if (venueCache.has(name)) return venueCache.get(name)

  const known = KNOWN_VENUES[name]

  let venueId
  if (known) {
    // Known campus venue — use its specific details
    venueId = await ensureVenueGeneric(name, {
      ...known,
      lat: lat ? parseFloat(lat) : known.lat,
      lng: lng ? parseFloat(lng) : known.lng,
    })
  } else {
    // Off-campus / external venue — only pass coords if available
    venueId = await ensureVenueGeneric(name, {
      city:  'Akron',
      state: 'OH',
      lat:   lat ? parseFloat(lat) : null,
      lng:   lng ? parseFloat(lng) : null,
    })
  }

  venueCache.set(name, venueId)
  return venueId
}

async function ensureUakronOrganizer() {
  return ensureOrganization('University of Akron', {
    website:     'https://www.uakron.edu',
    description: 'The University of Akron is a public research university in Akron, Ohio, offering diverse academic programs, performing arts events, and community programming.',
  })
}

// ── Fetch ──────────────────────────────────────────────────────────────────

async function fetchEvents() {
  console.log('\n🔍  Fetching University of Akron events via LiveWhale API…')

  const res = await fetch(API_URL, {
    headers: {
      Accept:       'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; The330-bot/1.0)',
    },
  })

  if (!res.ok) throw new Error(`UAkron LiveWhale API error ${res.status}: ${await res.text()}`)

  const data = await res.json()
  const events = Array.isArray(data) ? data : (data.events ?? [])
  console.log(`  Received ${events.length} events`)
  return events
}

// ── Process ────────────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId) {
  const ejThomasResults  = { inserted: 0, skipped: 0, total: 0 }
  const uakronResults    = { inserted: 0, skipped: 0, total: 0 }

  for (const ev of rawEvents) {
    if (!ev.title || !ev.date_iso) continue

    const isEJThomas = (ev.group_title === EJ_THOMAS_GROUP)
    const source     = isEJThomas ? 'ejthomas_hall' : 'uakron_calendar'
    const results    = isEJThomas ? ejThomasResults : uakronResults
    results.total++

    try {
      // Use date_iso (already has timezone offset) — parse to UTC
      const startAt = ev.date_iso  ? new Date(ev.date_iso).toISOString()  : null
      const endAt   = ev.date2_iso ? new Date(ev.date2_iso).toISOString() : null

      if (!startAt) { results.skipped++; continue }

      const venueId = await ensureVenue(ev.location_title, ev.location_latitude, ev.location_longitude)
      const category = parseCategory(ev)
      const tags     = parseTags(ev)
      const price_min = parsePrice(ev.cost)
      const descText  = stripHtml(ev.description ?? '')
      const imageUrl  = ev.thumbnail ?? null

      const row = {
        title:           ev.title,
        description:     descText || null,
        start_at:        startAt,
        end_at:          endAt,
        category,
        tags,
        price_min,
        price_max:       null,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ev.url ?? null,
        source,
        source_id:       String(ev.id),
        status:          'published',
        featured:        false,
      }

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}" [${source}]:`, error.message)
        results.skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        results.inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${ev.title}":`, err.message)
      results.skipped++
    }
  }

  return { ejThomasResults, uakronResults }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting University of Akron calendar ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureUakronOrganizer()
    const rawEvents   = await fetchEvents()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)

    const { ejThomasResults, uakronResults } = await processEvents(rawEvents, organizerId)
    const durationMs = Date.now() - start

    await logUpsertResult('ejthomas_hall', ejThomasResults.inserted, 0, ejThomasResults.skipped, {
      eventsFound: ejThomasResults.total,
      durationMs,
    })
    await logUpsertResult('uakron_calendar', uakronResults.inserted, 0, uakronResults.skipped, {
      eventsFound: uakronResults.total,
      durationMs,
    })

    console.log(`\n✅  Done in ${(durationMs / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('uakron_calendar', err, start)
    process.exit(1)
  }
}

main()
