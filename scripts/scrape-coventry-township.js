/**
 * scrape-coventry-township.js — Coventry Township (coventrytownship.com).
 *
 * The township has no calendar. It announces meetings and community events as
 * posts on its Wix blog, mixed in with ordinary news (board vacancies, the
 * newsletter, ballot issues). A post is treated as an event only when its
 * TITLE ends with a date, which is how the township titles the ones that
 * happen on a day:
 *
 *   "Zoning Commission Board Meeting - NOV 17"
 *   "Coventry Clock Tower Tree Lighting - Holiday Kick-Off Event Dec. 6th"
 *
 * Everything else is news and is ignored. For each dated post the page is
 * fetched and read for the rest:
 *
 *   year   an explicit "December 6, 2026" in the post for the same month and
 *          day; otherwise the first such date after the day it was posted,
 *          within five months. A title dated BEFORE its post (a press
 *          release about something that happened) is not an event.
 *   time   the one clock time or range the post states (lib/prose-time.js).
 *          A post that states no time, or several different ones, is skipped
 *          and counted. No time is ever assumed.
 *   place  a "Location: …" line, or a named street address in the text
 *          (lib/prose-venue.js). Township meetings are held at the Coventry
 *          Community Center. A post that names no place gets no venue.
 *
 * A title marked cancelled is skipped. The blog feed carries the 20 newest
 * posts; a week with only news in it is a normal empty run.
 *
 * Usage:
 *   node scripts/scrape-coventry-township.js
 *   node scripts/scrape-coventry-township.js --dry-run
 */
import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { decodeEntities, clampChars, easternToIso } from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'
import { MONTH_RE, monthNumber } from './lib/clock-time.js'
import { proseTime } from './lib/prose-time.js'
import { findAddressedVenue } from './lib/prose-venue.js'
import { classifySummitLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'coventry_township'
const ORIGIN = 'https://www.coventrytownship.com'
export const FEED_URL = `${ORIGIN}/blog-feed.xml`
const MAX_DESCRIPTION = 1500
const PAGE_DELAY_MS = 250
const DAY_MS = 86_400_000

const ORG = {
  name: 'Coventry Township',
  details: { website: ORIGIN, description: 'Township government for Coventry Township in southern Summit County.' },
}

export const COMMUNITY_CENTER = {
  name: 'Coventry Community Center',
  details: { address: '335 E Willow View Dr', city: 'Akron', state: 'OH', zip: '44319', website: ORIGIN },
}

const cdata = (s = '') => decodeEntities(String(s).replace(/^\s*<!\[CDATA\[|\]\]>\s*$/g, '')).trim()
const clean = (s = '') => String(s).replace(/[\u00a0\u200b]/g, ' ').replace(/[ \t]+/g, ' ').trim()

/** RSS → [{ title, link, slug, publishedAt, categories }]. */
export function parseFeed(xml = '') {
  const out = []
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (name) => cdata(m[1].match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? '')
    const link = tag('link')
    const slug = link.match(/\/post\/([^/?#]+)/)?.[1] ?? null
    const publishedAt = Date.parse(tag('pubDate'))
    if (!slug || Number.isNaN(publishedAt)) continue
    out.push({
      title: clean(tag('title')),
      link,
      slug,
      publishedAt,
      categories: [...m[1].matchAll(/<category>([\s\S]*?)<\/category>/g)].map((c) => cdata(c[1])),
    })
  }
  return out
}

/**
 * The date a title ends with → { month, day, title } where `title` is the
 * title without it. "… - Mon. Nov 23rd" / "… - NOV 17" / "… Event Dec. 6th".
 * null when the title does not end with a month and day.
 */
export function titleDate(title = '') {
  const m = clean(title).match(/^(.*?)[\s(–—-]*(?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\)?\.?$/i)
  if (!m) return null
  const month = monthNumber(m[2])
  const day = Number(m[3])
  if (!month || day < 1 || day > 31 || !clean(m[1])) return null
  return { month, day, title: clean(m[1]) }
}

export const isCancelled = (title = '') => /\bcancel?led\b|\bpostponed\b/i.test(title)

/** Post page → { lines, imageUrl }; lines are the post body, one per paragraph. */
export function parsePost(html = '') {
  const page = String(html)
  const start = page.indexOf('data-id="content-viewer"')
  let lines = []
  if (start >= 0) {
    const end = page.indexOf('data-hook="post-footer"', start)
    const body = page.slice(start, end > start ? end : undefined)
      .replace(/<(script|style|svg|figure|button)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\b[^>]*>|<\/(?:div|p|h[1-6]|li|ul|ol)>/gi, '\n')
      .replace(/^[^>]*>/, '')
      .replace(/<[^>]*>?/g, '')
    lines = decodeEntities(body).split('\n').map(clean).filter(Boolean)
  }
  let imageUrl = null
  const ld = page.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i)?.[1]
  if (ld) {
    try { imageUrl = JSON.parse(ld)?.image?.url ?? null } catch { /* malformed JSON-LD: no image */ }
  }
  return { lines, imageUrl }
}

/** The year the post itself prints for this month and day, or null. */
export function statedYear(text, month, day) {
  for (const m of String(text).matchAll(new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, 'gi'))) {
    if (monthNumber(m[1]) === month && Number(m[2]) === day) return Number(m[3])
  }
  return null
}

/**
 * The year of a title's month and day, judged from when the post went up.
 * An announcement comes before its event, and not by long: the date must fall
 * between the day before posting and HORIZON_DAYS after it (which carries a
 * December post about a January meeting into the next year). A date outside
 * that window is a post ABOUT a day that already happened (a press release),
 * not an event, and returns null.
 */
const HORIZON_DAYS = 150
export function eventYear(publishedAt, month, day) {
  const posted = new Date(publishedAt)
  for (const year of [posted.getUTCFullYear(), posted.getUTCFullYear() + 1]) {
    const endOfDay = Date.UTC(year, month - 1, day + 1)
    if (endOfDay >= posted.getTime() && endOfDay - posted.getTime() <= HORIZON_DAYS * 86_400_000) return year
  }
  return null
}

/** Titles that end in a date but report something, rather than invite anyone. */
export const isNewsTitle = (title = '') => /\bpress release\b|\bfor immediate release\b|\bnow hiring\b|\bballot\b/i.test(title)

/** Where the post says it is → { name, details } or null. */
export function findPlace(lines = []) {
  const text = lines.join('\n')
  if (/community center/i.test(text) && /willow\s?view/i.test(text)) return COMMUNITY_CENTER
  const labelled = lines.map((l) => l.match(/^location\s*:\s*(.{3,80})$/i)?.[1]).find(Boolean)
  if (labelled) return { name: clean(labelled), details: { city: 'Akron', state: 'OH', zip: '44319' } }
  const found = findAddressedVenue(text)
  if (found && classifySummitLocation({ city: found.city }) !== 'out') {
    return { name: found.name, details: { address: found.address, city: found.city, state: 'OH' } }
  }
  return null
}

/** Body lines → description: no file downloads, contact lines or signatures of address. */
export function describe(lines = []) {
  const kept = lines.filter((l) =>
    !/@[\w-]+\.\w+/.test(l) && !/\.(?:pdf|docx?)\b/i.test(l) && !/^download (?:pdf|docx?)\b/i.test(l) && !/^location$/i.test(l))
  return kept.length ? clampChars(kept.join('\n\n'), MAX_DESCRIPTION) : null
}

export function categoriesFor(title = '') {
  if (/\b(meeting|hearing|board|commission|trustees?)\b/i.test(title)) return ['civic']
  if (/\b(tree lighting|festival|parade|fireworks|holiday|celebration)\b/i.test(title)) return ['festival']
  return ['civic']
}

/** One dated post + its page → { row, venue } or { skip }. */
export function buildRow(post, page) {
  const dated = titleDate(post?.title)
  if (!dated || !post?.slug) return { skip: 'invalid' }
  if (isNewsTitle(post.title)) return { skip: 'news' }
  if (isCancelled(post.title)) return { skip: 'cancelled' }
  const text = page.lines.join('\n')
  const time = proseTime(text)
  if (!time) return { skip: 'no_single_time' }
  const year = statedYear(text, dated.month, dated.day) ?? eventYear(post.publishedAt, dated.month, dated.day)
  if (!year) return { skip: 'dated_before_posting' }
  const dateStr = `${year}-${String(dated.month).padStart(2, '0')}-${String(dated.day).padStart(2, '0')}`
  const startAt = easternToIso(dateStr, time.startTime)
  if (!startAt) return { skip: 'undatable' }
  const endAt = time.endTime ? easternToIso(dateStr, time.endTime) : null
  return {
    row: {
      title: dated.title,
      description: describe(page.lines),
      start_at: startAt,
      end_at: endAt && endAt > startAt ? endAt : null,
      categories: categoriesFor(dated.title),
      tags: ['coventry-township', 'township'],
      price_min: null,
      price_max: null,
      age_restriction: 'all_ages',
      image_url: page.imageUrl,
      ticket_url: post.link,
      source: SOURCE_KEY,
      source_id: post.slug,
      status: 'published',
      featured: false,
    },
    venue: findPlace(page.lines),
  }
}

const pause = (ms) => (ms ? new Promise((r) => setTimeout(r, ms)) : null)

export async function collect({ fetchImpl, now = Date.now, delayMs = PAGE_DELAY_MS } = {}) {
  const res = await fetchWithRetry(FEED_URL, { headers: { Accept: 'application/rss+xml, text/xml' }, fetchImpl })
  if (!res.ok) throw new Error(`${FEED_URL} answered HTTP ${res.status}`)
  const xml = await res.text()
  if (!/<rss\b/i.test(xml)) throw new Error(`${FEED_URL} did not return an RSS feed`)
  const rows = []
  const skipped = {}
  const skip = (reason, n = 1) => { if (n > 0) skipped[reason] = (skipped[reason] ?? 0) + n }
  const earliest = now() - DAY_MS
  let found = 0
  for (const post of parseFeed(xml)) {
    const dated = titleDate(post.title)
    if (!dated) continue // news, not an event
    found++
    if (isNewsTitle(post.title)) { skip('news'); continue }
    if (isCancelled(post.title)) { skip('cancelled'); continue }
    // Decide "past" from the title before spending a request on the page.
    const roughYear = eventYear(post.publishedAt, dated.month, dated.day)
    if (!roughYear) { skip('dated_before_posting'); continue }
    if (Date.UTC(roughYear, dated.month - 1, dated.day + 1) < earliest) { skip('past'); continue }
    let page
    try {
      await pause(delayMs)
      const pageRes = await fetchWithRetry(post.link, { headers: { Accept: 'text/html' }, fetchImpl })
      if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`)
      page = parsePost(await pageRes.text())
    } catch (err) {
      console.warn(`  ⚠ Post page failed (${post.link}): ${err.message}`)
      skip('post_page_failed')
      continue
    }
    if (!page.lines.length) { skip('empty_post'); continue }
    const built = buildRow(post, page)
    if (built.skip) { skip(built.skip); continue }
    if (Date.parse(built.row.start_at) < earliest) { skip('past'); continue }
    rows.push(built)
  }
  return { found, rows, skipped }
}

export function run({ dryRun = false, fetchImpl, now, delayMs } = {}) {
  return runPlannedScraper({
    source: SOURCE_KEY,
    label: 'Coventry Township',
    emoji: '🏛️',
    org: ORG,
    homeVenue: COMMUNITY_CENTER,
    collect: () => collect({ fetchImpl, now, delayMs }),
    dryRun,
    emptyIsError: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
