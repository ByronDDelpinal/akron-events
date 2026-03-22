/**
 * scrape-akron-art-museum.js
 *
 * Fetches upcoming events from the Akron Art Museum (akronartmuseum.org)
 * by scraping the /calendar/ page. The museum uses a custom "Museum Events"
 * WordPress plugin (not Tribe) — there is no REST API for events.
 *
 * Approach:
 *   • Fetch /calendar/?date=YYYY-MM-DD&days=31 for each of the next 6 months
 *   • Parse .me-event-list-item elements from the HTML
 *   • Each event links to /media/events/[slug]/ — follow those links to get
 *     price, full description, and registration URLs
 *   • Convert Eastern → UTC using DST-aware helper
 *
 * Usage:
 *   node scripts/scrape-akron-art-museum.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { logUpsertResult, logScraperError } from './lib/normalize.js'

const BASE_URL   = 'https://akronartmuseum.org/calendar/'
const DAYS_AHEAD = 180   // 6 months

// ── Helpers ───────────────────────────────────────────────────────────────

function stripHtml(html = '') {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#8217;/g, "'").replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"')
    .replace(/\s+/g, ' ').trim()
}

/**
 * Convert a local Eastern date + time string to an ISO 8601 UTC string.
 * DST: second Sunday of March → first Sunday of November (EDT = UTC-4)
 * Standard time outside that range (EST = UTC-5)
 */
function easternToIso(dateStr, timeStr = '12:00 pm') {
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return null

  const year = d.getFullYear()
  const dstStart = getNthSunday(year, 2, 2)   // 2nd Sunday of March
  const dstEnd   = getNthSunday(year, 10, 1)  // 1st Sunday of November
  const offsetMs = (d >= dstStart && d < dstEnd) ? 4 * 3600_000 : 5 * 3600_000

  const timeMatch = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
  if (!timeMatch) return null
  let hours = parseInt(timeMatch[1], 10)
  const mins = parseInt(timeMatch[2] ?? '0', 10)
  const ampm = timeMatch[3]?.toLowerCase()
  if (ampm === 'pm' && hours < 12) hours += 12
  if (ampm === 'am' && hours === 12) hours = 0

  const localMs = d.getTime() + hours * 3600_000 + mins * 60_000
  return new Date(localMs + offsetMs).toISOString()
}

function getNthSunday(year, month, n) {
  const d = new Date(year, month, 1)
  const firstSunday = d.getDay() === 0 ? 1 : 8 - d.getDay()
  return new Date(year, month, firstSunday + (n - 1) * 7)
}

/**
 * Parse event date and time from the raw text found in the <p> tag inside each
 * .me-event-list-item__text-column. The format the museum uses is:
 *   "Tuesday, March 24, 20261:00 – 4:00 pm"  (no space between year and time)
 *   "Friday, April 4, 202610:00 am – 12:00 pm"
 *   "Saturday, March 22, 2026All day"
 *
 * Returns { dateStr: 'YYYY-MM-DD', startTime: '1:00 pm', endTime: '4:00 pm' | null }
 */
function parseEventDateTime(rawText = '') {
  const text = rawText.replace(/\s+/g, ' ').trim()

  // Match date portion: "Tuesday, March 24, 2026" (with optional day-of-week)
  const datePat = /(?:\w+,\s+)?(\w+ \d{1,2},\s+\d{4})/
  const dateMatch = text.match(datePat)
  if (!dateMatch) return null

  const dateStr = new Date(dateMatch[1]).toISOString().split('T')[0]
  if (!dateStr || dateStr === 'Invalid Date') return null

  // Everything after the date is the time portion
  const afterDate = text.slice(dateMatch.index + dateMatch[0].length).trim()

  if (!afterDate || /all\s*day/i.test(afterDate)) {
    return { dateStr, startTime: '12:00 pm', endTime: null, allDay: true }
  }

  // Time range: "1:00 – 4:00 pm" or "10:00 am – 12:00 pm" or "7:00 pm"
  // The dash can be – (en dash) or -
  const rangePat = /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[–\-]\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i
  const rangeMatch = afterDate.match(rangePat)

  if (rangeMatch) {
    let start = rangeMatch[1].trim()
    const end = rangeMatch[2].trim()

    // If start has no am/pm but end does, infer am/pm for start
    if (!/am|pm/i.test(start) && /am|pm/i.test(end)) {
      const endAmPm = end.match(/am|pm/i)[0].toLowerCase()
      // If end is pm and start hour ≤ end hour, start is also pm unless it's 12
      const startHour = parseInt(start, 10)
      const endHour   = parseInt(end, 10)
      if (endAmPm === 'pm' && startHour <= endHour && startHour !== 12) {
        start += ' pm'
      } else {
        start += ' ' + endAmPm
      }
    }

    return { dateStr, startTime: start, endTime: end, allDay: false }
  }

  // Single time only
  const singlePat = /(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i
  const singleMatch = afterDate.match(singlePat)
  if (singleMatch) {
    return { dateStr, startTime: singleMatch[1].trim(), endTime: null, allDay: false }
  }

  return { dateStr, startTime: '12:00 pm', endTime: null, allDay: false }
}

/**
 * Extract all event items from a calendar page HTML string.
 * Returns array of { title, href, rawDateTime, imageUrl, types }
 */
function parseCalendarPage(html) {
  const events = []

  // Find all .me-event-list-item blocks
  // Each item is wrapped in: <div class="me-event-list-item">...</div>
  const itemRe = /<div[^>]+class="[^"]*me-event-list-item[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*<\/a>/g
  // Simpler: split on the opening tag of the anchor .me-event-list-item__link
  const linkRe = /href="(https:\/\/akronartmuseum\.org\/media\/events\/[^"]+)"/g

  // Walk the HTML looking for .me-event-list-item__link anchors
  // Strategy: find each occurrence of class="me-event-list-item" and extract the block
  let pos = 0
  while (true) {
    const classIdx = html.indexOf('me-event-list-item"', pos)
    if (classIdx === -1) break

    // Find the enclosing <a> for this item (it starts before the div)
    const aStart = html.lastIndexOf('<a ', classIdx)
    if (aStart === -1) { pos = classIdx + 1; continue }

    // Extract href from the <a> tag
    const aTag = html.slice(aStart, html.indexOf('>', aStart) + 1)
    const hrefMatch = aTag.match(/href="([^"]+)"/)
    if (!hrefMatch) { pos = classIdx + 1; continue }
    const href = hrefMatch[1]

    // Find the closing </a> — search from the class position forward
    const aEnd = html.indexOf('</a>', classIdx)
    if (aEnd === -1) { pos = classIdx + 1; continue }

    const block = html.slice(aStart, aEnd + 4)

    // Title from .me-event-list-item__title
    const titleMatch = block.match(/class="me-event-list-item__title"[^>]*>([\s\S]*?)<\/h2>/)
    const title = titleMatch ? stripHtml(titleMatch[1]) : ''

    // Date/time from <p> inside .me-event-list-item__text-column
    const textColMatch = block.match(/me-event-list-item__text-column[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/)
    const rawDateTime = textColMatch ? stripHtml(textColMatch[1]) : ''

    // Image from .me-event-list-item__image-column
    const imgMatch = block.match(/me-event-list-item__image-column[\s\S]*?<img[^>]+src="([^"]+)"/)
    const imageUrl = imgMatch ? imgMatch[1] : null

    // Event types from <ul><li> list
    const types = []
    const typesMatch = block.match(/<ul>([\s\S]*?)<\/ul>/)
    if (typesMatch) {
      const liRe = /<li>([\s\S]*?)<\/li>/g
      let liMatch
      while ((liMatch = liRe.exec(typesMatch[1])) !== null) {
        types.push(stripHtml(liMatch[1]))
      }
    }

    if (title && href) {
      events.push({ title, href, rawDateTime, imageUrl, types })
    }

    pos = aEnd + 4
  }

  return events
}

/**
 * Fetch an individual event detail page and extract:
 * price, full description, registration URL
 */
async function fetchEventDetail(href) {
  try {
    const res = await fetch(href, {
      headers: {
        'Accept': 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; The330-bot/1.0)',
      },
      redirect: 'follow',
    })
    if (!res.ok) return {}

    const html = await res.text()

    // Registration / ticket link
    const regMatch = html.match(/href="([^"]*(?:register|ticket|rsvp|eventbrite|squarespace)[^"]*)"/i)
    const ticketUrl = regMatch ? regMatch[1] : href

    // Price: look for $ amounts or "Free" / "Members"
    let priceMin = null, priceMax = null
    const freeMatch = /\bfree\b/i.test(html)
    const priceMatch = html.match(/\$(\d+(?:\.\d{2})?)/g)
    if (freeMatch && (!priceMatch || priceMatch.length === 0)) {
      priceMin = 0
    } else if (priceMatch) {
      const prices = priceMatch.map(p => parseFloat(p.replace('$', '')))
      priceMin = Math.min(...prices)
      priceMax = prices.length > 1 ? Math.max(...prices) : null
    }

    // Description: look for the main content area
    const descPatterns = [
      /class="entry-content"[^>]*>([\s\S]*?)<\/div>/,
      /class="me-event-detail[^"]*"[^>]*>([\s\S]*?)<\/div>/,
      /class="event-description[^"]*"[^>]*>([\s\S]*?)<\/div>/,
    ]
    let description = null
    for (const pat of descPatterns) {
      const m = html.match(pat)
      if (m) { description = stripHtml(m[1]).slice(0, 1000) || null; break }
    }

    return { ticketUrl, priceMin, priceMax, description }
  } catch {
    return {}
  }
}

/**
 * Map event type strings to our category enum.
 */
function parseCategory(types = [], title = '') {
  const t = types.join(' ').toLowerCase() + ' ' + title.toLowerCase()
  if (/music|concert|perform/i.test(t)) return 'music'
  if (/lecture|workshop|class|education|program/i.test(t)) return 'education'
  if (/film|cinema|screening/i.test(t)) return 'art'
  if (/family|children|kids/i.test(t)) return 'community'
  if (/tour|exhibit|gallery/i.test(t)) return 'art'
  if (/member/i.test(t)) return 'community'
  return 'art' // Museum default
}

// ── Venue / Organizer ─────────────────────────────────────────────────────

async function ensureVenue() {
  const { data: existing } = await supabaseAdmin
    .from('venues').select('id').eq('name', 'Akron Art Museum').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('venues').insert({
    name:         'Akron Art Museum',
    address:      '1 S High St',
    city:         'Akron',
    state:        'OH',
    zip:          '44308',
    lat:          41.0831,
    lng:          -81.5188,
    parking_type: 'garage',
    parking_notes:'Free 2-hour street parking. Paid parking at Quaker Square garage (nearby).',
    website:      'https://akronartmuseum.org',
    description:  'The Akron Art Museum is a modern art museum in downtown Akron, OH.',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create AAM venue:', error.message); return null }
  console.log('  ✚ Created Akron Art Museum venue')
  return data.id
}

async function ensureOrganizer() {
  const { data: existing } = await supabaseAdmin
    .from('organizers').select('id').eq('name', 'Akron Art Museum').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('organizers').insert({
    name:    'Akron Art Museum',
    website: 'https://akronartmuseum.org',
    description: 'The Akron Art Museum presents modern and contemporary art in downtown Akron, OH.',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create AAM organizer:', error.message); return null }
  console.log('  ✚ Created Akron Art Museum organizer')
  return data.id
}

// ── Fetch calendar pages ───────────────────────────────────────────────────

async function fetchAllEvents() {
  const allItems = new Map() // href → item (dedup across months)
  const now = new Date()

  console.log('\n🔍  Fetching Akron Art Museum calendar pages…')

  for (let monthOffset = 0; monthOffset < 6; monthOffset++) {
    const d = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1)
    const dateParam = d.toISOString().split('T')[0]

    const url = `${BASE_URL}?date=${dateParam}&days=31`
    console.log(`  Fetching ${url}`)

    const res = await fetch(url, {
      headers: {
        'Accept': 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; The330-bot/1.0)',
      },
      redirect: 'follow',
    })

    if (!res.ok) {
      console.warn(`  ⚠ Calendar page returned ${res.status} for ${dateParam}`)
      continue
    }

    const html = await res.text()
    const items = parseCalendarPage(html)
    console.log(`    Found ${items.length} events`)

    for (const item of items) {
      if (!allItems.has(item.href)) allItems.set(item.href, item)
    }

    await new Promise(r => setTimeout(r, 300))
  }

  return [...allItems.values()]
}

// ── Process ───────────────────────────────────────────────────────────────

async function processEvents(items, venueId, organizerId) {
  let inserted = 0, updated = 0, skipped = 0
  const now = Date.now()

  for (const item of items) {
    try {
      const parsed = parseEventDateTime(item.rawDateTime)
      if (!parsed) {
        console.log(`  ⚠ Skipping "${item.title}" — unparseable date: "${item.rawDateTime}"`)
        skipped++
        continue
      }

      const { dateStr, startTime, endTime } = parsed
      const startAt = easternToIso(dateStr, startTime)
      if (!startAt) { skipped++; continue }

      // Skip past events
      if (new Date(startAt).getTime() < now - 3 * 3600_000) { skipped++; continue }

      let endAt = null
      if (endTime) {
        endAt = easternToIso(dateStr, endTime)
      } else if (startAt) {
        // Default: 2-hour event for museum programs
        endAt = new Date(new Date(startAt).getTime() + 2 * 3600_000).toISOString()
      }

      // Fetch detail page for price, description, ticket link
      // Use a slug derived from the URL as source_id — stable across runs
      const slugMatch = item.href.match(/\/events\/([^/]+)\/?$/)
      const slug = slugMatch ? slugMatch[1] : item.href
      const source_id = slug

      // Rate-limit detail page fetches
      const detail = await fetchEventDetail(item.href)
      await new Promise(r => setTimeout(r, 200))

      const category = parseCategory(item.types, item.title)
      const tags = [
        ...item.types.map(t => t.toLowerCase()),
        'museum', 'art', 'akron',
      ].filter((v, i, a) => a.indexOf(v) === i)

      const priceMin = detail.priceMin ?? 0
      const priceMax = detail.priceMax ?? null
      const description = detail.description || null
      const ticketUrl = detail.ticketUrl || item.href

      const row = {
        title:           item.title,
        description,
        start_at:        startAt,
        end_at:          endAt,
        venue_id:        venueId,
        organizer_id:    organizerId,
        category,
        tags,
        price_min:       priceMin,
        price_max:       priceMax,
        age_restriction: 'not_specified',
        image_url:       item.imageUrl ?? null,
        ticket_url:      ticketUrl,
        source:          'akron_art_museum',
        source_id,
        status:          'published',
        featured:        false,
      }

      const { error } = await supabaseAdmin
        .from('events')
        .upsert(row, { onConflict: 'source,source_id', ignoreDuplicates: false })

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${item.title}":`, error.message)
        skipped++
      } else {
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${item.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, updated, skipped }
}

// ── Entry point ───────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Akron Art Museum ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([ensureVenue(), ensureOrganizer()])
    const items = await fetchAllEvents()

    if (items.length === 0) {
      console.log('\n  ℹ  No events found on calendar pages.')
    } else {
      console.log(`\n📥  Processing ${items.length} unique events (fetching detail pages)…`)
    }

    const { inserted, updated, skipped } = await processEvents(items, venueId, organizerId)
    await logUpsertResult('akron_art_museum', inserted, updated, skipped, {
      eventsFound: items.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('akron_art_museum', err, start)
    process.exit(1)
  }
}

main()
