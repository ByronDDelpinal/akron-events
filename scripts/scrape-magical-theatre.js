/**
 * scrape-magical-theatre.js
 *
 * Magical Theatre Company — the professional theatre for young audiences in
 * downtown Barberton (565 W. Tuscarawas Ave.). Each season is a handful of
 * family productions, each with a run of public performances.
 *
 * Source: https://www.magicaltheatre.org — WordPress + Divi, hand-maintained
 * pages (no events plugin, no feed, no schema.org Event markup).
 *
 *   discovery     /upcoming-events/ and every /<yyyy>-<yyyy>-season/ page
 *                 linked from it → the set of /events/<slug>/ show pages
 *
 *   show page     <h1 …>Elf the Musical TYA</h1>
 *                 <span class="ticket-list-price">$23 and $25 per person</span>
 *                 <h2 …>Public Performances</h2>
 *                 <ul class="ticket-list">
 *                   <li><div>Fri December 4, 2026</div><div>7:30 pm</div>
 *                       <div class="ticket-container"><a href="…" class="ticket-btn">BUY TICKETS</a></div></li>
 *                   …
 *                 <div id="show-credits" …><div class="et_pb_text_inner">synopsis</div>
 *                 <div class="event-photo"><img src="…"></div>   (og:image is the season logo)
 *
 * Decisions:
 *   • ONE ROW PER PERFORMANCE. A visitor is choosing a date and time, and the
 *     site prices and tickets each performance separately.
 *   • Only the list under "Public Performances" is read. School-day matinees
 *     are sold to schools and are not public events; if the page ever adds a
 *     second list for them it is ignored because it is not that first list.
 *   • Date and time come from the list as written. A performance whose date
 *     or time does not parse is skipped and counted; nothing is defaulted.
 *   • Price is the range in ticket-list-price ("$23 and $25" → 23–25). Absent
 *     or unparseable → null (never assume free).
 *   • source_id is `<slug>-<YYYY-MM-DD>-<HHMM>`: stable for a given
 *     performance, and a rescheduled one becomes a new row (the old date is
 *     no longer a performance).
 *   • All performances are at the company's own theatre in Barberton, which
 *     is in Summit County: no per-row geo gate.
 *   • A season with nothing announced is real for this company (between
 *     seasons the pages list no shows), so zero listings is NOT an error.
 *     A show page that lists zero public performances is counted as
 *     `no_public_performances` so a markup change is still visible.
 *
 * Usage:   node scripts/scrape-magical-theatre.js [--dry-run]
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (not needed for --dry-run)
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { htmlToText, clampChars, easternToIso } from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'

export const SOURCE_KEY = 'magical_theatre'
const ORIGIN = 'https://www.magicaltheatre.org'
const START_URL = `${ORIGIN}/upcoming-events/`
const MAX_DESCRIPTION = 4000
const PAGE_DELAY_MS = 250
const MAX_SEASON_PAGES = 4
const DAY_MS = 86_400_000

const ORG = {
  name: 'Magical Theatre Company',
  details: {
    website: ORIGIN,
    description: 'Northeast Ohio’s professional resident and touring theatre for young audiences and families, based in downtown Barberton.',
  },
}

export const MAIN_VENUE = {
  name: 'Magical Theatre Company',
  details: {
    address: '565 W Tuscarawas Ave',
    city: 'Barberton', state: 'OH', zip: '44203',
    website: ORIGIN,
    parking_type: 'street',
  },
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** Show-page URLs on a page, absolute, de-duplicated, in page order. */
export function findShowLinks(html = '') {
  const out = []
  for (const m of String(html).matchAll(/href="(?:https?:\/\/(?:www\.)?magicaltheatre\.org)?(\/events\/([a-z0-9-]+)\/?)"/gi)) {
    const url = `${ORIGIN}/events/${m[2]}/`
    if (!out.includes(url)) out.push(url)
  }
  return out
}

/** Season-page URLs on a page ("/2026-2027-season/"), absolute. */
export function findSeasonLinks(html = '') {
  const out = []
  for (const m of String(html).matchAll(/href="(?:https?:\/\/(?:www\.)?magicaltheatre\.org)?\/(\d{4}-\d{4}-season)\/?"/gi)) {
    const url = `${ORIGIN}/${m[1]}/`
    if (!out.includes(url)) out.push(url)
  }
  return out
}

/** "Fri December 4, 2026" → "2026-12-04", else null. */
export function parsePerformanceDate(text = '') {
  const m = htmlToText(String(text)).replace(/\s+/g, ' ').trim()
    .match(/^(?:[A-Za-z]{3,9}\.?,?\s+)?([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/)
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  const day = Number(m[2])
  if (!month || day < 1 || day > 31) return null
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** "7:30 pm" → { time: "7:30 pm", hhmm: "1930" }, else null. */
export function parsePerformanceTime(text = '') {
  const m = htmlToText(String(text)).replace(/\s+/g, ' ').trim().match(/^(\d{1,2})(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)$/i)
  if (!m) return null
  const hour = Number(m[1])
  if (hour < 1 || hour > 12) return null
  const minute = m[2] ?? '00'
  const mer = /^p/i.test(m[3]) ? 'pm' : 'am'
  const hour24 = (hour % 12) + (mer === 'pm' ? 12 : 0)
  return { time: `${hour}:${minute} ${mer}`, hhmm: `${String(hour24).padStart(2, '0')}${minute}` }
}

/** "$23 and $25 per person" → { price_min: 23, price_max: 25 }. */
export function parsePrice(text = '') {
  const nums = [...htmlToText(String(text)).matchAll(/\$\s*(\d+(?:\.\d{1,2})?)/g)].map((m) => parseFloat(m[1]))
  if (!nums.length) return { price_min: null, price_max: null }
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  return { price_min: min, price_max: max > min ? max : null }
}

const meta = (html, property) =>
  html.match(new RegExp(`<meta[^>]+property="${property}"[^>]+content="([^"]*)"`, 'i'))?.[1] ??
  html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="${property}"`, 'i'))?.[1] ?? null

/**
 * A show page → { title, description, imageUrl, price_min, price_max,
 * performances: [{ dateStr, time, hhmm, ticketUrl }], unparsed }.
 * `unparsed` counts list items whose date or time did not parse.
 */
export function parseShowPage(html = '') {
  const s = String(html)
  const title = htmlToText(s.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim()
  // The synopsis is the "show-credits" text block. The page has no
  // og:description, and og:image is the season logo, so the production photo
  // is preferred when there is one.
  const credits = s.match(/id="show-credits"[^>]*>\s*<div class="et_pb_text_inner">([\s\S]*?)<\/div>/i)?.[1] ?? ''
  const description = htmlToText(credits).replace(/[ \t]+\n/g, '\n').trim()
  const photo = s.match(/<div class="event-photo">\s*<img[^>]+src="([^"]+)"/i)?.[1] ?? null
  const imageUrl = (photo ?? meta(s, 'og:image'))?.replace(/&amp;/g, '&') ?? null
  const price = parsePrice(s.match(/<span class="ticket-list-price">([\s\S]*?)<\/span>/i)?.[1] ?? '')

  // The first ticket-list after the "Public Performances" heading.
  const after = s.split(/Public Performances/i)[1] ?? ''
  const list = after.match(/<ul class="ticket-list">([\s\S]*?)<\/ul>/i)?.[1] ?? ''
  const performances = []
  let unparsed = 0
  for (const li of list.matchAll(/<li>([\s\S]*?)<\/li>/gi)) {
    const divs = [...li[1].matchAll(/<div(?:\s[^>]*)?>([\s\S]*?)<\/div>/gi)].map((d) => d[1])
    const dateStr = parsePerformanceDate(divs[0])
    const t = parsePerformanceTime(divs[1])
    if (!dateStr || !t) { unparsed++; continue }
    const ticketUrl = li[1].match(/<a[^>]+href="([^"]+)"[^>]*class="ticket-btn"/i)?.[1]?.replace(/&amp;/g, '&') ?? null
    performances.push({ dateStr, time: t.time, hhmm: t.hhmm, ticketUrl })
  }

  return {
    title,
    description: description ? clampChars(description, MAX_DESCRIPTION) : null,
    imageUrl: imageUrl || null,
    ...price,
    performances,
    unparsed,
  }
}

/** One show + one of its performances → { row, venue } or { skip }. */
export function buildRow(showUrl, show, perf) {
  const slug = showUrl.match(/\/events\/([a-z0-9-]+)\/?$/i)?.[1]
  if (!slug || !show?.title) return { skip: 'invalid' }
  const startAt = easternToIso(perf.dateStr, perf.time)
  if (!startAt) return { skip: 'undatable' }

  return {
    row: {
      title: show.title,
      description: show.description,
      start_at: startAt,
      end_at: null,
      categories: ['theater'],
      is_family: true,
      tags: ['theatre', 'family', 'barberton', 'young-audiences'],
      price_min: show.price_min,
      price_max: show.price_max,
      age_restriction: 'not_specified',
      image_url: show.imageUrl,
      ticket_url: perf.ticketUrl || showUrl,
      source: SOURCE_KEY,
      source_id: `${slug}-${perf.dateStr}-${perf.hhmm}`,
      status: 'published',
      featured: false,
    },
    venue: MAIN_VENUE,
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function fetchHtml(url, fetchImpl) {
  const res = await fetchWithRetry(url, { headers: { Accept: 'text/html' }, fetchImpl })
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`)
  return res.text()
}

const pause = (ms) => (ms ? new Promise((r) => setTimeout(r, ms)) : null)

export async function collect({ fetchImpl, now = Date.now, delayMs = PAGE_DELAY_MS } = {}) {
  const startHtml = await fetchHtml(START_URL, fetchImpl)
  const showUrls = findShowLinks(startHtml)

  // Season pages list shows the "upcoming" page has not picked up yet. A
  // season page that fails is a warning, not a failed run: the upcoming page
  // already answered.
  for (const seasonUrl of findSeasonLinks(startHtml).slice(0, MAX_SEASON_PAGES)) {
    try {
      await pause(delayMs)
      for (const url of findShowLinks(await fetchHtml(seasonUrl, fetchImpl))) {
        if (!showUrls.includes(url)) showUrls.push(url)
      }
    } catch (err) {
      console.warn(`  ⚠ Season page failed (${seasonUrl}): ${err.message}`)
    }
  }

  const rows = []
  const skipped = {}
  const skip = (reason, n = 1) => { if (n > 0) skipped[reason] = (skipped[reason] ?? 0) + n }
  const earliest = now() - DAY_MS
  let found = 0

  for (const showUrl of showUrls) {
    let show
    try {
      await pause(delayMs)
      show = parseShowPage(await fetchHtml(showUrl, fetchImpl))
    } catch (err) {
      console.warn(`  ⚠ Show page failed (${showUrl}): ${err.message}`)
      skip('show_page_failed')
      continue
    }
    found += show.performances.length + show.unparsed
    skip('unparsed_performance', show.unparsed)
    if (!show.performances.length) { skip('no_public_performances'); continue }

    for (const perf of show.performances) {
      const built = buildRow(showUrl, show, perf)
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
    label: 'Magical Theatre Company',
    emoji: '🎭',
    org: ORG,
    homeVenue: MAIN_VENUE,
    collect: () => collect({ fetchImpl, now, delayMs }),
    dryRun,
    // Between seasons the site lists no shows; that is not a broken parser.
    emptyIsError: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
