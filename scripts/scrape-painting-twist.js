/**
 * scrape-painting-twist.js
 *
 * Scrapes upcoming paint-and-sip events from Painting with a Twist (Fairlawn, OH).
 * Platform: Custom ASP.NET MVC — server-rendered calendar page.
 *
 * Usage:
 *   node scripts/scrape-painting-twist.js
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
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'

const CALENDAR_URL  = 'https://www.paintingwithatwist.com/studio/akron-fairlawn/calendar/'
const STUDIO_BASE   = 'https://www.paintingwithatwist.com/studio/akron-fairlawn'

// ── Helpers ────────────────────────────────────────────────────────────────

const MONTH_MAP = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4,
  june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

/**
 * Parse a PWT date-time string like "Sun, Mar 22, 6:30 pm".
 * Returns { dateStr: "YYYY-MM-DD", timeStr: "HH:MM:00" } or { dateStr: null, timeStr: null }.
 */
function parsePwtDateTime(raw) {
  if (!raw) return { dateStr: null, timeStr: null }
  const s = raw.trim()

  // Pattern: "Day, Mon DD, H:MM am/pm" or "Day, Mon DD, H:MM pm"
  const match = s.match(
    /[A-Za-z]{2,3},\s+([A-Za-z]{3,})\s+(\d{1,2}),\s+(\d{1,2}):(\d{2})\s*(am|pm)/i
  )

  if (match) {
    const [, mon, day, hour, minute, mer] = match
    const m = MONTH_MAP[mon.toLowerCase()]
    if (!m) return { dateStr: null, timeStr: null }

    // Infer year: if this month-day is in the past this year, it's next year
    const now       = new Date()
    let   year      = now.getFullYear()
    const candidate = new Date(Date.UTC(year, m - 1, parseInt(day)))
    const today     = new Date(now.toISOString().split('T')[0] + 'T00:00:00Z')
    if (candidate < today) year++

    let hr = parseInt(hour, 10)
    if (mer.toLowerCase() === 'pm' && hr !== 12) hr += 12
    if (mer.toLowerCase() === 'am' && hr === 12) hr = 0

    const dateStr = `${year}-${String(m).padStart(2,'0')}-${String(parseInt(day)).padStart(2,'0')}`
    const timeStr = `${String(hr).padStart(2,'0')}:${minute}:00`
    return { dateStr, timeStr }
  }

  return { dateStr: null, timeStr: null }
}

/**
 * Parse a price string like "$34-$44", "$30-$39", "$35-$44", "Free".
 * Returns { price_min, price_max }.
 */
function parsePrice(raw) {
  if (!raw) return { price_min: 0, price_max: null }
  const s = raw.trim().toLowerCase()

  if (s.includes('free')) return { price_min: 0, price_max: null }

  // "$XX-$XX" range
  const rangeMatch = s.match(/\$?(\d+(?:\.\d+)?)\s*[-–]\s*\$?(\d+(?:\.\d+)?)/)
  if (rangeMatch) {
    return {
      price_min: parseFloat(rangeMatch[1]),
      price_max: parseFloat(rangeMatch[2]),
    }
  }

  // Single price "$XX"
  const singleMatch = s.match(/\$?(\d+(?:\.\d+)?)/)
  if (singleMatch) {
    return { price_min: parseFloat(singleMatch[1]), price_max: null }
  }

  return { price_min: 0, price_max: null }
}

// ── Venue / Organizer ──────────────────────────────────────────────────────

async function ensurePwtVenue() {
  return ensureVenue('Painting with a Twist - Fairlawn', {
    address:       '2955 W Market St Ste J',
    city:          'Fairlawn',
    state:         'OH',
    zip:           '44333',
    lat:           41.1357,
    lng:           -81.5997,
    parking_type:  'lot',
    parking_notes: 'Free parking in shopping center lot.',
    website:       `${STUDIO_BASE}/`,
  })
}

async function ensurePwtOrganizer() {
  return ensureOrganization('Painting with a Twist - Fairlawn', {
    website:     `${STUDIO_BASE}/`,
    description: 'Painting with a Twist Fairlawn offers guided paint-and-sip events for adults and kids in a fun, social setting.',
  })
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

// ── Parse events ───────────────────────────────────────────────────────────

/**
 * The PWT calendar page renders events in a list.
 * Each event has:
 *   - A link to /event/{id}/
 *   - Date-time text like "Sun, Mar 22, 6:30 pm"
 *   - Price like "$34-$44"
 *   - Title like "$5 OFF: Bless our Nest"
 *
 * Strategy: find all <a href*="/event/"> links, extract surrounding container text,
 * then parse date/price/title from that text.
 */
function parseEvents(html) {
  const events = []
  const seen   = new Set()

  // Find all event links — /event/{id}/
  const eventLinkPattern = /href="(\/studio\/akron-fairlawn\/event\/(\d+)\/)"/gi
  const eventLinks       = [...html.matchAll(eventLinkPattern)]

  if (eventLinks.length === 0) {
    // Fallback: look for numeric event IDs in any link
    const altPattern = /href="([^"]*\/event\/(\d+)[^"]*)"/gi
    eventLinks.push(...html.matchAll(altPattern))
  }

  // Also try regex-based text parsing as the primary approach
  // The structured calendar text has date patterns near price and title patterns
  const datePattern = /[A-Z][a-z]{2,3},\s+[A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{1,2}:\d{2}\s*[ap]m/gi

  // Build a map of event IDs → context blocks from the HTML
  const idContextMap = new Map()
  for (const match of eventLinks) {
    const id   = match[2]
    const pos  = match.index ?? 0
    // Get a chunk of HTML around this link (2000 chars before and after)
    const chunk = html.slice(Math.max(0, pos - 2000), pos + 500)
    idContextMap.set(id, chunk)
  }

  // Extract text from each container and parse fields
  for (const [id, chunk] of idContextMap) {
    if (seen.has(id)) continue

    const text  = stripHtml(chunk)
    const lines = text.split(/[\n\t]+/).map(l => l.trim()).filter(Boolean)

    // Find date line
    let dateTimeStr = null
    let priceStr    = null
    let title       = null

    for (const line of lines) {
      if (!dateTimeStr && /[A-Za-z]{2,3},\s+[A-Za-z]{3,}\s+\d{1,2},\s+\d{1,2}:\d{2}\s*[ap]m/i.test(line)) {
        dateTimeStr = line
        continue
      }
      if (!priceStr && /^\$\d+/.test(line)) {
        priceStr = line
        continue
      }
      // Title: first non-empty line after we've seen a date (and optionally price)
      if (dateTimeStr && !title && line.length > 3 && !/^\d+$/.test(line) &&
          !line.toLowerCase().includes('spots left') &&
          !line.toLowerCase().includes('loyalty') &&
          !line.toLowerCase().includes('notifications')) {
        title = line
      }
    }

    if (!dateTimeStr || !title) continue

    const { dateStr, timeStr } = parsePwtDateTime(dateTimeStr)
    if (!dateStr) continue

    const { price_min, price_max } = parsePrice(priceStr)

    // Skip past events
    const now = new Date()
    if (new Date(dateStr) < new Date(now.toISOString().split('T')[0])) continue

    seen.add(id)
    events.push({ id, title, dateStr, timeStr, price_min, price_max })
  }

  // If no events found from the link-context approach, try pure text regex
  if (events.length === 0) {
    console.warn('  ⚠ Link-context parsing found 0 events — trying regex text approach')

    const cleanText = stripHtml(html)
    const blocks    = cleanText.split(/\n{2,}/).map(b => b.trim()).filter(Boolean)

    let currentDate = null
    let currentTime = null

    for (const block of blocks) {
      const dtMatch = block.match(/([A-Za-z]{2,3},\s+[A-Za-z]{3,}\s+\d{1,2},\s+\d{1,2}:\d{2}\s*[ap]m)/i)
      if (dtMatch) {
        const { dateStr, timeStr } = parsePwtDateTime(dtMatch[1])
        currentDate = dateStr
        currentTime = timeStr
      }

      if (currentDate) {
        // Look for event link pattern to get ID
        const idMatch = block.match(/\/event\/(\d+)\//)
        if (idMatch) {
          const id = idMatch[1]
          if (seen.has(id)) continue

          // Parse price
          const priceMatch = block.match(/\$[\d.]+-?\$?[\d.]*/)
          const { price_min, price_max } = priceMatch ? parsePrice(priceMatch[0]) : { price_min: 0, price_max: null }

          // Find title — non-price, non-date, non-logistics line
          const titleLine = block.split('\n').map(l => l.trim()).find(l =>
            l.length > 3 &&
            !l.match(/^\$/) &&
            !l.match(/[A-Za-z]{2,3},\s+[A-Za-z]{3,}\s+\d/) &&
            !l.toLowerCase().includes('spots left') &&
            !l.toLowerCase().includes('loyalty') &&
            !l.toLowerCase().includes('notifications')
          )

          if (!titleLine) continue

          const now = new Date()
          if (new Date(currentDate) < new Date(now.toISOString().split('T')[0])) continue

          seen.add(id)
          events.push({ id, title: titleLine, dateStr: currentDate, timeStr: currentTime, price_min, price_max })
        }
      }
    }
  }

  return events
}

// ── Process ────────────────────────────────────────────────────────────────

async function processEvents(events, venueId, organizerId) {
  let inserted = 0, skipped = 0

  for (const ev of events) {
    try {
      const startAt = easternToIso(ev.dateStr, ev.timeStr)
      if (!startAt) { skipped++; continue }

      const row = {
        title:           ev.title,
        description:     null,
        start_at:        startAt,
        end_at:          null,
        category:        'art',
        tags:            ['paint-and-sip', 'art', 'fairlawn', 'social', 'date-night', 'girls-night'],
        price_min:       ev.price_min,
        price_max:       ev.price_max,
        age_restriction: 'all_ages',
        image_url:       null,
        ticket_url:      `${STUDIO_BASE}/event/${ev.id}/`,
        source:          'painting_twist',
        source_id:       ev.id,
        status:          'published',
        featured:        false,
      }

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
  console.log('🚀  Starting Painting with a Twist (Fairlawn) ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([ensurePwtVenue(), ensurePwtOrganizer()])

    console.log(`\n🔍  Fetching ${CALENDAR_URL}…`)
    const html   = await fetchHtml(CALENDAR_URL)
    const events = parseEvents(html)
    console.log(`  Found ${events.length} upcoming events`)

    if (events.length === 0) {
      console.warn('  ⚠ No events parsed. The page structure may have changed — inspect manually.')
    }

    console.log(`\n📥  Processing ${events.length} events…`)
    const { inserted, skipped } = await processEvents(events, venueId, organizerId)

    await logUpsertResult('painting_twist', inserted, 0, skipped, {
      eventsFound: events.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('painting_twist', err, start)
    process.exit(1)
  }
}

main()
