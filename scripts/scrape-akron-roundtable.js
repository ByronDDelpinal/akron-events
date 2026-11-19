/**
 * scrape-akron-roundtable.js — Akron Roundtable (akronroundtable.org), the
 * monthly speaker luncheon.
 *
 * The home page lists the season, one linked block per speaker:
 *
 *   Dr. Rhea Boyd
 *   Pediatrician, public health advocate, and scholar
 *   noon • Thursday • December 10, 2026 Doubletree by Hilton Akron/Fairlawn
 *   Presentation Title: The Politics, Policing, and Possibilities of Black Motherhood
 *
 * Each block links to /speakers/<slug>/<id>/; the id is the event id, so a
 * speaker or venue change updates the listing instead of duplicating it.
 *
 *   date   printed in full, and checked against the weekday printed with it
 *   time   "noon" or a clock time on the same line; anything else is skipped
 *   place  the text after the date. "Event Location TBD" means no venue yet:
 *          the luncheon is listed without one and picks it up when announced
 *   skip   "Speaker TBA" months, until a speaker is named
 *
 * Titles follow the form already used for luncheons submitted by email
 * ("Akron Roundtable: <speaker>") so cross-source dedupe can pair them.
 *
 * Usage:
 *   node scripts/scrape-akron-roundtable.js
 *   node scripts/scrape-akron-roundtable.js --dry-run
 */
import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { easternToIso } from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'
import { MONTH_RE, monthNumber, parseClockTime } from './lib/clock-time.js'
import { htmlLines } from './lib/html-lines.js'

export const SOURCE_KEY = 'akron_roundtable'
const ORIGIN = 'https://www.akronroundtable.org'
export const PAGE_URL = `${ORIGIN}/`
const DAY_MS = 86_400_000
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

const ORG = {
  name: 'Akron Roundtable',
  details: { website: ORIGIN, description: 'Monthly luncheon series bringing national and regional speakers to Akron since 1976.' },
}

/** Places the Roundtable names, with the address the listing needs. */
const KNOWN_VENUES = [
  { match: /doubletree/i, name: 'DoubleTree by Hilton Akron-Fairlawn', details: { address: '3150 W Market St', city: 'Akron', state: 'OH', zip: '44333' } },
  { match: /quaker station/i, name: 'Quaker Station', details: { address: '135 S Broadway St', city: 'Akron', state: 'OH', zip: '44308' } },
]

const DATE_LINE_RE = new RegExp(`^(.+?)\\s*[•·|]\\s*(${WEEKDAYS.join('|')})\\s*[•·|]\\s*(${MONTH_RE})\\s+(\\d{1,2}),\\s*(20\\d{2})\\s*(.*)$`, 'i')

/** "noon • Thursday • December 10, 2026 Doubletree…" → parts, or null. */
export function parseDateLine(line = '') {
  const m = String(line).trim().match(DATE_LINE_RE)
  if (!m) return null
  const time = /^noon$/i.test(m[1].trim()) ? parseClockTime('12:00 pm') : parseClockTime(m[1].trim())
  return { time, weekday: WEEKDAYS.indexOf(m[2].toLowerCase()), month: monthNumber(m[3]), day: Number(m[4]), year: Number(m[5]), place: m[6].trim() }
}

/** Home page → [{ id, url, speaker, about, date, talk, sponsor }], in page order. */
export function parseSpeakers(html = '') {
  const out = []
  const seen = new Set()
  const inner = (block, cls) => block.match(new RegExp(`<(div|h2)\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>`, 'i'))?.[2] ?? ''
  // One block per speaker: heading, subtitle, date and place, description, then the link.
  for (const block of String(html).split(/<div class="lrmColumn lrmNonMediaColumn">/i).slice(1)) {
    const link = block.match(/<a\b[^>]*href="(\/speakers\/[^"/]+\/(\d+)\/)"/i)
    if (!link || seen.has(link[2])) continue
    const upTo = block.slice(0, block.indexOf(link[0]))
    const heading = inner(upTo, 'barTitle').replace(/<div\b[^>]*barTitleDate[^>]*>[\s\S]*?<\/div>/i, '')
    const speaker = htmlLines(heading).join(' ')
    const dateBlock = upTo.match(/<div class="barFormattedDate">([\s\S]*?)<\/div>\s*<\/div>/i)?.[1] ?? ''
    const dateLines = htmlLines(dateBlock)
    const date = parseDateLine(dateLines[0] ?? '')
    if (!speaker || !date) continue
    if (!date.place && dateLines[1]) date.place = dateLines[1]
    seen.add(link[2])
    const body = htmlLines(upTo.slice(upTo.search(/barDescriptionContent/i)))
    out.push({
      id: link[2],
      url: `${ORIGIN}${link[1]}`,
      speaker,
      about: htmlLines(inner(upTo, 'barSubtitle')).join(' ') || null,
      date,
      talk: body.map((l) => l.match(/presentation title\s*:\s*(.+)$/i)?.[1]).find(Boolean) ?? null,
      sponsor: body.find((l) => /sponsored by|made possible by/i.test(l)) ?? null,
    })
  }
  return out
}

/** "Doubletree by Hilton Akron/Fairlawn" → { name, details }; null while TBD. */
export function resolvePlace(place = '') {
  const p = String(place).trim()
  if (!p || /\btb[da]\b|to be (?:determined|announced)/i.test(p)) return null
  const known = KNOWN_VENUES.find((v) => v.match.test(p))
  return known ? { name: known.name, details: known.details } : { name: p, details: { city: 'Akron', state: 'OH' } }
}

/** One speaker block → { row, venue } or { skip }. */
export function buildRow(s) {
  if (!s?.id || !s.speaker || !s.date) return { skip: 'invalid' }
  if (/^speaker tb[ad]$/i.test(s.speaker)) return { skip: 'speaker_unannounced' }
  const { date } = s
  if (!date.time) return { skip: 'no_time' }
  if (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() !== date.weekday) return { skip: 'weekday_mismatch' }
  const dateStr = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
  const startAt = easternToIso(dateStr, date.time.time)
  if (!startAt) return { skip: 'undatable' }
  const parts = [
    `Akron Roundtable luncheon with ${s.speaker}${s.about ? `, ${s.about.replace(/\.$/, '')}` : ''}.`,
    s.talk ? `Presentation: ${s.talk}.` : null,
    s.sponsor ? `${s.sponsor.replace(/\.$/, '')}.` : null,
  ].filter(Boolean)
  return {
    row: {
      title: `Akron Roundtable: ${s.speaker}`,
      description: parts.join(' '),
      start_at: startAt,
      end_at: null,
      categories: ['learning'],
      tags: ['speaker-series', 'luncheon', 'civic', 'akron'],
      price_min: null,
      price_max: null,
      age_restriction: 'not_specified',
      image_url: null,
      ticket_url: s.url,
      source: SOURCE_KEY,
      source_id: s.id,
      status: 'published',
      featured: false,
    },
    venue: resolvePlace(date.place),
  }
}

export async function collect({ fetchImpl, now = Date.now } = {}) {
  const res = await fetchWithRetry(PAGE_URL, { headers: { Accept: 'text/html' }, fetchImpl })
  if (!res.ok) throw new Error(`${PAGE_URL} answered HTTP ${res.status}`)
  const html = await res.text()
  // No speaker links at all means the page changed, not that the season ended.
  if (!/href="\/speakers\//i.test(html)) throw new Error(`${PAGE_URL} has no speaker listings`)
  const speakers = parseSpeakers(html)
  const rows = []
  const skipped = {}
  const earliest = now() - DAY_MS
  for (const s of speakers) {
    const built = buildRow(s)
    if (built.skip) { skipped[built.skip] = (skipped[built.skip] ?? 0) + 1; continue }
    if (Date.parse(built.row.start_at) < earliest) { skipped.past = (skipped.past ?? 0) + 1; continue }
    rows.push(built)
  }
  return { found: speakers.length, rows, skipped }
}

export function run({ dryRun = false, fetchImpl, now } = {}) {
  return runPlannedScraper({
    source: SOURCE_KEY, label: 'Akron Roundtable', emoji: '🎤', org: ORG, homeVenue: null,
    collect: () => collect({ fetchImpl, now }), dryRun, emptyIsError: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
