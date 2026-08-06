/**
 * scrape-downtown-cf.js
 *
 * Downtown Cuyahoga Falls (downtowncf.com) — the Downtown Cuyahoga Falls
 * organization's own event program (Oktoberfest, Nightmare on Front Street, …)
 * along Front Street in downtown Cuyahoga Falls, SUMMIT COUNTY. As a first-party
 * source for its own programming, events publish directly; the single venue is
 * always downtown Cuyahoga Falls, so classifySummitLocation is 'in' and used
 * only as a defensive guard (a schema/data slip that ever flipped the city
 * should fail loudly, not leak a non-Summit row).
 *
 * Platform: a Drupal 10 site. The list page (/events) renders each event as a
 * single anchor to /events/<slug> whose text is a run-together teaser blob — it
 * does NOT carry the server-rendered <div class="item"> / <div class="date"> /
 * <div class="time"> fields (those are injected by JS on the list only). So the
 * list is used purely to ENUMERATE event slugs; every field comes from the
 * detail page, which IS clean server HTML. The "community-calendar" slug is a
 * pointer page (date "VARIOUS"), not an event, and is skipped.
 *
 * Each detail page (/events/<slug>) has a server-rendered
 * <div class="item"><h2>title</h2><div class="date">Oct 17</div>
 * <div class="time">3-8PM</div></div> header, a Drupal body field
 * (.field--name-body) with the description, and — for some events — an italic
 * "GPS LOCATION: <address>" line. Date is a single day ("Oct 17") or a
 * same-month range ("Sept 18-20"), always with NO year.
 *
 * Parsing decisions:
 *   • Date — a single day is that day; a range ("Sept 18-20") becomes a
 *     multi-day event with start = first day and end = last day. The site never
 *     prints a year, so we infer it by anchoring to Eastern "today" and rolling
 *     forward when the month/day is already past (same approach as
 *     scrape-downtown-akron.js's reconstructDate).
 *   • Time — a stated range ("3-8PM") gives a real start (3:00 PM) and end
 *     (8:00 PM). "Varies"/absent states NO clock time; rather than silently
 *     fabricating one we apply the SANCTIONED-DEFAULT-TIME convention (midday
 *     start, evening end for a multi-day run) AND flag the row needs_review so a
 *     human confirms the real time. See the SANCTIONED-DEFAULT-TIME marker below.
 *   • All times are America/New_York, converted via easternToIso.
 *
 * Usage:   node scripts/scrape-downtown-cf.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, easternToIso, easternTodayIso,
  htmlToText, stripHtml, decodeEntities, enrichWithImageDimensions,
  upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization,
} from './lib/normalize.js'
import { classifySummitLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'downtown_cf'
const BASE_URL   = 'https://www.downtowncf.com'
const EVENTS_URL = `${BASE_URL}/events`
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'
const ORG_NAME   = 'Downtown Cuyahoga Falls'

// The one venue every downtowncf.com event happens at: the Front Street
// plaza / amphitheater / pavilion in downtown Cuyahoga Falls.
const VENUE = {
  name:  'Downtown Cuyahoga Falls',
  address: 'Front Street',
  city:  'Cuyahoga Falls',
  state: 'OH',
  zip:   '44221',
}

// SANCTIONED-DEFAULT-TIME
// downtowncf.com states no clock time for some events ("Varies", or none at
// all). Storing those at midnight would drop them out of every feed on their
// own day (the list/map/digest feeds filter .gte('start_at', now()) with no
// grace window). So a timeless event gets a midday default start and — when
// it's a multi-day run — an evening default end, and is ALSO flagged
// needs_review so the invented time is a human-confirmable placeholder, never a
// silent fabrication. Same convention as scrape-ohio-festivals.js; see the
// maintainer's docs/default-event-times-decision-2026-07-28.md (docs/ is
// gitignored, so a secondary reference).
const DEFAULT_START_TIME = '12:00 PM'
const DEFAULT_END_TIME   = '8:00 PM'

const MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sept: 8, sep: 8, october: 9, oct: 9,
  november: 10, nov: 10, december: 11, dec: 11,
}

const pad = (n) => String(n).padStart(2, '0')

/** "Nightmare on Front Street" → "nightmare-on-front-street". */
export function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Month token ("Sept", "Oct.", "October") → 0-based month index, or null. */
function monthIndex(token) {
  const key = String(token || '').toLowerCase().replace(/\.$/, '')
  return key in MONTHS ? MONTHS[key] : null
}

/**
 * Infer the calendar year for a month/day with no year printed. Anchored to
 * Eastern "today"; if the month/day already passed this year, roll to next.
 * Numbers on both sides — never a Date compared against a string.
 */
function inferYear(monthIdx, day, now) {
  const [ty, tm, td] = easternTodayIso(now).split('-').map(Number)
  let year = ty
  if (Date.UTC(year, monthIdx, day) < Date.UTC(ty, tm - 1, td)) year++
  return year
}

/**
 * Parse a <div class="date"> string into { startYmd, endYmd }.
 *   "Oct 17"          → single day  → { startYmd, endYmd: null }
 *   "Sept 18-20"      → same-month range → start = 18th, end = 20th
 *   "Sept 30-Oct 2"   → cross-month range (handled defensively)
 * Returns null for anything that isn't a real date ("VARIOUS", empty, unknown
 * month) — that's how non-event .item blocks get skipped.
 */
export function parseDateRange(dateText, now = new Date()) {
  const s = String(dateText || '').trim()
  if (!s) return null

  // Cross-month range: "Sept 30 - Oct 2"
  let m = s.match(/^([A-Za-z]+\.?)\s+(\d{1,2})\s*[-–—]\s*([A-Za-z]+\.?)\s+(\d{1,2})$/)
  if (m) {
    const m1 = monthIndex(m[1]), m2 = monthIndex(m[3])
    if (m1 == null || m2 == null) return null
    const d1 = parseInt(m[2], 10), d2 = parseInt(m[4], 10)
    const y1 = inferYear(m1, d1, now)
    const y2 = m2 < m1 ? y1 + 1 : y1
    return { startYmd: `${y1}-${pad(m1 + 1)}-${pad(d1)}`, endYmd: `${y2}-${pad(m2 + 1)}-${pad(d2)}` }
  }

  // Same-month range: "Sept 18-20"
  m = s.match(/^([A-Za-z]+\.?)\s+(\d{1,2})\s*[-–—]\s*(\d{1,2})$/)
  if (m) {
    const mi = monthIndex(m[1])
    if (mi == null) return null
    const d1 = parseInt(m[2], 10), d2 = parseInt(m[3], 10)
    const y = inferYear(mi, d1, now)
    return { startYmd: `${y}-${pad(mi + 1)}-${pad(d1)}`, endYmd: `${y}-${pad(mi + 1)}-${pad(d2)}` }
  }

  // Single day: "Oct 17"
  m = s.match(/^([A-Za-z]+\.?)\s+(\d{1,2})$/)
  if (m) {
    const mi = monthIndex(m[1])
    if (mi == null) return null
    const d = parseInt(m[2], 10)
    const y = inferYear(mi, d, now)
    return { startYmd: `${y}-${pad(mi + 1)}-${pad(d)}`, endYmd: null }
  }

  return null
}

/** hour/minute + am/pm → 24-hour "HH:MM". */
function to24(hour, minute, meridiem) {
  let h = hour
  const pm = /p/i.test(meridiem || '')
  const am = /a/i.test(meridiem || '')
  if (pm && h !== 12) h += 12
  if (am && h === 12) h = 0
  return `${pad(h)}:${pad(minute)}`
}

const TIME_TOKEN = String.raw`(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?`
const TIME_RANGE = new RegExp(`${TIME_TOKEN}\\s*[-–—]\\s*${TIME_TOKEN}`, 'i')
const TIME_ONE   = new RegExp(TIME_TOKEN, 'i')

/**
 * Parse a <div class="time"> string into { startTime, endTime } as 24-hour
 * "HH:MM" strings, or nulls when no clock time is stated ("Varies", "TBA", "").
 *   "3-8PM"   → { startTime: '15:00', endTime: '20:00' }   (end's PM applies to both)
 *   "7:30 PM" → { startTime: '19:30', endTime: null }
 *   "Noon-8PM"→ { startTime: '12:00', endTime: '20:00' }
 * The caller decides how to default a null start; we never invent one here.
 */
export function parseTimeRange(timeText) {
  const s = String(timeText || '').trim()
  if (!s || /^(varies|tba|tbd|various)\b/i.test(s)) return { startTime: null, endTime: null }

  const norm = s.toLowerCase()
    .replace(/\bnoon\b/g, '12pm')
    .replace(/\bmidnight\b/g, '12am')

  const r = norm.match(TIME_RANGE)
  if (r) {
    const startMer = r[3] || r[6]           // start inherits the end's meridiem when unstated
    const endMer   = r[6] || r[3]
    let startTime  = to24(parseInt(r[1], 10), r[2] != null ? parseInt(r[2], 10) : 0, startMer)
    const endTime  = to24(parseInt(r[4], 10), r[5] != null ? parseInt(r[5], 10) : 0, endMer)
    // If inheriting the end's meridiem pushed the start AFTER the end (e.g.
    // "11-1PM" = 11am–1pm, not 11pm–1pm), the start is really AM.
    if (!r[3] && startTime > endTime) {
      startTime = to24(parseInt(r[1], 10), r[2] != null ? parseInt(r[2], 10) : 0, 'am')
    }
    return { startTime, endTime }
  }

  const one = norm.match(TIME_ONE)
  if (one && one[3]) {
    return { startTime: to24(parseInt(one[1], 10), one[2] != null ? parseInt(one[2], 10) : 0, one[3]), endTime: null }
  }
  return { startTime: null, endTime: null }
}

/** Title → v2 category. These are downtown street events, so festival is the floor. */
export function parseCategory(title = '') {
  const l = title.toLowerCase()
  if (/market/.test(l)) return 'market'
  if (/concert|music|band|jazz/.test(l)) return 'music'
  if (/film|movie|cinema/.test(l)) return 'film'
  if (/run|race|walk|5k/.test(l)) return 'fitness'
  return 'festival'
}

// ── Pure list/detail parsers ────────────────────────────────────────────────

/** Split raw HTML into per-`<div class="item">` segments (start-to-next-start). */
function itemBlocks(html) {
  const raw = String(html || '')
  const idxs = [...raw.matchAll(/<div\s+class="item"[^>]*>/gi)].map((m) => m.index)
  return idxs.map((from, i) => raw.slice(from, i + 1 < idxs.length ? idxs[i + 1] : raw.length))
}

/** First heading (h1–h6) text in a block, decoded + stripped. */
function headingText(block) {
  const m = block.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
  return m ? decodeEntities(stripHtml(m[1])).trim() : ''
}

/** `<div class="date">…</div>` text in a block. */
function fieldText(block, cls) {
  const m = block.match(new RegExp(`<div\\s+class="${cls}"[^>]*>([\\s\\S]*?)</div>`, 'i'))
  return m ? decodeEntities(stripHtml(m[1])).trim() : ''
}

// Slugs under /events/ that are pointer/landing pages, not real events.
const NON_EVENT_SLUGS = new Set(['community-calendar', 'city-events'])

/**
 * Parse the /events LIST page into [{ slug }] by enumerating every /events/<slug>
 * anchor. The list page does not carry per-event date/time server-side, so slugs
 * are all we take here — the detail page supplies the real fields.
 *
 * We drop: the bare /events index link (no slug), known pointer pages
 * (community-calendar), and duplicate anchors (Drupal renders each card as an
 * image link AND a "More" text link to the same slug).
 */
export function parseListItems(html) {
  const raw = String(html || '')
  const seen = new Set()
  const out = []
  const re = /href="[^"]*\/events\/([a-z0-9][a-z0-9-]*)\/?["#?]/gi
  let m
  while ((m = re.exec(raw))) {
    const slug = m[1].toLowerCase()
    if (NON_EVENT_SLUGS.has(slug) || seen.has(slug)) continue
    seen.add(slug)
    out.push({ slug })
  }
  return out
}

/** Pull "GPS LOCATION: <address>" from a detail page's body, or null. */
export function parseGpsLocation(html) {
  const m = String(html || '').match(/GPS\s*LOCATION:\s*([^<\n]+?)\s*(?:<\/|$)/i)
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().replace(/[*_]+$/, '').trim() : null
}

/**
 * Parse a /events/<slug> DETAIL page into
 * { title, dateText, timeText, description, gps }.
 *
 * Title/date/time come from the server-rendered <div class="item"> header (the
 * first .item block that actually carries a class="date"). The description comes
 * from the page's <meta name="description"> (Drupal mirrors the body summary
 * there), falling back to the first paragraph of the .field--name-body field.
 */
export function parseDetail(html) {
  const raw = String(html || '')
  const blocks = itemBlocks(raw)
  const block = blocks.find((b) => /class="date"/i.test(b)) || blocks[0] || raw

  let description = null
  // Delimiter-aware so an apostrophe inside the content doesn't truncate it.
  const meta = raw.match(/<meta[^>]+name=["']description["'][^>]+content=(["'])([\s\S]*?)\1/i)
  if (meta) description = decodeEntities(meta[2]).replace(/\s+/g, ' ').trim() || null
  if (!description) {
    const body = raw.match(/field--name-body[\s\S]*?<div\s+class="field__item"[^>]*>([\s\S]*?)<\/div>/i)
    if (body) description = htmlToText(body[1]).replace(/\s+/g, ' ').trim().slice(0, 600) || null
  }

  return {
    title:       headingText(block),
    dateText:    fieldText(block, 'date'),
    timeText:    fieldText(block, 'time'),
    description,
    gps:         parseGpsLocation(raw),
  }
}

/**
 * Build the DB row for one event, or null when the date can't be resolved.
 * Pure + exported so tests exercise the real date/time/year logic.
 */
export function buildRow({ slug, title, dateText, timeText, description }, { now = new Date() } = {}) {
  const range = parseDateRange(dateText, now)
  if (!range) return null

  const { startTime: parsedStart, endTime: parsedEnd } = parseTimeRange(timeText)
  const multiDay = Boolean(range.endYmd)

  let needsReview = false
  let startTime = parsedStart
  if (!startTime) {                       // "Varies"/absent → SANCTIONED default + review flag
    startTime = DEFAULT_START_TIME
    needsReview = true
  }

  const startAt = easternToIso(range.startYmd, startTime)
  if (!startAt) return null

  let endAt = null
  if (multiDay) {
    endAt = easternToIso(range.endYmd, parsedEnd || DEFAULT_END_TIME)
  } else if (parsedEnd) {
    endAt = easternToIso(range.startYmd, parsedEnd)
  }

  const slg = slug || slugify(title)
  const row = {
    title,
    description:     description || null,
    start_at:        startAt,
    end_at:          endAt,
    category:        parseCategory(title),
    tags:            ['downtown-cuyahoga-falls', 'cuyahoga falls', 'festival'],
    price_min:       null,               // never assume free
    price_max:       null,
    age_restriction: 'all_ages',
    image_url:       null,
    ticket_url:      `${BASE_URL}/events/${slg}`,
    source:          SOURCE_KEY,
    source_id:       `${slg}-${range.startYmd}`,
    status:          'published',
    featured:        false,
    ...(needsReview ? { needs_review: true } : {}),
  }
  return row
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🏙️  Starting Downtown Cuyahoga Falls ingestion…')
  const start = Date.now()
  const now = new Date()
  try {
    // Defensive geo guard: every event here is downtown Cuyahoga Falls, which is
    // in the Summit County allowlist. If that ever stops being true (a schema or
    // config slip), fail loudly instead of publishing a non-Summit row.
    if (classifySummitLocation({ city: VENUE.city }) !== 'in') {
      throw new Error(`Venue city "${VENUE.city}" did not classify as in-county — refusing to publish`)
    }

    const listHtml = await fetchPage(EVENTS_URL)
    const items = parseListItems(listHtml)
    console.log(`  Parsed ${items.length} event(s) from ${EVENTS_URL}`)
    if (!items.length) throw new Error('No events parsed from downtowncf.com/events — page format may have changed')

    const organizerId = await ensureOrganization(ORG_NAME, {
      website:     BASE_URL,
      description: 'Downtown Cuyahoga Falls presents street festivals and community events along Front Street in downtown Cuyahoga Falls.',
    })
    const venueId = await ensureVenue(VENUE.name, {
      address: VENUE.address, city: VENUE.city, state: VENUE.state, zip: VENUE.zip, website: BASE_URL,
    })

    let inserted = 0, skipped = 0
    for (const item of items) {
      try {
        const detailHtml = await fetchPage(`${BASE_URL}/events/${item.slug}`)
        const detail = parseDetail(detailHtml)
        await new Promise((r) => setTimeout(r, 250)) // polite delay

        // Prefer detail-page fields; fall back to the list card when absent.
        const row = buildRow({
          slug:        item.slug,
          title:       detail.title || item.title,
          dateText:    detail.dateText || item.dateText,
          timeText:    detail.timeText,
          description: detail.description,
        }, { now })
        if (!row) { skipped++; continue }

        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`); skipped++; continue }
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId, { source: SOURCE_KEY, selfHostVerified: true })
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error processing "${item.title}": ${err.message}`)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: items.length, durationMs: Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
