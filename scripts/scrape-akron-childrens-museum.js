/**
 * scrape-akron-childrens-museum.js
 *
 * Scrapes upcoming events from the Akron Children's Museum website.
 * Platform: Drupal 8 — fetches the /calendar, /calendar/special-events,
 * and /calendar/programs listing pages and parses Drupal Views rows.
 *
 * Usage:
 *   node scripts/scrape-akron-childrens-museum.js
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
} from './lib/normalize.js'

const SITE_BASE  = 'https://akronkids.org'
const SOURCE_KEY = 'akron_childrens_museum'

// Pages to scrape — main calendar + sub-sections
const LISTING_PAGES = [
  `${SITE_BASE}/calendar`,
  `${SITE_BASE}/calendar/special-events`,
  `${SITE_BASE}/calendar/programs`,
]

// ── HTML fetch ────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; The330-bot/1.0)',
      Accept:       'text/html',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Parse listing page ────────────────────────────────────────────────────

/**
 * Parse events from a Drupal Views listing page.
 *
 * The Akron Children's Museum uses Drupal Views with these CSS classes:
 *   .views-row                     — each event card
 *   .views-field-title             — event title
 *   .views-field-field-dates       — date range (e.g. "April 25, April 26")
 *   .views-field-field-repeat-info — recurring schedule (e.g. "Every Thursday")
 *   .views-field-field-event-times — time range (e.g. "5:00pm - 8:00pm")
 *   .views-field-field-cost        — cost info
 *   .views-field-body              — description text
 *   .views-field-field-images img  — event image
 *   a[href*="/calendar/"]          — detail page link
 */
export function parseListingHtml(html) {
  const events = []
  const seen = new Set()

  // Split by views-row boundaries
  const rowPattern = /<div[^>]*class="[^"]*views-row[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*views-row|<\/div>\s*<\/div>\s*<\/div>)/gi
  let match

  while ((match = rowPattern.exec(html)) !== null) {
    const block = match[1]

    // Skip announcements (no links to /calendar/ detail pages)
    if (!block.includes('/calendar/')) continue

    const title    = extractField(block, 'views-field-title') || extractField(block, 'views-field-field-title')
    if (!title) continue

    const dates    = extractField(block, 'views-field-field-dates')
    const repeat   = extractField(block, 'views-field-field-repeat-info')
    const times    = extractField(block, 'views-field-field-event-times')
    const cost     = extractField(block, 'views-field-field-cost')
    const body     = extractField(block, 'views-field-body')
    const category = extractField(block, 'views-field-field-event-category')

    // Image
    const imgMatch = block.match(/<img[^>]+src="([^"]+)"/)
    let imageUrl   = imgMatch?.[1] ?? null
    if (imageUrl && !imageUrl.startsWith('http')) {
      imageUrl = `${SITE_BASE}${imageUrl}`
    }

    // Detail page link
    const linkMatch = block.match(/href="(\/calendar\/[^"]+)"/)
    const detailUrl = linkMatch ? `${SITE_BASE}${linkMatch[1]}` : null

    // Deduplicate by title + dates (the same event can appear on multiple listing pages)
    const dedupeKey = `${title}|${dates}|${repeat}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    events.push({
      title:     stripHtml(title),
      dates:     dates ? stripHtml(dates) : null,
      repeat:    repeat ? stripHtml(repeat) : null,
      times:     times ? stripHtml(times) : null,
      cost:      cost ? stripHtml(cost) : null,
      body:      body ? stripHtml(body) : null,
      category:  category ? stripHtml(category) : null,
      imageUrl,
      detailUrl,
    })
  }

  return events
}

/** Extract text from a Drupal Views field by class name */
function extractField(html, className) {
  // Match the entire div with the specified class
  const pattern = new RegExp(
    `<[^>]*class="[^"]*${className}[^"]*"[^>]*>([\\s\\S]*?)(?=<[^>]*class="[^"]*views-field|$)`,
    'i'
  )
  const m = html.match(pattern)
  if (!m) return null
  const content = m[1].trim()
  return content || null
}

// ── Date parsing ──────────────────────────────────────────────────────────

const MONTH_MAP = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7,
  sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
}

/**
 * Parse date strings from the museum's listing.
 * Handles:
 *   "April 25, April 26"        → first date
 *   "Every Thursday"            → next occurrence
 *   "May 3"                     → that date
 *   "June 14 - June 15"        → first date
 *
 * Returns ISO date string or null.
 */
export function parseDateString(dateStr, repeatStr) {
  // Try specific dates first
  if (dateStr) {
    const dateMatch = dateStr.match(/([A-Za-z]+)\s+(\d{1,2})/)
    if (dateMatch) {
      const monthIdx = MONTH_MAP[dateMatch[1].toLowerCase()]
      if (monthIdx !== undefined) {
        const day  = parseInt(dateMatch[2], 10)
        const now  = new Date()
        // Try current year, then next year
        for (let offset = 0; offset <= 1; offset++) {
          const year = now.getFullYear() + offset
          const d    = new Date(Date.UTC(year, monthIdx, day))
          if (d >= new Date(now.toISOString().split('T')[0] + 'T00:00:00Z')) {
            return d.toISOString().split('T')[0]
          }
        }
      }
    }
  }

  // Handle recurring events ("Every Thursday", "Every Saturday", etc.)
  if (repeatStr) {
    const dayMatch = repeatStr.match(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i)
    if (dayMatch) {
      const targetDay = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday']
        .indexOf(dayMatch[1].toLowerCase())
      if (targetDay >= 0) {
        const now   = new Date()
        const today = now.getDay()
        let diff    = targetDay - today
        if (diff <= 0) diff += 7
        const next = new Date(now)
        next.setDate(now.getDate() + diff)
        return next.toISOString().split('T')[0]
      }
    }
  }

  return null
}

/**
 * Parse time string like "5:00pm - 8:00pm" → { startTime: "17:00:00", endTime: "20:00:00" }
 */
export function parseTimeRange(timeStr) {
  if (!timeStr) return { startTime: null, endTime: null }

  const timePattern = /(\d{1,2}):(\d{2})\s*(am|pm)/gi
  const matches = [...timeStr.matchAll(timePattern)]

  function toHour(hr, min, mer) {
    let h = parseInt(hr, 10)
    if (mer.toLowerCase() === 'pm' && h !== 12) h += 12
    if (mer.toLowerCase() === 'am' && h === 12) h = 0
    return `${String(h).padStart(2, '0')}:${min}:00`
  }

  const startTime = matches[0] ? toHour(matches[0][1], matches[0][2], matches[0][3]) : null
  const endTime   = matches[1] ? toHour(matches[1][1], matches[1][2], matches[1][3]) : null

  return { startTime, endTime }
}

/**
 * Parse cost string like "Cost: Free for members! $8 for regular admission."
 * Returns { price_min, price_max }
 */
export function parseCost(costStr) {
  if (!costStr) return { price_min: null, price_max: null }

  const lower = costStr.toLowerCase()
  if (lower.includes('free') && !lower.includes('$')) return { price_min: 0, price_max: null }

  const prices = [...costStr.matchAll(/\$(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1]))
  if (prices.length === 0) {
    if (lower.includes('free')) return { price_min: 0, price_max: null }
    return { price_min: null, price_max: null }
  }

  const min = Math.min(...prices)
  const max = Math.max(...prices)
  // If there's a "free" option alongside paid, min is 0
  if (lower.includes('free')) return { price_min: 0, price_max: max }
  return { price_min: min, price_max: max > min ? max : null }
}

/** Map ACM event category to our category enum */
export function mapCategory(categoryStr, title = '') {
  const lower = (categoryStr || title).toLowerCase()
  if (lower.includes('program')) return 'education'
  if (lower.includes('special event') || lower.includes('fundrais')) return 'community'
  // Museum is primarily education/family
  return 'education'
}

// ── Normalise ─────────────────────────────────────────────────────────────

import { easternToIso } from './lib/normalize.js'

export function normaliseEvent(parsed) {
  const date = parseDateString(parsed.dates, parsed.repeat)
  if (!date) return null

  const { startTime, endTime } = parseTimeRange(parsed.times)

  const startAt = startTime
    ? easternToIso(`${date} ${startTime}`)
    : easternToIso(`${date} 10:00:00`)   // default to museum opening time

  const endAt = endTime
    ? easternToIso(`${date} ${endTime}`)
    : null

  const { price_min, price_max } = parseCost(parsed.cost)
  const category = mapCategory(parsed.category, parsed.title)

  const tags = ['akron', 'children', 'family', 'museum']
  if (parsed.repeat) tags.push('recurring')
  if (category === 'education') tags.push('education')

  // Build a stable source_id from the detail URL path or title
  const sourceId = parsed.detailUrl
    ? parsed.detailUrl.replace(SITE_BASE, '').replace(/^\//, '')
    : parsed.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')

  return {
    title:           parsed.title,
    description:     parsed.body || null,
    start_at:        startAt,
    end_at:          endAt,
    category,
    tags:            [...new Set(tags)],
    price_min,
    price_max,
    age_restriction: 'all_ages',
    image_url:       parsed.imageUrl,
    ticket_url:      parsed.detailUrl || `${SITE_BASE}/calendar`,
    source:          SOURCE_KEY,
    source_id:       sourceId,
    status:          'published',
    featured:        false,
  }
}

// ── Process events ────────────────────────────────────────────────────────

async function processEvents(parsedEvents, venueId, organizerId) {
  let inserted = 0, skipped = 0

  for (const parsed of parsedEvents) {
    try {
      const row = normaliseEvent(parsed)
      if (!row || !row.start_at) {
        skipped++
        continue
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
      console.warn(`  ⚠ Error processing "${parsed.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ──────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Akron Children\'s Museum ingestion…')
  const start = Date.now()

  try {
    const venueId = await ensureVenue("Akron Children's Museum", {
      address: '216 S Main St',
      city:    'Akron',
      state:   'OH',
      zip:     '44308',
      lat:     41.0793,
      lng:     -81.5192,
      website: 'https://akronkids.org',
    })

    const organizerId = await ensureOrganization("Akron Children's Museum", {
      website:     'https://akronkids.org',
      description: "The Akron Children's Museum offers interactive exhibits and programs for children and families, fostering learning through play in downtown Akron.",
    })

    await linkOrganizationVenue(organizerId, venueId)

    let allParsed = []
    for (const pageUrl of LISTING_PAGES) {
      console.log(`\n🔍  Fetching ${pageUrl}…`)
      try {
        const html   = await fetchHtml(pageUrl)
        const parsed = parseListingHtml(html)
        console.log(`  Found ${parsed.length} events`)
        allParsed.push(...parsed)
      } catch (err) {
        console.warn(`  ⚠ Could not fetch ${pageUrl}:`, err.message)
      }

      await new Promise(r => setTimeout(r, 500)) // polite delay
    }

    // Deduplicate across pages (parseListingHtml already dedupes within a page)
    const seen = new Set()
    allParsed = allParsed.filter(ev => {
      const key = `${ev.title}|${ev.dates}|${ev.repeat}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    console.log(`\n📥  Processing ${allParsed.length} unique events…`)
    const { inserted, skipped } = await processEvents(allParsed, venueId, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: allParsed.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

main()
