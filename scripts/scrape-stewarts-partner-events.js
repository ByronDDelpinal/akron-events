/**
 * scrape-stewarts-partner-events.js
 *
 * Stewart's Caring Place "Community Partner Events" - fundraisers and benefit
 * events HOSTED BY local organizations, families, and individuals on behalf of
 * Stewart's Caring Place (the Fairlawn cancer wellness center). These never
 * appear in the center's own Tribe calendar (covered by
 * scrape-stewarts-caring-place.js); they live on a hand-edited WordPress page:
 *   https://stewartscaringplace.org/community-partner-events/
 *
 * Why HTML parsing: the page is server-rendered theme markup (classic-content
 * sections), not an events plugin - no REST, no JSON-LD, no ICS. Each section
 * is one event: a heading, bold Date:/Time:/Location: lines (or an unlabelled
 * <h5> date/time/venue stack), prose, and a qgiv/registration button.
 *
 * Page notes (verified 2026-08-07):
 *   • Dates are frequently YEAR-LESS ("Saturday, September 12"). Year-less
 *     dates resolve against the Eastern year of the run date, rolling forward
 *     when past; a stated weekday that matches neither candidate year voids
 *     the date (bad data beats a wrong date on the site).
 *   • Multi-week promotions ("Stampin' Out" stamp challenge, gallery
 *     exhibitions) span months. Anything spanning more than 14 days is
 *     skipped with a logged reason - they are campaigns, not dated events.
 *   • Organizer comes ONLY from explicit "Presented by / Hosted by" language.
 *     Stewart's Caring Place is the beneficiary, not the host, so it is never
 *     defaulted in as organizer.
 *   • Location lines naming Stewart's pin to the same Fairlawn HQ venue
 *     record the main scraper uses; a real venue name (The Rialto Theatre)
 *     resolves through ensureVenue's alias-aware lookup; a bare street
 *     address gets no venue link.
 *   • source_id is slugified-title + date, stable across description edits.
 *
 * Usage:   node scripts/scrape-stewarts-partner-events.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, decodeEntities, easternToIso, easternTodayIso,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization,
} from './lib/normalize.js'
import {
  isSummitCountyLocation, SUMMIT_COUNTY_CITIES, NOT_SUMMIT_COUNTY_CITIES,
} from './lib/summit-county.js'

export const SOURCE_KEY = 'stewarts_partner_events'
const PAGE_URL   = 'https://stewartscaringplace.org/community-partner-events/'
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'
const MAX_SPAN_DAYS = 14

// Same HQ record as scrape-stewarts-caring-place.js, so both sources pin to
// one canonical venue.
const SCP_VENUE_NAME = "Stewart's Caring Place"
const SCP_VENUE_DETAILS = {
  address: '3501 Ridge Park Dr',
  city: 'Fairlawn', state: 'OH', zip: '44333',
  website: 'https://stewartscaringplace.org',
  description: 'Nonprofit cancer wellness center in Fairlawn offering free fitness, holistic-care, and support programming for anyone touched by cancer.',
}

const TAGS = ['stewarts-caring-place', 'community-partner']

// ── Date/time vocabulary ────────────────────────────────────────────────────

const MONTHS = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sept: 9, sep: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
}
const MONTH_SRC   = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')
const MONTH_RE    = new RegExp(`\\b(${MONTH_SRC})\\b`, 'i')

const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 }
const WEEKDAY_SRC = Object.keys(WEEKDAYS).join('|')

const pad = (n) => String(n).padStart(2, '0')
const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`
/** Weekday index (0=Sunday) of a YYYY-MM-DD - timezone-free via Date.UTC. */
const weekdayOf = (iso) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()
/** YYYY-MM-DD of the day after `iso` - timezone-free via Date.UTC. */
const nextDayIso = (iso) => {
  const [y, m, d] = iso.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + 1))
  return isoOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

// ── Pure parsers (exported for tests) ───────────────────────────────────────

const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, ' '))
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ').trim()

/** HTML fragment to trimmed text lines (one per <br>/block element). */
function htmlToLines(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|div)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .split('\n')
    .map((l) => decodeEntities(l).replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * Split the page into its classic-content sections. Each section is one
 * candidate event: { title, html } where html is the content-cell fragment.
 * The title is the first non-empty heading; sections with only prose (the
 * Holding Light exhibition block) fall back to the text before the first
 * comma of the first line.
 */
export function parseSections(html) {
  const out = []
  const chunks = String(html || '').split(/<section class="section classic-content/i).slice(1)
  for (const chunk of chunks) {
    const end  = chunk.indexOf('</section>')
    const body = end === -1 ? chunk : chunk.slice(0, end)
    const cellM = body.match(/<div class="content-cell">([\s\S]*)/i)
    const cell  = cellM ? cellM[1] : body

    let title = null
    for (const h of cell.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)) {
      const text = stripTags(h[1])
      if (text) { title = text; break }
    }
    if (!title) {
      const first = htmlToLines(cell)[0] ?? ''
      title = first.split(',')[0].trim() || null
    }
    if (!title) continue
    out.push({ title, html: cell })
  }
  return out
}

/**
 * Labelled metadata lines: bold "Date(s):" / "Time:" / "Location:" /
 * "Presented by:" / "Hosted by:" values. Falls back to the unlabelled <h5>
 * stack some sections use (date / time / venue on <br> lines). Organizer is
 * captured ONLY from explicit hosted-by/presented-by language - never
 * defaulted.
 */
export function parseStructuredLines(html) {
  const out = { dateText: null, timeText: null, locationText: null, organizer: null }
  for (const line of htmlToLines(html)) {
    const date = line.match(/^dates?:\s*(.+)$/i)
    const time = line.match(/^time:\s*(.+)$/i)
    const loc  = line.match(/^location:\s*(.+)$/i)
    const org  = line.match(/^(?:presented|hosted)\s+by:?\s*(.+)$/i)
    if (date && !out.dateText)     out.dateText     = date[1].trim()
    if (time && !out.timeText)     out.timeText     = time[1].trim()
    if (loc  && !out.locationText) out.locationText = loc[1].trim()
    if (org  && !out.organizer)    out.organizer    = org[1].trim()
  }
  if (!out.dateText) {
    const h5 = String(html || '').match(/<h5[^>]*>([\s\S]*?)<\/h5>/i)
    if (h5) {
      const lines = htmlToLines(h5[1])
      if (lines.length >= 2 && MONTH_RE.test(lines[0])) {
        out.dateText     = lines[0]
        out.timeText     = out.timeText     ?? lines[1] ?? null
        out.locationText = out.locationText ?? lines[2] ?? null
      }
    }
  }
  return out
}

/**
 * First month-name date in prose text: "Thursday, September 10, 2026",
 * "Saturday, September 12", "May 30th". Returns "YYYY-MM-DD" or null.
 *
 * Year-less dates resolve against the Eastern year of the passed todayIso
 * (never new Date().toISOString()), rolling +1 when the date has already
 * passed. A stated weekday must agree: if it matches neither candidate year,
 * the date is bad data on the page and we return null so the event is
 * skipped and counted as a parse failure rather than published on a guessed
 * day. The day is also validated against the actual month length in the
 * resolved year (leap-aware): "September 31" or "February 29" in a non-leap
 * year is bad page data and returns null rather than letting Date roll it
 * into the next month.
 */
export function parseProseDate(text, todayIso) {
  const t = decodeEntities(String(text || ''))
  const m = t.match(new RegExp(
    `(?:\\b(${WEEKDAY_SRC})\\b[,\\s]+)?\\b(${MONTH_SRC})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:[,\\s]+(\\d{4}))?`, 'i'))
  if (!m) return null
  const weekday = m[1] != null ? WEEKDAYS[m[1].toLowerCase()] : null
  const month   = MONTHS[m[2].toLowerCase()]
  const day     = Number(m[3])
  if (!month || !day) return null

  if (m[4]) {
    const year = Number(m[4])
    if (day > lastDayOf(year, month)) return null // Sep 31, Feb 29 in a non-leap year
    const iso = isoOf(year, month, day)
    if (weekday != null && weekdayOf(iso) !== weekday) return null
    return iso
  }

  const baseYear  = Number(String(todayIso).slice(0, 4))
  const preferred = isoOf(baseYear, month, day) >= todayIso ? baseYear : baseYear + 1
  const other     = preferred === baseYear ? baseYear + 1 : baseYear
  // A candidate year in which the day does not exist (leap-aware) is not a
  // candidate at all; if neither survives, the date is invalid on the page.
  const candidates = [preferred, other].filter((y) => day <= lastDayOf(y, month))
  if (candidates.length === 0) return null
  if (weekday == null) return isoOf(candidates[0], month, day)
  for (const y of candidates) {
    if (weekdayOf(isoOf(y, month, day)) === weekday) return isoOf(y, month, day)
  }
  return null
}

/**
 * A month-to-month or day-to-day date RANGE ("May 30th - August 29th",
 * "July through September, 2026"). Month-only endpoints widen to the first /
 * last day of the month. Returns { startIso, endIso, days } or null. Used to
 * skip multi-week campaigns (span > 14 days), so year resolution is simple
 * base-year anchoring with an end-side wrap, never a past-date roll.
 */
export function parseDateSpan(text, todayIso) {
  const t = decodeEntities(String(text || ''))
  const m = t.match(new RegExp(
    `\\b(${MONTH_SRC})\\b\\.?(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?(?:,?\\s*(\\d{4}))?` +
    `\\s*(?:through|thru|until|to|[-\\u2013\\u2014])\\s*` +
    `(?:\\b(?:${WEEKDAY_SRC})\\b[,\\s]+)?\\b(${MONTH_SRC})\\b\\.?(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?(?:,?\\s*(\\d{4}))?`, 'i'))
  if (!m) return null
  const m1 = MONTHS[m[1].toLowerCase()]
  const m2 = MONTHS[m[4].toLowerCase()]
  if (!m1 || !m2) return null
  const baseYear = Number(String(todayIso).slice(0, 4))
  const y1 = m[3] ? Number(m[3]) : (m[6] ? Number(m[6]) : baseYear)
  let   y2 = m[6] ? Number(m[6]) : y1
  const d1 = m[2] ? Number(m[2]) : 1
  const d2 = m[5] ? Number(m[5]) : lastDayOf(y2, m2)
  if (isoOf(y2, m2, d2) < isoOf(y1, m1, d1)) y2 += 1
  const days = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400_000)
  return { startIso: isoOf(y1, m1, d1), endIso: isoOf(y2, m2, d2), days }
}

/**
 * Time range in the page's shapes: "3:00-7:00pm", "7pm - 10pm", "9am - 12pm",
 * "11a-3p". The end meridiem is required (it is what distinguishes a time
 * range from a date range); a start with no meridiem inherits the end's,
 * flipping to AM when that would put the start after the end. Returns 24-hour
 * { start: 'HH:MM', end: 'HH:MM' }, a start-only match { start, end: null },
 * or null. A range whose end is earlier than its start crosses midnight
 * ("10pm - 1am"): the stated start is kept and the result carries
 * `endNextDay: true` so the caller lands the end on the following day.
 * Returning null there would silently downgrade a STATED start time to the
 * noon default.
 */
export function parseTimeRange(text) {
  const t = decodeEntities(String(text || ''))
  const MER = String.raw`(a\.?m\.?|p\.?m\.?|a|p)`
  const range = t.match(new RegExp(
    String.raw`\b(\d{1,2})(?::(\d{2}))?\s*${MER}?\s*(?:[-\u2013\u2014]|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*${MER}\b`, 'i'))
  if (range) {
    const endMer   = range[6][0].toLowerCase()
    const startMer = range[3] ? range[3][0].toLowerCase() : null
    const end   = to24(range[4], range[5], endMer)
    let   start = to24(range[1], range[2], startMer ?? endMer)
    if (startMer == null && cmp(start, end) > 0) start = to24(range[1], range[2], endMer === 'p' ? 'a' : 'p')
    if (cmp(start, end) > 0) return { start: fmt(start), end: fmt(end), endNextDay: true } // crosses midnight
    return { start: fmt(start), end: fmt(end) }
  }
  const single = t.match(new RegExp(String.raw`\b(\d{1,2})(?::(\d{2}))?\s*${MER}\b`, 'i'))
  if (single) return { start: fmt(to24(single[1], single[2], single[3][0].toLowerCase())), end: null }
  return null
}

function to24(h, mm, mer) {
  let hour = Number(h)
  if (mer === 'p' && hour !== 12) hour += 12
  if (mer === 'a' && hour === 12) hour = 0
  return { hour, minute: Number(mm ?? 0) }
}
const cmp = (a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute)
const fmt = (c) => `${pad(c.hour)}:${pad(c.minute)}`

/** "Fighting Cancer Benefit Concert" -> "fighting-cancer-benefit-concert". */
export function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Stable per-event id: slugified title + date. Deliberately excludes times,
 * descriptions, and links so wording edits on the page never mint a
 * duplicate row.
 */
export function buildSourceId(title, dateStr) {
  return `${slugify(title)}-${dateStr}`
}

/**
 * Best-effort city from a location line, for the Summit gate. Only a word
 * matching a KNOWN city (Summit allow-list or known-non-Summit block-list)
 * counts - venue-name words never do - so city-less locations stay null and
 * pass the gate.
 */
export function parseCity(locationText) {
  const t = String(locationText || '').toLowerCase()
  if (!t) return null
  const known = [...SUMMIT_COUNTY_CITIES, ...NOT_SUMMIT_COUNTY_CITIES]
    .sort((a, b) => b.length - a.length)
  for (const city of known) {
    if (new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)) return city
  }
  return null
}

/**
 * Registration link: a qgiv.com href wins; otherwise a button-styled anchor
 * with register/ticket/reserve language. Returns null when the section has
 * neither (the caller falls back to the page URL).
 */
export function parseTicketUrl(html) {
  const anchors = [...String(html || '').matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ href: m[1].match(/href="([^"]+)"/i)?.[1] ?? '', attrs: m[1], text: stripTags(m[2]) }))
    .filter((a) => /^https?:\/\//i.test(a.href))
  const qgiv = anchors.find((a) => /qgiv\.com/i.test(a.href))
  if (qgiv) return qgiv.href
  const btn = anchors.find((a) => /\bbutton\b/i.test(a.attrs) && /register|ticket|reserve|sign\s*up/i.test(a.text))
  return btn ? btn.href : null
}

/**
 * Conservative title-only category, same approach as the Woven Words
 * scraper: only unambiguous signals classify, everything else stays 'other'.
 */
export function inferCategory(title = '') {
  const t = String(title).toLowerCase()
  if (/\b(concert|music|band)\b/.test(t))     return 'music'
  if (/\b(5k|race|run|walk)\b/.test(t))       return 'fitness'
  if (/\bgolf\b/.test(t))                     return 'sports'
  if (/\b(art|exhibit|exhibition)\b/.test(t)) return 'visual-art'
  return 'other'
}

/** Explicit benefit/fundraiser/proceeds language only - never assumed. */
export function parseIsFundraiser(text = '') {
  return /\b(benefit|fundrais\w*|proceeds)\b/i.test(String(text))
}

function parseDescription(html) {
  const paras = []
  for (const p of String(html || '').matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const lines = htmlToLines(p[1])
      .filter((l) => !/^(dates?|time|location):/i.test(l) && !/^(?:presented|hosted)\s+by:?/i.test(l))
    if (lines.length) paras.push(lines.join(' '))
  }
  return paras.join('\n\n').slice(0, 2000) || null
}

function parseImage(html) {
  const src = String(html || '').match(/<img[^>]+src="([^"]+)"/i)?.[1] ?? null
  return src ? src.replace(/^http:\/\//i, 'https://') : null
}

/**
 * Full pure parse: page HTML -> { events, skipped }. No I/O, no DB - venue
 * and organizer resolution happen in main(). `skipped` carries a reason per
 * rejected section so the run log explains every miss.
 */
export function parseEvents(html, todayIso, pageUrl = PAGE_URL) {
  const events = [], skipped = []
  for (const section of parseSections(html)) {
    const { title } = section
    const text = htmlToLines(section.html).join('\n')
    const structured = parseStructuredLines(section.html)
    const dateSource = structured.dateText ?? text

    const span = parseDateSpan(dateSource, todayIso)
    if (span && span.days > MAX_SPAN_DAYS) {
      skipped.push({ title, reason: `date span ${span.days} days exceeds ${MAX_SPAN_DAYS} (campaign, not a dated event)` })
      continue
    }

    const dateIso = span ? span.startIso : parseProseDate(dateSource, todayIso)
    if (!dateIso) {
      skipped.push({ title, reason: 'no parseable date (or stated weekday / day-of-month is valid in no candidate year)' })
      continue
    }

    const city = parseCity(structured.locationText)
    if (city && !isSummitCountyLocation({ city })) {
      skipped.push({ title, reason: `outside Summit County (${city})` })
      continue
    }

    const range = parseTimeRange(structured.timeText ?? text)
    let startTime, endTime, endNextDay = false, timeStated
    if (range) {
      startTime  = range.start
      endTime    = range.end
      endNextDay = range.endNextDay === true // cross-midnight range: end lands tomorrow
      timeStated = true
    } else {
      // SANCTIONED-DEFAULT-TIME
      // The page states no clock time for some events. Storing them at
      // midnight would drop them out of every feed on their own day (the
      // list/map/digest feeds filter .gte('start_at', now()) with no grace
      // window), so a timeless event gets a midday default start. Same
      // convention as scrape-downtown-cf.js / scrape-ohio-festivals.js.
      startTime = '12:00'
      endTime   = null
      timeStated = false
    }

    events.push({
      title,
      dateIso,
      startIso:     easternToIso(dateIso, startTime),
      endIso:       endTime ? easternToIso(endNextDay ? nextDayIso(dateIso) : dateIso, endTime) : null,
      timeStated,
      locationText: structured.locationText,
      organizer:    structured.organizer,
      ticketUrl:    parseTicketUrl(section.html) ?? pageUrl,
      isFundraiser: parseIsFundraiser(`${title}\n${text}`),
      category:     inferCategory(title),
      description:  parseDescription(section.html),
      imageUrl:     parseImage(section.html),
      sourceId:     buildSourceId(title, dateIso),
    })
  }
  return { events, skipped }
}

// ── Fetch ───────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🎗  Starting Stewart's Caring Place partner-events ingestion…")
  const start = Date.now()
  try {
    const html = await fetchHtml(PAGE_URL)
    const todayIso = easternTodayIso()
    const { events, skipped: parseSkips } = parseEvents(html, todayIso)
    for (const s of parseSkips) console.log(`  ⛔ Skipping "${s.title}" - ${s.reason}`)
    console.log(`  Parsed ${events.length} event(s), skipped ${parseSkips.length} section(s)`)

    const venueCache = new Map()
    const orgCache   = new Map()
    let inserted = 0, skipped = parseSkips.length

    for (const ev of events) {
      try {
        if (ev.dateIso < todayIso) { console.log(`  ⏭  "${ev.title}" already past (${ev.dateIso})`); skipped++; continue }

        // Venue: Stewart's -> the shared HQ record; a real venue name ->
        // ensureVenue (alias-aware); a bare street address -> no venue link.
        let venueId = null
        const loc = ev.locationText
        if (loc && /stewart/i.test(loc)) {
          if (!venueCache.has(SCP_VENUE_NAME)) venueCache.set(SCP_VENUE_NAME, await ensureVenue(SCP_VENUE_NAME, SCP_VENUE_DETAILS))
          venueId = venueCache.get(SCP_VENUE_NAME)
        } else if (loc && !/^\d/.test(loc.trim())) {
          if (!venueCache.has(loc)) venueCache.set(loc, await ensureVenue(loc, { state: 'OH' }))
          venueId = venueCache.get(loc)
        }

        // Organizer ONLY from explicit hosted-by/presented-by language.
        // Stewart's Caring Place is the beneficiary, never defaulted as host.
        let organizerId = null
        if (ev.organizer) {
          if (!orgCache.has(ev.organizer)) orgCache.set(ev.organizer, await ensureOrganization(ev.organizer, {}))
          organizerId = orgCache.get(ev.organizer)
        }

        const row = {
          title:           ev.title,
          description:     ev.description,
          start_at:        ev.startIso,
          end_at:          ev.endIso,
          category:        ev.category,
          tags:            ev.isFundraiser ? [...TAGS, 'fundraiser', 'give-back'] : TAGS,
          price_min:       null,
          price_max:       null,
          age_restriction: 'not_specified',
          image_url:       ev.imageUrl,
          ticket_url:      ev.ticketUrl,
          source:          SOURCE_KEY,
          source_id:       ev.sourceId,
          status:          'published',
          featured:        false,
          is_fundraiser:   ev.isFundraiser || undefined,
        }
        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed "${row.title}":`, error.message); skipped++; continue }
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on "${ev.title}":`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: events.length + parseSkips.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s - ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
