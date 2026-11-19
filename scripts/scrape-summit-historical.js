/**
 * scrape-summit-historical.js
 *
 * The Summit County Historical Society of Akron, Ohio — steward of the Perkins
 * Stone Mansion and the John Brown House on Copley Road. Its calendar carries
 * lectures (the John Brown Institute series), the Simple Gifts holiday tours,
 * open houses and society events.
 *
 * Source: https://www.summithistory.org/events — Drupal 7, server-rendered.
 *
 *   list page     <div class="news-event-item">
 *                   <a href="/events/<slug>" class="content-wrap">
 *                     <span property="dc:date" content="2026-11-21T00:00:00-05:00" …>Nov</span>
 *                     <span class="info">Members Only Holiday Open House</span>
 *
 *   detail page   <div class="field-title"><h2>Title</h2></div>
 *                 <div class="date-txt"><span property="dc:date" content="…">Nov 21, 2026</span></div>
 *                 <div class="field-body">description</div>
 *
 * Decisions:
 *   • The machine-readable `content` date on the list is used as the date. It
 *     is always midnight: the site records a day, not a time.
 *   • The time, when there is one, is in the description ("Saturday,
 *     November 21st from 12-3 p.m."). lib/prose-time.js reads it when the
 *     text states exactly one clock time, or a list of tour slots ("tours at
 *     1 p.m., 2 p.m. and 3 p.m." → the first slot). Otherwise the row keeps
 *     the sanctioned noon placeholder and is marked `time_inferred`.
 *   • MEMBERS-ONLY events are skipped. Akron Pulse lists what the public can
 *     attend.
 *   • VENUE. The Society programs at its two houses and at borrowed rooms
 *     around town. A venue is asserted only when the description spells out
 *     a place with its street address (lib/prose-venue.js) or names one of
 *     the Society's own sites; anything else is published without a venue
 *     and flagged for review rather than pinned to the mansion by default.
 *   • One listing can be a multi-week run announced by its first day ("Simple
 *     Gifts Holiday Tours Start"). It is listed as the Society lists it: one
 *     row on that date.
 *   • source_id is the URL slug. Drupal makes these unique per node
 *     ("simple-gifts-holiday-tour-0").
 *
 * Usage:   node scripts/scrape-summit-historical.js [--dry-run]
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (not needed for --dry-run)
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { htmlToText, clampChars, easternToIso } from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'
import { proseTime } from './lib/prose-time.js'
import { findAddressedVenue } from './lib/prose-venue.js'
import { classifySummitLocation } from './lib/summit-county.js'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'

export const SOURCE_KEY = 'summit_historical'
const ORIGIN = 'https://www.summithistory.org'
const EVENTS_URL = `${ORIGIN}/events`
const MAX_DESCRIPTION = 4000
const DETAIL_DELAY_MS = 250
const DAY_MS = 86_400_000

const ORG = {
  name: 'Summit County Historical Society',
  details: {
    website: ORIGIN,
    description: 'The Summit County Historical Society of Akron, Ohio preserves and interprets the county’s history at the Perkins Stone Mansion and the John Brown House.',
  },
}

export const PERKINS_MANSION = {
  name: 'Perkins Stone Mansion',
  details: {
    address: '550 Copley Rd',
    city: 'Akron', state: 'OH', zip: '44320',
    website: ORIGIN,
    parking_type: 'lot',
  },
}

export const JOHN_BROWN_HOUSE = {
  name: 'John Brown House',
  details: {
    address: '514 Diagonal Rd',
    city: 'Akron', state: 'OH', zip: '44320',
    website: ORIGIN,
    parking_type: 'lot',
  },
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

const absolute = (href) => (!href ? null : /^https?:\/\//i.test(href) ? href : `${ORIGIN}${href.startsWith('/') ? '' : '/'}${href}`)

/**
 * The list page → [{ href, slug, title, dateStr }], one per distinct slug.
 * `dateStr` is the calendar day from the dc:date `content` attribute.
 */
export function parseList(html = '') {
  const items = []
  const seen = new Set()
  const blockRe = /<div class="news-event-item">\s*<a\s+href="(\/events\/([^"/?#]+))"[^>]*>([\s\S]*?)<\/a>/gi
  for (const m of String(html).matchAll(blockRe)) {
    const [, href, slug, inner] = m
    if (seen.has(slug)) continue
    const title = htmlToText(inner.match(/<span class="info">([\s\S]*?)<\/span>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim()
    const dateStr = inner.match(/property="dc:date"[^>]*content="(\d{4}-\d{2}-\d{2})T/i)?.[1] ?? null
    if (!title || !dateStr) continue
    seen.add(slug)
    items.push({ href, slug, title, dateStr })
  }
  return items
}

/** The detail page → { description, imageUrl }. */
export function parseDetail(html = '') {
  const s = String(html)
  // field-body is the last block inside the event node; the node's wrapper
  // closes before the page's sidebar/footer, which start with an id.
  const body = s.match(/<div class="field-body">([\s\S]*?)<\/div>\s*<\/div>/i)?.[1] ?? ''
  const text = htmlToText(body).replace(/[ \t]+\n/g, '\n').trim()
  const img = body.match(/<img[^>]+src="([^"]+)"/i)?.[1] ?? null
  return {
    description: text ? clampChars(text, MAX_DESCRIPTION) : null,
    imageUrl: img ? absolute(img.replace(/&amp;/g, '&')) : null,
  }
}

/** True for an event the public cannot attend. */
export function isMembersOnly(title = '') {
  return /\bmembers?[\s-]+only\b/i.test(String(title))
}

/**
 * Where an event is, from its title and description.
 *
 *   1. A place the description spells out ("…at the City of Joy Enrichment
 *      Center, 610 W. Exchange Street, Akron") is where it is, even when the
 *      text also mentions the mansion in passing. A city known to be outside
 *      Summit County drops the row; an unrecognized city keeps the venue and
 *      flags the row.
 *   2. Otherwise one of the Society's own houses, if named. The mansion wins
 *      when both are: it is where visitors start.
 *   3. Otherwise no venue, flagged for review.
 * @returns {{venue: object|null, needsReview?: boolean, drop?: boolean}}
 */
export function resolveVenue(title = '', description = '') {
  const text = `${title}\n${description ?? ''}`
  const stated = findAddressedVenue(description)
  if (stated) {
    const where = classifySummitLocation({ city: stated.city })
    if (where === 'out') return { venue: null, drop: true }
    return {
      venue: { name: stated.name, details: { address: stated.address, city: stated.city, state: 'OH' } },
      needsReview: where === 'unknown' ? true : undefined,
    }
  }
  if (/\bperkins\b[^.\n]{0,40}\bmansion\b|\bperkins stone mansion\b|\b550 copley\b/i.test(text)) return { venue: PERKINS_MANSION }
  if (/\bjohn brown house\b|\b514 diagonal\b/i.test(text)) return { venue: JOHN_BROWN_HOUSE }
  return { venue: null, needsReview: true }
}

/** One list item + its detail page → { row, venue } or { skip }. */
export function buildRow(item, detail = {}) {
  if (isMembersOnly(item.title)) return { skip: 'members_only' }

  // The Society's multi-time listings are tour slots ("tours at 1 p.m.,
  // 2 p.m. and 3 p.m."): the first slot is when a visitor can first turn up.
  const time = proseTime(detail.description, { earliestOfSlots: true })
  const startAt = easternToIso(item.dateStr, time?.startTime ?? '12:00:00')
  if (!startAt) return { skip: 'undatable' }
  let endAt = time?.endTime ? easternToIso(item.dateStr, time.endTime) : null
  if (endAt && Date.parse(endAt) <= Date.parse(startAt)) endAt = null

  const { venue, needsReview, drop } = resolveVenue(item.title, detail.description)
  if (drop) return { skip: 'out_of_county' }

  return {
    row: {
      title: item.title,
      description: detail.description ?? null,
      start_at: startAt,
      end_at: endAt,
      tags: ['history', 'summit-county-historical-society', 'akron'],
      price_min: null,
      price_max: null,
      age_restriction: 'not_specified',
      image_url: detail.imageUrl ?? null,
      ticket_url: absolute(item.href),
      source: SOURCE_KEY,
      source_id: item.slug,
      status: 'published',
      time_inferred: time ? undefined : true,
      needs_review: needsReview ? true : undefined,
      featured: false,
    },
    venue,
  }
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
  // Whole-day comparison: a listing dated today is still on today.
  const earliest = now() - DAY_MS

  for (const item of items) {
    if (isMembersOnly(item.title)) { skip('members_only'); continue }
    if (Date.parse(`${item.dateStr}T23:59:59-05:00`) < earliest) { skip('past'); continue }
    let detail
    try {
      detail = parseDetail(await fetchHtml(absolute(item.href), fetchImpl))
    } catch (err) {
      console.warn(`  ⚠ Detail page failed for "${item.title}": ${err.message}`)
      skip('detail_failed')
      continue
    }
    const built = buildRow(item, detail)
    if (built.skip) { skip(built.skip); continue }
    if (Date.parse(built.row.start_at) < earliest) { skip('past'); continue }
    rows.push(built)
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
  }
  return { found: items.length, rows, skipped }
}

export function run({ dryRun = false, fetchImpl, now, delayMs } = {}) {
  return runPlannedScraper({
    source: SOURCE_KEY,
    label: 'Summit County Historical Society',
    emoji: '🏛️',
    org: ORG,
    homeVenue: PERKINS_MANSION,
    collect: () => collect({ fetchImpl, now, delayMs }),
    dryRun,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
