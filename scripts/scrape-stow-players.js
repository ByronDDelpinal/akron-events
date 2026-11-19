/**
 * scrape-stow-players.js — Stow Players (stowplayers.net)
 *
 * Community theater in the Heritage Barn at Silver Springs Park, Stow.
 * WordPress + Elementor, hand-maintained: the home page lists the season's
 * productions (each card links to /production/<slug>/ and shows the opening
 * date WITH its year), and each production page has a "Showtimes" block:
 *
 *   December 4, 5, 11, 12, 18, and 19 at 7:30 PM
 *   December 6, 13, 19, and 20 at 2:30 PM
 *
 * One row per performance, id `<slug>-<date>-<hhmm>`, so a run's dates can
 * change without orphaning the rest.
 *
 * The showtimes carry no year. The year comes from that production's card on
 * the home page (the opening date); a month earlier than the opening month
 * belongs to the following year. Without a card date the shared nearest-year
 * rule is used. The page's own "<h1>The 2025-26 Season</h1>" is stale theme
 * text and is deliberately not read.
 *
 * No price is published on the site (tickets are on Arts People), so price
 * stays unknown. An empty run is normal between seasons.
 *
 * Usage:
 *   node scripts/scrape-stow-players.js
 *   node scripts/scrape-stow-players.js --dry-run
 */
import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { htmlToText, clampChars, easternToIso } from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'
import { inferYearForMonthDay } from './lib/year-inference.js'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'

export const SOURCE_KEY = 'stow_players'
const ORIGIN = 'https://stowplayers.net'
const START_URL = `${ORIGIN}/`
const MAX_DESCRIPTION = 4000
const PAGE_DELAY_MS = 250
const DAY_MS = 86_400_000

const ORG = {
  name: 'Stow Players',
  details: {
    website: ORIGIN,
    description: 'Non-profit community theater in Stow since 1953, performing in the Heritage Barn at Silver Springs Park.',
  },
}

export const MAIN_VENUE = {
  name: 'The Heritage Barn',
  details: {
    address: '5238 Young Road',
    city: 'Stow', state: 'OH', zip: '44224',
    website: `${ORIGIN}/about/directions/`,
    parking_type: 'lot',
  },
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}
const MONTH_RE = Object.keys(MONTHS).join('|')

/**
 * Production pages linked from the home page, with the opening date printed
 * on each card. Returns [{ url, slug, openMonth, openYear }] in page order;
 * openMonth/openYear are null when the card shows no dated line.
 */
export function findProductions(html = '') {
  const s = String(html)
  const hits = [...s.matchAll(/href="(?:https?:\/\/(?:www\.)?stowplayers\.net)?\/production\/([a-z0-9-]+)\/?"/gi)]
  const out = []
  for (let i = 0; i < hits.length; i++) {
    const slug = hits[i][1].toLowerCase()
    // Text from this link up to the next production link is this card.
    const end = hits.slice(i + 1).find((h) => h[1].toLowerCase() !== slug)?.index ?? s.length
    const text = htmlToText(s.slice(hits[i].index, end))
    const m = text.match(new RegExp(`\\b(${MONTH_RE})\\s+\\d{1,2},\\s*(\\d{4})\\b`, 'i'))
    const existing = out.find((p) => p.slug === slug)
    const open = m ? { openMonth: MONTHS[m[1].toLowerCase()], openYear: Number(m[2]) } : null
    if (existing) {
      if (open && existing.openYear == null) Object.assign(existing, open)
      continue
    }
    out.push({ url: `${ORIGIN}/production/${slug}/`, slug, openMonth: open?.openMonth ?? null, openYear: open?.openYear ?? null })
  }
  return out
}

/** "7:30 PM" / "7:30pm" / "2 PM" → { time: '7:30 pm', hhmm: '1930' } or null. */
export function parseTime(text = '') {
  const m = String(text).trim().match(/^(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)$/i)
  if (!m) return null
  const hour = Number(m[1])
  if (hour < 1 || hour > 12) return null
  const minute = m[2] ?? '00'
  const mer = /^p/i.test(m[3]) ? 'pm' : 'am'
  const hour24 = (hour % 12) + (mer === 'pm' ? 12 : 0)
  return { time: `${hour}:${minute} ${mer}`, hhmm: `${String(hour24).padStart(2, '0')}${minute}` }
}

/**
 * One showtimes line → [{ month, day, time, hhmm }].
 * "February 7, 14, 20, and 21 at 2:30PM" → four entries. A line that does not
 * fit the pattern returns null so the caller can count it, not guess.
 */
export function parseShowtimeLine(line = '') {
  const text = String(line).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
  const m = text.match(new RegExp(`^(${MONTH_RE})\\s+([\\d,\\s&and]+?)\\s+at\\s+(.+)$`, 'i'))
  if (!m) return null
  const time = parseTime(m[3])
  if (!time) return null
  const days = m[2].split(/\s*(?:,|&|\band\b)\s*/i).map((d) => d.trim()).filter(Boolean)
  if (!days.length || days.some((d) => !/^\d{1,2}$/.test(d) || Number(d) < 1 || Number(d) > 31)) return null
  const month = MONTHS[m[1].toLowerCase()]
  return days.map((d) => ({ month, day: Number(d), ...time }))
}

/** Parse one production page. `unparsed` counts showtime lines that did not fit. */
export function parseProductionPage(html = '') {
  const s = String(html)
  const clean = (h) => htmlToText(h ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
  // The show's own <h1>; the theme also prints a stale "The 2025-26 Season" <h1>.
  const h1 = [...s.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].find((m) => !/\bSeason\b/i.test(clean(m[1])))
  const title = h1
    ? clean(h1[1])
    : clean(s.match(/<title>([\s\S]*?)<\/title>/i)?.[1]).replace(/\s*[-–—|]\s*Stow Players\s*$/i, '')
  // The line under the title ("A Comedy Improv Troupe", "A Jones Hope Wooten comedy").
  const subtitle = h1 ? clean(s.slice(h1.index + h1[0].length).match(/^[\s\S]{0,600}?<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1]) : ''

  const at = s.search(/>\s*Showtimes\s*</i)
  const before = at === -1 ? s : s.slice(0, at)
  const after = at === -1 ? '' : s.slice(at)

  // The synopsis is the post-content widget above the Showtimes heading.
  const body = before.match(/elementor-widget-theme-post-content[^>]*>\s*<div class="elementor-widget-container">([\s\S]*?)<\/div>/i)?.[1] ?? ''
  const synopsis = htmlToText(body).replace(/[ \t\u00a0]+\n/g, '\n').replace(/[ \t\u00a0]{2,}/g, ' ').trim()
  const parts = [subtitle, synopsis].filter(Boolean)
  const description = parts.length ? clampChars(parts.join('\n\n'), MAX_DESCRIPTION) : null

  const block = after.match(/elementor-heading-title[^>]*>\s*(?!Showtimes)([\s\S]*?)<\/div>/i)?.[1] ?? ''
  const lines = htmlToText(block.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n'))
    .split('\n').map((l) => l.trim()).filter(Boolean)
  const showtimes = []
  let unparsed = 0
  for (const line of lines) {
    const parsed = parseShowtimeLine(line)
    if (!parsed) { unparsed++; continue }
    showtimes.push(...parsed)
  }

  // The featured image is the first "attachment-large" upload; sponsor logos
  // and the site logo use other size classes.
  const imageUrl = [...s.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0])
    .find((tag) => /class="[^"]*attachment-large/.test(tag) && /\/wp-content\/uploads\//.test(tag))
    ?.match(/\ssrc="([^"]+)"/)?.[1] ?? null
  const ticketUrl = s.match(/href="(https:\/\/app\.arts-people\.com\/[^"]+)"/i)?.[1]?.replace(/&amp;/g, '&') ?? null

  return { title, description, showtimes, unparsed, imageUrl, ticketUrl }
}

/** The year a showtime falls in, from the production's opening date. */
export function yearFor(production, month, day, now = new Date()) {
  if (production?.openYear && production?.openMonth) {
    return month < production.openMonth ? production.openYear + 1 : production.openYear
  }
  return inferYearForMonthDay(month, day, now)
}

/** One performance → { row, venue } or { skip }. */
export function buildRow(production, page, showtime, now = new Date()) {
  if (!production?.slug || !page?.title) return { skip: 'invalid' }
  const year = yearFor(production, showtime.month, showtime.day, now)
  const dateStr = `${year}-${String(showtime.month).padStart(2, '0')}-${String(showtime.day).padStart(2, '0')}`
  const startAt = easternToIso(dateStr, showtime.time)
  if (!startAt) return { skip: 'undatable' }
  const improv = /improv/i.test(`${page.title} ${page.description ?? ''}`)
  return {
    row: {
      title: page.title,
      description: page.description,
      start_at: startAt,
      end_at: null,
      categories: improv ? ['comedy', 'theater'] : ['theater'],
      tags: ['theatre', 'community-theater', 'stow', ...(improv ? ['improv'] : [])],
      price_min: null,
      price_max: null,
      age_restriction: 'not_specified',
      image_url: page.imageUrl,
      ticket_url: page.ticketUrl || production.url,
      source: SOURCE_KEY,
      source_id: `${production.slug}-${dateStr}-${showtime.hhmm}`,
      status: 'published',
      featured: false,
    },
    venue: MAIN_VENUE,
  }
}

async function fetchHtml(url, fetchImpl) {
  const res = await fetchWithRetry(url, { headers: { Accept: 'text/html' }, fetchImpl })
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`)
  return res.text()
}
const pause = (ms) => (ms ? new Promise((r) => setTimeout(r, ms)) : null)

export async function collect({ fetchImpl, now = Date.now, delayMs = PAGE_DELAY_MS } = {}) {
  const productions = findProductions(await fetchHtml(START_URL, fetchImpl))
  const rows = []
  const skipped = {}
  const skip = (reason, n = 1) => { if (n > 0) skipped[reason] = (skipped[reason] ?? 0) + n }
  const earliest = now() - DAY_MS
  let found = 0

  for (const production of productions) {
    let page
    try {
      await pause(delayMs)
      page = parseProductionPage(await fetchHtml(production.url, fetchImpl))
    } catch (err) {
      console.warn(`  ⚠ Production page failed (${production.url}): ${err.message}`)
      skip('production_page_failed')
      continue
    }
    found += page.showtimes.length + page.unparsed
    skip('unparsed_showtime', page.unparsed)
    if (!page.showtimes.length) { skip('no_showtimes'); continue }
    for (const showtime of page.showtimes) {
      const built = buildRow(production, page, showtime, new Date(now()))
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
    label: 'Stow Players',
    emoji: '🎭',
    org: ORG,
    homeVenue: MAIN_VENUE,
    collect: () => collect({ fetchImpl, now, delayMs }),
    dryRun,
    emptyIsError: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
