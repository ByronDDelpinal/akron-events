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

const SOURCE_URL = 'https://www.akronzoo.org/events?field_event_categories_target_id=All'
const BASE_DOMAIN = 'https://www.akronzoo.org'

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
  const has = (kw) => lower.includes(kw)
  const hasWord = (kw) => new RegExp(`\\b${kw}\\b`).test(lower)

  // Zoo events are inherently nature/animal-focused. Education-flavored
  // titles (kids' camps, classes, programs) are still nature in spirit,
  // and the May 2026 Nature backfill treated this source's would-be
  // community/education events as nature. Mirror that here.
  if (has('camp') || hasWord('class') || has('program') || has('education') || has('learn')) return 'nature'
  return 'nature'
}

function parseTags(title = '') {
  const lower  = title.toLowerCase()
  const tags   = ['zoo', 'family', 'animals', 'akron-zoo']
  if (lower.includes('kids') || lower.includes('children') || lower.includes('family') || lower.includes('junior')) tags.push('kids')
  return [...new Set(tags)]
}

// ── Venue / Organizer ──────────────────────────────────────────────────────

async function ensureZooVenue() {
  return ensureVenue('Akron Zoo', {
    address:       '500 Edgewood Ave',
    city:          'Akron',
    state:         'OH',
    zip:           '44307',
    lat:           41.0615,
    lng:           -81.5160,
    parking_type:  'lot',
    parking_notes: 'Free parking in zoo lots.',
    website:       'https://www.akronzoo.org',
  })
}

async function ensureZooOrganizer() {
  return ensureOrganization('Akron Zoo', {
    website:     'https://www.akronzoo.org',
    description: 'The Akron Zoo is a 68-acre zoo in Akron, Ohio, home to over 900 animals and offering family events, educational programs, and special seasonal experiences.',
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

// ── Parse events from HTML ─────────────────────────────────────────────────

function parseEvents(html) {
  const events = []
  const seen   = new Set()

  // The Akron Zoo events page renders cards as:
  //   <div class="item xxtight">
  //     <a href="/event-slug">
  //       <img src="..." alt="...">
  //       EVENT TITLE
  //       <div class="date">JUN 13</div>
  //     </a>
  //   </div>
  //
  // Each card closes with </a></div>, which we use as the boundary.
  // Each card in the raw HTML:
  //   <div class="item xxtight"><a class="wrap" href="/slug">
  //     <div class="text">Title<br><span class="date">Jun 13</span></div>
  //     <span class="bg bg-replace"><img src="..." /></span>
  //   </a></div>
  const cardRegex = /<div[^>]*class="[^"]*\bitem\b[^"]*\bxxtight\b[^"]*"[^>]*>([\s\S]*?<\/a>)\s*<\/div>/gi
  const matches = [...html.matchAll(cardRegex)]

  for (const match of matches) {
    const cardHtml = match[1]

    // Extract href
    const hrefMatch = cardHtml.match(/<a[^>]*href="([^"]+)"/)
    const href = hrefMatch ? resolveUrl(hrefMatch[1]) : null

    // Title and date both live inside <div class="text">
    const textDivMatch = cardHtml.match(/<div[^>]*class="text"[^>]*>([\s\S]*?)<\/div>/i)
    let title = null, rawDate = null
    if (textDivMatch) {
      const inner = textDivMatch[1]
      // Date is in <span class="date">Jun 13</span>
      const dateSpanMatch = inner.match(/<span[^>]*class="date"[^>]*>([\s\S]*?)<\/span>/i)
      rawDate = dateSpanMatch ? stripHtml(dateSpanMatch[1]).trim() : null
      // Title is the remaining text after removing the date span and <br>
      title = stripHtml(
        inner
          .replace(/<span[^>]*class="date"[^>]*>[\s\S]*?<\/span>/gi, '')
          .replace(/<br\s*\/?>/gi, ' ')
      ).replace(/\s+/g, ' ').trim()
    }
    if (!title || title.length < 3) continue

    // Extract image from <span class="bg bg-replace"><img src="..."></span>
    const imgMatch = cardHtml.match(/<img[^>]*src="([^"?]+)/)
    let imageUrl = imgMatch ? imgMatch[1] : null
    if (imageUrl && !imageUrl.startsWith('http')) imageUrl = BASE_DOMAIN + imageUrl

    // Parse date — parseDateText handles "JUN 13", "JUL 24 - JUL 26", "SEP 1 - 30", etc.
    const { dateStr, timeStr } = parseDateText(rawDate ?? '')

    // source_id: slug + date to disambiguate recurring events (e.g. Zoothing Hour)
    let slug = null
    if (href) {
      const pathMatch = href.match(/\/([^/?#]+)\/?(?:\?.*)?$/)
      slug = pathMatch ? pathMatch[1] : null
    }
    if (!slug) {
      slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    }
    const sourceId = dateStr ? `${slug}-${dateStr}` : slug

    if (seen.has(sourceId)) continue
    seen.add(sourceId)

    events.push({ title, dateStr, timeStr, href, imageUrl, sourceId })
  }

  if (events.length === 0) {
    console.warn('  ⚠ No event cards matched div.item.xxtight — the page structure may have changed.')
  }

  // Filter out past events
  const today = new Date().toISOString().split('T')[0]
  return events.filter(ev => ev.dateStr && ev.dateStr >= today)
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
        category:        parseCategory(ev.title),
        tags:            parseTags(ev.title),
        price_min:       null,
        price_max:       null,
        age_restriction: 'all_ages',
        image_url:       ev.imageUrl,
        ticket_url:      ev.href ?? 'https://www.akronzoo.org/tickets',
        source:          'akron_zoo',
        source_id:       ev.sourceId,
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
  console.log('🚀  Starting Akron Zoo ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([ensureZooVenue(), ensureZooOrganizer()])

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
