/**
 * scrape-blu-jazz.js
 *
 * Fetches upcoming events from BLU Jazz+ (blujazzakron.com).
 *
 * BLU Jazz+ manages ticketing through TurnTable Tickets, which renders all
 * upcoming shows as a single server-side HTML page at:
 *   https://blu-jazz.turntabletickets.com/
 *
 * The page requires no authentication. Each event card has an `id` attribute
 * of the form `show-{id}-{YYYY-MM-DD}`, and the description text contains
 * structured patterns like "Doors: 7:00pm", "Show: 8:00pm", "Tickets: $20".
 *
 * Strategy:
 *   1. Fetch the show-list HTML page (typically ~15 events, ~4-6 weeks out).
 *   2. Split into individual cards using the `id="show-..."` anchor pattern.
 *   3. Parse title, date, show time, price, image, and description from each card.
 *   4. Convert Eastern time → UTC using a DST-aware helper.
 *   5. Upsert to Supabase.
 *
 * Usage:
 *   node scripts/scrape-blu-jazz.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { logUpsertResult, logScraperError, stripHtml } from './lib/normalize.js'

const SHOWS_URL = 'https://blu-jazz.turntabletickets.com/'

// ── DST-aware Eastern → UTC conversion ───────────────────────────────────
// (same logic as scrape-akron-library.js)

function nthWeekdayOfMonth(year, month, dayOfWeek, n) {
  const first  = new Date(Date.UTC(year, month, 1))
  const offset = (dayOfWeek - first.getUTCDay() + 7) % 7
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7))
}

function isEasternDST(utcDate) {
  const y        = utcDate.getUTCFullYear()
  const dstStart = nthWeekdayOfMonth(y, 2, 0, 2)   // 2nd Sunday in March
  const dstEnd   = nthWeekdayOfMonth(y, 10, 0, 1)  // 1st Sunday in November
  return utcDate >= dstStart && utcDate < dstEnd
}

/**
 * Convert a local Eastern date+time string like "2026-03-26 20:00:00"
 * to a UTC ISO string. Correctly handles EST (UTC-5) vs EDT (UTC-4).
 */
function easternToIso(dateStr, timeStr) {
  // Normalise "8:00pm" → "20:00"
  const normalised = timeStr.trim().replace(
    /^(\d{1,2}):(\d{2})\s*(am|pm)$/i,
    (_, h, m, meridiem) => {
      let hour = parseInt(h, 10)
      if (meridiem.toLowerCase() === 'pm' && hour !== 12) hour += 12
      if (meridiem.toLowerCase() === 'am' && hour === 12) hour = 0
      return `${String(hour).padStart(2, '0')}:${m}:00`
    }
  )

  const [year, month, day]         = dateStr.split('-').map(Number)
  const [hour, minute, second = 0] = normalised.split(':').map(Number)

  const localUtcMs = Date.UTC(year, month - 1, day, hour, minute, second)
  // Approximate UTC to determine DST (close enough — the offset is only 1 hour)
  const approxUtc     = new Date(localUtcMs + 5 * 3_600_000)
  const offsetHours   = isEasternDST(approxUtc) ? 4 : 5
  return new Date(localUtcMs + offsetHours * 3_600_000).toISOString()
}

// ── HTML helpers ──────────────────────────────────────────────────────────
// stripHtml imported from normalize.js — handles all named + numeric HTML entities

/** Pull the innerText equivalent from a raw HTML chunk */
function textOf(html) {
  return stripHtml(html)
}

// ── Card parsing ──────────────────────────────────────────────────────────

/**
 * Given the raw HTML of a single show-card chunk, return a structured object
 * (or null if we can't extract enough data).
 */
function parseCard(cardHtml) {
  // ── ID and date ──────────────────────────────────────────────────────
  const idMatch = cardHtml.match(/id="show-(\d+)-(\d{4}-\d{2}-\d{2})"/)
  if (!idMatch) return null
  const [, showId, showDate] = idMatch

  // ── Title ────────────────────────────────────────────────────────────
  const titleMatch = cardHtml.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i)
  const title = titleMatch ? stripHtml(titleMatch[1]).trim() : null
  if (!title) return null

  // ── Image (prefer full-size img src over webp srcset) ────────────────
  // TurnTable asset pattern: assets-prod.turntabletickets.com/media/blu-jazz/...
  const imgMatch = cardHtml.match(
    /<img\b[^>]*\bsrc="(https:\/\/assets-prod\.turntabletickets\.com\/[^"]+\.(jpe?g|png|gif|webp))"/i
  )
  const imageUrl = imgMatch ? imgMatch[1] : null

  // ── Raw text (for time / price extraction) ────────────────────────────
  const rawText = textOf(cardHtml)

  // ── Show time  ────────────────────────────────────────────────────────
  // Format in description: "Show: 8:00pm"  or  "07:00 PM SHOW"
  const showTimeMatch =
    rawText.match(/\bShow:\s*(\d{1,2}:\d{2}\s*(?:am|pm))/i) ||
    rawText.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))\s+SHOW\b/i)
  const showTimeStr = showTimeMatch ? showTimeMatch[1].trim() : null

  // ── Doors time (used to derive event end estimate if no explicit end) ─
  const doorsTimeMatch = rawText.match(/\bDoors:\s*(\d{1,2}:\d{2}\s*(?:am|pm))/i)
  const doorsTimeStr = doorsTimeMatch ? doorsTimeMatch[1].trim() : null

  // ── Price ─────────────────────────────────────────────────────────────
  let priceMin = null
  let priceMax = null

  const freeMatch = rawText.match(/\bfree\s+admission\b|\bno\s+cover\b|\bno\s+charge\b|\bfree\s+to\s+attend\b/i)
  if (freeMatch) {
    priceMin = 0
    priceMax = 0
  } else {
    // "$15 in advance, $20 day of show" → min=$15, max=$20
    const advanceMatch = rawText.match(/\$(\d+(?:\.\d+)?)\s+in\s+advance/i)
    const doorMatch    = rawText.match(/\$(\d+(?:\.\d+)?)\s+(?:at\s+the\s+)?door/i)
    const generalMatch = rawText.match(/\$(\d+(?:\.\d+)?)(?:\s+(?:general|admission|per\s+person|pp))?/i)

    if (advanceMatch) priceMin = parseFloat(advanceMatch[1])
    if (doorMatch)    priceMax = parseFloat(doorMatch[1])
    if (!priceMin && generalMatch) priceMin = parseFloat(generalMatch[1])
    if (!priceMax && priceMin !== null) priceMax = priceMin
  }

  // ── Description ───────────────────────────────────────────────────────
  // The full text includes the title, date, and times. Extract a clean
  // description by taking the block before "Doors:" or after the date header.
  let description = null
  const descBlockMatch = rawText.match(
    /(?:(?:mon|tue|wed|thu|fri|sat|sun),\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d+\s*)([\s\S]*?)(?:\s*Doors:|$)/i
  )
  if (descBlockMatch) {
    description = descBlockMatch[1].trim().replace(/\s+/g, ' ') || null
  }
  // Fallback: use the full raw text minus the title
  if (!description) {
    description = rawText.replace(title, '').replace(/\s+/g, ' ').trim() || null
  }
  // Trim to something reasonable
  if (description && description.length > 1200) {
    description = description.substring(0, 1197) + '…'
  }

  return { showId, showDate, title, showTimeStr, doorsTimeStr, priceMin, priceMax, description, imageUrl }
}

// ── Fetch and split HTML into cards ──────────────────────────────────────

async function fetchCards() {
  console.log('\n🔍  Fetching BLU Jazz+ show list…')
  const res = await fetch(SHOWS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; The330-bot/1.0)' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)

  const html = await res.text()

  // Locate every show-card by its unique id attribute
  const cardStarts = []
  const idPattern  = /id="show-\d+-\d{4}-\d{2}-\d{2}"/g
  let match
  while ((match = idPattern.exec(html)) !== null) {
    cardStarts.push(match.index)
  }

  if (!cardStarts.length) {
    throw new Error('No show-card elements found on the page — the HTML structure may have changed.')
  }

  // Extract each card's HTML chunk (from its id= to the start of the next card)
  const cards = cardStarts.map((start, i) => {
    const end = i < cardStarts.length - 1 ? cardStarts[i + 1] : html.length
    return html.slice(start, end)
  })

  console.log(`  Found ${cards.length} show cards`)
  return cards
}

// ── Venue / Organizer ─────────────────────────────────────────────────────

async function ensureVenue() {
  const { data: existing } = await supabaseAdmin
    .from('venues').select('id').eq('name', 'BLU Jazz+').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('venues').insert({
    name:          'BLU Jazz+',
    address:       '47 E Market St',
    city:          'Akron',
    state:         'OH',
    zip:           '44308',
    lat:           41.0831,
    lng:           -81.5186,
    parking_type:  'street',
    parking_notes: 'Street parking on E Market St. Canal Park parking garage is 2 blocks away.',
    website:       'https://blujazzakron.com',
    description:   'Akron\'s dedicated jazz venue in the Historic Arts District, featuring world-class jazz, blues, and beyond in an intimate listening room setting.',
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create BLU Jazz+ venue:', error.message); return null }
  console.log('  ✚ Created BLU Jazz+ venue')
  return data.id
}

async function ensureOrganizer() {
  const { data: existing } = await supabaseAdmin
    .from('organizers').select('id').eq('name', 'BLU Jazz+').maybeSingle()
  if (existing) return existing.id

  const { data, error } = await supabaseAdmin.from('organizers').insert({
    name:        'BLU Jazz+',
    website:     'https://blujazzakron.com',
    description: "Akron's premier jazz venue presenting world-class local and touring jazz artists.",
  }).select('id').single()

  if (error) { console.warn('  ⚠ Could not create BLU Jazz+ organizer:', error.message); return null }
  console.log('  ✚ Created BLU Jazz+ organizer')
  return data.id
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting BLU Jazz+ ingestion…')
  const start = Date.now()
  let cardHtmls = []

  try {
    const [venueId, organizerId] = await Promise.all([ensureVenue(), ensureOrganizer()])

    cardHtmls = await fetchCards()

    let inserted = 0, skipped = 0

    for (const cardHtml of cardHtmls) {
      const ev = parseCard(cardHtml)
      if (!ev) { skipped++; continue }

      const { showId, showDate, title, showTimeStr, doorsTimeStr, priceMin, priceMax,
              description, imageUrl } = ev

      // Build UTC timestamps
      // Use show time if available; fall back to doors time + 1 hour; last resort noon
      const effectiveShowTime = showTimeStr ?? (doorsTimeStr ? addHour(doorsTimeStr) : '12:00pm')
      let startAt, endAt = null

      try {
        startAt = easternToIso(showDate, effectiveShowTime)
        // Estimate end time as 3 hours after show start if no explicit end
        endAt = new Date(new Date(startAt).getTime() + 3 * 3_600_000).toISOString()
      } catch {
        console.warn(`  ⚠ Could not parse time for "${title}" on ${showDate} — skipping`)
        skipped++
        continue
      }

      const ticketUrl = `https://blu-jazz.turntabletickets.com/shows/${showId}/?date=${showDate}`

      const row = {
        title,
        description,
        start_at:        startAt,
        end_at:          endAt,
        venue_id:        venueId,
        organizer_id:    organizerId,
        category:        'music',
        tags:            ['jazz', 'live music', 'blu jazz+'],
        price_min:       priceMin,
        price_max:       priceMax,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ticketUrl,
        source:          'blu_jazz',
        source_id:       `${showId}_${showDate}`,  // date-scoped: same show can repeat
        status:          'published',
        featured:        false,
      }

      const { error } = await supabaseAdmin
        .from('events')
        .upsert(row, { onConflict: 'source,source_id', ignoreDuplicates: false })

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${title}":`, error.message)
        skipped++
      } else {
        inserted++
        console.log(`  ✓ ${showDate}  ${title}`)
      }
    }

    await logUpsertResult('blu_jazz', inserted, 0, skipped, {
      eventsFound: cardHtmls.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('blu_jazz', err, start)
    process.exit(1)
  }
}

/** Add one hour to a time string like "7:00pm" → "8:00pm" */
function addHour(timeStr) {
  const m = timeStr.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i)
  if (!m) return timeStr
  let h = parseInt(m[1], 10)
  const min = m[2]
  let meridiem = m[3].toLowerCase()
  h += 1
  if (h === 12) meridiem = 'pm'
  if (h > 12)   { h -= 12; if (meridiem === 'am') meridiem = 'pm' }
  return `${h}:${min}${meridiem}`
}

main()
