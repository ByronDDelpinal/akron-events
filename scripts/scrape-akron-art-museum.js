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

const BASE_URL   = 'https://akronartmuseum.org/calendar/'
const DAYS_AHEAD = 180   // 6 months

// ── Helpers ───────────────────────────────────────────────────────────────
// stripHtml imported from normalize.js — handles all named + numeric HTML entities

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
 * Extract a real image URL from a page's HTML.
 *
 * Priority:
 *   1. JSON-LD Event schema `image` field — always contains the real URL
 *      on EventBrite even before JavaScript hydration; og:image may hold a
 *      server-side placeholder (data URI) until JS runs.
 *   2. og:image meta tag
 *   3. twitter:image meta tag
 *
 * Only returns http/https URLs — data URIs and blobs are rejected because
 * they are JS-rendered placeholders that will never load correctly as a
 * stored image_url.
 */
function extractPageImage(html) {
  // ── 1. JSON-LD ──────────────────────────────────────────────────────
  const scriptRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let scriptMatch
  while ((scriptMatch = scriptRe.exec(html)) !== null) {
    try {
      const raw = scriptMatch[1].trim()
      const schemas = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [JSON.parse(raw)]
      for (const schema of schemas) {
        const entries = Array.isArray(schema) ? schema : [schema]
        for (const entry of entries) {
          if (entry['@type'] === 'Event' && entry.image) {
            const img = typeof entry.image === 'string'
              ? entry.image
              : entry.image?.url ?? (Array.isArray(entry.image) ? entry.image[0] : null)
            if (img && /^https?:\/\//i.test(img)) return img
          }
        }
      }
    } catch { /* invalid JSON, skip */ }
  }

  // ── 2. og:image ─────────────────────────────────────────────────────
  const ogRe = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  ]
  for (const re of ogRe) {
    const m = html.match(re)
    if (m && /^https?:\/\//i.test(m[1])) return m[1]
  }

  // ── 3. twitter:image ────────────────────────────────────────────────
  const twRe = [
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
  ]
  for (const re of twRe) {
    const m = html.match(re)
    if (m && /^https?:\/\//i.test(m[1])) return m[1]
  }

  return null
}

/**
 * Fetch an individual event detail page and extract:
 * price, full description, registration URL, and image (og:image).
 * If no image found on the museum page and the ticket URL is EventBrite,
 * we do a second fetch to grab EventBrite's og:image — EventBrite always
 * has high-quality event images.
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

    // Image: try the museum's own detail page first (JSON-LD → og → twitter)
    let imageUrl = extractPageImage(html)

    // Fallback: if the ticket URL is EventBrite, fetch that page and parse
    // its JSON-LD Event schema — this reliably returns the real CDN image URL
    // from EventBrite's server-side HTML before JS hydration replaces it.
    if (!imageUrl && ticketUrl && /eventbrite\.com/i.test(ticketUrl)) {
      try {
        const ebRes = await fetch(ticketUrl, {
          headers: {
            'Accept': 'text/html',
            'User-Agent': 'Mozilla/5.0 (compatible; The330-bot/1.0)',
          },
          redirect: 'follow',
        })
        if (ebRes.ok) {
          const ebHtml = await ebRes.text()
          imageUrl = extractPageImage(ebHtml)
        }
      } catch {
        // EventBrite fetch failed — no image, not fatal
      }
    }

    return { ticketUrl, priceMin, priceMax, description, imageUrl }
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

async function ensureAamVenue() {
  return ensureVenue('Akron Art Museum', {
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
  })
}

async function ensureAamOrganizer() {
  return ensureOrganization('Akron Art Museum', {
    website: 'https://akronartmuseum.org',
    description: 'The Akron Art Museum presents modern and contemporary art in downtown Akron, OH.',
  })
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
      // Calendar listing image takes precedence; fall back to detail page og:image
      // (which may have been pulled from EventBrite if the ticket URL pointed there)
      const imageUrl = item.imageUrl ?? detail.imageUrl ?? null

      const row = {
        title:           item.title,
        description,
        start_at:        startAt,
        end_at:          endAt,
        category,
        tags,
        price_min:       priceMin,
        price_max:       priceMax,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ticketUrl,
        source:          'akron_art_museum',
        source_id,
        status:          'published',
        featured:        false,
      }

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${item.title}":`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
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
    const [venueId, organizerId] = await Promise.all([ensureAamVenue(), ensureAamOrganizer()])
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
