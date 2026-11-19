/**
 * scrape-astronomy-club-akron.js — Astronomy Club of Akron (acaoh.org).
 *
 * The club's home page has a hand-edited "Upcoming Events" block listing its
 * next public meetings, each as a few lines:
 *
 *   November 15, 2026 - 2PM
 *   ACA Public Lecture Meeting
 *   Stacy McGaugh, Case Western Reserve University
 *   Missing Mass Problem – Dark Matter & Our Understanding of Gravity
 *   <a paragraph about the talk>
 *
 * The block usually holds one or two meetings and is often left showing the
 * last one until the next is announced, so most runs find nothing new. Built
 * against the live page and the Internet Archive capture of March 2025, which
 * use the same layout (the 2025 entries have no time on the date line).
 *
 *   date   the full date printed on the entry, year included
 *   time   the time on the date line when there is one. Otherwise the
 *          standing time the page gives for meetings ("…at 2:00 PM at the
 *          Portage Lakes Kiwanis Civic Center"), marked time_inferred so the
 *          listing says the time is a placeholder. With neither, skipped.
 *   place  the page's own sentence: "All meetings are held at the Portage
 *          Lakes Kiwanis Civic Center, 725 Portage Lakes Drive, Akron."
 *
 * Star parties are not read: they are announced a day ahead as free text in a
 * bulletin, depend on the weather, and the seasonal schedule is a PDF.
 *
 * Usage:
 *   node scripts/scrape-astronomy-club-akron.js
 *   node scripts/scrape-astronomy-club-akron.js --dry-run
 */
import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { clampChars, easternToIso } from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'
import { MONTH_RE, monthNumber, parseClockTime } from './lib/clock-time.js'
import { htmlLines } from './lib/html-lines.js'

export const SOURCE_KEY = 'astronomy_club_akron'
const ORIGIN = 'https://www.acaoh.org'
export const PAGE_URL = `${ORIGIN}/`
const MAX_DESCRIPTION = 2000
const DAY_MS = 86_400_000

const ORG = {
  name: 'Astronomy Club of Akron',
  details: { website: ORIGIN, description: 'Amateur astronomy club serving the Akron area since 1949, with free public lecture meetings and star parties.' },
}

const DATE_RE = new RegExp(`^(${MONTH_RE})\\s+(\\d{1,2}),?\\s+(20\\d{2})(?:\\s*[-–—@,]\\s*(.+))?$`, 'i')

/** "November 15, 2026 - 2PM" → { year, month, day, time|null }; null for any other line. */
export function parseDateLine(line = '') {
  const m = String(line).trim().match(DATE_RE)
  if (!m) return null
  const day = Number(m[2])
  if (day < 1 || day > 31) return null
  return { year: Number(m[3]), month: monthNumber(m[1]), day, time: m[4] ? parseClockTime(m[4]) : null }
}

/**
 * Page lines → { entries, meetingTime, meetingVenue, free }
 *   entries       [{ date, kind, speaker, talk, blurb }] from the Upcoming Events block
 *   meetingTime   the standing meeting time the page states, or null
 *   meetingVenue  { name, details } from "All meetings are held at …", or null
 *   found         false when the page has no "Upcoming Events" block at all
 */
export function parsePage(lines = []) {
  const start = lines.findIndex((l) => /upcoming events/i.test(l) && /-\s*-/.test(l))
  const out = { found: start >= 0, entries: [], meetingTime: null, meetingVenue: null, free: false }
  const all = lines.join('\n')
  out.free = /open to the public and free of charge/i.test(all)
  const standing = all.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*[AP]\.?M\.?)\s+at\s+the\s+Portage Lakes Kiwanis/i)
  if (standing) out.meetingTime = parseClockTime(standing[1])
  const held = all.match(/All meetings are held at (?:the )?([^,\n]+),\s*(\d+[^,\n]+),\s*([A-Za-z .]+?)\.?(?:\n|$)/i)
  if (held) out.meetingVenue = { name: held[1].trim(), details: { address: held[2].trim(), city: held[3].trim(), state: 'OH' } }
  if (start < 0) return out

  const endAt = lines.findIndex((l, i) => i > start && /^about the club$/i.test(l))
  const block = lines.slice(start + 1, endAt > start ? endAt : undefined)
  const isBoilerplate = (l) => /^all (?:meetings|star parties)\b/i.test(l) || /activity schedule$/i.test(l) || /^\d+ [A-Za-z ]+ Rd\b/i.test(l) || /^Akron, OH$/i.test(l) || /^ACA Observatory$/i.test(l)
  let current = null
  for (const line of block) {
    const date = parseDateLine(line)
    if (date) { current = { date, rest: [] }; out.entries.push(current); continue }
    if (!current) continue
    if (isBoilerplate(line)) { current = null; continue }
    current.rest.push(line)
  }
  out.entries = out.entries.map(({ date, rest }) => ({
    date,
    kind: rest[0] ?? null,
    speaker: rest.length >= 3 ? rest[1] : null,
    talk: rest.length >= 3 ? rest[2] : (rest[1] ?? null),
    blurb: rest.slice(3).join(' ').replace(/\s+/g, ' ').trim() || null,
  }))
  return out
}

/** One entry → { row, venue } or { skip }. */
export function buildRow(entry, page) {
  if (!entry?.date || !entry.kind) return { skip: 'invalid' }
  if (!/meeting|lecture/i.test(entry.kind)) return { skip: 'not_a_meeting' }
  const time = entry.date.time ?? page.meetingTime
  if (!time) return { skip: 'no_time' }
  const { year, month, day } = entry.date
  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const startAt = easternToIso(dateStr, time.time)
  if (!startAt) return { skip: 'undatable' }
  const intro = `Astronomy Club of Akron ${/public/i.test(entry.kind) ? 'public lecture meeting' : 'meeting'}${page.free ? ', open to the public and free of charge' : ''}.`
  const speaker = entry.speaker ? ` Speaker: ${entry.speaker}.` : ''
  const row = {
    title: entry.talk ? `${entry.talk} (Astronomy Club of Akron)` : `Astronomy Club of Akron: ${entry.kind.replace(/^ACA\s+/i, '')}`,
    description: clampChars(`${intro}${speaker}${entry.blurb ? `\n\n${entry.blurb}` : ''}`, MAX_DESCRIPTION),
    start_at: startAt,
    end_at: null,
    categories: ['learning'],
    tags: ['astronomy', 'science', 'lecture', 'portage-lakes'],
    price_min: page.free ? 0 : null,
    price_max: page.free ? 0 : null,
    age_restriction: 'all_ages',
    image_url: null,
    ticket_url: PAGE_URL,
    source: SOURCE_KEY,
    // The date, not the talk: a meeting whose speaker is announced later keeps its id.
    source_id: `${dateStr}-meeting`,
    status: 'published',
    featured: false,
  }
  // SANCTIONED-DEFAULT-TIME: no time on the entry, so the page's standing
  // meeting time is used and disclosed as a placeholder.
  if (!entry.date.time) row.time_inferred = true
  return { row, venue: page.meetingVenue }
}

export async function collect({ fetchImpl, now = Date.now } = {}) {
  const res = await fetchWithRetry(PAGE_URL, { headers: { Accept: 'text/html' }, fetchImpl })
  if (!res.ok) throw new Error(`${PAGE_URL} answered HTTP ${res.status}`)
  const page = parsePage(htmlLines(await res.text()))
  if (!page.found) throw new Error(`${PAGE_URL} has no "Upcoming Events" block`)
  const rows = []
  const skipped = {}
  const skip = (reason) => { skipped[reason] = (skipped[reason] ?? 0) + 1 }
  const earliest = now() - DAY_MS
  for (const entry of page.entries) {
    const built = buildRow(entry, page)
    if (built.skip) { skip(built.skip); continue }
    if (Date.parse(built.row.start_at) < earliest) { skip('past'); continue }
    rows.push(built)
  }
  return { found: page.entries.length, rows, skipped }
}

export function run({ dryRun = false, fetchImpl, now } = {}) {
  return runPlannedScraper({
    source: SOURCE_KEY,
    label: 'Astronomy Club of Akron',
    emoji: '🔭',
    org: ORG,
    homeVenue: null,
    collect: () => collect({ fetchImpl, now }),
    dryRun,
    emptyIsError: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
