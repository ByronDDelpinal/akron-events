/**
 * scrape-downtown-akron.js
 *
 * Scrapes upcoming events from the Downtown Akron Partnership calendar.
 * Platform: CityInsight CMS (ctycms.com) — events rendered server-side as HTML cards.
 *
 * Fetches the current month plus the next 2 months for coverage.
 *
 * Usage:
 *   node scripts/scrape-downtown-akron.js
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
  easternToIso,
} from './lib/normalize.js'

const BASE_URL = 'https://www.downtownakron.com'

// ── Helpers ────────────────────────────────────────────────────────────────

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

// Short month abbreviations as used in the ctycms DOM:
// "Sunday 22 Mar" → day-of-week, day number, month abbrev
function reconstructDate(dayNum, monthAbbr) {
  const m = MONTH_MAP[monthAbbr.toLowerCase()]
  if (!m) return null
  const now   = new Date()
  let   year  = now.getFullYear()
  const d     = parseInt(dayNum, 10)
  // If this month+day combination is in the past this year, move to next year
  const candidate = new Date(Date.UTC(year, m - 1, d))
  const today     = new Date(now.toISOString().split('T')[0] + 'T00:00:00Z')
  if (candidate < today) year++
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * Parse time from strings like "2 p.m.", "7:30 p.m.", "noon", "2 p.m. - 11 p.m."
 * Returns the start time as HH:MM:00 or "12:00:00" fallback.
 */
function parseTime(raw) {
  if (!raw) return '12:00:00'
  const s = raw.trim().toLowerCase()

  if (s.includes('noon')) return '12:00:00'
  if (s.includes('midnight')) return '00:00:00'

  // Handle "X p.m." or "X:XX p.m." — extract just the start time
  const match = s.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/)
  if (match) {
    let hr  = parseInt(match[1], 10)
    const m = match[2] ?? '00'
    const isPm = /p/i.test(match[3])
    if (isPm && hr !== 12) hr += 12
    if (!isPm && hr === 12) hr = 0
    return `${String(hr).padStart(2, '0')}:${m}:00`
  }

  return '12:00:00'
}

function parseCategory(title = '') {
  const lower = title.toLowerCase()
  if (/concert|music|jazz|band|festival|symphony|orchestra/.test(lower)) return 'music'
  if (/art|exhibit|gallery|film|movie|theatre|play|performance|ballet|dance/.test(lower)) return 'art'
  if (/food|tasting|market|brew|wine|culinary/.test(lower)) return 'food'
  if (/run|race|walk|bike|5k|marathon/.test(lower)) return 'sports'
  if (/storytime|story time|family|kids|children/.test(lower)) return 'community'
  if (/gala|benefit|fundrais|nonprofit|charity/.test(lower)) return 'nonprofit'
  return 'community'
}

// ── Venue cache ────────────────────────────────────────────────────────────

const venueCache = new Map()

async function ensureVenueByName(venueName) {
  if (!venueName) return null
  const name = venueName.trim()
  if (venueCache.has(name)) return venueCache.get(name)

  // Create a minimal venue record — we don't have full address data from DAP calendar
  const venueId = await ensureVenue(name, {
    city:         'Akron',
    state:        'OH',
    parking_type: 'unknown',
  })

  venueCache.set(name, venueId)
  return venueId
}

async function ensureDapOrganizer() {
  return ensureOrganization('Downtown Akron Partnership', {
    website:     'https://www.downtownakron.com',
    description: "The Downtown Akron Partnership promotes events, culture, and entertainment in downtown Akron's 49-block district.",
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

// ── Parse event cards ──────────────────────────────────────────────────────

/**
 * The ctycms calendar page renders events as <a href="/event/{slug}"> elements.
 * The innerText of each link contains tab/newline-separated fields:
 *   title
 *   time / venue
 *   View Details
 *   day-of-week \t day-number \t month-abbr
 *
 * Example innerText:
 *   "Man of LaMancha\n\t\t2 p.m. / Ohio Shakespeare Festival\n\t\tView Details\n\t\n\t\t\tSunday\t\t22\t\tMar"
 */
function parseCalendarHtml(html) {
  const events = []

  // Find all event links
  const linkPattern = /<a[^>]*href="(\/event\/([^"/?#]+))[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
  const matches     = [...html.matchAll(linkPattern)]

  for (const match of matches) {
    const slug      = match[2]
    const linkHref  = BASE_URL + match[1]
    const innerHtml = match[3]

    // Extract text content and split into parts
    const text = stripHtml(innerHtml)
    const parts = text.split(/[\n\t]+/).map(p => p.trim()).filter(Boolean)

    if (parts.length < 3) continue

    // First non-empty, non-"View Details" part is the title
    const title = parts.find(p => p.toLowerCase() !== 'view details' && p.length > 2)
    if (!title) continue

    // Find the time/venue line (contains " / " separator)
    const timeVenuePart = parts.find(p => p.includes(' / '))
    let   timeStr  = '12:00:00'
    let   venueName = null

    if (timeVenuePart) {
      const [timePart, ...venueParts] = timeVenuePart.split(' / ')
      timeStr   = parseTime(timePart)
      venueName = venueParts.join(' / ').trim() || null
    }

    // Find date parts — look for day number and month abbreviation
    // ctycms renders like: "Sunday\t\t22\t\tMar" or "22\tMar"
    // Search for a number 1-31 followed by a month abbreviation
    const remaining = parts.filter(p => p !== title && !p.includes(' / ') && p.toLowerCase() !== 'view details')
    let dayNum  = null
    let monthAb = null

    for (const part of remaining) {
      // Check for numeric day
      const numMatch = part.match(/^(\d{1,2})$/)
      if (numMatch) { dayNum = numMatch[1]; continue }

      // Check for month abbreviation
      const monKey = part.toLowerCase().trim()
      if (MONTH_MAP[monKey]) { monthAb = monKey; continue }
    }

    // Also try to match from the full text with a combined pattern
    if (!dayNum || !monthAb) {
      const combined = parts.join(' ')
      const dateMatch = combined.match(/\b(\d{1,2})\s+([A-Za-z]{3,})\b/)
      if (dateMatch) {
        const candidate = dateMatch[2].toLowerCase()
        if (MONTH_MAP[candidate]) {
          dayNum  = dayNum  || dateMatch[1]
          monthAb = monthAb || candidate
        }
      }
      // Also try "MonthAbbr DayNum" ordering
      const dateMatch2 = combined.match(/\b([A-Za-z]{3,})\s+(\d{1,2})\b/)
      if (dateMatch2 && MONTH_MAP[dateMatch2[1].toLowerCase()]) {
        dayNum  = dayNum  || dateMatch2[2]
        monthAb = monthAb || dateMatch2[1].toLowerCase()
      }
    }

    if (!dayNum || !monthAb) continue

    const dateStr = reconstructDate(dayNum, monthAb)
    if (!dateStr) continue

    events.push({ title, dateStr, timeStr, venueName, slug, linkHref })
  }

  return events
}

// ── Build month URLs ───────────────────────────────────────────────────────

function getMonthUrls() {
  const urls  = [`${BASE_URL}/calendar`]
  const now   = new Date()

  for (let i = 1; i <= 2; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    urls.push(`${BASE_URL}/calendar?month=${month}`)
  }

  return urls
}

// ── Process ────────────────────────────────────────────────────────────────

async function processEvents(events, organizerId) {
  let inserted = 0, skipped = 0

  for (const ev of events) {
    try {
      const venueId = await ensureVenueByName(ev.venueName)
      const startAt = easternToIso(ev.dateStr, ev.timeStr)
      if (!startAt) { skipped++; continue }

      const row = {
        title:           ev.title,
        description:     null,
        start_at:        startAt,
        end_at:          null,
        category:        parseCategory(ev.title),
        tags:            ['downtown-akron', 'akron', ...(ev.venueName ? [ev.venueName.toLowerCase()] : [])],
        price_min:       0,
        price_max:       null,
        age_restriction: 'not_specified',
        image_url:       null,
        ticket_url:      ev.linkHref,
        source:          'downtown_akron',
        source_id:       ev.slug,
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
  console.log('🚀  Starting Downtown Akron Partnership ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureDapOrganizer()

    const monthUrls = getMonthUrls()
    const allEvents = []
    const seenSlugs = new Set()

    for (const url of monthUrls) {
      console.log(`\n🔍  Fetching ${url}…`)
      try {
        const html   = await fetchHtml(url)
        const events = parseCalendarHtml(html)
        console.log(`  Found ${events.length} events`)

        for (const ev of events) {
          if (!seenSlugs.has(ev.slug)) {
            seenSlugs.add(ev.slug)
            allEvents.push(ev)
          }
        }
      } catch (fetchErr) {
        console.warn(`  ⚠ Could not fetch ${url}:`, fetchErr.message)
      }

      // Polite delay between requests
      await new Promise(r => setTimeout(r, 500))
    }

    // Filter out past events
    const now     = new Date()
    const today   = now.toISOString().split('T')[0]
    const future  = allEvents.filter(ev => ev.dateStr >= today)
    console.log(`\n  Total unique future events: ${future.length} (from ${allEvents.length} total found)`)

    if (future.length === 0) {
      console.warn('  ⚠ No future events found. Calendar page structure may have changed.')
    }

    console.log(`\n📥  Processing ${future.length} events…`)
    const { inserted, skipped } = await processEvents(future, organizerId)

    await logUpsertResult('downtown_akron', inserted, 0, skipped, {
      eventsFound: future.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('downtown_akron', err, start)
    process.exit(1)
  }
}

main()
