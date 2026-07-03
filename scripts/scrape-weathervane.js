/**
 * scrape-weathervane.js
 *
 * Scrapes the season lineup from Weathervane Playhouse's upcoming-shows page,
 * then crawls each show's own detail page (/events/{slug}) for its synopsis
 * and "Buy Tickets" link — the listing page alone has no description, and its
 * generic /tickets link was being reused as ticket_url/source_url for every
 * show (2026-07-02 data-quality plan, task 4). The poster image comes from
 * the listing page itself, which already embeds it per show.
 * Platform: Drupal 11 — static HTML season listing.
 *
 * Usage:
 *   node scripts/scrape-weathervane.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  htmlToText,
  stripHtml,
  decodeEntities,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  easternToIso,
} from './lib/normalize.js'

const BASE_URL    = 'https://www.weathervaneplayhouse.com'
const SOURCE_URL  = `${BASE_URL}/upcoming-shows`

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

  // Skip obvious season headers: ranges spanning two explicit years, joined by
  // a dash OR the word "to" (e.g. "AUGUST 20, 2026 TO JULY 11, 2027").
  if (/\d{4}\s*(?:[-–]|TO)\s*\w+\s+\d+,?\s*\d{4}/.test(s)) return null

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
      // Prefer an explicit year in the range (e.g. "JUNE 18 - JULY 12, 2026")
      // over inference, so a currently-running show isn't rolled to next year.
      const explicit = stripped.match(/\b(\d{4})\b/)
      const year = explicit ? parseInt(explicit[1], 10) : inferYear(m, parseInt(day))
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
//
// The listing page renders each show as a single <a href="/events/{slug}">
// wrapping a poster <img> and the title/date text — verified 2026-07-02.
// Parsing per-anchor (rather than walking the whole page's text lines) both
// fixes a title/date mis-pairing risk at block boundaries AND gives us the
// show's own detail-page URL and poster image for free, without an extra
// request per show.
//
// Title and date aren't reliably split by htmlToText's block-newline rules
// (they land in whatever tag the theme happens to use — <div>, <span>, plain
// text — and htmlToText only breaks on <p>/<br>/<li>/heading closes). So
// instead of relying on a line break between them, find the first month name
// in the flattened text and split there — robust even if the two run
// together with no whitespace at all.
const MONTH_NAME_RE = /(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)/i

export function parseShows(html) {
  const shows = []

  // Remove scripts and styles
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')

  const seen    = new Set()
  const now     = new Date()
  const todayMs = new Date(now.toISOString().split('T')[0] + 'T00:00:00Z').getTime()

  const linkPattern = /<a[^>]+href="(\/events\/([a-z0-9-]+))"[^>]*>([\s\S]*?)<\/a>/gi

  for (const match of clean.matchAll(linkPattern)) {
    const href       = BASE_URL + match[1]
    const slug       = match[2]
    const innerHtml  = match[3]

    // Nav/footer links to /events/* with no poster image aren't show cards.
    const imgMatch = innerHtml.match(/<img[^>]+src="([^"]+)"/i)
    if (!imgMatch) continue
    const posterUrl = decodeEntities(imgMatch[1])

    const blob = htmlToText(innerHtml).replace(/\s+/g, ' ').trim()
    const monthMatch = blob.match(MONTH_NAME_RE)
    if (!monthMatch) continue

    const title    = blob.slice(0, monthMatch.index).trim()
    const dateLine = blob.slice(monthMatch.index).trim()
    if (!title || title.length <= 3) continue
    if (!isDateLine(dateLine) || isSeasonHeader(dateLine) || isSeasonHeader(title)) continue

    const dateStr = parseDateString(dateLine)
    if (!dateStr) continue

    // Skip past shows
    if (new Date(dateStr).getTime() < todayMs) continue

    if (seen.has(slug)) continue
    seen.add(slug)

    shows.push({ title, dateStr, slug, href, posterUrl })
  }

  return shows
}

/**
 * The show's own page (e.g. /events/parade) carries the synopsis paragraph
 * and, for musicals/plays with a licensor, a "Buy Tickets" link to the box
 * office system (OvationTix). Verified 2026-07-02 against /events/parade.
 * Never throws — callers get nulls on failure so the show still ingests with
 * what the listing page gave us (title/date/poster).
 */
function parseShowDetail(html) {
  return {
    description: extractWvDescription(html),
    ticketUrl:   extractWvTicketUrl(html),
  }
}

/**
 * The synopsis is a plain <p> in the page body. Distinguish it from the
 * surrounding noise (byline block, content warning, licensor credit, cast
 * list) with a few cheap heuristics rather than a brittle DOM path, since
 * this is server-rendered Drupal markup we don't control. Exported for tests.
 */
export function extractWvDescription(html) {
  const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => stripHtml(m[1]).trim())
  for (const text of paragraphs) {
    if (!text || text.length < 60) continue
    if (/^content warning/i.test(text)) continue
    if (/presented (through|by) special arrangement|all authorized performance materials/i.test(text)) continue
    // Real prose has lowercase words followed by punctuation; a byline/cast
    // block is mostly short, capitalized name fragments.
    if (!/[a-z]{4,}[.,]/.test(text)) continue
    return text
  }
  return null
}

/** The "Buy Tickets" CTA link on a show's page, or null. Exported for tests. */
export function extractWvTicketUrl(html) {
  const m = html.match(/<a[^>]+href="([^"]+)"[^>]*>\s*Buy Tickets\s*<\/a>/i)
  return m ? decodeEntities(m[1]) : null
}

// ── Venue / Organizer ──────────────────────────────────────────────────────

async function ensureWvVenue() {
  return ensureVenue('Weathervane Playhouse', {
    address:       '1301 Weathervane Lane',
    city:          'Akron',
    state:         'OH',
    zip:           '44313',
    lat:           41.1073,
    lng:           -81.5651,
    parking_type:  'lot',
    parking_notes: 'Free on-site parking.',
    website:       'https://www.weathervaneplayhouse.com',
  })
}

async function ensureWvOrganizer() {
  return ensureOrganization('Weathervane Playhouse', {
    website:     'https://www.weathervaneplayhouse.com',
    description: 'Weathervane Playhouse is a community theatre in Akron, Ohio, presenting professional-quality productions for over 90 seasons.',
  })
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

      let description = null
      let ticketUrl    = show.href
      try {
        const detailHtml = await fetchHtml(show.href)
        const detail      = parseShowDetail(detailHtml)
        description = detail.description
        ticketUrl   = detail.ticketUrl || show.href
      } catch (err) {
        console.warn(`  ⚠ Detail-page fetch failed for "${show.title}":`, err.message)
      }
      // Polite delay between detail-page requests.
      await new Promise((r) => setTimeout(r, 300))

      const row = {
        title:           show.title,
        description,
        start_at:        startAt,
        end_at:          null,
        category:        'theater',
        tags:            ['theatre', 'community-theatre', 'live-performance', 'akron'],
        price_min:       20,
        price_max:       null,
        age_restriction: 'all_ages',
        image_url:       show.posterUrl || null,
        ticket_url:      ticketUrl,
        source_url:      show.href,
        source:          'weathervane',
        source_id:       slugify(show.title),
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
    const [venueId, organizerId] = await Promise.all([ensureWvVenue(), ensureWvOrganizer()])

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

// Run only when invoked directly (`node scripts/scrape-weathervane.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
