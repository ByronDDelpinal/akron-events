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
 * 2026 markup drift: newer listings drop the year, prefix a weekday, and put
 * the time in its own bold run — e.g. "THURSDAY, JUNE 18" / "4 – 7PM" /
 * "Located at Mason Park Community Center" (this is the format on the
 * homepage event blocks and broke the old strongs[0]/strongs[1] positional
 * parsing). parseEvents now scans the bold runs for a date, a time-only
 * line, and a short venue-ish line, and infers the year when missing.
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
  easternTodayIso,
} from './lib/normalize.js'
import { pathToFileURL } from 'node:url'

const SOURCE_KEY = 'the_well_cdc'
const EVENTS_URL = 'https://thewellakron.com/events/'

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7,
  aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

// ── Date / time parsing ──────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * Infer the year for a year-less date ("JUNE 18").
 *
 * Default to the current year. Only roll forward to next year when the
 * current-year candidate is a long way (>6 months) in the past — i.e. a
 * December page listing a January event. Deliberately NOT the 1-day roll
 * used by scrape-house-three-thirty.js: The Well leaves past events on the
 * page for weeks, and a naive roll would resurrect each of them as a
 * phantom event a year out instead of letting the past-event filter drop
 * them.
 */
function inferYear(month, day, now = new Date()) {
  const year = now.getFullYear()
  const candidate = new Date(year, month - 1, day)
  const sixMonthsMs = 183 * 86_400_000
  if (now.getTime() - candidate.getTime() > sixMonthsMs) return year + 1
  return year
}

/**
 * Find the first "MONTH D[, YYYY]" in `text` (tolerating a leading weekday,
 * e.g. "THURSDAY, JUNE 18"). Returns { dateStr, rest } where `rest` is
 * whatever follows the date match (used for same-line time extraction),
 * or null if no date is present. Year is optional — The Well dropped it
 * from event listings — and is inferred relative to `now` when absent.
 */
function matchDate(text, now = new Date()) {
  if (!text) return null
  const s = String(text)
  const re = /([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/g
  for (const m of s.matchAll(re)) {
    const month = MONTH_MAP[m[1].toLowerCase()]
    if (!month) continue                       // skips weekday tokens
    const day = parseInt(m[2], 10)
    if (!day || day > 31) continue
    const year = m[3] ? parseInt(m[3], 10) : inferYear(month, day, now)
    return {
      dateStr: `${year}-${pad2(month)}-${pad2(day)}`,
      rest:    s.slice(m.index + m[0].length),
    }
  }
  return null
}

/** "JUNE 4, 2026" → "2026-06-04"; "JUNE 18" → year inferred (null if unparseable). */
export function parseDate(text, now = new Date()) {
  return matchDate(text, now)?.dateStr ?? null
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

/**
 * True when a string is nothing but a clock time / time range —
 * "4 – 7PM", "5:30PM", "10 – 11:30AM", "12 NOON". Used to tell the
 * standalone time line apart from a venue line.
 */
export function isTimeOnly(text) {
  const s = stripHtml(String(text || '')).trim()
  if (!s || !/\d/.test(s)) return false
  if (!/(a\.?m\.?|p\.?m\.?|noon)\b/i.test(s)) return false
  // Strip meridians/fillers, then digits/punctuation — letters left ⇒ not a
  // time. No \b before the meridian: "7PM" has no boundary between 7 and P.
  return s
    .replace(/(a\.?m\.?|p\.?m\.?|noon|to|until)/gi, '')
    .replace(/[\d:.\s|–—-]/g, '') === ''
}

/** "THE EAST END – 1200 E MARKET ST" → "The East End". */
function parseVenue(text) {
  if (!text) return null
  let s = stripHtml(text).trim()
  // Strip a "Located at" / "@" prefix (newer listings use this phrasing).
  s = s.replace(/^(?:located\s+at|at|@)\s+/i, '')
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

export function parseEvents(html, now = new Date()) {
  const events = []
  // Each event is a Divi blurb whose title is an h4.et_pb_module_header.
  const chunks = html.split(/<h4[^>]*class="[^"]*et_pb_module_header[^"]*"[^>]*>/i)
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]
    const titleRaw = (chunk.match(/^([\s\S]*?)<\/h4>/i) || [])[1]
    const title = titleRaw ? stripHtml(titleRaw) : null
    if (!title) continue

    // Bold runs carry the metadata. Older markup: strongs[0] = "JUNE 4, 2026
    // | 5:30PM" and strongs[1] = "VENUE – ADDRESS". Newer markup drops the
    // year, may prefix a weekday, and splits date and time into separate
    // strongs ("THURSDAY, JUNE 18" / "4 – 7PM"), so scan instead of relying
    // on fixed positions. <b> is matched too — Divi editors flip between them.
    const strongs = [...chunk.matchAll(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi)]
      .map(m => stripHtml(m[1]).trim()).filter(Boolean)

    // 1. Date: first strong containing a "MONTH D[, YYYY]".
    let dateStr = null, dateRest = '', dateIdx = -1
    for (let s = 0; s < strongs.length; s++) {
      const dm = matchDate(strongs[s], now)
      if (dm) { dateStr = dm.dateStr; dateRest = dm.rest; dateIdx = s; break }
    }
    if (!dateStr) continue

    // 2. Time: remainder of the date line ("… | 5:30PM"), else the next
    //    strong that is purely a time ("4 – 7PM").
    let timeIdx = -1
    let timeSource = /\d/.test(dateRest) ? dateRest : null
    if (!timeSource) {
      for (let s = dateIdx + 1; s < strongs.length; s++) {
        if (isTimeOnly(strongs[s])) { timeSource = strongs[s]; timeIdx = s; break }
      }
    }
    const timeStr = parseTime(timeSource || '')

    // 3. Venue: first non-time strong after the date line (checked within the
    //    next few strongs so a bolded run deep in the description can't be
    //    mistaken for a venue). Venue lines are short name-ish strings —
    //    reject anything long or sentence-like (bolded description copy).
    let venueName = null
    for (let s = dateIdx + 1; s < Math.min(strongs.length, dateIdx + 4); s++) {
      if (s === timeIdx || isTimeOnly(strongs[s])) continue
      const raw = parseVenue(strongs[s])
      if (!raw) continue
      const v = raw.split(/\s*,\s*/)[0].trim()   // "People's Park, 760 Elma St" → name only
      const wordy = v.split(/\s+/).length > 8    // sentence-like ⇒ bolded description copy
      if (v && v.length <= 60 && /[A-Za-z]{3}/.test(v) && !/[!?]/.test(v) && !wordy) {
        venueName = v
        break
      }
    }

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

    const today = easternTodayIso()
    const future = parsed.filter(e => e.dateStr >= today)
    console.log(`  ${future.length} upcoming (dropped ${parsed.length - future.length} past)`)

    if (future.length === 0) {
      // Distinguish a real parser break from a page that simply has no events
      // posted: only treat 0 parsed as an error when the Divi event headers ARE
      // present (so date/venue parsing is what failed). If the headers are
      // absent, nothing is listed right now — a clean zero run, not an error.
      const hasEventMarkup = /et_pb_module_header/i.test(html)
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: parsed.length === 0 && hasEventMarkup ? 'error' : 'ok',
        errorMessage: parsed.length === 0 && hasEventMarkup
          ? 'Found event headers (h4.et_pb_module_header) but parsed 0 events — the date/venue markup likely changed.'
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
