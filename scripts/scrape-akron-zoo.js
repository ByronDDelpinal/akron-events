/**
 * scrape-akron-zoo.js
 *
 * Scrapes upcoming events from the Akron Zoo's events page.
 * The site uses Drupal — events are rendered server-side, sometimes in a Slick carousel.
 *
 * NOTE: If this scraper returns 0 events, inspect the HTML structure — Drupal carousel
 * nesting may have changed. Check the page at https://www.akronzoo.org/events manually.
 *
 * Usage:
 *   node scripts/scrape-akron-zoo.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { logUpsertResult, logScraperError, stripHtml } from './lib/normalize.js'

const SOURCE_URL = 'https://www.akronzoo.org/events'
const BASE_DOMAIN = 'https://www.akronzoo.org'

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
function easternToIso(dateStr, timeStr = '09:00:00') {
  if (!dateStr) return null
  const normalised = timeStr.trim().replace(
    /^(\d{1,2}):?(\d{2})?\s*(am|pm)$/i,
    (_, h, m = '00', mer) => {
      let hr = parseInt(h, 10)
      if (mer.toLowerCase() === 'pm' && hr !== 12) hr += 12
      if (mer.toLowerCase() === 'am' && hr === 12) hr = 0
      return `${String(hr).padStart(2, '0')}:${m}:00`
    }
  )
  const [datePart] = dateStr.split('T')
  const [year, month, day] = datePart.split('-').map(Number)
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

/**
 * Try to parse a date from various Drupal formats:
 *   "March 22, 2026"   → "2026-03-22"
 *   "March 22-24, 2026" → "2026-03-22" (use start)
 *   "March 22"         → "2026-03-22" (infer year)
 *   "2026-03-22"       → "2026-03-22" (already ISO)
 * Also extracts time if present in the string (e.g., "9:30am").
 */
function parseDateText(raw) {
  if (!raw) return { dateStr: null, timeStr: '09:00:00' }
  const s = raw.trim()

  // ISO datetime attribute format
  const isoMatch = s.match(/^(\d{4}-\d{2}-\d{2})/)
  if (isoMatch) {
    const timeMatch = s.match(/T(\d{2}:\d{2})/)
    return { dateStr: isoMatch[1], timeStr: timeMatch ? timeMatch[1] + ':00' : '09:00:00' }
  }

  // Extract time if present in string like "March 22, 2026 at 9:30am"
  let timeStr = '09:00:00'
  const timeInStr = s.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i)
  if (timeInStr) {
    const rawTime = timeInStr[1].trim()
    const timeNorm = rawTime.replace(
      /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i,
      (_, h, m = '00', mer) => {
        let hr = parseInt(h, 10)
        if (mer.toLowerCase() === 'pm' && hr !== 12) hr += 12
        if (mer.toLowerCase() === 'am' && hr === 12) hr = 0
        return `${String(hr).padStart(2, '0')}:${m}:00`
      }
    )
    timeStr = timeNorm
  }

  // "Month DD, YYYY" or "Month DD-DD, YYYY"
  const fullMatch = s.match(/([A-Za-z]+)\s+(\d{1,2})(?:-\d{1,2})?,?\s*(\d{4})/)
  if (fullMatch) {
    const [, mon, day, year] = fullMatch
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) return {
      dateStr: `${year}-${String(m).padStart(2,'0')}-${String(parseInt(day)).padStart(2,'0')}`,
      timeStr,
    }
  }

  // "Month DD" no year
  const shortMatch = s.match(/([A-Za-z]+)\s+(\d{1,2})/)
  if (shortMatch) {
    const [, mon, day] = shortMatch
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) {
      const year = new Date().getFullYear()
      return {
        dateStr: `${year}-${String(m).padStart(2,'0')}-${String(parseInt(day)).padStart(2,'0')}`,
        timeStr,
      }
    }
  }

  return { dateStr: null, timeStr }
}

function resolveUrl(href) {
  if (!href) return null
  if (href.startsWith('http')) return href
  return BASE_DOMAIN + (href.startsWith('/') ? '' : '/') + href
}

function parseCategory(title = '') {
  const lower = title.toLowerCase()
  if (lower.includes('camp') || lower.includes('class') || lower.includes('program') || lower.includes('education') || lower.includes('learn')) return 'education'
  return 'community'
}

function parseTags(title = '') {
  const lower  = title.toLowerCase()
  const tags   = ['zoo', 'family', 'animals', 'akron-zoo']
  if (lower.includes('kids') || lower.includes('children') || lower.includes('family') || lower.includes('junior')) tags.push('kids')
  return [...new Set(tags)]
}

// ── Venue / Organizer ──────────────────────────────────────────────────────

async function ensureVenue() {
  const { data: existing } = await supabaseAdmin
    .from('venues').select('id').eq('name', 'Akron Zoo').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('venues').insert({
    name:          'Akron Zoo',
    address:       '500 Edgewood Ave',
    city:          'Akron',
    state:         'OH',
    zip:           '44307',
    lat:           41.0615,
    lng:           -81.5160,
    parking_type:  'lot',
    parking_notes: 'Free parking in zoo lots.',
    website:       'https://www.akronzoo.org',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create Akron Zoo venue:', error.message); return null }
  console.log('  ✚ Created venue: Akron Zoo')
  return data.id
}

async function ensureOrganizer() {
  const { data: existing } = await supabaseAdmin
    .from('organizers').select('id').eq('name', 'Akron Zoo').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('organizers').insert({
    name:        'Akron Zoo',
    website:     'https://www.akronzoo.org',
    description: 'The Akron Zoo is a 68-acre zoo in Akron, Ohio, home to over 900 animals and offering family events, educational programs, and special seasonal experiences.',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create Akron Zoo organizer:', error.message); return null }
  console.log('  ✚ Created Akron Zoo organizer')
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

// ── Parse events from HTML ─────────────────────────────────────────────────

function parseEvents(html) {
  const events = []
  const seen   = new Set()

  // Strategy 1: Look for Drupal Views rows / article nodes / Slick slides
  // Try multiple selector patterns via regex
  const cardPatterns = [
    // Drupal views-row pattern
    /<div[^>]*class="[^"]*views-row[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*views-row|<\/div>\s*<\/div>\s*<\/div>)/gi,
    // Article node
    /<article[^>]*>([\s\S]*?)<\/article>/gi,
    // Slick slides
    /<li[^>]*class="[^"]*slick(?:__slide|-slide)[^"]*"[^>]*>([\s\S]*?)<\/li>/gi,
    // Generic event items
    /<(?:div|li)[^>]*class="[^"]*(?:event-item|event-card|node--type-event)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|li)>/gi,
  ]

  let matched = false

  for (const pattern of cardPatterns) {
    const matches = [...html.matchAll(pattern)]
    if (matches.length === 0) continue
    matched = true

    for (const match of matches) {
      const cardHtml = match[1] ?? match[0]

      // Extract title
      const titleMatch = cardHtml.match(/<(?:h2|h3|h4)[^>]*>([\s\S]*?)<\/(?:h2|h3|h4)>/i) ??
                         cardHtml.match(/class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\//i)
      const title = titleMatch ? stripHtml(titleMatch[1]) : null
      if (!title || title.length < 3) continue

      // Extract date — prefer datetime attribute
      const datetimeAttr = cardHtml.match(/<time[^>]*datetime="([^"]+)"/)
      const dateTextEl   = cardHtml.match(/class="[^"]*date[^"]*"[^>]*>([\s\S]*?)<\//i)
      const rawDate      = datetimeAttr ? datetimeAttr[1] : (dateTextEl ? stripHtml(dateTextEl[1]) : null)

      const { dateStr, timeStr } = parseDateText(rawDate ?? '')

      // Extract URL
      const hrefMatch = cardHtml.match(/<a[^>]*href="([^"]+)"/)
      const href      = hrefMatch ? resolveUrl(hrefMatch[1]) : null

      // Extract image
      const imgMatch = cardHtml.match(/<img[^>]*src="([^"]+)"/)
      let   imageUrl = imgMatch ? imgMatch[1] : null
      if (imageUrl && !imageUrl.startsWith('http')) imageUrl = BASE_DOMAIN + imageUrl

      // Derive source_id from URL path or title slug
      let sourceId = null
      if (href) {
        const pathMatch = href.match(/\/([^/?#]+)\/?(?:\?.*)?$/)
        sourceId = pathMatch ? pathMatch[1] : null
      }
      if (!sourceId) {
        sourceId = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      }

      if (seen.has(sourceId)) continue
      seen.add(sourceId)

      events.push({ title, dateStr, timeStr, href, imageUrl, sourceId })
    }

    if (matched && events.length > 0) break
  }

  // Strategy 2: If no cards found, parse text lines with date patterns
  if (events.length === 0) {
    console.warn('  ⚠ No event cards found via CSS patterns — falling back to text parsing')

    const cleanText = stripHtml(html)
    const lines     = cleanText.split('\n').map(l => l.trim()).filter(Boolean)

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const { dateStr } = parseDateText(line)
      if (!dateStr) continue

      const titleLine = lines[i + 1] ?? ''
      if (!titleLine || titleLine.length < 3) continue

      const sourceId = titleLine.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      if (seen.has(sourceId)) continue
      seen.add(sourceId)

      events.push({ title: titleLine, dateStr, timeStr: '09:00:00', href: null, imageUrl: null, sourceId })
    }
  }

  // Filter out past events
  const now = new Date()
  return events.filter(ev => {
    if (!ev.dateStr) return false
    return new Date(ev.dateStr) >= new Date(now.toISOString().split('T')[0])
  })
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
        venue_id:        venueId,
        organizer_id:    organizerId,
        category:        parseCategory(ev.title),
        tags:            parseTags(ev.title),
        price_min:       0,
        price_max:       null,
        age_restriction: 'all_ages',
        image_url:       ev.imageUrl,
        ticket_url:      ev.href ?? 'https://www.akronzoo.org/tickets',
        source:          'akron_zoo',
        source_id:       ev.sourceId,
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

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Akron Zoo ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([ensureVenue(), ensureOrganizer()])

    console.log(`\n🔍  Fetching ${SOURCE_URL}…`)
    const html   = await fetchHtml(SOURCE_URL)
    const events = parseEvents(html)
    console.log(`  Found ${events.length} upcoming events`)

    if (events.length === 0) {
      console.warn('  ⚠ No events parsed. If this is unexpected, inspect the page HTML — Drupal carousel nesting may have changed.')
    }

    console.log(`\n📥  Processing ${events.length} events…`)
    const { inserted, skipped } = await processEvents(events, venueId, organizerId)

    await logUpsertResult('akron_zoo', inserted, 0, skipped, {
      eventsFound: events.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('akron_zoo', err, start)
    process.exit(1)
  }
}

main()
