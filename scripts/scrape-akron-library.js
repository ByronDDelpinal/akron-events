/**
 * scrape-akron-library.js
 *
 * Fetches upcoming events from the Akron-Summit County Public Library
 * via their internal Communico/Libnet event API — no auth required.
 *
 * Usage:
 *   node scripts/scrape-akron-library.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { logUpsertResult, logScraperError } from './lib/normalize.js'

const API_BASE   = 'https://services.akronlibrary.org/eeventcaldata'
const DAYS_AHEAD = 180  // fetch 6 months at a time

// ── Known branch library addresses ───────────────────────────────────────
// Used to pre-populate venue records. Branches not listed here get name-only records.
const BRANCH_INFO = {
  'Main Library':                     { address: '60 S High St',            zip: '44326', lat: 41.0819, lng: -81.5188, parking_type: 'garage',  parking_notes: 'Parking garage adjacent to building on S High St.' },
  'Highland Square Branch Library':   { address: '807 W Market St',         zip: '44303', lat: 41.0808, lng: -81.5468, parking_type: 'lot',     parking_notes: 'Free surface lot behind building.' },
  'Kenmore Branch Library':           { address: '969 Kenmore Blvd',        zip: '44314', lat: 41.0510, lng: -81.5355, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Firestone Park Branch Library':    { address: '1486 Aster Ave',          zip: '44301', lat: 41.0450, lng: -81.5093, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Ellet Branch Library':             { address: '2470 E Market St',        zip: '44312', lat: 41.0808, lng: -81.4706, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'North Hill Branch Library':        { address: '183 E Cuyahoga Falls Ave', zip: '44310', lat: 41.1108, lng: -81.5143, parking_type: 'lot',    parking_notes: 'Free on-site parking lot.' },
  'Green Branch Library':             { address: '4046 Massillon Rd',       zip: '44232', lat: 40.9478, lng: -81.4696, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Goodyear Branch Library':          { address: '60 Goodyear Blvd',        zip: '44305', lat: 41.0680, lng: -81.4870, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Northwest Akron Branch Library':   { address: '1720 Shatto Ave',         zip: '44313', lat: 41.1065, lng: -81.5665, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Fairlawn-Bath Branch Library':     { address: '3490 W Market St',        zip: '44333', lat: 41.1353, lng: -81.5927, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Portage Lakes Branch Library':     { address: '4261 Shriver Rd',         zip: '44319', lat: 40.9987, lng: -81.5346, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Mogadore Branch Library':          { address: '144 S Cleveland Ave',      zip: '44260', lat: 41.0593, lng: -81.4018, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Maple Valley Branch Library':      { address: '1187 Mogadore Rd',        zip: '44306', lat: 41.0588, lng: -81.4625, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Richfield Branch Library':         { address: '3761 S Park Dr',          zip: '44286', lat: 41.2304, lng: -81.6412, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Nordonia Hills Branch Library':    { address: '70 Olde Eight Rd',        zip: '44067', lat: 41.2112, lng: -81.5107, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Norton Branch Library':            { address: '3930 S Cleveland-Massillon Rd', zip: '44203', lat: 40.9892, lng: -81.6395, parking_type: 'lot', parking_notes: 'Free on-site parking lot.' },
  'Springfield-Lakemore Branch Library': { address: '1100 Canton Rd',       zip: '44312', lat: 41.0169, lng: -81.4632, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Tallmadge Branch Library':         { address: '90 North Ave',            zip: '44278', lat: 41.0992, lng: -81.4426, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
  'Odom Boulevard Branch Library':    { address: '600 Vernon Odom Blvd',    zip: '44307', lat: 41.0631, lng: -81.5372, parking_type: 'lot',     parking_notes: 'Free on-site parking lot.' },
}

// ── Time conversion ───────────────────────────────────────────────────────

/** Get the nth occurrence of dayOfWeek (0=Sun) in a given month */
function nthWeekdayOfMonth(year, month, dayOfWeek, n) {
  const first = new Date(Date.UTC(year, month, 1))
  const offset = (dayOfWeek - first.getUTCDay() + 7) % 7
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7))
}

/** Returns true if the given UTC date is during Eastern Daylight Time */
function isEasternDST(utcDate) {
  const y = utcDate.getUTCFullYear()
  const dstStart = nthWeekdayOfMonth(y, 2, 0, 2)  // 2nd Sunday in March
  const dstEnd   = nthWeekdayOfMonth(y, 10, 0, 1) // 1st Sunday in November
  return utcDate >= dstStart && utcDate < dstEnd
}

/**
 * Convert an Eastern local time string ("YYYY-MM-DD HH:MM:SS") to ISO UTC.
 * Correctly handles EST (UTC-5) vs EDT (UTC-4) transitions.
 */
function easternToIso(localDateStr) {
  if (!localDateStr) return null
  const [datePart, timePart = '00:00:00'] = localDateStr.split(' ')
  const [year, month, day]        = datePart.split('-').map(Number)
  const [hour, minute, second = 0] = timePart.split(':').map(Number)
  const localUtcMs = Date.UTC(year, month - 1, day, hour, minute, second)
  // Start by checking with the EST offset; close enough to determine DST
  const approxUtc = new Date(localUtcMs + 5 * 3600_000)
  const offsetHours = isEasternDST(approxUtc) ? 4 : 5
  return new Date(localUtcMs + offsetHours * 3600_000).toISOString()
}

// ── Category mapping ──────────────────────────────────────────────────────

const LIBRARY_CATEGORY_MAP = {
  'arts & crafts':        'art',
  'art':                  'art',
  'music':                'music',
  'concert':              'music',
  'performance':          'music',
  'film':                 'art',
  'movie':                'art',
  'storytime':            'community',
  'story time':           'community',
  'games & gaming':       'community',
  'gaming':               'community',
  'book':                 'education',
  'book sale':            'community',
  'education':            'education',
  'computer':             'education',
  'technology':           'education',
  'stem':                 'education',
  'science':              'education',
  'financial':            'education',
  'job':                  'education',
  'career':               'education',
  'health':               'community',
  'wellness':             'community',
  'yoga':                 'community',
  'fitness':              'sports',
  'volunteer':            'nonprofit',
  'fundrais':             'nonprofit',
  'nonprofit':            'nonprofit',
  'family':               'community',
  'kids':                 'community',
  'teen':                 'community',
  'senior':               'community',
  'community':            'community',
  'food':                 'food',
  'cooking':              'food',
}

function parseCategory(tagStr = '', title = '') {
  const combined = (tagStr + ' ' + title).toLowerCase()
  for (const [keyword, cat] of Object.entries(LIBRARY_CATEGORY_MAP)) {
    if (combined.includes(keyword)) return cat
  }
  return 'community' // Library default
}

function parseTags(tagStr = '', ageStr = '') {
  const tags = []
  if (tagStr) tags.push(...tagStr.toLowerCase().split(',').map(t => t.trim()).filter(Boolean))
  if (ageStr) {
    const ages = ageStr.toLowerCase().split(',').map(a => a.trim()).filter(Boolean)
    for (const age of ages) {
      if (age.includes('baby') || age.includes('toddler') || age.includes('preschool')) tags.push('kids')
      if (age.includes('teen') || age.includes('tween')) tags.push('teens')
      if (age.includes('adult')) tags.push('adults')
      if (age.includes('senior') || age.includes('older')) tags.push('seniors')
    }
  }
  tags.push('free', 'library')
  return [...new Set(tags)]
}

// ── Venue management ──────────────────────────────────────────────────────

const venueCache = new Map() // locationId → venueId

async function ensureLibraryVenue(locationId, locationName) {
  if (venueCache.has(locationId)) return venueCache.get(locationId)

  const { data: existing } = await supabaseAdmin
    .from('venues').select('id').eq('name', locationName).maybeSingle()

  if (existing) {
    venueCache.set(locationId, existing.id)
    return existing.id
  }

  const info = BRANCH_INFO[locationName] ?? {}
  const { data, error } = await supabaseAdmin.from('venues').insert({
    name:         locationName,
    address:      info.address ?? null,
    city:         'Akron',
    state:        'OH',
    zip:          info.zip ?? null,
    lat:          info.lat ?? null,
    lng:          info.lng ?? null,
    parking_type: info.parking_type ?? 'lot',
    parking_notes:info.parking_notes ?? 'Free on-site parking available.',
    website:      'https://www.akronlibrary.org',
    description:  `Branch of the Akron-Summit County Public Library.`,
  }).select('id').single()

  if (error) {
    console.warn(`  ⚠ Could not create venue for "${locationName}":`, error.message)
    venueCache.set(locationId, null)
    return null
  }

  console.log(`  ✚ Created venue: ${locationName}`)
  venueCache.set(locationId, data.id)
  return data.id
}

async function ensureOrganizer() {
  const { data: existing } = await supabaseAdmin
    .from('organizers').select('id').eq('name', 'Akron-Summit County Public Library').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('organizers').insert({
    name:        'Akron-Summit County Public Library',
    website:     'https://www.akronlibrary.org',
    description: 'The Akron-Summit County Public Library provides resources for learning, programs for all ages, and events that enrich community life across Summit County.',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create library organizer:', error.message); return null }
  console.log('  ✚ Created library organizer')
  return data.id
}

// ── Fetch ─────────────────────────────────────────────────────────────────

async function fetchEvents() {
  const startDate = new Date().toISOString().split('T')[0]
  console.log(`\n🔍  Fetching library events for next ${DAYS_AHEAD} days…`)

  const req = JSON.stringify({
    private:   false,
    date:      startDate,
    days:      DAYS_AHEAD,
    locations: [],
    ages:      [],
    types:     [],
  })

  const url = `${API_BASE}?event_type=0&req=${encodeURIComponent(req)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Library API error ${res.status}: ${await res.text()}`)

  const data = await res.json()
  console.log(`  Received ${data.length} events`)
  return data
}

// ── Process ───────────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId) {
  let inserted = 0, skipped = 0

  for (const ev of rawEvents) {
    try {
      const venueId = await ensureLibraryVenue(ev.location_id, ev.location || 'Akron-Summit County Public Library')

      const category = parseCategory(ev.tags, ev.title)
      const tags     = parseTags(ev.tags, ev.age)
      const startAt  = easternToIso(ev.raw_start_time)
      const endAt    = easternToIso(ev.raw_end_time)
      const descText = (ev.long_description || ev.description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

      if (!startAt) { skipped++; continue }

      const row = {
        title:           ev.title,
        description:     descText || null,
        start_at:        startAt,
        end_at:          endAt,
        venue_id:        venueId,
        organizer_id:    organizerId,
        category,
        tags,
        price_min:       0,
        price_max:       null,
        age_restriction: 'not_specified',
        image_url:       null,   // image filenames only — no reliable base URL
        ticket_url:      ev.url || null,
        source:          'akron_library',
        source_id:       String(ev.id),
        status:          'published',
        featured:        false,
      }

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

// ── Entry point ───────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Akron-Summit County Library ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganizer()
    const rawEvents   = await fetchEvents()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skipped } = await processEvents(rawEvents, organizerId)
    await logUpsertResult('akron_library', inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('akron_library', err, start)
    process.exit(1)
  }
}

main()
