/**
 * scrape-hudson-players.js — Hudson Players (hudsonplayers.com), the community
 * theatre at the Barlow Community Center in Hudson.
 *
 * The /now-playing page (Strikingly, server-rendered) carries the current
 * production as prose:
 *
 *   <h2>Come From Away</h2>
 *   October 30,31 November 6,7,8*,13,14,15*,20,21, 2026
 *   Friday and Saturday performances @ 7:30pm
 *   *Sunday matinees @ 2pm
 *
 * Each date becomes its own event. The time is never assumed: it comes from
 * the page's own weekday rules ("Friday and Saturday … @ 7:30pm"), matched to
 * the weekday each date falls on. A date whose weekday has no rule is skipped
 * and counted. That also catches a misread year, because the dates then land
 * on weekdays the page has no rule for.
 *
 * The site's /calendar-of-events page is not used: it lists the same run as
 * loose day ranges and has disagreed with this page (it showed "21-22" for a
 * run that ends Friday the 20th and Saturday the 21st).
 *
 * Tickets are sold on Ludus, which refuses automated requests, so no price is
 * read. Between productions the page has no dated run: an empty run is normal.
 *
 * Usage:
 *   node scripts/scrape-hudson-players.js
 *   node scripts/scrape-hudson-players.js --dry-run
 */
import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { htmlToText, clampChars, easternToIso } from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'
import { MONTH_RE, monthNumber, parseClockTime } from './lib/clock-time.js'

export const SOURCE_KEY = 'hudson_players'
const ORIGIN = 'https://www.hudsonplayers.com'
export const PAGE_URL = `${ORIGIN}/now-playing`
const MAX_DESCRIPTION = 4000
const DAY_MS = 86_400_000

const ORG = {
  name: 'Hudson Players',
  details: {
    website: ORIGIN,
    description: 'Volunteer community theatre in Hudson, performing at the Barlow Community Center.',
  },
}

export const MAIN_VENUE = {
  name: 'Barlow Community Center',
  details: {
    address: '41 S Oviatt St',
    city: 'Hudson', state: 'OH', zip: '44236',
    website: `${ORIGIN}/directions`,
  },
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const CREDIT_RE = /^(?:directed|music directed|musical direction|music\b|lyrics|book|choreograph|produced|presented|written|adapted|by\b)[^:]{0,60}:/i

const clean = (s = '') => String(s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * "October 30,31 November 6,7,8*,13,14,15*,20,21, 2026" →
 *   { year: 2026, dates: [{ month: 10, day: 30, starred: false }, …] }
 * The printed year belongs to the LAST month; an earlier month with a higher
 * number is the year before ("December 11,12 January 8,9, 2027"). Returns null
 * when the line is not a run of month + day lists ending in a year.
 */
export function parseRunLine(line = '') {
  const text = clean(line)
  const tail = text.match(/,?\s*(20\d{2})$/)
  if (!tail) return null
  const body = text.slice(0, tail.index)
  const groupRe = new RegExp(`(${MONTH_RE})\\s+([\\d,*\\s&-]+)`, 'gi')
  const groups = [...body.matchAll(groupRe)]
  if (!groups.length) return null
  // Nothing but month groups may be on the line.
  if (clean(body.replace(groupRe, '')).replace(/[,;]/g, '') !== '') return null
  const dates = []
  for (const g of groups) {
    const month = monthNumber(g[1])
    for (const token of g[2].split(/[,&]/).map((t) => t.trim()).filter(Boolean)) {
      const m = token.match(/^(\d{1,2})(\*)?$/)
      if (!m || Number(m[1]) < 1 || Number(m[1]) > 31) return null
      dates.push({ month, day: Number(m[1]), starred: Boolean(m[2]) })
    }
  }
  if (!dates.length) return null
  const lastYear = Number(tail[1])
  const lastMonth = dates[dates.length - 1].month
  return { year: lastYear, dates: dates.map((d) => ({ ...d, year: d.month > lastMonth ? lastYear - 1 : lastYear })) }
}

/**
 * "Friday and Saturday performances @ 7:30pm" → { 5: {…7:30 pm}, 6: {…7:30 pm} }
 * Returns {} for a line that names no weekday or no readable time.
 */
export function parseTimeRule(line = '') {
  const text = clean(line)
  const m = text.match(/^(.*?)\s*(?:@|\bat\b)\s*(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)\s*\.?$/i)
  if (!m) return {}
  const time = parseClockTime(m[2])
  if (!time) return {}
  const rule = {}
  WEEKDAYS.forEach((name, index) => {
    if (new RegExp(`\\b${name}s?\\b`, 'i').test(m[1])) rule[index] = time
  })
  return rule
}

/** Weekday (0 = Sunday) of a calendar date. */
export const weekdayOf = (year, month, day) => new Date(Date.UTC(year, month - 1, day)).getUTCDay()

/**
 * Productions on the page: [{ title, slug, description, imageUrl, ticketUrl,
 * run, rules }]. `run` is null when the block has no readable date line.
 */
export function parseNowPlaying(html = '') {
  const body = String(html).replace(/<(script|style|svg|noscript)\b[\s\S]*?<\/\1>/gi, '')
  const start = body.search(/<h1[^>]*>(?:\s|<[^>]+>)*Now Playing(?:\s|<[^>]+>)*<\/h1>/i)
  if (start < 0) return []
  const rest = body.slice(start)
  const footer = rest.search(/HELPFUL LINKS/i)
  const section = footer > 0 ? rest.slice(0, footer) : rest
  const blocks = section.split(/(?=<h2\b)/i).slice(1)
  const out = []
  for (const block of blocks) {
    const title = clean(htmlToText(block.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? ''))
    if (!title) continue
    const paragraphs = [...block.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => clean(htmlToText(m[1]))).filter(Boolean)
    let run = null
    const rules = {}
    const prose = []
    for (const p of paragraphs) {
      if (!run) {
        const parsed = parseRunLine(p)
        if (parsed) { run = parsed; continue }
      }
      const rule = parseTimeRule(p)
      if (Object.keys(rule).length) { Object.assign(rules, rule); continue }
      if (CREDIT_RE.test(p) || /^get tickets/i.test(p)) continue
      prose.push(p)
    }
    const img = block.match(/<img\b[^>]*\bsrc="([^"]+)"/i)?.[1] ?? null
    const ticket = block.match(/<a\b[^>]*\bhref="(https?:\/\/[^"]*(?:ludus\.com|arts-people\.com)[^"]*)"/i)?.[1] ?? null
    out.push({
      title,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      description: prose.length ? clampChars(prose.join('\n\n'), MAX_DESCRIPTION) : null,
      imageUrl: img ? (img.startsWith('//') ? `https:${img}` : img) : null,
      ticketUrl: ticket ? ticket.replace(/&amp;/g, '&') : null,
      run,
      rules,
    })
  }
  return out
}

/** One performance → { row, venue } or { skip }. */
export function buildRow(production, date) {
  if (!production?.slug || !production?.title) return { skip: 'invalid' }
  const time = production.rules?.[weekdayOf(date.year, date.month, date.day)]
  if (!time) return { skip: 'no_time_rule' }
  const dateStr = `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
  const startAt = easternToIso(dateStr, time.time)
  if (!startAt) return { skip: 'undatable' }
  return {
    row: {
      title: production.title,
      description: production.description,
      start_at: startAt,
      end_at: null,
      categories: ['theater'],
      tags: ['theatre', 'community-theater', 'hudson'],
      price_min: null,
      price_max: null,
      age_restriction: 'not_specified',
      image_url: production.imageUrl,
      ticket_url: production.ticketUrl || PAGE_URL,
      source: SOURCE_KEY,
      source_id: `${production.slug}-${dateStr}-${time.hhmm}`,
      status: 'published',
      featured: false,
    },
    venue: MAIN_VENUE,
  }
}

export async function collect({ fetchImpl, now = Date.now } = {}) {
  const res = await fetchWithRetry(PAGE_URL, { headers: { Accept: 'text/html' }, fetchImpl })
  if (!res.ok) throw new Error(`${PAGE_URL} answered HTTP ${res.status}`)
  const html = await res.text()
  // A page without its heading is a redesign, not an empty season.
  if (!/Now Playing/i.test(html)) throw new Error(`${PAGE_URL} no longer has a "Now Playing" section`)
  const rows = []
  const skipped = {}
  const skip = (reason, n = 1) => { if (n > 0) skipped[reason] = (skipped[reason] ?? 0) + n }
  const earliest = now() - DAY_MS
  let found = 0
  for (const production of parseNowPlaying(html)) {
    if (!production.run) { skip('no_run_dates'); continue }
    found += production.run.dates.length
    for (const date of production.run.dates) {
      const built = buildRow(production, date)
      if (built.skip) { skip(built.skip); continue }
      if (Date.parse(built.row.start_at) < earliest) { skip('past'); continue }
      rows.push(built)
    }
  }
  return { found, rows, skipped }
}

export function run({ dryRun = false, fetchImpl, now } = {}) {
  return runPlannedScraper({
    source: SOURCE_KEY,
    label: 'Hudson Players',
    emoji: '🎭',
    org: ORG,
    homeVenue: MAIN_VENUE,
    collect: () => collect({ fetchImpl, now }),
    dryRun,
    emptyIsError: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
