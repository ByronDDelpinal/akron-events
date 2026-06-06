/**
 * scrape-the-well-cdc.js
 *
 * The Well CDC — Akron's place-based community development corporation for the
 * Middlebury neighborhood (647 E Market St).
 *   https://thewellakron.com/events/
 *
 * The events page is built with the Divi page builder (WordPress). Each event
 * is a Divi "blurb" module:
 *
 *   <div class="et_pb_blurb …">
 *     <h4 class="et_pb_module_header"><span>TITLE</span></h4>
 *     <div class="et_pb_blurb_description">
 *       <p><strong>JUNE 4, 2026 | 5:30PM</strong></p>      (date | time)
 *       <p><strong>THE EAST END – 1200 E MARKET ST</strong></p>   (venue – address)
 *       <p>Free-text description…</p>
 *       <a href="…">Learn more and register!</a>           (optional; some are mailto:)
 *     </div>
 *   </div>
 *
 * Events: the Taste of Middlebury fundraiser, Juneteenth celebration (Akron
 * Hope), Middlebury Fall Fest, Coffee & Career Development, the annual Wrapping
 * Night, and other neighborhood programming. Venues are mostly in/around
 * Middlebury, so the neighborhood resolver tags them automatically.
 *
 * Usage:   node scripts/scrape-the-well-cdc.js
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

const SOURCE_KEY = 'the_well_cdc'
const EVENTS_URL = 'https://thewellakron.com/events/'

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
}

// ── Date / time parsing ──────────────────────────────────────────────────────

/** "JUNE 4, 2026" → "2026-06-04" (null if unparseable). */
export function parseDate(text) {
  if (!text) return null
  const m = String(text).match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (!m) return null
  const month = MONTH_MAP[m[1].toLowerCase()]
  if (!month) return null
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`
}

/**
 * Parse a start time from the portion of the date line after the date, e.g.
 *   "5:30PM"        → 17:30
 *   "6 – 8PM"       → 18:00  (start hour 6, meridian inferred from the range)
 *   "10 – 11:30AM"  → 10:00
 *   ""              → 00:00  (all-day)
 * The start hour can lack its own AM/PM ("6 – 8PM"); we fall back to the
 * meridian of the last token in the range.
 */
export function parseTime(text) {
  if (!text) return '00:00:00'
  const tokens = [...String(text).matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi)]
    .filter(t => t[1] !== undefined && /\d/.test(t[1]))
  if (tokens.length === 0) return '00:00:00'
  const first = tokens[0]
  let hr = parseInt(first[1], 10)
  const min = first[2] ?? '00'
  // Meridian: prefer the start token's own, else any later token's.
  let mer = first[3]
  if (!mer) mer = (tokens.find(t => t[3]) || [])[3]
  if (mer) {
    const isPm = /pm/i.test(mer)
    if (isPm && hr !== 12) hr += 12
    if (!isPm && hr === 12) hr = 0
  }
  return `${String(hr).padStart(2, '0')}:${min}:00`
}

/** "THE EAST END – 1200 E MARKET ST" → "The East End". */
function parseVenue(text) {
  if (!text) return null
  let s = stripHtml(text).trim()
  // Venue name precedes the street address, separated by en/em dash or hyphen.
  s = s.split(/\s[–—-]\s/)[0].trim()
  if (!s) return null
  // Title-case ALL-CAPS venue names ("THE EAST END" → "The East End").
  if (s === s.toUpperCase()) {
    s = s.toLowerCase().replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
  }
  return s || null
}

function slugify(str) {
  return String(str).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
}

// Category: infer from title + description.
function mapCategory(title = '', desc = '') {
  return inferCategory(title, desc)
}

// ── Parse ────────────────────────────────────────────────────────────────────

export function parseEvents(html) {
  const events = []
  // Each event is a Divi blurb whose title is an h4.et_pb_module_header.
  const chunks = html.split(/<h4[^>]*class="[^"]*et_pb_module_header[^"]*"[^>]*>/i)
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]
    const titleRaw = (chunk.match(/^([\s\S]*?)<\/h4>/i) || [])[1]
    const title = titleRaw ? stripHtml(titleRaw) : null
    if (!title) continue

    // The date and venue are the first two <strong> runs in the description.
    const strongs = [...chunk.matchAll(/<strong>([\s\S]*?)<\/strong>/gi)]
      .map(m => stripHtml(m[1])).filter(Boolean)
    const dateLine = strongs[0] || ''
    const dateStr = parseDate(dateLine)
    if (!dateStr) continue
    // Time is whatever follows the date in the same line ("… | 5:30PM").
    const afterDate = dateLine.replace(/.*?\d{4}\s*/, '')
    const timeStr = parseTime(afterDate)
    const venueName = parseVenue(strongs[1] || '')

    // Description: first <p> that isn't the date/venue strongs and isn't a
    // "email … for more info" line.
    const paras = [...chunk.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => stripHtml(m[1]))
    const description = paras.find(p =>
      p && !strongs.includes(p) && !/^email\b/i.test(p) && p.length > 20
    ) || null

    // First non-mailto link is the register/learn-more URL.
    const link = [...chunk.matchAll(/href="(https?:[^"]+)"/gi)]
      .map(m => m[1]).find(u => !/^mailto:/i.test(u)) || null

    const imageUrl = (chunk.match(/<img[^>]+(?:data-src|src)="([^"]+\.(?:jpe?g|png|webp)[^"]*)"/i) || [])[1] || null

    events.push({
      title, dateStr, timeStr, venueName, description,
      ticketUrl: link, imageUrl,
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
  console.log('💧  Starting The Well CDC ingestion (Middlebury, Divi HTML)…')
  const start = Date.now()

  try {
    const html = await fetchHtml(EVENTS_URL)
    const parsed = parseEvents(html)
    console.log(`  Parsed ${parsed.length} event blocks`)

    const today = new Date().toISOString().split('T')[0]
    const future = parsed.filter(e => e.dateStr >= today)
    console.log(`  ${future.length} upcoming (dropped ${parsed.length - future.length} past)`)

    if (future.length === 0) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: parsed.length === 0 ? 'error' : 'ok',
        errorMessage: parsed.length === 0
          ? 'Page fetched but 0 events parsed — the Divi markup may have changed (expected h4.et_pb_module_header + <strong> date/venue).'
          : undefined,
        durationMs:  Date.now() - start,
        eventsFound: parsed.length,
      })
      console.warn('  ⚠ No upcoming events — exiting 0.')
      process.exit(0)
    }

    const organizerId = await ensureOrganization('The Well CDC', {
      website:     'https://thewellakron.com',
      description: "The Well CDC is Akron's place-based community development corporation devoted to the Middlebury neighborhood, creating shared prosperity through affordable housing, economic development, and placemaking. Hosts the Taste of Middlebury fundraiser, Middlebury Fall Fest, Akron Hope's Juneteenth celebration and Wrapping Night, and career-development programming.",
    })

    let inserted = 0, skipped = 0
    const venueCache = new Map()

    for (const ev of future) {
      try {
        const startAt = easternToIso(`${ev.dateStr} ${ev.timeStr}`)
        if (!startAt) { skipped++; continue }

        let venueId = null
        const venueName = ev.venueName || 'Middlebury'
        if (venueCache.has(venueName)) {
          venueId = venueCache.get(venueName)
        } else {
          venueId = await ensureVenue(venueName, { city: 'Akron', state: 'OH' })
          venueCache.set(venueName, venueId)
        }
        if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

        const row = {
          title:           ev.title,
          description:     ev.description,
          start_at:        startAt,
          end_at:          null,
          category:        mapCategory(ev.title, ev.description || ''),
          tags:            ['the-well-cdc', 'middlebury', 'akron'],
          price_min:       null,
          price_max:       null,
          age_restriction: 'all_ages',
          image_url:       ev.imageUrl || null,
          ticket_url:      ev.ticketUrl || EVENTS_URL,
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
