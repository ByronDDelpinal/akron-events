/**
 * scrape-boston-township.js — Boston Township (bostontownship.org), the
 * township around Peninsula in the Cuyahoga Valley.
 *
 * The township keeps a hand-built PHP month grid at /calendar.php. Each entry
 * is a link to calnote.php?note=<id> holding a time, a title and a place:
 *
 *   10   6:30 pm  Zoning Commission
 *                 at Township Offices, 1775 Main Street.
 *
 * This month and the next two are read (calendar.php?month=M&year=Y). The
 * month and year come from the grid's own heading and must match the month
 * that was asked for, so a redesign or a redirect is an error, not a quiet
 * empty run. The note id is the event id: it survives a retitle or a move to
 * another day.
 *
 * An entry with no clock time is skipped and counted. "Trustees Meeting"
 * means nothing in a county-wide feed, so titles are prefixed with the
 * township's name. A month with no entries is normal (the grid is filled in
 * a month or two ahead).
 *
 * Usage:
 *   node scripts/scrape-boston-township.js
 *   node scripts/scrape-boston-township.js --dry-run
 */
import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { htmlToText, easternToIso, easternTodayIso } from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'
import { MONTH_RE, monthNumber, parseClockTime } from './lib/clock-time.js'

export const SOURCE_KEY = 'boston_township'
const ORIGIN = 'https://www.bostontownship.org'
const MONTHS_AHEAD = 2
const PAGE_DELAY_MS = 250
const DAY_MS = 86_400_000

const ORG = {
  name: 'Boston Township',
  details: { website: ORIGIN, description: 'Township government for Boston Township, around Peninsula in the Cuyahoga Valley.' },
}

export const TOWNSHIP_HALL = {
  name: 'Boston Township Hall',
  details: { address: '1775 Main St', city: 'Peninsula', state: 'OH', zip: '44264', website: ORIGIN },
}

// The grid writes "&nbsp" without its semicolon, which no entity decoder accepts.
const clean = (s = '') => htmlToText(String(s).replace(/&nbsp;?/gi, ' ')).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()

export const monthUrl = (year, month) => `${ORIGIN}/calendar.php?month=${month}&year=${year}`

/** The months to read: the one containing `now` (Eastern) and the next MONTHS_AHEAD. */
export function monthsToRead(now = new Date(), ahead = MONTHS_AHEAD) {
  const [y, m] = easternTodayIso(now).split('-').map(Number)
  return Array.from({ length: ahead + 1 }, (_, i) => {
    const index = (m - 1) + i
    return { year: y + Math.floor(index / 12), month: (index % 12) + 1 }
  })
}

/**
 * One month page → { year, month, entries: [{ noteId, day, timeText, title, place }] }.
 * null when the page has no "<Month> <Year>" grid heading.
 */
export function parseMonth(html = '') {
  const page = String(html)
  const heading = page.match(new RegExp(`<span\\b[^>]*>\\s*(${MONTH_RE})\\s+(20\\d{2})\\s*<\\/span>`, 'i'))
  if (!heading) return null
  const entries = []
  for (const cell of page.split(/<td\b/i).slice(1)) {
    const day = Number(cell.match(/^[^>]*>\s*<b>\s*(\d{1,2})(?:&nbsp|\s|<)/i)?.[1])
    if (!day) continue
    for (const a of cell.matchAll(/<a\b[^>]*calnote\.php\?note=(\d+)[^>]*>([\s\S]*?)<\/a>/gi)) {
      const inner = a[2]
      entries.push({
        noteId: a[1],
        day,
        timeText: clean(inner.match(/<b>([\s\S]*?)<\/b>/i)?.[1] ?? ''),
        title: clean(inner.match(/<span\b[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? ''),
        place: clean(inner.match(/<small>([\s\S]*?)<\/small>/i)?.[1] ?? '').replace(/^at\s+/i, '').replace(/\.$/, ''),
      })
    }
  }
  return { year: Number(heading[2]), month: monthNumber(heading[1]), entries }
}

/** "Trustees Meeting" → "Boston Township Trustees Meeting"; a title naming the township is left alone. */
export const fullTitle = (title = '') => (/boston/i.test(title) ? title : `Boston Township ${title}`)

/** One grid entry → { row, venue } or { skip }. */
export function buildRow(entry, { year, month }) {
  if (!entry?.noteId || !entry?.title) return { skip: 'invalid' }
  const time = parseClockTime(entry.timeText)
  if (!time) return { skip: 'no_time' }
  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(entry.day).padStart(2, '0')}`
  const startAt = easternToIso(dateStr, time.time)
  if (!startAt) return { skip: 'undatable' }
  const atHall = /township (?:offices?|hall)|1775 main/i.test(entry.place)
  const where = entry.place ? ` Held at ${entry.place}.` : ''
  return {
    row: {
      title: fullTitle(entry.title),
      description: `Listed on the Boston Township calendar.${where}`,
      start_at: startAt,
      end_at: null,
      categories: ['civic'],
      tags: ['boston-township', 'township', 'peninsula'],
      price_min: null,
      price_max: null,
      age_restriction: 'all_ages',
      image_url: null,
      ticket_url: `${ORIGIN}/calendar.php?month=${month}&year=${year}`,
      source: SOURCE_KEY,
      source_id: `note-${entry.noteId}`,
      status: 'published',
      featured: false,
    },
    // A place other than the hall stays in the description; it is not minted as a venue.
    venue: atHall ? TOWNSHIP_HALL : null,
  }
}

const pause = (ms) => (ms ? new Promise((r) => setTimeout(r, ms)) : null)

export async function collect({ fetchImpl, now = Date.now, delayMs = PAGE_DELAY_MS } = {}) {
  const rows = []
  const seen = new Set()
  const skipped = {}
  const skip = (reason, n = 1) => { if (n > 0) skipped[reason] = (skipped[reason] ?? 0) + n }
  const earliest = now() - DAY_MS
  let found = 0
  let first = true
  for (const want of monthsToRead(new Date(now()))) {
    if (!first) await pause(delayMs)
    first = false
    const url = monthUrl(want.year, want.month)
    const res = await fetchWithRetry(url, { headers: { Accept: 'text/html' }, fetchImpl })
    if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`)
    const parsed = parseMonth(await res.text())
    if (!parsed) throw new Error(`${url} has no month grid`)
    if (parsed.year !== want.year || parsed.month !== want.month) {
      throw new Error(`${url} returned ${parsed.month}/${parsed.year}, not the month asked for`)
    }
    for (const entry of parsed.entries) {
      if (seen.has(entry.noteId)) continue
      seen.add(entry.noteId)
      found++
      const built = buildRow(entry, parsed)
      if (built.skip) { skip(built.skip); continue }
      if (Date.parse(built.row.start_at) < earliest) { skip('past'); continue }
      rows.push(built)
    }
  }
  return { found, rows, skipped }
}

export function run({ dryRun = false, fetchImpl, now, delayMs } = {}) {
  return runPlannedScraper({
    source: SOURCE_KEY,
    label: 'Boston Township',
    emoji: '🏛️',
    org: ORG,
    homeVenue: TOWNSHIP_HALL,
    collect: () => collect({ fetchImpl, now, delayMs }),
    dryRun,
    emptyIsError: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
