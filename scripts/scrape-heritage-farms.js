/**
 * scrape-heritage-farms.js
 *
 * Heritage Farms — a 5th-generation family farm in the Village of Peninsula
 * (6050 Riverview Rd, Peninsula OH 44264 — Summit County, in the heart of the
 * Cuyahoga Valley). The farm hosts a handful of curated ANNUAL events:
 *   • Peninsula Flea at the Farm  — an upscale summer flea market held on a few
 *     Saturdays (June–Aug), one of which is themed "Christmas in July".
 *   • Pumpkin Pandemonium         — a fall pumpkin-patch weekend festival that
 *     runs Saturdays & Sundays from late Sept through late Oct (hayrides, maze,
 *     scavenger challenge, food vendors, live musicians).
 *   • Christmas Trees             — cut-your-own & fresh-cut tree season opening
 *     the weekend before Thanksgiving and running through the holidays.
 *
 * Platform: Wix, but NOT the Wix Events app — these are hand-authored static
 * content pages (no events widget, no JSON-LD, no #wix-warmup event objects).
 * Each event lives on its own detail page (/peninsula-flea, /pumpkin-pandemonium,
 * /christmas-trees) whose prose carries the real schedule. We tag-split the raw
 * HTML into logical lines (htmlToLines — the stripHtml-contract lesson: stripHtml
 * flattens ALL whitespace, so it can't be used for line-based parsing) and parse
 * the schedule statements defensively.
 *
 * Date modelling — the hard part. The pages mix content across seasons (the site
 * chrome shows a 2026 copyright while a fall schedule block may still read 2025).
 * We NEVER assume "this year". Instead each schedule states a weekday cadence
 * ("held on the Saturday", "Saturday & Sunday", "closed Thanksgiving Day"), so we
 * DERIVE the season year by finding the year (within a tight ±window of today)
 * whose anchor date lands on the stated weekday. This both picks the right year
 * and validates the dates against the cadence — a built-in stale-content guard.
 * If the fall/winter blocks are stale (their derived year is in the past), those
 * occurrences are simply filtered out as past events, and a future scrape picks
 * up the new season once the farm updates the page. As of the 2026 build:
 *   • Flea    → derives 2026 (June 6/27, July 25, Aug 8 are all Saturdays) ✓
 *   • Pumpkin → derives 2025 (Sep 27 is a Saturday only in 2025) → stale/past
 *   • Xmas    → derives 2025 (Nov 27 Thanksgiving is a Thursday only in 2025) → stale/past
 *
 * Times come straight from the page prose (10a–4p flea, 10a–5p pumpkin weekends,
 * 9a–7p Christmas Fri–Sun). Prices are left null — the pages state no admission
 * fee either way, and we never assume free. Every event is at the one farm
 * address, pinned to a single canonical Summit-County venue → status published.
 *
 * Usage:   node scripts/scrape-heritage-farms.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, easternToIso,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'
import { WEEKDAY, easternTodayYmd } from './lib/weekly-occurrences.js'

export const SOURCE_KEY = 'heritage_farms'
const SITE = 'https://www.heritagefarms.com'
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

const PAGES = {
  flea:     `${SITE}/peninsula-flea`,
  pumpkin:  `${SITE}/pumpkin-pandemonium`,
  christmas: `${SITE}/christmas-trees`,
}

const ORG_NAME = 'Heritage Farms'
const VENUE_NAME = 'Heritage Farms'
const VENUE_DETAILS = {
  address: '6050 Riverview Road',
  city: 'Peninsula', state: 'OH', zip: '44264',
  website: SITE,
  description: 'A 5th-generation family farm in the Village of Peninsula, in the heart of the Cuyahoga Valley — home to the summer Peninsula Flea, fall Pumpkin Pandemonium, and a cut-your-own Christmas tree farm.',
}
const ORG_DESCRIPTION = VENUE_DETAILS.description

// Horizon guard: nothing more than ~13 months out (season pages publish one
// season at a time; this keeps a mis-parsed far-future date from slipping in).
const MAX_DAYS_AHEAD = 400
const PAST_SLACK_MS = 12 * 3600_000 // keep an event until ~12h after its start

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
}

// ── Pure parsers (exported for tests) ────────────────────────────────────────

/**
 * Line-split raw HTML on the tags that delimit content on Wix pages (closing
 * div/span/heading/etc. plus <br>), then strip the rest. htmlToText is NOT
 * suitable — logical lines here are separated by element boundaries, not
 * <br>/<p> pairs (the stripHtml-contract lesson).
 */
export function htmlToLines(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|span|td|tr|p|h[1-6]|li|a|section|header|footer|title)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;|&#x27;|&#39;/g, "'")
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&nbsp;/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** JS getUTCDay() for a given calendar date (0=Sun … 6=Sat). */
function weekdayOf(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

/**
 * Derive the season year for a schedule whose only year signal is a weekday
 * cadence. Search a tight window around "today" (Eastern) and return the year
 * in which (month/day) falls on `expectedDow`. Prefer the soonest such year
 * that is today-or-future; otherwise the most recent past match (stale block).
 * Returns null when no year in the window matches — a stale/inconsistent block
 * we should NOT guess at.
 */
export function resolveSeasonYear(month, day, expectedDow, now = new Date()) {
  const thisYear = Number(easternTodayYmd(now).slice(0, 4))
  const matches = []
  for (let y = thisYear - 1; y <= thisYear + 2; y++) {
    if (weekdayOf(y, month, day) === expectedDow) matches.push(y)
  }
  if (!matches.length) return null
  const [ty, tm, td] = easternTodayYmd(now).split('-').map(Number)
  const todayMs = Date.UTC(ty, tm - 1, td)
  const future = matches.filter((y) => Date.UTC(y, month - 1, day) >= todayMs - 2 * 86_400_000)
  return future.length ? Math.min(...future) : Math.max(...matches)
}

/** 'YYYY-MM-DD' calendar dates in [startYmd, endYmd] whose weekday is in `dows`. */
export function datesInRangeOnWeekdays(startYmd, endYmd, dows) {
  const out = []
  const end = Date.parse(`${endYmd}T00:00:00Z`)
  for (let ms = Date.parse(`${startYmd}T00:00:00Z`); ms <= end; ms += 86_400_000) {
    if (dows.includes(new Date(ms).getUTCDay())) out.push(new Date(ms).toISOString().slice(0, 10))
  }
  return out
}

/**
 * Parse a "10:00 a.m. - 4:00 p.m." / "10:00 am to 5:00 pm" style range.
 * Returns { start: '10:00 am', end: '4:00 pm' } (meridiem normalised) or null.
 */
export function parseTimeRange(text = '') {
  const m = String(text).match(
    /(\d{1,2}(?::\d{2})?)\s*(a\.?m\.?|p\.?m\.?)\s*(?:-|–|—|to)\s*(\d{1,2}(?::\d{2})?)\s*(a\.?m\.?|p\.?m\.?)/i,
  )
  if (!m) return null
  const norm = (mer) => (/^p/i.test(mer) ? 'pm' : 'am')
  return { start: `${m[1]} ${norm(m[2])}`, end: `${m[3]} ${norm(m[4])}` }
}

/** Parse a single "Month Day" token → { month, day } or null. */
function parseMonthDay(token) {
  const m = String(token).trim().match(/([A-Za-z]+)\s+(\d{1,2})/)
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  if (!month) return null
  return { month, day: Number(m[2]) }
}

/**
 * Peninsula Flea — an explicit list of Saturday dates + one hours line.
 * Year is derived from the first date being a Saturday (the stated cadence).
 * The date matching "Christmas in July" gets a themed title.
 */
export function parseFleaEvents(lines, now = new Date()) {
  const text = lines.join('  ')
  const datesLine = lines.find((l) => /^Dates?:/i.test(l))
  if (!datesLine) return []
  const hours = parseTimeRange(lines.find((l) => parseTimeRange(l) && /a\.?m/i.test(l)) || '')
  const startTime = hours ? hours.start : null
  const endTime = hours ? hours.end : null

  const tokens = datesLine.replace(/^Dates?:/i, '').split(/,|&|\band\b/i)
  const parsed = tokens.map(parseMonthDay).filter(Boolean)
  if (!parsed.length) return []

  const year = resolveSeasonYear(parsed[0].month, parsed[0].day, WEEKDAY.saturday, now)
  if (!year) return []

  // Which date is the "Christmas in July" edition?
  const cij = text.match(/([A-Za-z]+)\s+(\d{1,2})[^.]{0,20}Christmas in July/i)
  const cijMd = cij ? parseMonthDay(`${cij[1]} ${cij[2]}`) : null

  return parsed.map(({ month, day }) => {
    const ymd = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const isCij = cijMd && cijMd.month === month && cijMd.day === day
    const title = isCij
      ? 'Peninsula Flea at the Farm: Christmas in July'
      : 'Peninsula Flea at the Farm'
    const description =
      'The Peninsula Flea at Heritage Farms is an upscale flea market on the grounds of the ' +
      'farm’s century home, featuring high-quality handmade, repurposed, and vintage goods ' +
      'from dedicated artists, crafters, and collectors, plus seasonal refreshments and free parking.' +
      (isCij ? ' This edition is the farm’s "Christmas in July" market.' : '') +
      (startTime && endTime ? ` Held ${startTime}–${endTime}.` : '')
    return {
      title,
      description,
      startIso: startTime ? easternToIso(ymd, startTime) : easternToIso(ymd, ''),
      endIso: endTime ? easternToIso(ymd, endTime) : null,
      // If the hours line ever fails to parse we fall back to a date-only
      // (midnight ET) start — never publish that silently; flag it for review
      // instead of pretending the market opens at 00:00.
      needsReview: !startTime,
      ymd,
      sourceId: `peninsula-flea-${ymd}`,
      tags: ['heritage-farms', 'peninsula', 'flea-market', 'market', 'shopping'],
      isFamily: undefined, // a shopping market — let inference decide the family facet
      ticketUrl: PAGES.flea,
    }
  })
}

/**
 * Pumpkin Pandemonium — a Sat/Sun weekend festival across an explicit date
 * range. Year derived from the range START being a Saturday (stated cadence:
 * "Saturday & Sunday"). Generates one event per weekend day in-range.
 */
export function parsePumpkinEvents(lines, now = new Date()) {
  // First range like "September 27th thru October 26th".
  let range = null
  for (const l of lines) {
    const m = l.match(
      /([A-Za-z]+)\s+(\d{1,2})\w*\s*(?:thru|through|to|-|–|—)\s*(?:([A-Za-z]+)\s+)?(\d{1,2})\w*/i,
    )
    if (!m) continue
    const start = parseMonthDay(`${m[1]} ${m[2]}`)
    const end = parseMonthDay(`${m[3] || m[1]} ${m[4]}`)
    if (start && end) { range = { start, end }; break }
  }
  if (!range) return []

  // Weekend hours: the first am–pm range on a line that mentions the weekend
  // cadence or immediately follows it. Fall back to the first am–pm range.
  const weekendHours =
    parseTimeRange(lines.find((l) => /saturday\s*&\s*sunday/i.test(l) && parseTimeRange(l)) || '') ||
    parseTimeRange(lines.find((l) => parseTimeRange(l)) || '')
  const startTime = weekendHours ? weekendHours.start : '10:00 am'
  const endTime = weekendHours ? weekendHours.end : null

  const year = resolveSeasonYear(range.start.month, range.start.day, WEEKDAY.saturday, now)
  if (!year) return []

  const startYmd = `${year}-${String(range.start.month).padStart(2, '0')}-${String(range.start.day).padStart(2, '0')}`
  const endYmd = `${year}-${String(range.end.month).padStart(2, '0')}-${String(range.end.day).padStart(2, '0')}`

  return datesInRangeOnWeekdays(startYmd, endYmd, [WEEKDAY.saturday, WEEKDAY.sunday]).map((ymd) => ({
    title: 'Pumpkin Pandemonium at Heritage Farms',
    description:
      'Pumpkin Pandemonium is Heritage Farms’ fall festival of pumpkins, gourds, corn shocks, ' +
      'and straw bales, with hayrides, a corn maze, a scavenger challenge, seasonal refreshments, ' +
      'and weekend food vendors and live musicians. Open Saturdays and Sundays' +
      (startTime && endTime ? ` ${startTime}–${endTime}` : '') + '.',
    startIso: easternToIso(ymd, startTime),
    endIso: endTime ? easternToIso(ymd, endTime) : null,
    ymd,
    sourceId: `pumpkin-pandemonium-${ymd}`,
    tags: ['heritage-farms', 'peninsula', 'pumpkin-patch', 'fall-festival', 'festival', 'family', 'outdoors'],
    isFamily: true,
    ticketUrl: PAGES.pumpkin,
  }))
}

/**
 * Christmas Trees — a season, not a per-date listing. We model a single opening
 * event dated to the stated opening day. Year is anchored on the "Closed
 * Thanksgiving Day, November <27>" statement (Thanksgiving is always a Thursday),
 * which uniquely pins the season year.
 */
export function parseChristmasEvents(lines, now = new Date()) {
  const text = lines.join('  ')
  const openM = text.match(/Open\s+([A-Za-z]+)\s+(\d{1,2})/i)
  const open = openM ? parseMonthDay(`${openM[1]} ${openM[2]}`) : null
  if (!open) return []

  // Anchor: "Thanksgiving Day, November 27" → that date is a Thursday.
  const thanks = text.match(/Thanksgiving Day,?\s*([A-Za-z]+)\s+(\d{1,2})/i)
  const thanksMd = thanks ? parseMonthDay(`${thanks[1]} ${thanks[2]}`) : null
  const year = thanksMd
    ? resolveSeasonYear(thanksMd.month, thanksMd.day, WEEKDAY.thursday, now)
    : resolveSeasonYear(open.month, open.day, weekdayOf(2025, open.month, open.day), now)
  if (!year) return []

  const ymd = `${year}-${String(open.month).padStart(2, '0')}-${String(open.day).padStart(2, '0')}`
  return [{
    title: 'Christmas Trees at Heritage Farms',
    description:
      'Heritage Farms opens for Christmas tree season — choose-and-cut from the fields grown ' +
      'from seedlings, or pick a fresh-cut tree in the tree barn, with greenery, wreaths, and hot ' +
      'chocolate by the fireplace. Open Friday–Sunday 9am–7pm and Monday–Thursday 12pm–7pm ' +
      '(cut-your-own fields close at dusk); closed Thanksgiving Day.',
    startIso: easternToIso(ymd, '9:00 am'),
    endIso: null,
    ymd,
    sourceId: `christmas-trees-${year}`,
    tags: ['heritage-farms', 'peninsula', 'christmas-trees', 'holiday', 'family', 'outdoors'],
    isFamily: true,
    ticketUrl: PAGES.christmas,
  }]
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Entry point ────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌾  Starting Heritage Farms ingestion…')
  const start = Date.now()
  try {
    const [organizerId, venueId] = await Promise.all([
      ensureOrganization(ORG_NAME, { website: SITE, description: ORG_DESCRIPTION }),
      ensureVenue(VENUE_NAME, VENUE_DETAILS),
    ])
    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    const [fleaHtml, pumpkinHtml, xmasHtml] = await Promise.all([
      fetchPage(PAGES.flea), fetchPage(PAGES.pumpkin), fetchPage(PAGES.christmas),
    ])

    const events = [
      ...parseFleaEvents(htmlToLines(fleaHtml)),
      ...parsePumpkinEvents(htmlToLines(pumpkinHtml)),
      ...parseChristmasEvents(htmlToLines(xmasHtml)),
    ]
    console.log(`  Parsed ${events.length} candidate occurrence(s) across 3 annual events`)

    const now = Date.now()
    const cutoff = now + MAX_DAYS_AHEAD * 86_400_000
    let inserted = 0, skipped = 0

    for (const ev of events) {
      const startMs = ev.startIso ? Date.parse(ev.startIso) : NaN
      if (Number.isNaN(startMs) || startMs < now - PAST_SLACK_MS || startMs > cutoff) { skipped++; continue }
      const row = {
        title:           ev.title,
        description:     ev.description,
        start_at:        ev.startIso,
        end_at:          ev.endIso,
        tags:            ev.tags,
        price_min:       null, // pages state no admission fee either way
        price_max:       null,
        age_restriction: 'all_ages',
        image_url:       null, // shared fallback image covers display
        ticket_url:      ev.ticketUrl,
        source_url:      ev.ticketUrl,
        source:          SOURCE_KEY,
        source_id:       ev.sourceId,
        status:          'published',
        featured:        false,
      }
      if (ev.isFamily !== undefined) row.is_family = ev.isFamily
      if (ev.needsReview) row.needs_review = true // date-only midnight fallback — surface it

      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) {
        console.warn(`  ⚠ Upsert failed "${row.title}" (${ev.ymd}): ${error.message}`)
        skipped++
        continue
      }
      if (venueId) await linkEventVenue(upserted.id, venueId)
      if (organizerId) await linkEventOrganization(upserted.id, organizerId)
      inserted++
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: events.length, durationMs: Date.now() - start,
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
