/**
 * scrape-akron-civic.js
 *
 * Scrapes upcoming shows from Akron Civic Theatre's "View All Shows" page.
 * Akron Civic uses Bolt CMS with a structured text listing of shows.
 *
 * Usage:
 *   node scripts/scrape-akron-civic.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { logUpsertResult, logScraperError, stripHtml } from './lib/normalize.js'

const SOURCE_URL = 'https://www.akroncivic.com/view-all-shows'

// ── DST-aware Eastern → UTC ────────────────────────────────────────────────

function nthWeekdayOfMonth(year, month, dayOfWeek, n) {
  const first  = new Date(Date.UTC(year, month, 1))
  const offset = (dayOfWeek - first.getUTCDay() + 7) % 7
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7))
}
function isEasternDST(utcDate) {
  const y        = utcDate.getUTCFullYear()
  const dstStart = nthWeekdayOfMonth(y, 2, 0, 2)
  const dstEnd   = nthWeekdayOfMonth(y, 10, 0, 1)
  return utcDate >= dstStart && utcDate < dstEnd
}
function easternToIso(dateStr, timeStr = '19:30:00') {
  if (!dateStr) return null
  // timeStr can be "7:30 PM", "19:30", "19:30:00"
  const normalised = timeStr.trim().replace(
    /^(\d{1,2}):(\d{2})\s*(am|pm)$/i,
    (_, h, m, mer) => {
      let hr = parseInt(h, 10)
      if (mer.toLowerCase() === 'pm' && hr !== 12) hr += 12
      if (mer.toLowerCase() === 'am' && hr === 12) hr = 0
      return `${String(hr).padStart(2, '0')}:${m}:00`
    }
  )
  const [datePart] = dateStr.split('T')
  const [year, month, day] = datePart.split('-').map(Number)
  const [hour, minute, second = 0] = normalised.split(':').map(Number)
  const localUtcMs   = Date.UTC(year, month - 1, day, hour, minute, second)
  const approxUtc    = new Date(localUtcMs + 5 * 3600_000)
  const offsetHours  = isEasternDST(approxUtc) ? 4 : 5
  return new Date(localUtcMs + offsetHours * 3600_000).toISOString()
}

// ── Helpers ────────────────────────────────────────────────────────────────

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

/**
 * Parse a date string like:
 *   "March 22 - April 12, 2026"  → start "2026-03-22"
 *   "Thursday, April 3, 2026"    → "2026-04-03"
 *   "March 22 - 29"              → start "2026-03-22" (year inferred)
 * Returns the start date as "YYYY-MM-DD" or null.
 */
function parseDateString(raw) {
  if (!raw) return null
  const s = raw.trim()

  // Strip leading day-of-week
  const stripped = s.replace(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s*/i, '')

  // Pattern: "Month DD - Month DD, YYYY" or "Month DD, YYYY"
  const fullRangeMatch = stripped.match(
    /^([A-Za-z]+)\s+(\d{1,2})\s*[-–]\s*(?:[A-Za-z]+\s+)?(\d{1,2}),?\s*(\d{4})/
  )
  if (fullRangeMatch) {
    const [, mon, day, , year] = fullRangeMatch
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) return `${year}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`
  }

  // Pattern: "Month DD, YYYY"
  const singleDateMatch = stripped.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})/)
  if (singleDateMatch) {
    const [, mon, day, year] = singleDateMatch
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) return `${year}-${String(m).padStart(2,'0')}-${String(parseInt(day)).padStart(2,'0')}`
  }

  // Pattern: "Month DD - DD" (no year — infer)
  const shortRangeMatch = stripped.match(/^([A-Za-z]+)\s+(\d{1,2})\s*[-–]\s*(\d{1,2})$/)
  if (shortRangeMatch) {
    const [, mon, day] = shortRangeMatch
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) {
      const year = new Date().getFullYear()
      return `${year}-${String(m).padStart(2,'0')}-${String(parseInt(day)).padStart(2,'0')}`
    }
  }

  // Pattern: "Month DD - Month DD" (no year)
  const crossMonthMatch = stripped.match(/^([A-Za-z]+)\s+(\d{1,2})\s*[-–]\s*([A-Za-z]+)\s+(\d{1,2})$/)
  if (crossMonthMatch) {
    const [, mon, day] = crossMonthMatch
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) {
      const year = new Date().getFullYear()
      return `${year}-${String(m).padStart(2,'0')}-${String(parseInt(day)).padStart(2,'0')}`
    }
  }

  return null
}

/** Slug-based source_id */
function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** Derive tags from show title keywords */
function deriveTags(title) {
  const lower = title.toLowerCase()
  const tags  = ['theatre', 'live-performance', 'downtown-akron']
  if (lower.includes('musical') || lower.includes(' music')) tags.push('musical')
  if (lower.includes('comedy') || lower.includes('laugh')) tags.push('comedy')
  if (lower.includes('symphony') || lower.includes('orchestra') || lower.includes('classical')) tags.push('classical')
  if (lower.includes('ballet') || lower.includes('dance')) tags.push('dance')
  return tags
}

// ── Known sub-venues at Akron Civic ───────────────────────────────────────

const CIVIC_VENUES = {
  'akron civic theatre': {
    address: '182 S Main St', city: 'Akron', state: 'OH', zip: '44308',
    lat: 41.0802, lng: -81.5193, parking_type: 'garage',
    parking_notes: 'Parking available in nearby city garages on Main St.',
  },
  'the knight stage': {
    address: '182 S Main St', city: 'Akron', state: 'OH', zip: '44308',
    lat: 41.0802, lng: -81.5193, parking_type: 'garage',
    parking_notes: 'Parking available in nearby city garages on Main St.',
  },
  "wild oscar's": {
    address: '182 S Main St', city: 'Akron', state: 'OH', zip: '44308',
    lat: 41.0802, lng: -81.5193, parking_type: 'garage',
    parking_notes: 'Parking available in nearby city garages on Main St.',
  },
  'pnc plaza': {
    address: '182 S Main St', city: 'Akron', state: 'OH', zip: '44308',
    lat: 41.0802, lng: -81.5193, parking_type: 'garage',
    parking_notes: 'Parking available in nearby city garages on Main St.',
  },
}

const venueCache = new Map()

async function ensureVenue(venueName) {
  const key = (venueName ?? 'Akron Civic Theatre').toLowerCase().trim()
  if (venueCache.has(key)) return venueCache.get(key)

  const displayName = venueName ?? 'Akron Civic Theatre'

  const { data: existing } = await supabaseAdmin
    .from('venues').select('id').eq('name', displayName).maybeSingle()

  if (existing) { venueCache.set(key, existing.id); return existing.id }

  const info = CIVIC_VENUES[key] ?? CIVIC_VENUES['akron civic theatre']
  const { data, error } = await supabaseAdmin.from('venues').insert({
    name:          displayName,
    address:       info.address,
    city:          info.city,
    state:         info.state,
    zip:           info.zip,
    lat:           info.lat,
    lng:           info.lng,
    parking_type:  info.parking_type,
    parking_notes: info.parking_notes,
    website:       'https://www.akroncivic.com',
  }).select('id').single()

  if (error) {
    console.warn(`  ⚠ Could not create venue "${displayName}":`, error.message)
    venueCache.set(key, null)
    return null
  }
  console.log(`  ✚ Created venue: ${displayName}`)
  venueCache.set(key, data.id)
  return data.id
}

async function ensureOrganizer() {
  const { data: existing } = await supabaseAdmin
    .from('organizers').select('id').eq('name', 'Akron Civic Theatre').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('organizers').insert({
    name:        'Akron Civic Theatre',
    website:     'https://www.akroncivic.com',
    description: 'Akron Civic Theatre is a historic performing arts venue in downtown Akron presenting Broadway touring productions, concerts, comedy, and local performances.',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create Akron Civic organizer:', error.message); return null }
  console.log('  ✚ Created Akron Civic Theatre organizer')
  return data.id
}

// ── HTML fetch ─────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronEventsBot/1.0)',
      'Accept':     'text/html,application/xhtml+xml',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Parse shows ────────────────────────────────────────────────────────────

/**
 * The Bolt CMS page at /view-all-shows has a predictable 3-line structure
 * within each show block:
 *   1) Venue name
 *   2) Date range / single date
 *   3) Show title
 *
 * We try multiple extraction strategies for resilience.
 */
function parseShows(html) {
  const shows = []

  // Strategy 1: Look for <article> or <div> elements with class patterns
  // Extract date patterns and surrounding context
  const datePattern = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/gi

  // Strategy 2: Extract main text and parse blocks
  // Remove scripts/styles
  const cleanHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')

  // Try to isolate the main content area
  const mainMatch = cleanHtml.match(/<main[\s\S]*?<\/main>/i) ??
                    cleanHtml.match(/<div[^>]*class="[^"]*content[^"]*"[\s\S]*?<\/div>/i) ??
                    [cleanHtml]

  const mainHtml = mainMatch[0] ?? cleanHtml

  // Strip all HTML tags to get the text content
  const rawText = stripHtml(mainHtml)

  // Split into lines and clean up
  const lines = rawText
    .split(/\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0)

  // Find all date lines
  const seen = new Set()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Check if this line is a date-like string
    const isDate = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d/i.test(line)
    if (!isDate) continue

    const dateStr = parseDateString(line)
    if (!dateStr) continue

    // Look backward for a venue name (typically 1 line before date)
    const venueLine = i > 0 ? lines[i - 1] : ''
    const knownVenueKeys = Object.keys(CIVIC_VENUES)
    const isVenue = knownVenueKeys.some(k => venueLine.toLowerCase().includes(k)) ||
                    /civic|knight|oscar|plaza/i.test(venueLine)
    const venueName = isVenue ? venueLine : 'Akron Civic Theatre'

    // Look forward for the show title (typically 1 line after date)
    const titleLine = lines[i + 1] ?? ''
    if (!titleLine || titleLine.length < 3) continue

    // Skip if title looks like another date or a navigation item
    if (/^\d{4}$/.test(titleLine)) continue
    if (/^(January|February|March|April|May|June|July|August|September|October|November|December)/i.test(titleLine)) continue

    // Skip past show dates
    const now = new Date()
    const showDate = new Date(dateStr + 'T19:30:00')
    if (showDate < now) continue

    const id = slugify(titleLine)
    if (seen.has(id)) continue
    seen.add(id)

    shows.push({
      title:    titleLine,
      dateStr,
      venue:    venueName,
    })
  }

  return shows
}

// ── Process ────────────────────────────────────────────────────────────────

async function processShows(shows, organizerId) {
  let inserted = 0, skipped = 0

  for (const show of shows) {
    try {
      const venueId  = await ensureVenue(show.venue)
      const startAt  = easternToIso(show.dateStr, '19:30:00')

      if (!startAt) { skipped++; continue }

      const row = {
        title:           show.title,
        description:     null,
        start_at:        startAt,
        end_at:          null,
        venue_id:        venueId,
        organizer_id:    organizerId,
        category:        'art',
        tags:            deriveTags(show.title),
        price_min:       25,
        price_max:       null,
        age_restriction: 'not_specified',
        image_url:       null,
        ticket_url:      'https://www.akroncivic.com/tickets',
        source:          'akron_civic',
        source_id:       slugify(show.title),
        status:          'published',
        featured:        false,
      }

      const { error } = await supabaseAdmin
        .from('events')
        .upsert(row, { onConflict: 'source,source_id', ignoreDuplicates: false })

      if (error) { console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message); skipped++ }
      else inserted++
    } catch (err) {
      console.warn(`  ⚠ Error processing "${show.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Akron Civic Theatre ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganizer()

    console.log(`\n🔍  Fetching ${SOURCE_URL}…`)
    const html  = await fetchHtml(SOURCE_URL)
    const shows = parseShows(html)
    console.log(`  Found ${shows.length} upcoming shows`)

    if (shows.length === 0) {
      console.warn('  ⚠ No shows parsed — HTML structure may have changed. Inspect the page manually.')
    }

    console.log(`\n📥  Processing ${shows.length} shows…`)
    const { inserted, skipped } = await processShows(shows, organizerId)

    await logUpsertResult('akron_civic', inserted, 0, skipped, {
      eventsFound: shows.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('akron_civic', err, start)
    process.exit(1)
  }
}

main()
