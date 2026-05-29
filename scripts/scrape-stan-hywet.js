/**
 * scrape-stan-hywet.js
 *
 * Scrapes upcoming public events from Stan Hywet Hall & Gardens.
 * Platform: Drupal 7. The /public-events listing renders a static, stable
 * markup of `<div class="event-item clearfix">` cards containing:
 *   - `<div class="left"><a><img/></a></div>` — thumbnail (Drupal image style)
 *   - `<div class="alert">…</div>` — optional one-line teaser
 *   - `<div><h2><a href="/events/SLUG">Title</a></h2></div>` — title + canonical link
 *   - `<p class="date">…</p>` — human-formatted date (many shapes)
 *
 * Why a dedicated scraper: Stan Hywet sells tickets through their own
 * platform (stanhywet.ticketapp.org), not Eventbrite or Ticketmaster, so the
 * citywide geo-aggregators don't catch their events. The estate runs ~10–15
 * public events per month April–December (Ohio Mart, Father's Day Car Show,
 * Murder Mystery weekends, Coffee with the Curator, etc.) and a much sparser
 * winter cadence. Zero-event runs in Jan–Feb are normal, not alerting.
 *
 * Date-format heterogeneity is the main parsing risk. Examples in the wild:
 *   - "May 28 | 6pm-7:30pm"               → specific date + time
 *   - "May 23–September 13, 2026"          → date range (use start)
 *   - "Sundays through 10/25/26"           → recurring (use today)
 *   - "Continues until the End of May"     → open-ended (skip)
 *   - "April 21, 2026"                     → full date
 * We parse what we can and skip events with no resolvable start date rather
 * than synthesise a date that might be wrong.
 *
 * Usage:
 *   node scripts/scrape-stan-hywet.js
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
  inferCategory,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_KEY   = 'stan_hywet'
const SOURCE_URL   = 'https://stanhywet.org/public-events'
const BASE_DOMAIN  = 'https://stanhywet.org'

// Drupal image-style prefix we strip when normalising thumbnail → full image
const DRUPAL_STYLE_RE = /\/files\/styles\/[^/]+\/public\//

const DEFAULT_TIME = '09:00:00'   // when only a date is given

// ── Date parsing ───────────────────────────────────────────────────────────

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

/**
 * Convert "6:30pm" / "6pm" / "6:30 PM" → "HH:MM:SS" 24h.
 * Returns null on no match.
 */
function parseTimeFragment(raw) {
  if (!raw) return null
  const m = raw.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i)
  if (!m) return null
  let hr = parseInt(m[1], 10)
  const min = m[2] ?? '00'
  const mer = m[3].toLowerCase()
  if (mer === 'pm' && hr !== 12) hr += 12
  if (mer === 'am' && hr === 12) hr = 0
  return `${String(hr).padStart(2, '0')}:${min}:00`
}

/**
 * Parse Stan Hywet's `<p class="date">` text into { dateStr, timeStr,
 * endDateStr }.  Strategies, in order:
 *   1) Numeric range with year:   "9/13/26", "10/25/26"
 *   2) Pipe-separated date+time:  "May 28 | 6pm-7:30pm"
 *   3) Month-range with year:     "May 23–September 13, 2026"
 *   4) Full date:                 "April 21, 2026"
 *   5) Short date (no year):      "October 30" → infer current/next year
 *   6) "Sundays through 10/25/26" → start today (recurring marker)
 * Returns nulls when nothing parses; the caller skips the event in that case.
 */
function parseStanHywetDate(raw) {
  if (!raw) return { dateStr: null, timeStr: DEFAULT_TIME, endDateStr: null }
  const s = raw.replace(/–|—/g, '-').trim()
  const nowYear = new Date().getFullYear()

  // Find an inline time range "6pm-7:30pm" or single time "6pm"
  let timeStr = DEFAULT_TIME
  const timeRange = s.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm))\s*-\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)/i)
  const timeSingle = s.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i)
  const timeText = (timeRange?.[1] ?? timeSingle?.[1] ?? '').replace(/\s+/g, '')
  const parsedTime = parseTimeFragment(timeText)
  if (parsedTime) timeStr = parsedTime

  // 1) Numeric M/D/YY-range fragment ("Sundays through 10/25/26")
  const numericRange = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  const recurringMarker = /sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|weekly|every/i.test(s)
  if (numericRange && recurringMarker) {
    // Recurring event with an end date — start "today" so it surfaces immediately.
    const today = new Date()
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const [, mm, dd, yy] = numericRange
    const year = yy.length === 2 ? 2000 + parseInt(yy, 10) : parseInt(yy, 10)
    const endDateStr = `${year}-${String(parseInt(mm, 10)).padStart(2, '0')}-${String(parseInt(dd, 10)).padStart(2, '0')}`
    return { dateStr, timeStr, endDateStr }
  }

  // 2) Month-range with year — "May 23–September 13, 2026"
  const monthRange = s.match(/([A-Za-z]+)\s+(\d{1,2})\s*-\s*([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})/)
  if (monthRange) {
    const [, m1, d1, m2, d2, year] = monthRange
    const startMonth = MONTH_MAP[m1.toLowerCase()]
    const endMonth   = MONTH_MAP[m2.toLowerCase()]
    if (startMonth && endMonth) {
      const dateStr    = `${year}-${String(startMonth).padStart(2, '0')}-${String(parseInt(d1, 10)).padStart(2, '0')}`
      const endDateStr = `${year}-${String(endMonth).padStart(2, '0')}-${String(parseInt(d2, 10)).padStart(2, '0')}`
      return { dateStr, timeStr, endDateStr }
    }
  }

  // 3) Same-month range — "October 9-11, 2026"
  const sameMonthRange = s.match(/([A-Za-z]+)\s+(\d{1,2})\s*-\s*(\d{1,2}),?\s*(\d{4})/)
  if (sameMonthRange) {
    const [, mon, d1, d2, year] = sameMonthRange
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) {
      const dateStr    = `${year}-${String(m).padStart(2, '0')}-${String(parseInt(d1, 10)).padStart(2, '0')}`
      const endDateStr = `${year}-${String(m).padStart(2, '0')}-${String(parseInt(d2, 10)).padStart(2, '0')}`
      return { dateStr, timeStr, endDateStr }
    }
  }

  // 4) Full date — "April 21, 2026"
  const fullDate = s.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/)
  if (fullDate) {
    const [, mon, day, year] = fullDate
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) {
      return {
        dateStr: `${year}-${String(m).padStart(2, '0')}-${String(parseInt(day, 10)).padStart(2, '0')}`,
        timeStr,
        endDateStr: null,
      }
    }
  }

  // 5) Short date — "May 28 | 6pm" or "May 28"
  const shortDate = s.match(/([A-Za-z]+)\s+(\d{1,2})\b/)
  if (shortDate) {
    const [, mon, day] = shortDate
    const m = MONTH_MAP[mon.toLowerCase()]
    if (m) {
      // Infer year: if the resulting date is in the past, roll to next year.
      // This handles Dec listings in November.
      let year = nowYear
      const candidate = new Date(Date.UTC(year, m - 1, parseInt(day, 10)))
      const today     = new Date(); today.setUTCHours(0, 0, 0, 0)
      if (candidate < today) year += 1
      return {
        dateStr: `${year}-${String(m).padStart(2, '0')}-${String(parseInt(day, 10)).padStart(2, '0')}`,
        timeStr,
        endDateStr: null,
      }
    }
  }

  return { dateStr: null, timeStr, endDateStr: null }
}

// ── HTML fetch + parse ─────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronEventsBot/1.0; +https://akronpulse.com)',
      'Accept':     'text/html,application/xhtml+xml',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

function resolveUrl(href) {
  if (!href) return null
  if (/^https?:/.test(href)) return href
  return BASE_DOMAIN + (href.startsWith('/') ? '' : '/') + href
}

/**
 * Strip Drupal's `/files/styles/<name>/public/` prefix so we store the
 * full-resolution image rather than the listing-page thumbnail.
 */
function normalizeImage(src) {
  if (!src) return null
  const full = resolveUrl(src)
  if (!full) return null
  return full.replace(DRUPAL_STYLE_RE, '/files/')
}

/**
 * Parse the `.event-item` cards out of the listing HTML.  Returns an array
 * of raw event records {title, dateText, alertText, href, imageUrl, slug}.
 */
function parseEventCards(html) {
  const cards = []
  const seen  = new Set()

  // Capture each card.  The closing `</div>` for `.event-item` is followed
  // by another `.event-item` opener OR the listing wrapper close — we use a
  // lookahead so cards stay independent.
  const cardRe = /<div[^>]*class="[^"]*event-item[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*event-item|<\/div>\s*<div[^>]*class="(?:view-footer|item-list)|<\/div>\s*<\/div>)/gi

  for (const match of html.matchAll(cardRe)) {
    const inner = match[1]

    // Title + slug
    const titleMatch = inner.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i)
    if (!titleMatch) continue
    const href  = resolveUrl(titleMatch[1])
    const title = stripHtml(titleMatch[2])
    if (!title || title.length < 3) continue

    // Slug from href becomes the source_id (stable per event regardless of
    // listing position).  Falls back to slugified title.
    const slugMatch = (titleMatch[1] || '').match(/\/events\/([^/?#]+)/)
    const slug = slugMatch
      ? slugMatch[1]
      : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

    if (seen.has(slug)) continue
    seen.add(slug)

    // Date
    const dateMatch = inner.match(/<p[^>]*class="[^"]*date[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
    const dateText  = dateMatch ? stripHtml(dateMatch[1]) : null

    // Optional teaser
    const alertMatch = inner.match(/<div[^>]*class="[^"]*alert[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    const alertText  = alertMatch ? stripHtml(alertMatch[1]) : null

    // Image
    const imgMatch = inner.match(/<img[^>]*src="([^"]+)"/i)
    const imageUrl = imgMatch ? normalizeImage(imgMatch[1]) : null

    cards.push({ title, slug, href, dateText, alertText, imageUrl })
  }

  return cards
}

// ── Venue / Organizer ──────────────────────────────────────────────────────

async function ensureStanHywetVenue() {
  return ensureVenue('Stan Hywet Hall & Gardens', {
    address:       '714 N Portage Path',
    city:          'Akron',
    state:         'OH',
    zip:           '44303',
    lat:           41.1206,
    lng:           -81.5605,
    parking_type:  'lot',
    parking_notes: 'Free on-site parking; overflow on Portage Path during major events.',
    website:       'https://stanhywet.org',
    description:   "Tudor Revival country estate built by Goodyear Tire & Rubber co-founder F.A. Seiberling, on the National Register of Historic Places. Public programming includes Ohio Mart, the Father's Day Car Show, Murder Mystery weekends, and Coffee with the Curator.",
  })
}

async function ensureStanHywetOrganizer() {
  return ensureOrganization('Stan Hywet Hall & Gardens', {
    website:     'https://stanhywet.org',
    description: 'Historic estate and gardens museum operating the former F.A. Seiberling residence as a public-events venue.',
  })
}

// ── Tag mapping ────────────────────────────────────────────────────────────

function parseTags(title = '', alert = '') {
  const text = `${title} ${alert}`.toLowerCase()
  const tags = ['stan-hywet', 'historic-estate']
  if (/garden|plant|bloom|flower/.test(text)) tags.push('gardens')
  if (/family|kids|children|junior/.test(text))  tags.push('family')
  if (/holiday|christmas|halloween|murder mystery/.test(text)) tags.push('seasonal')
  if (/car show|cars/.test(text)) tags.push('cars')
  if (/lecture|talk|history|curator/.test(text)) tags.push('lecture')
  return [...new Set(tags)]
}

// ── Process ────────────────────────────────────────────────────────────────

async function processEvents(cards, venueId, organizerId) {
  let inserted = 0, skipped = 0

  for (const card of cards) {
    try {
      const { dateStr, timeStr, endDateStr } = parseStanHywetDate(card.dateText)
      if (!dateStr) {
        console.warn(`  ⚠ Skipping "${card.title}" — unparseable date: "${card.dateText}"`)
        skipped++
        continue
      }

      const startAt = easternToIso(`${dateStr} ${timeStr}`)
      const endAt   = endDateStr ? easternToIso(`${endDateStr} 23:59:59`) : null
      if (!startAt) { skipped++; continue }

      // Filter past events.  Range events whose end is still in the future
      // count as upcoming.
      const startMs = new Date(startAt).getTime()
      const endMs   = endAt ? new Date(endAt).getTime() : startMs
      if (endMs < Date.now() - 86_400_000) { skipped++; continue }

      const description = card.alertText && card.alertText.length > 0
        ? card.alertText
        : null

      const row = {
        title:           card.title,
        description,
        start_at:        startAt,
        end_at:          endAt,
        category:        inferCategory(card.title, description ?? ''),
        tags:            parseTags(card.title, card.alertText ?? ''),
        price_min:       null,
        price_max:       null,
        age_restriction: 'all_ages',
        image_url:       card.imageUrl,
        ticket_url:      card.href ?? 'https://stanhywet.org/public-events',
        source:          SOURCE_KEY,
        source_id:       card.slug,
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
      console.warn(`  ⚠ Error processing "${card.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Stan Hywet ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([
      ensureStanHywetVenue(),
      ensureStanHywetOrganizer(),
    ])
    if (venueId && organizerId) {
      await linkOrganizationVenue(organizerId, venueId)
    }

    console.log(`\n🔍  Fetching ${SOURCE_URL}…`)
    const html  = await fetchHtml(SOURCE_URL)
    const cards = parseEventCards(html)
    console.log(`  Found ${cards.length} event cards`)

    if (cards.length === 0) {
      console.warn('  ⚠ No event cards parsed. If unexpected, inspect /public-events — Drupal markup may have changed.')
    }

    console.log(`\n📥  Processing ${cards.length} events…`)
    const { inserted, skipped } = await processEvents(cards, venueId, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: cards.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

main()
