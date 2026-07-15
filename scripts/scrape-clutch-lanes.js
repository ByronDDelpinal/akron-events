/**
 * scrape-clutch-lanes.js
 *
 * Scrapes upcoming events from Clutch Lanes & Sports Center, a bowling and
 * sports center in Cuyahoga Falls (Summit County).
 *
 * Platform: SpotApps-hosted venue site (static.spotapps.co). The events page is
 * fully server-rendered HTML — each event is a `<section id="{eventId}">` block
 * containing an `<h2>` title, a `.event-day` prose date ("Saturday July 18th"),
 * and a `.event-time` range ("07:00 PM - 10:00 PM"). There is NO per-event
 * description; the hidden `.event-info-text` div only carries data-attributes
 * (data-event-id, data-is-recurring, data-tags — all empty in practice).
 *
 * Why HTML parsing (not a JSON endpoint): SpotApps pages sometimes hydrate from
 * a JSON config, but this one embeds no ld+json and exposes no page-visible
 * events API — the events are baked into the static HTML at build time
 * (there's a `<!-- wcache ... -->` server-cache stamp at the top). Raw-HTML
 * parse with no browser sees everything.
 *
 * Quirks:
 *   • The prose date carries a weekday and month/day but NO year. Year is
 *     inferred by anchoring "today" to America/New_York and choosing the
 *     nearest future year whose weekday matches the stated weekday (a robust
 *     rollover disambiguator — verified the source's weekday/date pairs agree).
 *   • Late shows cross midnight ("09:00 PM - 12:00 AM"): when the end time is
 *     not after the start time, end_at rolls to the next day.
 *   • The events page's own footer/meta carry PLACEHOLDER address data (the
 *     og:url points at a "golden-colorado" template sibling, and a stray 44685
 *     Uniontown zip appears) — the real venue address (4190 State Road,
 *     Cuyahoga Falls, OH 44223) is hardcoded from the site homepage instead.
 *   • Single fixed Summit County venue → no per-event geo classification needed.
 *
 * Category mapping (documented): the events feed is a weekend live-band lineup
 * plus the occasional bowling special. Titles matching bowling / tournament /
 * league / trivia / bingo / arcade / cornhole → `games`; everything else (bare
 * band names, karaoke, DJ nights) → `music`, since the feed is otherwise a
 * live-music calendar. Text inference still enriches toward a second category.
 *
 * Usage:
 *   node scripts/scrape-clutch-lanes.js
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
  stripHtml,
  decodeEntities,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  linkOrganizationVenue,
  ensureVenue,
  ensureOrganization,
  easternToIso,
} from './lib/normalize.js'

const EVENTS_URL = 'https://clutchlanes.com/cuyahoga-falls-clutch-lanes-and-sports-center-events'
const SOURCE_KEY = 'clutch_lanes'

// ── Date / time maps ────────────────────────────────────────────────────────

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

// Weekday name (as written on the page) → JS getUTCDay index (0 = Sunday).
const WEEKDAY_MAP = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
}

// Cancelled/postponed events name it in the title ("CANCELED — Time Machine").
// Same title convention lib/civicplus.js uses — drop rather than publish.
const CANCELLED_RE = /\bcancell?ed\b|\bpostponed\b/i

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Today's date in America/New_York as 'YYYY-MM-DD'. Anchoring the year-
 *  rollover logic to Eastern (never local Date + toISOString) avoids the
 *  evening-run off-by-one where a late-ET run reads as "tomorrow" in UTC. */
function todayEastern(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

const pad2 = (n) => String(n).padStart(2, '0')

/** Add `n` days to a 'YYYY-MM-DD' string, returning a 'YYYY-MM-DD' string. */
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}

/** Parse a "H:MM AM"/"H AM" clock token to minutes-since-midnight, or null. */
export function timeToMinutes(raw) {
  if (!raw) return null
  const m = String(raw).trim().match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i)
  if (!m) return null
  let hr = parseInt(m[1], 10)
  const min = m[2] != null ? parseInt(m[2], 10) : 0
  const isPm = /^p/i.test(m[3])
  if (isPm && hr !== 12) hr += 12
  if (!isPm && hr === 12) hr = 0
  return hr * 60 + min
}

/**
 * Split a "07:00 PM - 10:00 PM" range into raw start/end clock strings.
 * Returns { startTime, endTime } (either may be null). A lone time with no
 * separator is treated as the start.
 */
export function parseTimeRange(timeText) {
  const s = decodeEntities(String(timeText || '')).replace(/\s+/g, ' ').trim()
  if (!s) return { startTime: null, endTime: null }
  // Normalize en/em dashes to hyphen before splitting.
  const parts = s.replace(/[‒-―]/g, '-').split(/\s*-\s*/)
  const startTime = parts[0]?.trim() || null
  const endTime = parts.length > 1 ? (parts[1]?.trim() || null) : null
  return { startTime, endTime }
}

/**
 * Parse a prose date like "Saturday July 18th" into 'YYYY-MM-DD'.
 *
 * The source omits the year. We pick the nearest year (this ET year, then +1,
 * +2) whose month/day both (a) fall on or after yesterday (ET) and (b) land on
 * the stated weekday. The weekday check is the disambiguator — it pins the
 * correct year across a New-Year rollover without guessing. If no candidate
 * matches the weekday (e.g. a source typo), fall back to the nearest future
 * year ignoring the weekday. Returns null if the string isn't a parseable date.
 */
export function parseEventDate(dayText, now = new Date()) {
  const t = decodeEntities(String(dayText || '')).replace(/\s+/g, ' ').trim()
  const m = t.match(/(?:(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b[,\s]*)?([A-Za-z]{3,})\s+(\d{1,2})(?:st|nd|rd|th)?/i)
  if (!m) return null
  const weekdayIdx = m[1] ? WEEKDAY_MAP[m[1].toLowerCase()] : null
  const month = MONTH_MAP[m[2].toLowerCase()]
  const day = parseInt(m[3], 10)
  if (!month || !day || day > 31) return null

  const [ty, tm, td] = todayEastern(now).split('-').map(Number)
  const cutoffMs = Date.UTC(ty, tm - 1, td) - 86400000 // yesterday (ET) — keep same-day/just-past

  let fallbackYear = null
  for (let offset = 0; offset <= 2; offset++) {
    const year = ty + offset
    const candMs = Date.UTC(year, month - 1, day)
    const cand = new Date(candMs)
    // Reject impossible day/month pairs (e.g. "February 29th" in a non-leap
    // year, "February 30th"): Date.UTC silently rolls them into the next month,
    // which would otherwise emit a fake date string and a mismatched weekday.
    if (cand.getUTCMonth() !== month - 1 || cand.getUTCDate() !== day) continue
    if (candMs < cutoffMs) continue
    if (fallbackYear === null) fallbackYear = year
    if (weekdayIdx == null || cand.getUTCDay() === weekdayIdx) {
      return `${year}-${pad2(month)}-${pad2(day)}`
    }
  }
  if (fallbackYear === null) return null
  return `${fallbackYear}-${pad2(month)}-${pad2(day)}`
}

/**
 * Compute { startAt, endAt } ISO-UTC timestamps from the prose date + time
 * range. end_at rolls to the next day when the end clock is not after the
 * start clock (late shows ending at/after midnight). Returns null when the
 * date can't be parsed. If the source ever omits a start time, startAt falls
 * back to midnight ET (date-only) — flagged by the upstream contract advisory.
 */
export function computeSchedule(dayText, timeText, now = new Date()) {
  const dateStr = parseEventDate(dayText, now)
  if (!dateStr) return null
  const { startTime, endTime } = parseTimeRange(timeText)

  const startAt = easternToIso(dateStr, startTime || '')
  if (!startAt) return null

  let endAt = null
  if (endTime) {
    const sMin = timeToMinutes(startTime)
    const eMin = timeToMinutes(endTime)
    const endDate = (sMin != null && eMin != null && eMin <= sMin) ? addDays(dateStr, 1) : dateStr
    endAt = easternToIso(endDate, endTime)
  }
  return { startAt, endAt }
}

/**
 * Title → v2 category. Bowling / tournament / league / trivia / bingo / arcade
 * / cornhole nights map to `games`; everything else defaults to `music` (the
 * events feed is otherwise a weekend live-band lineup). Text inference in
 * upsertEventSafe still enriches toward a second category where the title
 * supports it. Exported for tests.
 */
export function parseCategory(title = '') {
  const t = title.toLowerCase()
  if (/\bbowl(?:ing)?\b|tournament|\bleague\b|trivia|bingo|arcade|cornhole|\bdarts?\b/.test(t)) {
    return 'games'
  }
  return 'music'
}

/**
 * Parse the events page HTML into raw event records. Each event is a
 * `<section id="{id}">` with an `<h2>` title, a `.event-day` prose date, a
 * `.event-time` range, and an `.event-image`. Most events carry no per-event
 * text, but a few have a short note inside `.event-info-text` (e.g.
 * "Thanksgiving Eve") alongside a hidden data-only div — captured as the
 * description when present. Exported for tests.
 *
 * @returns {{sourceId:string,title:string,dayText:string,timeText:string,imageUrl:string|null,note:string|null}[]}
 */
export function parseEvents(html) {
  const events = []
  const s = String(html || '')
  const sectionRe = /<section id="(\d+)">([\s\S]*?)<\/section>/gi
  let sec
  while ((sec = sectionRe.exec(s)) !== null) {
    const sourceId = sec[1]
    const body = sec[2]

    const titleM = body.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
    const title = titleM ? stripHtml(titleM[1]) : ''
    if (!title) continue
    // Drop cancelled/postponed events rather than publishing a dead show.
    if (CANCELLED_RE.test(title)) continue

    const dayM = body.match(/class="[^"]*event-day[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
    const dayText = dayM ? stripHtml(dayM[1]) : ''
    if (!dayText) continue

    const timeM = body.match(/class="[^"]*event-time[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
    const timeText = timeM ? stripHtml(timeM[1]) : ''

    const imgM = body.match(/class="[^"]*event-image[^"]*"[^>]*\ssrc="([^"]+)"/i)
    let imageUrl = imgM ? imgM[1].trim() : null
    if (imageUrl && imageUrl.startsWith('//')) imageUrl = `https:${imageUrl}`

    // Optional human note inside .event-info-text — drop the hidden data-only
    // div (it holds data-event-id/data-tags attributes, no text) and keep any
    // remaining prose.
    let note = null
    const infoM = body.match(/class="[^"]*event-info-text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<p[^>]*event-time/i)
    if (infoM) {
      const noteText = stripHtml(infoM[1].replace(/<div\b[^>]*style="display:\s*none"[^>]*>[\s\S]*?<\/div>/i, ''))
      if (noteText) note = noteText
    }

    events.push({ sourceId, title, dayText, timeText, imageUrl, note })
  }
  return events
}

// ── Venue / organization ────────────────────────────────────────────────────

async function ensureClutchVenue() {
  return ensureVenue('Clutch Lanes & Sports Center', {
    address:       '4190 State Road',
    city:          'Cuyahoga Falls',
    state:         'OH',
    zip:           '44223',
    parking_type:  'lot',
    parking_notes: 'On-site parking lot.',
    website:       'https://clutchlanes.com',
    description:   'Bowling and sports center in Cuyahoga Falls with an arcade, outdoor sand volleyball, an all-sports simulator, and live music on weekends.',
  })
}

async function ensureClutchOrganizer() {
  return ensureOrganization('Clutch Lanes & Sports Center', {
    website:     'https://clutchlanes.com',
    description: 'Cuyahoga Falls bowling and sports center hosting live bands, bowling specials, and community nights.',
  })
}

// ── HTML fetch ──────────────────────────────────────────────────────────────

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

// ── Process ─────────────────────────────────────────────────────────────────

async function processEvents(rawEvents, venueId, organizerId) {
  let inserted = 0, skipped = 0
  const now = new Date()
  const cutoffMs = Date.now() - 2 * 86400000 // drop anything ended >~1 day ago

  for (const ev of rawEvents) {
    try {
      const schedule = computeSchedule(ev.dayText, ev.timeText, now)
      if (!schedule) {
        console.warn(`  ⚠ Could not parse date/time for "${ev.title}" (${ev.dayText} / ${ev.timeText}) — skipping`)
        skipped++
        continue
      }
      const { startAt, endAt } = schedule

      // Skip events that already ended more than ~a day ago.
      const endMs = endAt ? Date.parse(endAt) : Date.parse(startAt)
      if (endMs < cutoffMs) { skipped++; continue }

      const row = {
        title:           ev.title,
        description:     ev.note || null, // most events carry no description; a few have a short note
        start_at:        startAt,
        end_at:          endAt,
        category:        parseCategory(ev.title),
        tags:            ['clutch-lanes', 'cuyahoga-falls'],
        price_min:       null,
        price_max:       null,
        age_restriction: 'not_specified',
        image_url:       ev.imageUrl,
        ticket_url:      EVENTS_URL,
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

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Clutch Lanes & Sports Center ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([ensureClutchVenue(), ensureClutchOrganizer()])
    if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)

    console.log(`\n🔍  Fetching ${EVENTS_URL}…`)
    const html = await fetchHtml(EVENTS_URL)
    const rawEvents = parseEvents(html)
    console.log(`  Found ${rawEvents.length} events on the page`)

    if (rawEvents.length === 0) {
      console.warn('  ⚠ No events parsed — page structure may have changed.')
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, { eventsFound: 0, durationMs: Date.now() - start })
      return
    }

    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skipped } = await processEvents(rawEvents, venueId, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly; importing for tests exposes pure parsers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
