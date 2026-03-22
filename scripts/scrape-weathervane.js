/**
 * scrape-weathervane.js
 *
 * Scrapes the season lineup from Weathervane Playhouse's upcoming-shows page.
 * Platform: Drupal 11 — static HTML season listing.
 *
 * Usage:
 *   node scripts/scrape-weathervane.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { logUpsertResult, logScraperError, stripHtml } from './lib/normalize.js'

const SOURCE_URL = 'https://www.weathervaneplayhouse.com/upcoming-shows'

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
  const normalised = timeStr.trim().replace(
    /^(\d{1,2}):(\d{2})\s*(am|pm)$/i,
    (_, h, m, mer) => {
      let hr = parseInt(h, 10)
      if (mer.toLowerCase() === 'pm' && hr !== 12) hr += 12
      if (mer.toLowerCase() === 'am' && hr === 12) hr = 0
      return `${String(hr).padStart(2, '0')}:${m}:00`
    }
  )
  const [year, month, day] = dateStr.split('-').map(Number)
  const [hour, minute, second = 0] = normalised.split(':').map(Number)
  const localUtcMs  = Date.UTC(year, month - 1, day, hour, minute, second)
  const approxUtc   = new Date(localUtcMs + 5 * 3600_000)
  const offsetHours = isEasternDST(approxUtc) ? 4 : 5
  return new Date(localUtcMs + offsetHours * 3600_000).toISOString()
}

// ── Helpers ────────────────────────────────────────────────────────────────

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

/** Slugify a show title for source_id */
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/**
 * Parse a Weathervane date string and return the opening night date.
 *
 * Formats encountered on the page:
 *   "MARCH 5 - 29"          → March 5 of inferred year
 *   "APRIL 30 - MAY 24"     → April 30 of inferred year
 *   "SUNDAY, MAY 31, 2026"  → May 31, 2026
 *   "JUNE 18 - JULY 12"     → June 18 of inferred year
 *   "JULY 16 - 19"          → July 16 of inferred year
 *   "AUGUST 21, 2025 - JULY 19, 2026" → season header — returns null
 *
 * Year inference: months Jan–Jul → next occurrence starting from today;
 * months Aug–Dec → current year if not yet passed, else next year.
 */
function parseDateString(raw) {
  if (!raw) return null
  const s = raw.trim().toUpperCase()

  // Skip obvious season headers: ranges spanning multiple years
  if (/\d{4}\s*[-–]\s*\w+\s+\d+,?\s*\d{4}/.test(s)) return null

  // Strip leading day-of-week
  const stripped = s.replace(/^(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY),?\s*/i, '')

  // Pattern: "Month DD, YYYY" (single date with explicit year)
  const exactMatch = stripped.match(/^([A-Z]+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (exactMatch) {
    const [, mon, day, year] = exactMatch
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) return `${year}-${String(m).padStart(2,'0')}-${String(parseInt(day)).padStart(2,'0')}`
  }

  // Pattern: "Month DD - DD" or "Month DD - Month DD" (range, no explicit year)
  const rangeMatch = stripped.match(/^([A-Z]+)\s+(\d{1,2})\s*[-–]/)
  if (rangeMatch) {
    const [, mon, day] = rangeMatch
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) {
      const year = inferYear(m, parseInt(day))
      if (!year) return null
      return `${year}-${String(m).padStart(2,'0')}-${String(parseInt(day)).padStart(2,'0')}`
    }
  }

  // Pattern: "Month DD" (single date, no year)
  const singleMatch = stripped.match(/^([A-Z]+)\s+(\d{1,2})$/)
  if (singleMatch) {
    const [, mon, day] = singleMatch
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) {
      const year = inferYear(m, parseInt(day))
      if (!year) return null
      return `${year}-${String(m).padStart(2,'0')}-${String(parseInt(day)).padStart(2,'0')}`
    }
  }

  return null
}

/**
 * Infer the year for a month/day combo.
 * Returns the next future occurrence of that month/day, looking ahead up to 2 years.
 */
function inferYear(month, day) {
  const today = new Date()
  for (let offset = 0; offset <= 2; offset++) {
    const year = today.getFullYear() + offset
    const d    = new Date(Date.UTC(year, month - 1, day))
    const t    = new Date(today.toISOString().split('T')[0] + 'T00:00:00Z')
    if (d >= t) return year
  }
  return null
}

/** Detect if a line looks like a season range header (not an individual show date) */
function isSeasonHeader(line) {
  // "91st Season Lineup", "AUGUST 21, 2025 - JULY 19, 2026", etc.
  return /season lineup/i.test(line) ||
         /\d{4}\s*[-–]\s*\w+\s+\d+,?\s*\d{4}/.test(line) ||
         /^\d{4}$/.test(line.trim())
}

/** Check if a line looks like a date entry */
function isDateLine(line) {
  return /\b(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\b/i.test(line) &&
         /\d/.test(line)
}

// ── Parse shows ────────────────────────────────────────────────────────────

function parseShows(html) {
  const shows = []

  // Remove scripts and styles
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')

  // Extract text
  const rawText = stripHtml(clean)
  const lines   = rawText
    .split(/[\n\r]+/)
    .map(l => l.trim())
    .filter(l => l.length > 0)

  const seen    = new Set()
  const now     = new Date()
  const todayMs = new Date(now.toISOString().split('T')[0] + 'T00:00:00Z').getTime()

  // Walk lines looking for (title, date) pairs
  // The page alternates: title line → date line (or date → title in some layouts)
  // We look for date lines and infer the title from adjacent non-date lines.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (isSeasonHeader(line)) continue

    if (isDateLine(line)) {
      const dateStr = parseDateString(line)
      if (!dateStr) continue

      // Skip past shows
      if (new Date(dateStr).getTime() < todayMs) continue

      // Look backward and forward for a title
      const prevLine = i > 0 ? lines[i - 1] : ''
      const nextLine = i < lines.length - 1 ? lines[i + 1] : ''

      // Title is the adjacent non-date, non-header line
      let title = null
      if (prevLine && !isDateLine(prevLine) && !isSeasonHeader(prevLine) && prevLine.length > 3) {
        title = prevLine
      } else if (nextLine && !isDateLine(nextLine) && !isSeasonHeader(nextLine) && nextLine.length > 3) {
        title = nextLine
      }

      if (!title) continue

      const id = slugify(title)
      if (seen.has(id)) continue
      seen.add(id)

      shows.push({ title, dateStr })
    }
  }

  return shows
}

// ── Venue / Organizer ──────────────────────────────────────────────────────

async function ensureVenue() {
  const { data: existing } = await supabaseAdmin
    .from('venues').select('id').eq('name', 'Weathervane Playhouse').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('venues').insert({
    name:          'Weathervane Playhouse',
    address:       '1301 Weathervane Lane',
    city:          'Akron',
    state:         'OH',
    zip:           '44313',
    lat:           41.1073,
    lng:           -81.5651,
    parking_type:  'lot',
    parking_notes: 'Free on-site parking.',
    website:       'https://www.weathervaneplayhouse.com',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create Weathervane Playhouse venue:', error.message); return null }
  console.log('  ✚ Created venue: Weathervane Playhouse')
  return data.id
}

async function ensureOrganizer() {
  const { data: existing } = await supabaseAdmin
    .from('organizers').select('id').eq('name', 'Weathervane Playhouse').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('organizers').insert({
    name:        'Weathervane Playhouse',
    website:     'https://www.weathervaneplayhouse.com',
    description: 'Weathervane Playhouse is a community theatre in Akron, Ohio, presenting professional-quality productions for over 90 seasons.',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create Weathervane organizer:', error.message); return null }
  console.log('  ✚ Created Weathervane Playhouse organizer')
  return data.id
}

// ── HTML fetch ─────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronEventsBot/1.0)',
      'Accept':     'text/html',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Process ────────────────────────────────────────────────────────────────

async function processShows(shows, venueId, organizerId) {
  let inserted = 0, skipped = 0

  for (const show of shows) {
    try {
      const startAt = easternToIso(show.dateStr, '19:30:00')
      if (!startAt) { skipped++; continue }

      const row = {
        title:           show.title,
        description:     null,
        start_at:        startAt,
        end_at:          null,
        venue_id:        venueId,
        organizer_id:    organizerId,
        category:        'art',
        tags:            ['theatre', 'community-theatre', 'live-performance', 'akron'],
        price_min:       20,
        price_max:       null,
        age_restriction: 'all_ages',
        image_url:       null,
        ticket_url:      'https://www.weathervaneplayhouse.com/tickets',
        source:          'weathervane',
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
  console.log('🚀  Starting Weathervane Playhouse ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([ensureVenue(), ensureOrganizer()])

    console.log(`\n🔍  Fetching ${SOURCE_URL}…`)
    const html  = await fetchHtml(SOURCE_URL)
    const shows = parseShows(html)
    console.log(`  Found ${shows.length} upcoming shows`)

    if (shows.length === 0) {
      console.warn('  ⚠ No shows parsed. The page structure may have changed — inspect manually.')
    }

    console.log(`\n📥  Processing ${shows.length} shows…`)
    const { inserted, skipped } = await processShows(shows, venueId, organizerId)

    await logUpsertResult('weathervane', inserted, 0, skipped, {
      eventsFound: shows.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('weathervane', err, start)
    process.exit(1)
  }
}

main()
