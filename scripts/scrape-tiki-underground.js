/**
 * scrape-tiki-underground.js
 *
 * Scrapes upcoming events from Tiki Underground, a locally-owned tiki bar and
 * lounge in downtown Cuyahoga Falls (Summit County). The calendar is a weekly
 * lineup of live music, DJ/themed nights, and the occasional multi-day bar
 * promotion.
 *
 * Platform: SpotApps-hosted venue site (static.spotapps.co) — the same platform
 * as scrape-clutch-lanes.js, but a NEWER template. The events page is fully
 * server-rendered HTML and ships THREE views of the same data (a "pinboard" of
 * cards, an agenda list, and a full year calendar). We parse only the pinboard
 * region (`events-pinboard-view` … `events-agenda-view`) so a single event is
 * read once, not three times.
 *
 * Why HTML parsing (not a JSON endpoint): like Clutch Lanes, SpotApps bakes the
 * events into static HTML at build time and exposes no page-visible events API
 * or ld+json on the events page. But unlike the older Clutch template, each card
 * here is a `<div class="event-calendar-card ">` carrying MACHINE-READABLE data
 * attributes — `data-event-start-date` (ISO, midnight-UTC = the event date),
 * `data-event-start-time` (24h "HH:MM"), `data-event-end-date`, and
 * `data-event-recurrence-type` ("Does not Repeat" | "Daily"). We trust those for
 * dates/times, so NO weekday-based year inference is needed (that hack was only
 * required on Clutch because its dates carried a weekday but no year). The card
 * body still holds the human title, a real prose description, the time RANGE
 * ("05:00 PM - 09:00 PM" — the only place the END time appears), and an image.
 *
 * Shared parsing helpers below (timeToMinutes / parseTimeRange / addDays /
 * cross-midnight end handling) are intentionally close cousins of the ones in
 * scrape-clutch-lanes.js — same SpotApps time-range prose, ~50 lines of overlap
 * kept local per the build brief rather than lifted into a shared lib.
 *
 * Quirks:
 *   • data-event-start-date is "YYYY-MM-DDT00:00:00.000+00:00" — midnight UTC,
 *     so slice(0,10) is the intended local event date (start-of-day, NOT the
 *     end-of-day Simpleview footgun — no ±1 shift).
 *   • Multi-day promotions come through as a single card with
 *     recurrence-type="Daily" + a start/end date span (e.g. "XMAS IN JULY",
 *     Jul 20–25, 10AM–10PM daily). We expand those into one published row per
 *     day (source_id `{id}-{YYYY-MM-DD}`), matching how the site's own agenda &
 *     calendar views list the promotion on each day. Expansion is capped to the
 *     ~190-day horizon; a "Daily" card with no end date is treated as one day.
 *   • Late shows crossing midnight ("09:00 PM - 12:00 AM"): when the end clock
 *     is not after the start clock, end_at rolls to the next day.
 *   • age_restriction is set to '21_plus' only when the event text states it
 *     (most do — the whole bar is 21+, but the brief wants per-event evidence).
 *   • Single fixed Summit County venue → no per-event geo classification.
 *
 * Category mapping (documented): the feed is overwhelmingly live music and
 * themed DJ/party nights → `music`; trivia / bingo / game nights → `games`;
 * explicit food pop-ups / tasting dinners → `food`. Text inference in
 * upsertEventSafe still enriches toward a second category.
 *
 * Usage:
 *   node scripts/scrape-tiki-underground.js
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

const EVENTS_URL = 'https://tikiunderground.com/events'
const SOURCE_KEY = 'tiki_underground'
const EXPANSION_HORIZON_DAYS = 190 // safety cap for Daily-recurrence expansion

// Cancelled/postponed events name it in the title ("CANCELED: Goth Yacht").
// Same title convention lib/civicplus.js uses — drop rather than publish.
const CANCELLED_RE = /\bcancell?ed\b|\bpostponed\b/i

// ── Pure helpers (SpotApps time prose — cf. scrape-clutch-lanes.js) ──────────

/** Today's date in America/New_York as 'YYYY-MM-DD'. Anchoring past/horizon and
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

/** Whole-day difference (b - a) between two 'YYYY-MM-DD' strings. */
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

/** Parse a "H:MM AM"/"H AM"/"17:00" clock token to minutes-since-midnight, or null. */
export function timeToMinutes(raw) {
  if (!raw) return null
  const m = String(raw).trim().match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i)
  if (!m) return null
  let hr = parseInt(m[1], 10)
  const min = m[2] != null ? parseInt(m[2], 10) : 0
  if (m[3]) {
    const isPm = /^p/i.test(m[3])
    if (isPm && hr !== 12) hr += 12
    if (!isPm && hr === 12) hr = 0
  }
  if (hr > 23 || min > 59) return null
  return hr * 60 + min
}

/**
 * Split a "05:00 PM - 09:00 PM" range into raw start/end clock strings.
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
 * Compute { startAt, endAt } ISO-UTC timestamps for one occurrence date.
 * `dateStr` is 'YYYY-MM-DD' (already resolved from the card's data attribute).
 * The prose time range supplies the clock; `fallbackStart24` (the card's
 * data-event-start-time, e.g. "17:00") backs up a missing prose start. end_at
 * rolls to the next day when the end clock is not after the start (late shows
 * crossing midnight). Returns null when no start time can be resolved.
 * Exported for tests.
 */
export function computeSchedule(dateStr, timeText, fallbackStart24 = '') {
  if (!dateStr) return null
  const { startTime, endTime } = parseTimeRange(timeText)
  const startClock = startTime || (fallbackStart24 ? String(fallbackStart24).trim() : '')

  // No usable start clock → refuse to publish. Without this guard,
  // easternToIso(dateStr, '') falls into its date-only path and synthesizes a
  // midnight timestamp, silently producing a bogus 12:00 AM event.
  if (!startClock || timeToMinutes(startClock) == null) return null

  const startAt = easternToIso(dateStr, startClock)
  if (!startAt) return null

  let endAt = null
  if (endTime) {
    const sMin = timeToMinutes(startClock)
    const eMin = timeToMinutes(endTime)
    const endDate = (sMin != null && eMin != null && eMin <= sMin) ? addDays(dateStr, 1) : dateStr
    endAt = easternToIso(endDate, endTime)
  }
  return { startAt, endAt }
}

/**
 * Title + description → v2 category. Trivia / bingo / game nights → `games`;
 * explicit food pop-ups / tasting dinners → `food`; everything else defaults to
 * `music` (the feed is otherwise live bands and themed DJ/party nights). Text
 * inference in upsertEventSafe still enriches toward a second category.
 * Exported for tests.
 */
export function parseCategory(title = '', description = '') {
  const t = `${title} ${description}`.toLowerCase()
  if (/\btrivia\b|\bbingo\b|game night|board game|\bquizzo\b|karaoke contest/.test(t)) {
    return 'games'
  }
  if (/food (pop-?up|truck)|pop-?up dinner|tasting (menu|dinner)|chef['’]s? (table|dinner)|brunch pop-?up/.test(t)) {
    return 'food'
  }
  return 'music'
}

/** True when the event text explicitly states a 21+ restriction. */
export function detectAge(title = '', description = '') {
  return /\b21\s*\+|\b21\s*(?:and|&)?\s*(?:up|older|only)\b/i.test(`${title} ${description}`)
    ? '21_plus'
    : 'not_specified'
}

/**
 * Parse the pinboard region of the events HTML into raw event records. Each
 * card is a `<div class="event-calendar-card ">` with data attributes plus an
 * `<h2>` title, a `.event-day` prose date, an `.event-info-text` description
 * (a hidden data-only div followed by the real prose), a `.event-time` range,
 * and an `.event-image-holder` image. Exported for tests.
 *
 * @returns {{sourceId:string,title:string,startDate:string,startTime24:string,
 *   endDate:string|null,recurrence:string,dayText:string,timeText:string,
 *   description:string|null,imageUrl:string|null}[]}
 */
export function parseEvents(html) {
  const full = String(html || '')

  // Isolate the pinboard view so the agenda + calendar copies of each event
  // (which repeat every card, and list Daily promotions per-day) aren't
  // double-parsed.
  const startIdx = full.indexOf('events-pinboard-view')
  if (startIdx === -1) return []
  const endIdx = full.indexOf('events-agenda-view', startIdx)
  const region = full.slice(startIdx, endIdx === -1 ? full.length : endIdx)

  // Locate each card's opening tag; slice body up to the next card start.
  const cardOpenRe = /<div\b([^>]*\bclass="event-calendar-card\s*"[^>]*)>/gi
  const opens = []
  let m
  while ((m = cardOpenRe.exec(region)) !== null) {
    opens.push({ attrs: m[1], contentStart: cardOpenRe.lastIndex, tagStart: m.index })
  }

  const events = []
  for (let i = 0; i < opens.length; i++) {
    const attrs = opens[i].attrs
    const body = region.slice(opens[i].contentStart, i + 1 < opens.length ? opens[i + 1].tagStart : region.length)

    const attr = (name) => {
      const mm = attrs.match(new RegExp(`${name}="([^"]*)"`, 'i'))
      return mm ? mm[1].trim() : ''
    }

    const sourceId = attr('id')
    const startDate = attr('data-event-start-date').slice(0, 10) // 'YYYY-MM-DD'
    if (!sourceId || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) continue
    const startTime24 = attr('data-event-start-time')
    const endDate = attr('data-event-end-date').slice(0, 10) || null
    const recurrence = attr('data-event-recurrence-type') || 'Does not Repeat'

    const titleM = body.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
    const title = titleM ? stripHtml(titleM[1]) : ''
    if (!title) continue
    // Drop cancelled/postponed events rather than publishing a dead show.
    if (CANCELLED_RE.test(title)) continue

    const dayM = body.match(/class="[^"]*event-day[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
    const dayText = dayM ? stripHtml(dayM[1]) : ''

    const timeM = body.match(/class="[^"]*event-time[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
    const timeText = timeM ? stripHtml(timeM[1]) : ''

    // Description lives in .event-info-text, which opens with a hidden
    // data-only <div style="display: none">…</div> and is followed by the
    // .event-read-more button. Grab everything between, drop the hidden div,
    // then flatten to text.
    let description = null
    const infoM = body.match(/class="[^"]*event-info-text[^"]*"[^>]*>([\s\S]*?)<div class="event-read-more/i)
    if (infoM) {
      const cleaned = infoM[1].replace(/<div\b[^>]*style="display:\s*none"[^>]*>[\s\S]*?<\/div>/i, '')
      const text = stripHtml(cleaned)
      if (text) description = text
    }

    const imgM = body.match(/class="[^"]*event-image-holder[^"]*"[^>]*>\s*<img[^>]*\ssrc="([^"]+)"/i)
    let imageUrl = imgM ? imgM[1].trim() : null
    if (imageUrl && imageUrl.startsWith('//')) imageUrl = `https:${imageUrl}`

    events.push({
      sourceId, title, startDate, startTime24, endDate, recurrence,
      dayText, timeText, description, imageUrl,
    })
  }
  return events
}

/**
 * Expand a raw card into one or more occurrence dates. Non-recurring cards yield
 * a single date; "Daily" cards with an end date yield every day in the inclusive
 * span (capped to the horizon). Each occurrence carries a stable source_id.
 * Exported for tests.
 *
 * @returns {{sourceId:string,date:string}[]}
 */
export function expandOccurrences(ev, now = new Date()) {
  const isDaily = /daily/i.test(ev.recurrence)
  if (!isDaily || !ev.endDate) {
    return [{ sourceId: ev.sourceId, date: ev.startDate }]
  }
  const span = daysBetween(ev.startDate, ev.endDate)
  if (span < 0) return [{ sourceId: ev.sourceId, date: ev.startDate }]

  const today = todayEastern(now)
  const out = []
  for (let d = 0; d <= span; d++) {
    const date = addDays(ev.startDate, d)
    if (daysBetween(today, date) > EXPANSION_HORIZON_DAYS) break
    out.push({ sourceId: `${ev.sourceId}-${date}`, date })
  }
  return out.length ? out : [{ sourceId: ev.sourceId, date: ev.startDate }]
}

// ── Venue / organization ────────────────────────────────────────────────────

async function ensureTikiVenue() {
  return ensureVenue('Tiki Underground', {
    address:       '1832 Front Street',
    city:          'Cuyahoga Falls',
    state:         'OH',
    zip:           '44221',
    lat:           41.1305179,
    lng:           -81.484128,
    parking_type:  'street',
    parking_notes: 'Street and public-lot parking in the downtown Cuyahoga Falls district.',
    website:       'https://tikiunderground.com',
    description:   'Locally-owned tiki bar and lounge in downtown Cuyahoga Falls serving small plates and tiki cocktails, with live music and DJ nights on the back patio. 21+ only.',
  })
}

async function ensureTikiOrganizer() {
  return ensureOrganization('Tiki Underground', {
    website:     'https://tikiunderground.com',
    description: 'Cuyahoga Falls tiki bar hosting live bands, DJ/themed nights, and seasonal bar events.',
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
    const category = parseCategory(ev.title, ev.description || '')
    const age = detectAge(ev.title, ev.description || '')

    for (const occ of expandOccurrences(ev, now)) {
      try {
        const schedule = computeSchedule(occ.date, ev.timeText, ev.startTime24)
        if (!schedule) {
          console.warn(`  ⚠ Could not parse date/time for "${ev.title}" (${occ.date} / ${ev.timeText}) — skipping`)
          skipped++
          continue
        }
        const { startAt, endAt } = schedule

        // Skip occurrences that already ended more than ~a day ago.
        const endMs = endAt ? Date.parse(endAt) : Date.parse(startAt)
        if (endMs < cutoffMs) { skipped++; continue }

        const row = {
          title:           ev.title,
          description:     ev.description || null,
          start_at:        startAt,
          end_at:          endAt,
          category,
          tags:            ['tiki-underground', 'cuyahoga-falls'],
          price_min:       null,
          price_max:       null,
          age_restriction: age,
          image_url:       ev.imageUrl,
          ticket_url:      EVENTS_URL,
          source:          SOURCE_KEY,
          source_id:       occ.sourceId,
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
  }
  return { inserted, skipped }
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Tiki Underground ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([ensureTikiVenue(), ensureTikiOrganizer()])
    if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)

    console.log(`\n🔍  Fetching ${EVENTS_URL}…`)
    const html = await fetchHtml(EVENTS_URL)
    const rawEvents = parseEvents(html)
    console.log(`  Found ${rawEvents.length} event cards on the page`)

    if (rawEvents.length === 0) {
      console.warn('  ⚠ No events parsed — page structure may have changed.')
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, { eventsFound: 0, durationMs: Date.now() - start })
      return
    }

    console.log(`\n📥  Processing ${rawEvents.length} cards…`)
    const { inserted, skipped } = await processEvents(rawEvents, venueId, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — inserted ${inserted}, skipped ${skipped}`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly; importing for tests exposes pure parsers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
