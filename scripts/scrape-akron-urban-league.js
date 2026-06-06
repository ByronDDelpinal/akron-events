/**
 * scrape-akron-urban-league.js
 *
 * Scrapes the Akron Urban League events calendar from their WordPress site.
 * Platform: WordPress 6.x (custom AUL theme — server-rendered HTML)
 *
 * Strategy:
 *   1. Fetch /home/events/ listing page and collect all unique event URLs
 *      by scanning for hrefs matching the /events/ and /events-archive/ patterns.
 *   2. Fetch each event detail page and extract title, date, time, venue,
 *      description, image, and registration link using og:* meta tags plus
 *      regex-based content parsing.
 *
 * Date/time notes:
 *   - AUL events are published on a small-batch basis; typically 5-15 active events.
 *   - Dates appear in the page body as "Month D, YYYY" (e.g., "January 19, 2026").
 *   - Times, when present, appear in copy as "7:30 AM", "1:00pm-4:00pm", etc.
 *   - article:published_time is the WP post date, NOT the event date — ignored.
 *
 * Usage:
 *   node scripts/scrape-akron-urban-league.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import {
  easternToIso,
  enrichWithImageDimensions,
  ensureOrganization,
  ensureVenue,
  inferCategory,
  linkEventOrganization,
  linkEventVenue,
  linkOrganizationVenue,
  logScraperError,
  logUpsertResult,
  stripHtml,
  upsertEventSafe,
} from './lib/normalize.js'

const BASE_URL    = 'https://www.akronurbanleague.org'
const LISTING_URL = `${BASE_URL}/home/events/`
const SOURCE_KEY  = 'akron_urban_league'
const DAYS_AHEAD  = 365

// ── HTTP helper ────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0)',
      'Accept':     'text/html,application/xhtml+xml',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Meta parsing ───────────────────────────────────────────────────────────

/**
 * Extract all <meta property="..." content="..."> and
 * <meta name="..." content="..."> values from raw HTML.
 */
function parseMeta(html) {
  const meta = {}
  // Handle both property= and name= variants; content may come before or after
  const patterns = [
    /<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"/gi,
    /<meta\s+content="([^"]*)"\s+(?:property|name)="([^"]+)"/gi,
  ]
  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      // First pattern: key=m[1], value=m[2]; second pattern: value=m[1], key=m[2]
      const [key, val] = re.source.startsWith('/<meta\\s+(?:property|name)')
        ? [m[1], m[2]]
        : [m[2], m[1]]
      if (key && !(key in meta)) meta[key] = val
    }
  }
  return meta
}

// ── Date / time parsing ────────────────────────────────────────────────────

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

/**
 * Find the first "Month D, YYYY" or "Month D YYYY" date in text.
 * Returns "YYYY-MM-DD" or null.
 */
function extractDate(text) {
  if (!text) return null
  const m = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})\b/i,
  )
  if (!m) return null
  const month = MONTH_MAP[m[1].toLowerCase()]
  if (!month) return null
  const day  = String(parseInt(m[2], 10)).padStart(2, '0')
  const year = m[3]
  return `${year}-${String(month).padStart(2, '0')}-${day}`
}

/**
 * Find the first time in text and return "HH:MM:00".
 * Handles: "7:30 AM", "8:00am", "1:00pm", "6 PM", "noon", "midnight".
 * Returns null if nothing found.
 */
function extractTime(text) {
  if (!text) return null
  const lower = text.toLowerCase()
  if (/\bnoon\b/.test(lower))     return '12:00:00'
  if (/\bmidnight\b/.test(lower)) return '00:00:00'

  const re = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/gi
  const matches = [...text.matchAll(re)]
  if (!matches.length) return null

  // Prefer a time where the immediately preceding ~40 chars mention "begin" or "start"
  // (e.g. "Breakfast Begins: 8:00 AM"). Using a short lookback avoids mistakenly
  // favouring an earlier time just because "Doors Open" appears anywhere before it.
  const preferred = matches.find(m => /begin|start/i.test(text.slice(Math.max(0, m.index - 40), m.index)))
    ?? matches[0]

  let hr      = parseInt(preferred[1], 10)
  const min   = preferred[2] ?? '00'
  const isPm  = /p/i.test(preferred[3])
  if (isPm && hr !== 12) hr += 12
  if (!isPm && hr === 12) hr = 0
  return `${String(hr).padStart(2, '0')}:${min}:00`
}

// ── Category / tag mapping ─────────────────────────────────────────────────

// Category: infer from title + description.
function mapCategory(title = '', desc = '') {
  return inferCategory(title, desc)
}

function mapTags(title = '', desc = '') {
  const t    = (title + ' ' + desc).toLowerCase()
  const tags = ['akron-urban-league', 'akron', 'community']
  if (/mlk|martin luther king|breakfast/.test(t))   tags.push('mlk', 'annual-breakfast')
  if (/juneteenth/.test(t))                          tags.push('juneteenth')
  if (/gala|champions of change/.test(t))            tags.push('gala', 'fundraiser')
  if (/business|entrepreneur|mbac|mccap/.test(t))    tags.push('business', 'entrepreneurship')
  if (/youth|kids|camp|summer/.test(t))              tags.push('youth')
  if (/workforce|job|career/.test(t))                tags.push('workforce-development')
  if (/santa|holiday|christmas/.test(t))             tags.push('holiday', 'family')
  if (/credible messenger/.test(t))                  tags.push('community-safety')
  if (/scholars|scholarship|luncheon/.test(t))       tags.push('education', 'scholarship')
  if (/seeds.*growth|growth.*seeds/.test(t))         tags.push('community-growth')
  return [...new Set(tags)]
}

// ── Listing page — collect event URLs ─────────────────────────────────────

/**
 * Scan listing page HTML for all unique event detail URLs.
 * Matches /events/<slug>/ and /events-archive/<slug>/ (excludes the listing page itself).
 */
function extractEventUrls(html) {
  const seen = new Set()
  const urls = []
  const re   = /href="(https:\/\/www\.akronurbanleague\.org\/events(?:-archive)?\/[^/"]+\/)"/g
  for (const m of html.matchAll(re)) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      urls.push(m[1])
    }
  }
  return urls
}

// ── Detail page — full event data ──────────────────────────────────────────

/**
 * Parse a single event detail page. Returns a plain object with all
 * scraped fields (may include nulls for fields not found).
 */
function parseDetailPage(html, eventUrl) {
  const meta = parseMeta(html)

  // ── Title ──────────────────────────────────────────────────────────────
  let title = (meta['og:title'] ?? '').replace(/\s*[-–|]\s*Akron Urban League\s*$/i, '').trim()
  if (!title) {
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
    title = h1 ? stripHtml(h1[1]).trim() : ''
  }

  // ── Image ──────────────────────────────────────────────────────────────
  const imageUrl = meta['og:image'] ?? null

  // ── Description ────────────────────────────────────────────────────────
  let description = meta['og:description'] ?? null
  // og:description often leads with the title — strip it for cleaner copy
  if (description && title) {
    const safePfx = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    description = description.replace(new RegExp(`^${safePfx}\\s*`, 'i'), '').trim() || description
  }

  // ── Isolate main content block for date/time/venue parsing ────────────
  const contentBlock = (
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    ?? html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    ?? html
  )
  const contentText = stripHtml(contentBlock)

  // ── Date ───────────────────────────────────────────────────────────────
  // 1. <time> element (most reliable)
  let dateStr = null
  const timeEl = contentBlock.match(/<time[^>]*(?:datetime="([^"]*)")?[^>]*>([\s\S]*?)<\/time>/i)
  if (timeEl) dateStr = extractDate(timeEl[1] || stripHtml(timeEl[2]))
  // 2. Scan body text
  if (!dateStr) dateStr = extractDate(contentText)
  // 3. Last-resort: derive from URL slug
  if (!dateStr) {
    const slugTail = eventUrl.replace(/\/$/, '').split('/').pop()
    dateStr = extractDate(slugTail.replace(/-/g, ' '))
  }

  // ── Time ───────────────────────────────────────────────────────────────
  const timeStr = extractTime(contentText)

  // ── Venue + address ────────────────────────────────────────────────────
  // Look for an inline address: "StreetAddress, City, OH ZIP"
  const addrRe  = /([^\n,]{3,80}),\s*(Akron|Fairlawn|Cuyahoga Falls|Hudson|Stow|Kent|Tallmadge|Bath|Barberton|Norton|Green|Copley),?\s*OH\s+(\d{5})/i
  const addrM   = contentText.match(addrRe)
  let venue        = null
  let venueAddress = null
  let venueCity    = 'Akron'
  let venueState   = 'OH'
  let venueZip     = null

  if (addrM) {
    venueAddress = addrM[1].trim()
    venueCity    = addrM[2].trim()
    venueState   = 'OH'
    venueZip     = addrM[3]
    // Venue name: the line immediately before the address in the content
    const beforeAddr = contentText.slice(0, contentText.indexOf(addrM[0])).trim()
    const lines      = beforeAddr.split('\n').map(l => l.trim()).filter(Boolean)
    const candidate  = lines[lines.length - 1] ?? ''
    if (candidate.length > 3 && candidate.length < 80 && !/[.!?]$/.test(candidate)
        && !/^(join|this|the|our|come|we |register)/i.test(candidate)) {
      venue = candidate
    }
  }

  // ── Registration / ticket URL ──────────────────────────────────────────
  const registerRe = /<a[^>]+href="([^"]+)"[^>]*>\s*(?:Register(?:\s+Now)?|Buy\s+Tickets?|RSVP|Get\s+Tickets?)\s*<\/a>/i
  const ticketUrl  = html.match(registerRe)?.[1] ?? eventUrl

  return { title, description, imageUrl, dateStr, timeStr, venue, venueAddress, venueCity, venueState, venueZip, ticketUrl }
}

// ── Venue cache + helper ───────────────────────────────────────────────────

const venueCache = new Map()

async function resolveVenue(parsed, organizerId) {
  const { venue, venueAddress, venueCity, venueState, venueZip } = parsed
  if (!venue && !venueAddress) return null

  const cacheKey = venue ?? venueAddress
  if (venueCache.has(cacheKey)) return venueCache.get(cacheKey)

  const venueId = await ensureVenue(venue ?? venueAddress, {
    address: venueAddress,
    city:    venueCity  ?? 'Akron',
    state:   venueState ?? 'OH',
    zip:     venueZip   ?? null,
    website: null,
  })

  if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)
  venueCache.set(cacheKey, venueId)
  return venueId
}

// ── Process all events ─────────────────────────────────────────────────────

async function processEvents(eventUrls, organizerId) {
  const now     = Date.now()
  const horizon = now + DAYS_AHEAD * 86400_000
  let inserted = 0, skipped = 0

  for (const url of eventUrls) {
    try {
      console.log(`  → ${url}`)
      const html   = await fetchHtml(url)
      const parsed = parseDetailPage(html, url)

      if (!parsed.title) {
        console.warn(`    ⚠ No title — skipping`)
        skipped++
        continue
      }

      if (!parsed.dateStr) {
        console.warn(`    ⚠ No date found for "${parsed.title}" — skipping`)
        skipped++
        continue
      }

      const dateTime = parsed.timeStr
        ? `${parsed.dateStr} ${parsed.timeStr}`
        : parsed.dateStr
      const startAt  = easternToIso(dateTime)

      if (!startAt) { skipped++; continue }

      const startMs = new Date(startAt).getTime()
      if (startMs < now - 3 * 3600_000 || startMs > horizon) {
        console.log(`    ↳ Outside window (${parsed.dateStr}) — skipping`)
        skipped++
        continue
      }

      const slug     = url.replace(/\/$/, '').split('/').pop()
      const category = mapCategory(parsed.title, parsed.description ?? '')
      const tags     = mapTags(parsed.title, parsed.description ?? '')

      const row = {
        title:           parsed.title,
        description:     parsed.description || null,
        start_at:        startAt,
        end_at:          null,
        category,
        tags,
        price_min:       null,
        price_max:       null,
        age_restriction: 'all_ages',
        image_url:       parsed.imageUrl ?? null,
        ticket_url:      parsed.ticketUrl ?? url,
        source:          SOURCE_KEY,
        source_id:       slug,
        status:          'published',
        featured:        false,
      }

      const venueId    = await resolveVenue(parsed, organizerId)
      const enriched   = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enriched)

      if (error) {
        console.warn(`    ⚠ Upsert failed for "${row.title}": ${error.message}`)
        skipped++
      } else {
        if (venueId) await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        console.log(`    ✓ "${row.title}" on ${parsed.dateStr}`)
        inserted++
      }

      // Polite delay between requests
      await new Promise(r => setTimeout(r, 400))
    } catch (err) {
      console.warn(`  ⚠ Error processing ${url}: ${err.message}`)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Akron Urban League ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization('Akron Urban League', {
      website:     BASE_URL,
      description: 'The Akron Urban League improves the quality of life of Summit County residents, particularly African Americans, through economic self-reliance and social empowerment.',
    })

    console.log(`\n🔍  Fetching events listing from ${LISTING_URL}…`)
    const listingHtml = await fetchHtml(LISTING_URL)
    const eventUrls   = extractEventUrls(listingHtml)
    console.log(`  Found ${eventUrls.length} event URL(s)`)

    if (eventUrls.length === 0) {
      console.warn('  ⚠ No event URLs found — listing page structure may have changed.')
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status:       'error',
        errorMessage: 'No event URLs found on listing page',
        durationMs:   Date.now() - start,
        eventsFound:  0,
      })
      process.exit(0)
    }

    console.log(`\n📥  Fetching and processing ${eventUrls.length} event detail pages…`)
    const { inserted, skipped } = await processEvents(eventUrls, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: eventUrls.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

main()
