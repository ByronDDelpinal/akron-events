/**
 * scrape-dilly-ds.js
 *
 * Dilly D's Sports Grill — family-run sports bar & grill in Northfield
 * (9750 Olde Eight Road, Northfield, OH 44067, est. May 2018). One standing
 * weekly event plus occasional dated themed editions.
 *
 * Platform: GoDaddy Websites+Marketing static single-page site (dillyds.com),
 * no feed, no per-date listings. The page states (verified 2026-07-09):
 *   • "Last Call Trivia every Wednesday at 7PM!" (banner), restated in a
 *     LAST CALL TRIVIA section: "Join us on every Wednesday at 7pm …",
 *     "All ages welcome. Up to 8 players per team.", and a trivia-players
 *     drink special.
 *   • "Themed Trivia Nights:" — a compact list ("August 12th - Decades",
 *     "September 16th - Friends") plus THEME TRIVIA detail blocks, each
 *     "<Theme> Trivia Night" / description lines / "Wednesday, August 12th" /
 *     "7:00PM".
 *
 * Event model: parse the schedule STATEMENT (weekday + time never hardcoded —
 * if trivia moves to Tuesdays at 8 the next scrape follows), then GENERATE the
 * next 8 weekly occurrences via lib/weekly-occurrences.js (Eastern-anchored
 * calendar math, immune to the UTC-rollover footgun) + easternToIso(ymd, time).
 * Each dated themed night becomes its own event; when a themed night lands on
 * a generated weekly date (they are themed EDITIONS of the same Wednesday
 * slot) the plain weekly occurrence is dropped for that date so the run never
 * publishes two copies of one trivia night. Date-keyed source_ids
 * ('trivia-YYYY-MM-DD' / 'special-YYYY-MM-DD') keep the twice-daily run
 * idempotent; themed dates carry no year, so the year is inferred as the
 * current one, rolling forward when >45 days past (the parseShowDates idiom).
 * If the trivia block disappears the run yields zero events and existing
 * future rows age out via the stale sweep.
 *
 * The markup is GoDaddy div/span soup with logical lines delimited only by
 * closing element tags, so we tag-split the RAW HTML (htmlToLines) rather
 * than use htmlToText — the stripHtml-contract lesson. Fixture captured from
 * the live raw source (fetch().text(), not the rendered DOM — the Magic City
 * lesson) on 2026-07-09 and length-checked line-by-line against the page.
 *
 * Usage:   node scripts/scrape-dilly-ds.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, easternToIso,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'
import { WEEKDAY, nextWeeklyOccurrences } from './lib/weekly-occurrences.js'

export const SOURCE_KEY = 'dilly_ds'
const PAGE_URL = 'https://dillyds.com/'
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

const ORG_NAME   = "Dilly D's Sports Grill"
const VENUE_NAME = "Dilly D's Sports Grill"
const VENUE_DETAILS = {
  address: '9750 Olde Eight Road',
  city: 'Northfield', state: 'OH', zip: '44067',
  website: 'https://dillyds.com',
  description: 'Family-run sports bar & grill in Northfield, established 2018: daily lunch and dinner specials, seasonal martinis and cocktails, and weekly Last Call Trivia.',
}

const OCCURRENCE_COUNT = 8

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}
const MONTH_ALT = Object.keys(MONTHS).join('|')

// ── Pure parsers (exported for tests) ───────────────────────────────────────

/**
 * Line-split raw HTML on the tags that actually delimit content on this site
 * (closing div/span/td/p/h1-6/li, plus <br>), then strip the rest. htmlToText
 * is NOT suitable here — the GoDaddy layout separates logical lines only by
 * element boundaries, never <br>/<p> pairs.
 */
export function htmlToLines(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|span|td|tr|p|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;|&#x27;|&#39;|&apos;/g, "'").replace(/&#8211;|&ndash;/g, '–').replace(/&nbsp;|&#160;/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

const SCHEDULE_RE = /\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/i

/**
 * Year inference for month/day-only dates: current year, rolled forward when
 * the result would sit >45 days in the past (a December listing scraped in
 * January) — the parseShowDates idiom from the Magic City scraper.
 */
function inferYmd(month, day, now) {
  let year = now.getFullYear()
  if (Date.UTC(year, month - 1, day) < now.getTime() - 45 * 86400_000) year += 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * The standing weekly schedule statement, e.g. "Join us on every Wednesday at
 * 7pm …". The LAST CALL TRIVIA section's statement is preferred (its
 * neighboring lines are the event's real description); the site-wide banner
 * ("Last Call Trivia every Wednesday at 7PM!") is the fallback. Returns
 * { weekday, weekdayName, time, statement, details } or null when the page
 * carries no such statement (trivia dropped).
 *
 * details = the section lines that describe the night (prizes, "All ages
 * welcome. Up to 8 players per team.", drink special), stopping at the themed
 * list so themed entries never leak into the weekly description.
 */
export function parseTriviaSchedule(lines = []) {
  const fromMatch = (line) => {
    const m = line.match(SCHEDULE_RE)
    if (!m) return null
    const weekdayName = m[1].toLowerCase()
    return {
      weekday: WEEKDAY[weekdayName],
      weekdayName,
      time: `${m[2]}:${m[3] ?? '00'} ${m[4].toLowerCase()}m`,
      statement: line,
      details: [],
    }
  }

  const sectionIdx = lines.findIndex((l) => /^last call trivia$/i.test(l))
  if (sectionIdx !== -1) {
    let sched = null
    const details = []
    for (let i = sectionIdx + 1; i < Math.min(lines.length, sectionIdx + 8); i++) {
      if (/^themed trivia nights/i.test(lines[i]) || /^theme trivia$/i.test(lines[i])) break
      sched ??= fromMatch(lines[i])
      details.push(lines[i])
    }
    if (sched) return { ...sched, details }
  }
  for (const line of lines) {
    const sched = fromMatch(line)
    if (sched) return sched
  }
  return null
}

/**
 * Dated themed trivia nights, merged from the page's two forms:
 *   compact list  — "August 12th - Decades"
 *   detail block  — "Decades Trivia Night" / description lines /
 *                   "Wednesday, August 12th" / "7:00PM"
 * Detail blocks win on title/description; time comes from the block's own
 * time line when present. Returns [{ ymd, title, description, time|null }]
 * in date order.
 */
export function parseThemedNights(lines = [], now = new Date()) {
  const listRe  = new RegExp(`^(${MONTH_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*[-–—]\\s*(.+)$`, 'i')
  const dateRe  = new RegExp(`^(?:(?:sun|mon|tues|wednes|thurs|fri|satur)day,?\\s+)?(${MONTH_ALT})\\s+(\\d{1,2})(?:st|nd|rd|th)?$`, 'i')
  const timeRe  = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i
  const titleRe = /^(.+)\s+trivia night$/i // requires a theme prefix, so the bare "Trivia Night" nav item never opens a block
  const byYmd = new Map()

  for (const line of lines) {
    const m = line.match(listRe)
    if (!m) continue
    const ymd = inferYmd(MONTHS[m[1].toLowerCase()], Number(m[2]), now)
    byYmd.set(ymd, { ymd, title: `${m[3].trim()} Trivia Night`, description: '', time: null })
  }

  let block = null
  for (const line of lines) {
    const tm = line.match(titleRe)
    if (tm && !/^themed$/i.test(tm[1])) {
      block = { title: line, desc: [], ymd: null }
      continue
    }
    if (!block) continue
    if (!block.ymd) {
      const dm = line.match(dateRe)
      if (dm) {
        block.ymd = inferYmd(MONTHS[dm[1].toLowerCase()], Number(dm[2]), now)
        const prev = byYmd.get(block.ymd) ?? { ymd: block.ymd, time: null }
        byYmd.set(block.ymd, { ...prev, title: block.title, description: block.desc.join(' ') })
        continue
      }
      block.desc.push(line)
      if (block.desc.length > 6) block = null // runaway guard: not a real block
      continue
    }
    const t = line.match(timeRe)
    if (t) byYmd.get(block.ymd).time = `${t[1]}:${t[2] ?? '00'} ${t[3].toLowerCase()}m`
    block = null // one line past the date, time or not, the block is done
  }

  return [...byYmd.values()].sort((a, b) => a.ymd.localeCompare(b.ymd))
}

/**
 * The venue's street address as stated on the page footer ("9750 Olde Eight
 * Road, Northfield, Ohio 44067, United States") — a drift guard, not the
 * source of truth (VENUE_DETAILS is verified by hand). main() warns when the
 * page no longer matches.
 */
export function parseAddress(lines = []) {
  const re = /^(\d+[^,]+),\s*([A-Za-z .']+),\s*(?:OH|Ohio)\s+(\d{5})(?:,\s*United States)?$/i
  for (const line of lines) {
    const m = line.match(re)
    if (m) return { address: m[1].trim(), city: m[2].trim(), state: 'OH', zip: m[3] }
  }
  return null
}

/**
 * Assemble the full run: the next OCCURRENCE_COUNT weekly occurrences (minus
 * any date owned by a themed night) plus one event per themed night. Themed
 * nights with no time anywhere (own block, weekly statement) are skipped —
 * a bar event pinned to midnight is worse than absent. Returns [] when the
 * page carries no schedule statement and no themed nights.
 */
export function buildEvents(lines, now = new Date()) {
  const schedule = parseTriviaSchedule(lines)
  const themed = parseThemedNights(lines, now)
  const themedDates = new Set(themed.map((t) => t.ymd))
  const agesLine = schedule?.details.find((l) => /all ages|players per team/i.test(l)) ?? null
  const allAges = /all ages/i.test(agesLine ?? '')
  const events = []

  if (schedule) {
    const description = schedule.details.length
      ? schedule.details.join(' ')
      : `${schedule.statement} at Dilly D's Sports Grill in Northfield.`
    for (const ymd of nextWeeklyOccurrences(schedule.weekday, { count: OCCURRENCE_COUNT, now })) {
      if (themedDates.has(ymd)) continue // that night IS the themed edition
      events.push({
        kind: 'weekly',
        title: "Last Call Trivia at Dilly D's",
        description,
        startIso: easternToIso(ymd, schedule.time),
        ymd,
        sourceId: `trivia-${ymd}`,
        allAges,
      })
    }
  }

  for (const t of themed) {
    const time = t.time ?? schedule?.time
    if (!time) continue
    events.push({
      kind: 'themed',
      title: `${t.title} at Dilly D's`,
      description: [t.description, agesLine].filter(Boolean).join(' '),
      startIso: easternToIso(t.ymd, time),
      ymd: t.ymd,
      sourceId: `special-${t.ymd}`,
      allAges,
    })
  }

  return events.sort((a, b) => a.ymd.localeCompare(b.ymd))
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log("🍻  Starting Dilly D's ingestion…")
  const start = Date.now()
  try {
    const [organizerId, venueId] = await Promise.all([
      ensureOrganization(ORG_NAME, {
        website: VENUE_DETAILS.website,
        description: VENUE_DETAILS.description,
      }),
      ensureVenue(VENUE_NAME, VENUE_DETAILS),
    ])
    await linkOrganizationVenue(organizerId, venueId)

    const lines = htmlToLines(await fetchPage(PAGE_URL))

    const stated = parseAddress(lines)
    if (!stated || stated.address !== VENUE_DETAILS.address || stated.city !== VENUE_DETAILS.city) {
      console.warn('  ⚠ Page address drifted from VENUE_DETAILS:', JSON.stringify(stated))
    }

    const events = buildEvents(lines)
    console.log(`  ${PAGE_URL} → ${events.length} events (${events.filter((e) => e.kind === 'themed').length} themed)`)

    let inserted = 0, skipped = 0
    for (const ev of events) {
      if (!ev.startIso || Date.parse(ev.startIso) < Date.now() - 3 * 3600_000) { skipped++; continue }
      const row = {
        title:           ev.title,
        description:     ev.description,
        start_at:        ev.startIso,
        end_at:          null,
        category:        'games',
        tags:            ev.kind === 'themed'
          ? ['trivia', 'themed-trivia', 'bar', 'games', 'dilly-ds']
          : ['trivia', 'bar', 'games', 'dilly-ds'],
        price_min:       null,            // page states no entry fee either way
        price_max:       null,
        age_restriction: ev.allAges ? 'all_ages' : 'not_specified', // "All ages welcome." — parsed, not assumed
        image_url:       null,            // shared fallback image covers display
        ticket_url:      PAGE_URL,
        source:          SOURCE_KEY,
        source_id:       ev.sourceId,
        status:          'published',
        featured:        false,
      }
      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) {
        console.warn(`  ⚠ Upsert failed "${row.title}" (${ev.ymd}):`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
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
