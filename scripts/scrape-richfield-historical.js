/**
 * scrape-richfield-historical.js — Richfield Historical Society
 * (richfieldohiohistoricalsociety.org).
 *
 * The society posts its year as one hand-typed list on /calendar.html, laid
 * out in columns with runs of no-break spaces instead of a table:
 *
 *   March 21        Cabin Fever Tour                 Various Locations    All Afternoon
 *   April 14        TakeMeBack presentation:
 *                   "The Underground Railroad"       Fellowship Hall      7:00 PM
 *                   Presented by Kathy Dean-Dielman
 *   October 4,11,18,25   Richfield History Walking Tours   Various Locations   1:00 PM
 *
 * The list is replaced once a year (around February) and by autumn it is all
 * in the past. Built in November against the finished 2026 list and the
 * Internet Archive capture of the 2025 list, which are laid out the same way.
 *
 * THE YEAR IS NEVER GUESSED. The list prints month and day only, and a stale
 * list read in January would otherwise turn last March into next March. The
 * year is taken from the page:
 *   • a year the introduction prints ("…the Semi Q 2026 Calendar"), and
 *   • the "Memorial Day" entry the society lists every year: Memorial Day is
 *     the last Monday of May, which falls on a different date each year, so
 *     the entry's date identifies the year (May 25 → 2026, May 26 → 2025).
 * If both are present they must agree. If neither resolves, nothing is
 * published and every entry is counted as year_unknown.
 *
 * Also never guessed: the time. The last column must be a clock time or a
 * range; "All Afternoon" or "Various Locations and Times" means the entry is
 * skipped and counted. The society's own annual meeting is not listed.
 *
 * Usage:
 *   node scripts/scrape-richfield-historical.js
 *   node scripts/scrape-richfield-historical.js --dry-run
 */
import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { decodeEntities, easternToIso, easternTodayIso } from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'
import { MONTH_RE, monthNumber } from './lib/clock-time.js'
import { proseTime } from './lib/prose-time.js'

export const SOURCE_KEY = 'richfield_historical'
const ORIGIN = 'http://www.richfieldohiohistoricalsociety.org'
export const PAGE_URL = `${ORIGIN}/calendar.html`
const DAY_MS = 86_400_000
const GAP = '\u0001'

const ORG = {
  name: 'Richfield Historical Society',
  details: { website: ORIGIN, description: 'Volunteer historical society that runs the Historical Museum of Richfield and hosts history talks and tours.' },
}

export const MUSEUM = {
  name: 'Historical Museum of Richfield',
  details: { address: '3907 Broadview Road', city: 'Richfield', state: 'OH', zip: '44286', website: ORIGIN },
}

const TIME_COL_RE = /^\d{1,2}(?::\d{2})?\s*[AP]\.?M\.?(?:\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*[AP]\.?M\.?)?$/i
const TIME_TAIL = '\\d{1,2}(?::\\d{2})?\\s*[AP]\\.?M\\.?(?:\\s*[-–—]\\s*\\d{1,2}(?::\\d{2})?\\s*[AP]\\.?M\\.?)?'
const tidy = (s = '') => String(s).replace(/\s+/g, ' ').trim()
const unquote = (s = '') => tidy(String(s).replace(/["“”„‟]/g, '')).replace(/\.$/, '')

/**
 * The list as rows of columns: [{ cols: string[], indented: boolean }].
 * A column break is a run of two or more no-break spaces. `intro` is the
 * text between the heading and the first dated row.
 */
export function listRows(html = '') {
  const page = String(html)
  const start = page.search(/Calendar of Events/i)
  if (start < 0) return null
  const endAt = page.slice(start).search(/Please(?:\s|&nbsp;|<[^>]*>)+call\b/i)
  const segment = page.slice(start, endAt > 0 ? start + endAt : undefined)
  // Mark no-break spaces BEFORE decoding: they are the column separators, and
  // an entity decoder is free to turn them into ordinary spaces.
  const text = decodeEntities(segment
    .replace(/&nbsp;|&#160;|\u00a0/gi, GAP)
    .replace(/<br\b[^>]*>|<\/(?:div|p|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/\u200b/g, '')
    .replace(/\u00a0/g, GAP)
  return text.split('\n').map((line) => {
    const marked = line.replace(new RegExp(`(?:[ \\t]*${GAP}[ \\t]*){2,}`, 'g'), '\t').replace(new RegExp(GAP, 'g'), ' ')
    const cols = marked.split('\t').map(tidy)
    return { cols: cols.filter(Boolean), indented: cols[0] === '' }
  }).filter((row) => row.cols.length)
}

/**
 * Rows → entries: [{ month, days, title, location, timeText, presenter }].
 * `unparsed` counts dated rows with no title.
 */
export function parseEntries(rows = []) {
  const dateRe = new RegExp(`^(${MONTH_RE})\\s+(\\d{1,2}(?:\\s*,\\s*\\d{1,2})*),?(?:\\s+(.*))?$`, 'i')
  const groups = []
  const intro = []
  for (const row of rows) {
    const m = !row.indented && row.cols[0].match(dateRe)
    if (m) {
      const first = [...(m[3] ? [m[3]] : []), ...row.cols.slice(1)]
      groups.push({ month: monthNumber(m[1]), days: m[2].split(',').map((d) => Number(d.trim())), lines: [first] })
    } else if (groups.length) {
      groups[groups.length - 1].lines.push(row.cols)
    } else {
      intro.push(row.cols.join(' '))
    }
  }
  const entries = []
  let unparsed = 0
  for (const g of groups) {
    const presenterAt = g.lines.findIndex((cols) => /^presented by\b/i.test(cols[0] ?? ''))
    const body = presenterAt >= 0 ? g.lines.slice(0, presenterAt) : g.lines
    const presenter = presenterAt >= 0 ? tidy(g.lines.slice(presenterAt).flat().join(' ')).replace(/^presented by\s*/i, '') : null
    let timeText = null
    let location = null
    const titleParts = []
    for (const cols of body) {
      const t = cols.findIndex((c) => TIME_COL_RE.test(c))
      if (t >= 0 && timeText === null) {
        timeText = cols[t]
        location = t >= 1 ? cols[t - 1] : null
        titleParts.push(...cols.slice(0, Math.max(0, t - 1)))
      } else {
        titleParts.push(...cols)
      }
    }
    if (timeText === null && titleParts.length > 1) {
      // No time column of its own. The typist sometimes leaves a single space
      // between place and time ("Museum and Various Locations 11 AM - 4 PM").
      const last = titleParts.pop()
      const tail = last.match(new RegExp(`^(.*?)\\s+(${TIME_TAIL})$`, 'i'))
      if (tail && tidy(tail[1])) { location = tidy(tail[1]); timeText = tail[2] } else location = last
    }
    let title = tidy(titleParts.join(' '))
    const series = title.match(/^TakeMeBack\s+presentation\s*:?\s*(.*)$/i)
    if (series) title = unquote(series[1]) ? `TakeMeBack: ${unquote(series[1])}` : 'TakeMeBack presentation'
    else title = unquote(title)
    if (!title || g.days.some((d) => !(d >= 1 && d <= 31))) { unparsed++; continue }
    entries.push({ month: g.month, days: g.days, title, location, timeText, presenter: presenter || null })
  }
  return { entries, intro: intro.join(' '), unparsed }
}

const lastMondayOfMay = (year) => {
  const d = new Date(Date.UTC(year, 4, 31))
  return 31 - ((d.getUTCDay() + 6) % 7)
}

/**
 * The year the list is for, from the page alone (see the header). null when
 * it cannot be established or the two signals disagree.
 */
export function resolveYear({ entries = [], intro = '' } = {}, now = new Date()) {
  const thisYear = Number(easternTodayIso(now).slice(0, 4))
  const printed = intro.match(/\b(20\d{2})\s+Calendar\b/i)?.[1]
  const memorial = entries.find((e) => e.month === 5 && /memorial day/i.test(e.title) && e.days.length === 1)
  const fromMemorial = memorial
    ? [thisYear - 1, thisYear, thisYear + 1].filter((y) => lastMondayOfMay(y) === memorial.days[0])
    : []
  if (printed && fromMemorial.length) return fromMemorial.includes(Number(printed)) ? Number(printed) : null
  if (printed) return Number(printed)
  return fromMemorial.length === 1 ? fromMemorial[0] : null
}

export function categoriesFor(title = '') {
  if (/\bconcert\b/i.test(title)) return ['music']
  if (/\bart show\b/i.test(title)) return ['visual-art']
  if (/\b(parade|community day|festival)\b/i.test(title)) return ['festival']
  if (/\b(garden tour|plant sale)\b/i.test(title)) return ['outdoors']
  return ['learning']
}

const slug = (s = '') => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 5).join('-')

/** One entry on one of its days → { row, venue } or { skip }. */
export function buildRow(entry, day, year) {
  if (!year) return { skip: 'year_unknown' }
  if (/annual meeting/i.test(entry.title)) return { skip: 'members_meeting' }
  const time = entry.timeText ? proseTime(entry.timeText) : null
  if (!time) return { skip: 'no_time' }
  const dateStr = `${year}-${String(entry.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const startAt = easternToIso(dateStr, time.startTime)
  if (!startAt) return { skip: 'undatable' }
  const endAt = time.endTime ? easternToIso(dateStr, time.endTime) : null
  const atMuseum = /^museum$/i.test(entry.location ?? '')
  const parts = [
    'Listed on the Richfield Historical Society calendar.',
    entry.presenter ? `Presented by ${entry.presenter}.` : null,
    entry.location && !atMuseum ? `Location: ${entry.location}.` : null,
  ].filter(Boolean)
  return {
    row: {
      title: entry.title,
      description: parts.join(' '),
      start_at: startAt,
      end_at: endAt && endAt > startAt ? endAt : null,
      categories: categoriesFor(entry.title),
      tags: ['history', 'richfield'],
      price_min: null,
      price_max: null,
      age_restriction: 'all_ages',
      image_url: null,
      ticket_url: PAGE_URL,
      source: SOURCE_KEY,
      source_id: `${dateStr}-${slug(entry.title)}`,
      status: 'published',
      featured: false,
    },
    // Only the museum has an address on the page; other places stay in the text.
    venue: atMuseum ? MUSEUM : null,
  }
}

export async function collect({ fetchImpl, now = Date.now } = {}) {
  const res = await fetchWithRetry(PAGE_URL, { headers: { Accept: 'text/html' }, fetchImpl })
  if (!res.ok) throw new Error(`${PAGE_URL} answered HTTP ${res.status}`)
  const rows = listRows(await res.text())
  if (!rows) throw new Error(`${PAGE_URL} has no "Calendar of Events" list`)
  const parsed = parseEntries(rows)
  const year = resolveYear(parsed, new Date(now()))
  const out = []
  const skipped = {}
  const skip = (reason, n = 1) => { if (n > 0) skipped[reason] = (skipped[reason] ?? 0) + n }
  const earliest = now() - DAY_MS
  let found = parsed.unparsed
  skip('unparsed_row', parsed.unparsed)
  for (const entry of parsed.entries) {
    for (const day of entry.days) {
      found++
      const built = buildRow(entry, day, year)
      if (built.skip) { skip(built.skip); continue }
      if (Date.parse(built.row.start_at) < earliest) { skip('past'); continue }
      out.push(built)
    }
  }
  return { found, rows: out, skipped }
}

export function run({ dryRun = false, fetchImpl, now } = {}) {
  return runPlannedScraper({
    source: SOURCE_KEY,
    label: 'Richfield Historical Society',
    emoji: '🏛️',
    org: ORG,
    homeVenue: MUSEUM,
    collect: () => collect({ fetchImpl, now }),
    dryRun,
    emptyIsError: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
