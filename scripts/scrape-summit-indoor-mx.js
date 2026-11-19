/**
 * scrape-summit-indoor-mx.js — Summit Indoor MX (summitindoormx.com), the
 * indoor motocross series held each winter in Tallmadge.
 *
 * The series is two rounds a year, announced on the home page some weeks
 * ahead and left there until the next year's schedule replaces it. Built
 * while only the finished 2026 schedule was posted, against that page and
 * the archived 2025 page, which have the same shape:
 *
 *   2026 Race Schedule
 *   Friday:     Gate Opens: 2:30pm   Sign up: …   Practice: 6pm   Racing: 8pm
 *   Saturday :  Gate Opens: 1pm      Sign up: …   Practice: 5pm   Racing 7pm
 *   January - Round 1     Jan 8th - Thurs   Jan 9th - Fri   Jan 10th - Sat
 *   February - Round 2    Feb 19th - Thurs  Feb 20th - Fri  Feb 21st - Sat
 *
 * One event per race night (Friday and Saturday), starting at that day's
 * "Racing" time. Thursday is open practice for riders and is not listed.
 *
 * Nothing is assumed:
 *   year     only from the "<year> Race Schedule" heading
 *   time     only from the day's own "Racing" line; a race day with no such
 *            line is skipped and counted
 *   weekday  each date names its weekday ("Jan 9th - Fri"). The date must fall
 *            on that weekday in the heading's year, or it is skipped. This is
 *            what stops last year's dates being read under a new heading.
 *
 * Most of the year the posted schedule is in the past: an empty run is normal.
 *
 * Usage:
 *   node scripts/scrape-summit-indoor-mx.js
 *   node scripts/scrape-summit-indoor-mx.js --dry-run
 */
import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { easternToIso } from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'
import { monthNumber, parseClockTime } from './lib/clock-time.js'
import { htmlLines } from './lib/html-lines.js'

export const SOURCE_KEY = 'summit_indoor_mx'
const ORIGIN = 'https://summitindoormx.com'
export const PAGE_URL = `${ORIGIN}/`
const DAY_MS = 86_400_000
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const RACE_DAYS = new Set([5, 6])

const ORG = {
  name: 'Summit Indoor MX',
  details: { website: ORIGIN, description: 'Indoor motocross racing series held each winter in Tallmadge.' },
}

export const VENUE = {
  name: 'Summit Indoor MX',
  details: { address: '800 North Ave', city: 'Tallmadge', state: 'OH', zip: '44278', website: ORIGIN },
}

const dayIndex = (word = '') => DAYS[String(word).toLowerCase().slice(0, 3)] ?? null
const weekdayOf = (year, month, day) => new Date(Date.UTC(year, month - 1, day)).getUTCDay()

/**
 * Page lines → { year, rules, rounds, dates, gateFee }
 *   rules   { 5: { gate, practice, racing }, 6: {…} }  clock times per weekday
 *   rounds  { 1: 1, 2: 2 }                             month → round number
 *   dates   [{ month, day, weekday }]                  in page order, de-duplicated
 *   gateFee / kidsFree                                 only as the page prints them
 * year is null when the page has no "<year> Race Schedule" heading.
 */
export function parseSchedule(lines = []) {
  const out = { year: null, rules: {}, rounds: {}, dates: [], gateFee: null, kidsFree: false }
  const seen = new Set()
  let current = null
  for (const line of lines) {
    const heading = line.match(/^(20\d{2})\s+Race Schedule$/i)
    if (heading) { out.year = Number(heading[1]); continue }

    const fee = line.match(/GATE FEES?\s*\$(\d+)/i)
    if (fee) out.gateFee = Number(fee[1])
    if (/kids?\s+5\s+and\s+under\s+(?:are\s+)?free/i.test(line)) out.kidsFree = true

    const dayHead = line.match(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s*:$/i)
    if (dayHead) { current = dayIndex(dayHead[1]); out.rules[current] ??= {}; continue }

    const rule = line.match(/^(gates?\s+opens?|practice|racing)\s*:?\s*(\d{1,2}(?::\d{2})?\s*[ap]m)$/i)
    if (rule && current !== null) {
      const key = /^gate/i.test(rule[1]) ? 'gate' : rule[1].toLowerCase()
      const time = parseClockTime(rule[2])
      if (time) out.rules[current][key] = time
      continue
    }

    const round = line.match(/^([A-Za-z]{3,9})\s*-\s*Round\s+(\d+)$/i)
    if (round && monthNumber(round[1])) { out.rounds[monthNumber(round[1])] = Number(round[2]); current = null; continue }

    const date = line.match(/^([A-Za-z]{3,9})\.?\s*(\d{1,2})(?:st|nd|rd|th)?\s*-\s*(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?$/i)
    if (date && monthNumber(date[1])) {
      const entry = { month: monthNumber(date[1]), day: Number(date[2]), weekday: dayIndex(date[3]) }
      const key = `${entry.month}-${entry.day}`
      if (!seen.has(key) && entry.day >= 1 && entry.day <= 31) { seen.add(key); out.dates.push(entry) }
    }
  }
  return out
}

/** One schedule date → { row, venue } or { skip }. */
export function buildRow(date, schedule) {
  if (!schedule?.year) return { skip: 'no_year' }
  if (!RACE_DAYS.has(date.weekday)) return { skip: 'practice_day' }
  if (weekdayOf(schedule.year, date.month, date.day) !== date.weekday) return { skip: 'weekday_mismatch' }
  const rule = schedule.rules[date.weekday]
  if (!rule?.racing) return { skip: 'no_race_time' }
  const dateStr = `${schedule.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
  const startAt = easternToIso(dateStr, rule.racing.time)
  if (!startAt) return { skip: 'undatable' }
  const round = schedule.rounds[date.month]
  const dayName = DAY_NAMES[date.weekday]
  const timeline = [
    rule.gate ? `Gates open at ${rule.gate.time}` : null,
    rule.practice ? `practice at ${rule.practice.time}` : null,
    `racing at ${rule.racing.time}`,
  ].filter(Boolean).join(', ')
  const fee = schedule.gateFee ? ` Gate fee $${schedule.gateFee} per person${schedule.kidsFree ? '; kids 5 and under free' : ''}.` : ''
  return {
    row: {
      title: `Summit Indoor MX${round ? ` Round ${round}` : ''}: ${dayName} Night Racing`,
      description: `Indoor motocross racing in Tallmadge${round ? `, round ${round} of the ${schedule.year} series` : ''}. ${timeline}.${fee}`,
      start_at: startAt,
      end_at: null,
      categories: ['sports'],
      tags: ['motocross', 'racing', 'motorsports', 'tallmadge'],
      price_min: schedule.gateFee,
      price_max: schedule.gateFee,
      age_restriction: 'all_ages',
      image_url: null,
      ticket_url: PAGE_URL,
      source: SOURCE_KEY,
      source_id: `${dateStr}-racing`,
      status: 'published',
      featured: false,
    },
    venue: VENUE,
  }
}

export async function collect({ fetchImpl, now = Date.now } = {}) {
  const res = await fetchWithRetry(PAGE_URL, { headers: { Accept: 'text/html' }, fetchImpl })
  if (!res.ok) throw new Error(`${PAGE_URL} answered HTTP ${res.status}`)
  const schedule = parseSchedule(htmlLines(await res.text()))
  // No heading means the page changed shape; that must not look like an off-season.
  if (!schedule.year) throw new Error(`${PAGE_URL} has no "<year> Race Schedule" heading`)
  const rows = []
  const skipped = {}
  const skip = (reason) => { skipped[reason] = (skipped[reason] ?? 0) + 1 }
  const earliest = now() - DAY_MS
  for (const date of schedule.dates) {
    const built = buildRow(date, schedule)
    if (built.skip) { skip(built.skip); continue }
    if (Date.parse(built.row.start_at) < earliest) { skip('past'); continue }
    rows.push(built)
  }
  return { found: schedule.dates.length, rows, skipped }
}

export function run({ dryRun = false, fetchImpl, now } = {}) {
  return runPlannedScraper({
    source: SOURCE_KEY,
    label: 'Summit Indoor MX',
    emoji: '🏍️',
    org: ORG,
    homeVenue: VENUE,
    collect: () => collect({ fetchImpl, now }),
    dryRun,
    emptyIsError: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
