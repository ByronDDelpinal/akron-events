/**
 * scrape-better-kenmore.js
 *
 * Better Kenmore CDC — community development corporation for Akron's Kenmore
 * neighborhood and the historic Kenmore Boulevard business district.
 *   https://www.betterkenmore.org/upcoming-events/
 *
 * The site is WordPress running the Events Manager plugin, which renders an
 * upcoming-events list of structured items:
 *
 *   <div class="em-event em-item">
 *     <… class="em-event-title"><a href="/events/{slug}/">TITLE</a></…>
 *     <div class="em-item-meta-line em-event-date">Friday June 5, 2026</div>
 *     <div class="em-item-meta-line em-event-time">9:30 am - 10:30 am</div>
 *     <div class="em-item-meta-line em-event-location">Kenmore Senior Community Center</div>
 *   </div>
 *
 * Events: the BLVD Block Party, Kenmore First Friday Festival, Rialto Living
 * Room concert series, open-mic jams, and recurring Kenmore Senior Community
 * Center programming (Chair Yoga, Popcorn & Movie Fridays, etc.). All within
 * the Kenmore neighborhood, so the neighborhood resolver tags them.
 *
 * Usage:   node scripts/scrape-better-kenmore.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { pathToFileURL } from 'node:url'
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

const SOURCE_KEY = 'better_kenmore'
const EVENTS_URL = 'https://www.betterkenmore.org/upcoming-events/'
const ORIGIN = 'https://www.betterkenmore.org'

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
}

// ── Field helpers ────────────────────────────────────────────────────────────

/** "Friday June 5, 2026" → "2026-06-05" (weekday ignored). */
export function parseDate(text) {
  if (!text) return null
  const m = stripHtml(text).match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (!m) return null
  const month = MONTH_MAP[m[1].toLowerCase()]
  if (!month) return null
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`
}

/** "9:30 am - 10:30 am" → "09:30:00" (start time). "All Day"/empty → 00:00:00. */
export function parseTime(text) {
  if (!text) return '00:00:00'
  const m = stripHtml(text).match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)
  if (!m) return '00:00:00'
  let hr = parseInt(m[1], 10)
  const min = m[2] ?? '00'
  const isPm = /pm/i.test(m[3])
  if (isPm && hr !== 12) hr += 12
  if (!isPm && hr === 12) hr = 0
  return `${String(hr).padStart(2, '0')}:${min}:00`
}

function firstMatch(html, re) {
  const m = html.match(re)
  return m ? m[1] : null
}

function metaLine(chunk, cls) {
  return stripHtml(
    firstMatch(chunk, new RegExp(`class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`, 'i')) || '',
  ) || null
}

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90)
}

function mapCategory(title = '', loc = '') {
  const t = `${title} ${loc}`.toLowerCase()
  if (/yoga|fitness|zumba|walk|exercise|wellness/.test(t))               return 'fitness'
  if (/movie|film|popcorn/.test(t))                                      return 'art'
  if (/music|band|concert|living room|open mic|jam|rialto|jazz/.test(t)) return 'music'
  if (/market|vendor|block party|first friday|festival/.test(t))         return 'community'
  if (/food|dinner|lunch|breakfast|brunch|pancake/.test(t))              return 'food'
  if (/class|workshop|craft|art|paint/.test(t))                          return 'education'
  return 'community'
}

// ── Parse ────────────────────────────────────────────────────────────────────

export function parseEvents(html) {
  const events = []
  // Split into Events Manager items.
  const chunks = html.split(/<div[^>]*class="[^"]*\bem-event\b[^"]*\bem-item\b[^"]*"/i)
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]

    // Title + permalink: first /events/ link in the item.
    const linkMatch = chunk.match(/<a[^>]+href="([^"]*\/events\/[^"#?]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
    if (!linkMatch) continue
    let href = linkMatch[1]
    if (href.startsWith('/')) href = ORIGIN + href
    const title = stripHtml(linkMatch[2])
    if (!title) continue

    const dateStr = parseDate(metaLine(chunk, 'em-event-date'))
    if (!dateStr) continue
    const timeStr = parseTime(metaLine(chunk, 'em-event-time'))
    const location = metaLine(chunk, 'em-event-location')
    const imageUrl = firstMatch(chunk, /<img[^>]+(?:data-src|src)="([^"]+\.(?:jpe?g|png|webp)[^"]*)"/i)

    events.push({
      title, dateStr, timeStr, location, ticketUrl: href, imageUrl,
      sourceId: slugify(`${title}-${dateStr}`),
    })
  }
  return events
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎸  Starting Better Kenmore ingestion (Events Manager HTML)…')
  const start = Date.now()

  try {
    const html = await fetchHtml(EVENTS_URL)
    const parsed = parseEvents(html)
    console.log(`  Parsed ${parsed.length} events`)

    const today = new Date().toISOString().split('T')[0]
    const future = parsed.filter(e => e.dateStr >= today)
    console.log(`  ${future.length} upcoming (dropped ${parsed.length - future.length} past)`)

    if (future.length === 0) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: parsed.length === 0 ? 'error' : 'ok',
        errorMessage: parsed.length === 0
          ? 'Page fetched but 0 events parsed — the Events Manager markup may have changed (expected .em-event.em-item with .em-event-date).'
          : undefined,
        durationMs:  Date.now() - start,
        eventsFound: parsed.length,
      })
      console.warn('  ⚠ No upcoming events — exiting 0.')
      process.exit(0)
    }

    const organizerId = await ensureOrganization('Better Kenmore CDC', {
      website:     'https://www.betterkenmore.org',
      description: "Better Kenmore CDC works to improve quality of life in Akron's Kenmore neighborhood — its second-largest — through cultural, artistic, recreational, and business revitalization along the historic Kenmore Boulevard. Hosts the BLVD Block Party, Kenmore First Friday Festival, the Rialto Living Room concert series, and recurring Kenmore Senior Community Center programming.",
    })

    let inserted = 0, skipped = 0
    const venueCache = new Map()

    for (const ev of future) {
      try {
        const startAt = easternToIso(`${ev.dateStr} ${ev.timeStr}`)
        if (!startAt) { skipped++; continue }

        let venueId = null
        const venueName = ev.location || 'Kenmore Boulevard'
        if (venueCache.has(venueName)) {
          venueId = venueCache.get(venueName)
        } else {
          venueId = await ensureVenue(venueName, { city: 'Akron', state: 'OH' })
          venueCache.set(venueName, venueId)
        }
        if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

        const row = {
          title:           ev.title,
          description:     null,
          start_at:        startAt,
          end_at:          null,
          category:        mapCategory(ev.title, ev.location || ''),
          tags:            ['better-kenmore', 'kenmore', 'akron'],
          price_min:       null,
          price_max:       null,
          age_restriction: 'all_ages',
          image_url:       ev.imageUrl || null,
          ticket_url:      ev.ticketUrl,
          source:          SOURCE_KEY,
          source_id:       ev.sourceId,
          status:          'published',
          featured:        false,
        }

        const enrichedRow = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enrichedRow)
        if (error) {
          console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
          skipped++
          continue
        }
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error processing "${ev.title}":`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: parsed.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
