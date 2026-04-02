/**
 * scrape-ohio-shakespeare.js
 *
 * Scrapes upcoming productions from the Ohio Shakespeare Festival website.
 * Platform: Squarespace — fetches the homepage for show links, then each
 * individual production page for dates and details.
 *
 * Usage:
 *   node scripts/scrape-ohio-shakespeare.js
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

const BASE_URL   = 'https://www.ohioshakespearefestival.com'
const HOME_URL   = `${BASE_URL}/`

// Pages that are NOT individual productions — skip these
const NON_SHOW_SLUGS = new Set([
  'subscription', 'subscribe', 'programs', 'workshops', 'workshop',
  'resources', 'shakesbeer', 'donate', 'about', 'contact', 'season',
  'tickets', 'box-office', 'education', 'auditions',
])

// ── Helpers ────────────────────────────────────────────────────────────────

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

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

/**
 * Parse a date string from a show page.
 * Handles: "March 5-29", "June 18 - July 12", "Friday, April 3, 2026 8pm",
 *          "March 5", "April 3, 2026"
 * Returns the opening night as "YYYY-MM-DD" or null.
 */
function parseDateString(raw) {
  if (!raw) return null
  const s = raw.trim()

  // Strip leading day-of-week
  const stripped = s.replace(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),?\s*/i, '')

  // Pattern: "Month DD, YYYY" possibly followed by time
  const exactYearMatch = stripped.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (exactYearMatch) {
    const [, mon, day, year] = exactYearMatch
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) return `${year}-${String(m).padStart(2,'0')}-${String(parseInt(day)).padStart(2,'0')}`
  }

  // Pattern: "Month DD-DD" or "Month DD - DD" or "Month DD - Month DD"
  const rangeMatch = stripped.match(/^([A-Za-z]+)\s+(\d{1,2})\s*[-–]/)
  if (rangeMatch) {
    const [, mon, day] = rangeMatch
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) {
      const year = inferYear(m, parseInt(day))
      if (year) return `${year}-${String(m).padStart(2,'0')}-${String(parseInt(day)).padStart(2,'0')}`
    }
  }

  // Pattern: "Month DD" alone
  const singleMatch = stripped.match(/^([A-Za-z]+)\s+(\d{1,2})$/)
  if (singleMatch) {
    const [, mon, day] = singleMatch
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) {
      const year = inferYear(m, parseInt(day))
      if (year) return `${year}-${String(m).padStart(2,'0')}-${String(parseInt(day)).padStart(2,'0')}`
    }
  }

  return null
}

/**
 * Extract a time string from raw text like "8pm", "7:30pm", "2pm".
 * Returns "HH:MM:00" or null.
 */
function parseTime(text) {
  const match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  if (!match) return null
  let hr  = parseInt(match[1], 10)
  const m = match[2] ?? '00'
  const mer = match[3].toLowerCase()
  if (mer === 'pm' && hr !== 12) hr += 12
  if (mer === 'am' && hr === 12) hr = 0
  return `${String(hr).padStart(2, '0')}:${m}:00`
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

// ── Venue cache ────────────────────────────────────────────────────────────

const venueCache = new Map()

const KNOWN_VENUES = {
  'greystone hall': {
    name:          'Greystone Hall',
    address:       '103 S High St',
    city:          'Akron', state: 'OH', zip: '44308',
    lat:           41.0804, lng: -81.5185,
    parking_type:  'garage',
    parking_notes: 'City parking garages on S High St.',
    website:       'https://www.greystonehall.org',
  },
  'stan hywet': {
    name:          'Stan Hywet Hall & Gardens',
    address:       '714 N Portage Path',
    city:          'Akron', state: 'OH', zip: '44303',
    lat:           41.1048, lng: -81.5570,
    parking_type:  'lot',
    parking_notes: 'Free on-site parking.',
    website:       'https://stanhywet.org',
  },
}

async function ensureVenueByKeyword(pageText) {
  // Detect venue from page content keywords
  let venueKey = 'greystone hall' // default
  if (/stan hywet/i.test(pageText)) venueKey = 'stan hywet'

  if (venueCache.has(venueKey)) return venueCache.get(venueKey)

  const info = KNOWN_VENUES[venueKey]
  const venueId = await ensureVenue(info.name, info)
  venueCache.set(venueKey, venueId)
  return venueId
}

async function ensureOsfOrganizer() {
  return ensureOrganization('Ohio Shakespeare Festival', {
    website:     'https://www.ohioshakespearefestival.com',
    description: 'Ohio Shakespeare Festival is a professional theatre company in Akron, Ohio, celebrating its 25th anniversary season with a diverse repertoire from Shakespeare to contemporary musicals.',
  })
}

// ── Find show slugs on homepage ────────────────────────────────────────────

function extractShowSlugs(homeHtml) {
  const slugs = new Set()

  // Find all internal links that look like show pages
  const linkPattern = /href="https?:\/\/(?:www\.)?ohioshakespearefestival\.com\/([^"/?#]+)"/gi
  const relLinkPattern = /href="\/([^"/?#]+)"/gi

  for (const pattern of [linkPattern, relLinkPattern]) {
    for (const match of homeHtml.matchAll(pattern)) {
      const slug = match[1].trim().toLowerCase()
      if (!slug || slug.length < 2) continue
      if (NON_SHOW_SLUGS.has(slug)) continue
      if (/^(#|mailto:|tel:)/.test(slug)) continue
      // Skip slugs with common non-show patterns
      if (/^(page|tag|category|author|feed|wp-|admin|css|js|img|fonts)/.test(slug)) continue
      slugs.add(slug)
    }
  }

  return [...slugs]
}

// ── Parse individual show page ─────────────────────────────────────────────

function parseShowPage(html, slug) {
  // Get og:image meta tag (Squarespace reliably has this)
  const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/) ??
                  html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:image"/)
  const imageUrl = ogImage ? ogImage[1] : null

  // Get page title from og:title or <title> or <h1>
  const ogTitle  = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/) ??
                   html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:title"/)
  let title      = ogTitle ? stripHtml(ogTitle[1]) : null
  if (!title) {
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    title = h1Match ? stripHtml(h1Match[1]) : null
  }
  if (!title) {
    const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    title = titleTag ? stripHtml(titleTag[1]).replace(/\s*[|–-].*$/, '').trim() : null
  }

  // Extract all text for date parsing
  const bodyText = stripHtml(html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, ''))

  // Try to find date patterns in the text
  // Common Squarespace patterns: "March 5-29", "June 18 - July 12", "April 3, 2026 8pm"
  const datePatterns = [
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}[^a-zA-Z]/gi,
  ]

  let dateStr  = null
  let timeStr  = '20:00:00'

  for (const pattern of datePatterns) {
    const matches = [...bodyText.matchAll(pattern)]
    for (const m of matches) {
      const raw    = m[0]
      const parsed = parseDateString(raw)
      if (parsed) {
        dateStr = parsed
        // Try to extract time from nearby context
        const context = bodyText.slice(Math.max(0, m.index - 20), m.index + 60)
        const t       = parseTime(context)
        if (t) timeStr = t
        break
      }
    }
    if (dateStr) break
  }

  // Extract first paragraph as description
  const pMatch    = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
  const descText  = pMatch ? stripHtml(pMatch[1]) : null

  return { title, dateStr, timeStr, imageUrl, descText, bodyText }
}

// ── Fetch and process shows ────────────────────────────────────────────────

async function fetchAndProcessShows(organizerId) {
  console.log(`\n🔍  Fetching homepage: ${HOME_URL}…`)
  const homeHtml = await fetchHtml(HOME_URL)
  const slugs    = extractShowSlugs(homeHtml)
  console.log(`  Found ${slugs.length} potential show slugs: ${slugs.join(', ')}`)

  const now     = new Date()
  const todayMs = new Date(now.toISOString().split('T')[0] + 'T00:00:00Z').getTime()

  const results  = []

  for (const slug of slugs) {
    const url = `${BASE_URL}/${slug}`
    try {
      await new Promise(r => setTimeout(r, 1000)) // polite 1s delay
      console.log(`  Fetching ${url}…`)
      const showHtml = await fetchHtml(url)
      const parsed   = parseShowPage(showHtml, slug)

      if (!parsed.title) {
        console.warn(`    ⚠ No title found for /${slug} — skipping`)
        continue
      }

      if (!parsed.dateStr) {
        console.warn(`    ⚠ No date found for "${parsed.title}" (/${slug}) — skipping`)
        continue
      }

      // Skip past shows
      if (new Date(parsed.dateStr).getTime() < todayMs) {
        console.log(`    (past) ${parsed.title} — skipping`)
        continue
      }

      const venueId  = await ensureVenueByKeyword(parsed.bodyText)
      const startAt  = easternToIso(parsed.dateStr, parsed.timeStr)

      if (!startAt) continue

      results.push({
        title:    parsed.title,
        desc:     parsed.descText,
        startAt,
        imageUrl: parsed.imageUrl,
        venueId,
        slug,
        url,
      })
      console.log(`    ✓ ${parsed.title} — ${parsed.dateStr}`)
    } catch (err) {
      console.warn(`    ⚠ Could not process ${url}:`, err.message)
    }
  }

  return results
}

// ── Upsert ─────────────────────────────────────────────────────────────────

async function upsertShows(shows, organizerId) {
  let inserted = 0, skipped = 0

  for (const show of shows) {
    try {
      const row = {
        title:           show.title,
        description:     show.desc || null,
        start_at:        show.startAt,
        end_at:          null,
        category:        'art',
        tags:            ['theatre', 'shakespeare', 'professional-theatre', 'akron', 'live-performance'],
        price_min:       15,
        price_max:       null,
        age_restriction: 'all_ages',
        image_url:       show.imageUrl,
        ticket_url:      show.url,
        source:          'ohio_shakespeare',
        source_id:       show.slug,
        status:          'published',
        featured:        false,
      }

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, show.venueId)
        await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error upserting "${show.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Ohio Shakespeare Festival ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOsfOrganizer()
    const shows       = await fetchAndProcessShows(organizerId)
    console.log(`\n📥  Upserting ${shows.length} shows…`)

    const { inserted, skipped } = await upsertShows(shows, organizerId)

    await logUpsertResult('ohio_shakespeare', inserted, 0, skipped, {
      eventsFound: shows.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError('ohio_shakespeare', err, start)
    process.exit(1)
  }
}

main()
