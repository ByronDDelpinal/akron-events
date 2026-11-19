/**
 * scrape-bounce-hub.js
 *
 * Bounce Innovation Hub — Akron's startup and small-business hub in the former
 * B.F. Goodrich plant at 526 S. Main St. Its own calendar carries founder
 * workshops (the "Beyond Startup" series), free coworking days, networking
 * nights and fundraisers. Until now those reached Akron Pulse only when an
 * organizer also posted to Eventbrite.
 *
 * Source: https://bouncehub.org/events — a Drupal view, server-rendered.
 *
 *   list page     <div class="item"><a href="/events/<slug>" class="wrap">
 *                   <div class="image"><img src="…"></div>
 *                   <div class="text">
 *                     <div class="date">Nov 18</div>
 *                     <div class="label">Beyond Startup Series</div>
 *                     <h3>Title</h3>
 *
 *   detail page   <h2 class="sub-title">Title<br>
 *                   <span class="date">Nov 18, 2026 10:00 - 11:30 AM</span></h2>
 *                 …<div class="field field--name-body …">description</div>
 *
 * The list has the title, image and series label but no year and no time, so
 * every listing's detail page is fetched for the full date line. That line is
 * the only place the time exists.
 *
 * Decisions:
 *   • The date line is parsed strictly (one or more "Mon D, YYYY", then an
 *     optional time or time range). A listing whose line does not parse is
 *     skipped and counted as `undatable`; it is never dated from the list's
 *     year-less "Nov 18".
 *   • "10:00 - 11:30 AM": the start borrows the end's meridiem unless that
 *     would put it after the end ("11:00 - 1:00 PM" starts in the morning).
 *   • A line with a date and no time gets the sanctioned noon placeholder and
 *     is marked `time_inferred`.
 *   • Events are held at Bounce unless the title says otherwise. A title that
 *     says virtual / webinar / online gets no venue.
 *   • A RECURRING LISTING is one page whose date line lists every date
 *     ("Feb 25, 2026, Mar 25, 2026, … Dec 23, 2026 8 AM - 5 PM", the monthly
 *     Free Coworking Day). Each date becomes its own row, so the next one is
 *     always on the calendar and the past ones drop off.
 *   • source_id is the URL slug, plus the date for a recurring listing.
 *   • Price is never on the page: left null (never assume free).
 *
 * Usage:   node scripts/scrape-bounce-hub.js [--dry-run]
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (not needed for --dry-run)
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { htmlToText, clampChars, easternToIso } from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'

export const SOURCE_KEY = 'bounce_hub'
const ORIGIN = 'https://bouncehub.org'
const EVENTS_URL = `${ORIGIN}/events`
const MAX_DESCRIPTION = 4000
const DETAIL_DELAY_MS = 250
const DAY_MS = 86_400_000

const ORG = {
  name: 'Bounce Innovation Hub',
  details: {
    website: ORIGIN,
    description: 'Akron’s innovation hub for entrepreneurs and small businesses: programs, coworking, mentoring and event space in the former B.F. Goodrich complex downtown.',
  },
}

export const MAIN_VENUE = {
  name: 'Bounce Innovation Hub',
  details: {
    address: '526 S Main St',
    city: 'Akron', state: 'OH', zip: '44311',
    website: ORIGIN,
    parking_type: 'lot',
  },
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

// ── Pure helpers (exported for tests) ───────────────────────────────────────

const absolute = (href) => (!href ? null : /^https?:\/\//i.test(href) ? href : `${ORIGIN}${href.startsWith('/') ? '' : '/'}${href}`)

/**
 * The list page → [{ href, slug, title, label, imageUrl }], in page order,
 * one per distinct slug.
 */
export function parseList(html = '') {
  const items = []
  const seen = new Set()
  const blockRe = /<div class="item">\s*<a\s+href="(\/events\/([^"/?#]+))"[^>]*class="wrap"[^>]*>([\s\S]*?)<\/a>\s*<\/div>/gi
  for (const m of String(html).matchAll(blockRe)) {
    const [, href, slug, inner] = m
    if (seen.has(slug)) continue
    const title = htmlToText(inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '').trim()
    if (!title) continue
    seen.add(slug)
    const label = htmlToText(inner.match(/<div class="label">([\s\S]*?)<\/div>/i)?.[1] ?? '').trim()
    const img = inner.match(/<img[^>]+src="([^"]+)"/i)?.[1] ?? null
    items.push({ href, slug, title, label: label || null, imageUrl: img ? absolute(img.replace(/&amp;/g, '&')) : null })
  }
  return items
}

/**
 * A detail-page date line → { dates, startTime, endTime }, or null when no
 * date parses.
 *
 *   "Nov 18, 2026 10:00 - 11:30 AM"            one date, a range
 *   "Dec 02, 2026 10:00 AM - 11:30 AM"         both meridiems given
 *   "Feb 25, 2026, Mar 25, 2026, … Dec 23, 2026 8 AM - 5 PM"
 *                                              a recurring listing: every
 *                                              date shares the one time
 *
 * `dates` are "YYYY-MM-DD" in line order, de-duplicated. startTime / endTime
 * are "h:mm am|pm" or null.
 */
export function parseDateLine(line = '') {
  const s = htmlToText(String(line)).replace(/\s+/g, ' ').trim()
  const dateRe = /\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})\b/g
  const dates = []
  let lastEnd = 0
  for (const m of s.matchAll(dateRe)) {
    const month = MONTHS[m[1].toLowerCase()]
    const day = Number(m[2])
    if (!month || day < 1 || day > 31) continue
    const dateStr = `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    if (!dates.includes(dateStr)) dates.push(dateStr)
    lastEnd = m.index + m[0].length
  }
  if (!dates.length) return null

  // The time is whatever follows the last date.
  const rest = s.slice(lastEnd)
  const t = rest.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
    ?? rest.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i)
  if (!t) return { dates, startTime: null, endTime: null }

  const clock = (h, mi, mer) => `${Number(h)}:${mi ?? '00'} ${mer}`
  const mins = (h, mi, mer) => ((Number(h) % 12) + (mer === 'pm' ? 12 : 0)) * 60 + Number(mi ?? 0)
  if (t.length === 4) {
    return { dates, startTime: clock(t[1], t[2], t[3].toLowerCase()), endTime: null }
  }
  const endMer = t[6].toLowerCase()
  let startMer = t[3] ? t[3].toLowerCase() : endMer
  if (!t[3] && mins(t[1], t[2], startMer) >= mins(t[4], t[5], endMer)) startMer = endMer === 'pm' ? 'am' : 'pm'
  return { dates, startTime: clock(t[1], t[2], startMer), endTime: clock(t[4], t[5], endMer) }
}

/** The detail page → { dateLine, description }. */
export function parseDetail(html = '') {
  const s = String(html)
  const dateLine = s.match(/<h2[^>]*class="[^"]*sub-title[^"]*"[^>]*>[\s\S]*?<span class="date">([\s\S]*?)<\/span>/i)?.[1] ?? null
  // The body field runs to the end of the article; the article has no nested
  // <article>, so its close is a safe boundary.
  // The page's main content block. Anchored on the block id because header
  // and footer blocks carry their own field--name-body markup (menus).
  const body = s.match(/<div id="block-[a-z0-9-]+-content"[^>]*>\s*<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ?? ''
  const text = htmlToText(body).replace(/[ \t]+\n/g, '\n').trim()
  return { dateLine, description: text ? clampChars(text, MAX_DESCRIPTION) : null }
}

const ONLINE_RE = /\b(?:virtual|webinar|online|zoom)\b/i

/**
 * One list item + its detail page → { rows: [{ row, venue }] } or { skip }.
 * A recurring listing yields one row per date.
 */
export function buildRows(item, detail) {
  const when = detail?.dateLine ? parseDateLine(detail.dateLine) : null
  if (!when) return { skip: 'undatable' }

  const online = ONLINE_RE.test(item.title)
  const tags = ['bounce', 'entrepreneurship', 'akron']
  if (item.label) tags.push(item.label.toLowerCase())
  if (online) tags.push('online')
  const recurring = when.dates.length > 1

  const rows = []
  for (const dateStr of when.dates) {
    const startAt = easternToIso(dateStr, when.startTime ?? '12:00:00')
    if (!startAt) continue
    let endAt = when.endTime ? easternToIso(dateStr, when.endTime) : null
    if (endAt && Date.parse(endAt) <= Date.parse(startAt)) endAt = null
    rows.push({
      row: {
        title: item.title,
        description: detail.description,
        start_at: startAt,
        end_at: endAt,
        tags: [...new Set(tags)],
        price_min: null,
        price_max: null,
        age_restriction: 'not_specified',
        image_url: item.imageUrl,
        ticket_url: absolute(item.href),
        source: SOURCE_KEY,
        // One slug is one occurrence, except a recurring listing, where the
        // one page stands for every date on it.
        source_id: recurring ? `${item.slug}-${dateStr}` : item.slug,
        status: 'published',
        time_inferred: when.startTime ? undefined : true,
        featured: false,
      },
      venue: online ? null : MAIN_VENUE,
    })
  }
  return rows.length ? { rows } : { skip: 'undatable' }
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function fetchHtml(url, fetchImpl) {
  const res = await fetchWithRetry(url, { headers: { Accept: 'text/html' }, fetchImpl })
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`)
  return res.text()
}

export async function collect({ fetchImpl, now = Date.now, delayMs = DETAIL_DELAY_MS } = {}) {
  const items = parseList(await fetchHtml(EVENTS_URL, fetchImpl))
  const rows = []
  const skipped = {}
  const skip = (reason) => { skipped[reason] = (skipped[reason] ?? 0) + 1 }
  const earliest = now() - DAY_MS

  for (const item of items) {
    let detail
    try {
      detail = parseDetail(await fetchHtml(absolute(item.href), fetchImpl))
    } catch (err) {
      console.warn(`  ⚠ Detail page failed for "${item.title}": ${err.message}`)
      skip('detail_failed')
      continue
    }
    const built = buildRows(item, detail)
    if (built.skip) { skip(built.skip); continue }
    for (const planned of built.rows) {
      if (Date.parse(planned.row.start_at) < earliest) { skip('past'); continue }
      rows.push(planned)
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
  }
  return { found: items.length, rows, skipped }
}

export function run({ dryRun = false, fetchImpl, now, delayMs } = {}) {
  return runPlannedScraper({
    source: SOURCE_KEY,
    label: 'Bounce Innovation Hub',
    emoji: '🚀',
    org: ORG,
    homeVenue: MAIN_VENUE,
    collect: () => collect({ fetchImpl, now, delayMs }),
    dryRun,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
