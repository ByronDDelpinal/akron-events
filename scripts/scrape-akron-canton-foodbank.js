/**
 * scrape-akron-canton-foodbank.js
 *
 * Akron-Canton Regional Foodbank — the hunger-relief hub for eight counties,
 * headquartered at 350 Opportunity Pkwy in Akron. Its public events are few
 * and well known: the Selfless Elf 5k, the Harvest for Hunger kickoff, the
 * Merry Meals Mixer. None of them was on Akron Pulse.
 *
 * Source: https://www.akroncantonfoodbank.org/upcoming-events — a Drupal view,
 * server-rendered.
 *
 *   list page     <div class="item"><a href="/events/<slug>" class="wrap">
 *                   <img src="…">
 *                   <div class="text"><span class="date">Dec 19</span>
 *                     <span class="title">Selfless Elf 5k</span>
 *
 *   detail page   <h1 class="article">Selfless Elf 5k</h1>
 *                 …<span class="date">Dec 19 2026</span>
 *                 …<div class="field field--name-body …">description</div>
 *
 * Decisions:
 *   • The page publishes a DATE and no time. The time, when there is one,
 *     is in the description. lib/prose-time.js reads it only when the text
 *     states exactly one clock time; "6:30am registration, 8:00am race
 *     begins" states two, so that row keeps the sanctioned noon placeholder
 *     and is marked `time_inferred` (which adds the placeholder note and
 *     flags it for review).
 *   • The year comes from the detail page. A listing whose detail date does
 *     not parse is skipped as `undatable`, never dated from the list's
 *     year-less "Dec 19".
 *   • VENUE. The Foodbank runs events at its Akron campus, at its Canton
 *     campus and at rented halls in both counties. Stark County is out of
 *     scope. The venue is asserted only when the description spells out a
 *     place with its street address (lib/prose-venue.js) or names the Akron
 *     campus. A place in Canton, or a text naming only the Stark County
 *     campus, is skipped as out of county. Anything else is published
 *     without a venue and flagged for review: a wrong pin is worse than no
 *     pin.
 *   • Every row is a fundraiser or a volunteer drive for the Foodbank, so
 *     `is_fundraiser` is set.
 *   • source_id is the URL slug plus the year: the Foodbank reuses a slug for
 *     an annual event ("selfless-elf-5k") and next year's must be a new row.
 *   • A low-volume source by nature: three listings is a normal night, zero
 *     is not.
 *
 * Usage:   node scripts/scrape-akron-canton-foodbank.js [--dry-run]
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

export const SOURCE_KEY = 'akron_canton_foodbank'
const ORIGIN = 'https://www.akroncantonfoodbank.org'
const EVENTS_URL = `${ORIGIN}/upcoming-events`
const MAX_DESCRIPTION = 4000
const DETAIL_DELAY_MS = 250
const DAY_MS = 86_400_000

const ORG = {
  name: 'Akron-Canton Regional Foodbank',
  details: {
    website: ORIGIN,
    description: 'The Akron-Canton Regional Foodbank distributes food to hunger-relief programs across eight Northeast Ohio counties from its Akron and Canton campuses.',
  },
}

export const MAIN_VENUE = {
  name: 'Akron-Canton Regional Foodbank',
  details: {
    address: '350 Opportunity Pkwy',
    city: 'Akron', state: 'OH', zip: '44307',
    website: ORIGIN,
    parking_type: 'lot',
  },
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

// ── Pure helpers (exported for tests) ───────────────────────────────────────

const absolute = (href) => (!href ? null : /^https?:\/\//i.test(href) ? href : `${ORIGIN}${href.startsWith('/') ? '' : '/'}${href}`)

/** The list page → [{ href, slug, title, imageUrl }], one per distinct slug. */
export function parseList(html = '') {
  const items = []
  const seen = new Set()
  const blockRe = /<div class="item">\s*<a\s+href="(\/events\/([^"/?#]+))"[^>]*class="wrap"[^>]*>([\s\S]*?)<\/a>\s*<\/div>/gi
  for (const m of String(html).matchAll(blockRe)) {
    const [, href, slug, inner] = m
    if (seen.has(slug)) continue
    const title = htmlToText(inner.match(/<span class="title">([\s\S]*?)<\/span>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim()
    if (!title) continue
    seen.add(slug)
    const img = inner.match(/<img[^>]+src="([^"]+)"/i)?.[1] ?? null
    items.push({ href, slug, title, imageUrl: img ? absolute(img.replace(/&amp;/g, '&')) : null })
  }
  return items
}

/** "Dec 19 2026" or "Dec 19, 2026" → "2026-12-19", else null. */
export function parseDetailDate(text = '') {
  const m = htmlToText(String(text)).replace(/\s+/g, ' ').trim().match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/)
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  const day = Number(m[2])
  if (!month || day < 1 || day > 31) return null
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** The detail page → { dateStr, description }. */
export function parseDetail(html = '') {
  const s = String(html)
  const dateText = s.match(/<div[^>]*class="[^"]*event-date[^"]*"[\s\S]*?<span class="date">([\s\S]*?)<\/span>/i)?.[1] ?? null
  // The page's main content block. Anchored on the block id because header
  // and footer blocks carry their own field--name-body markup (menus).
  const body = s.match(/<div id="block-[a-z0-9-]+-content"[^>]*>\s*<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ?? ''
  const text = htmlToText(body).replace(/[ \t]+\n/g, '\n').trim()
  return {
    dateStr: dateText ? parseDetailDate(dateText) : null,
    description: text ? clampChars(text, MAX_DESCRIPTION) : null,
  }
}

const STARK_RE = /\bstark county campus\b|\bcanton campus\b|\bcanton,\s*(?:oh|ohio)\b/i
const AKRON_CAMPUS_RE = /\b350\s+opportunity\b|\bakron campus\b|\bat (?:the|your) akron-canton regional foodbank\b/i

/**
 * Where an event is, from its description.
 *
 *   1. A place the description spells out with a street address ("John S.
 *      Knight Center, 77 E. Mill Street, Akron") is where it is. A city known
 *      to be outside Summit County ("…4125 Mahoning Road NE, Canton") drops
 *      the row; an unrecognized city keeps the venue and flags the row.
 *   2. Otherwise the Akron campus, if the text names it; a text that names
 *      only the Stark County campus drops the row.
 *   3. Otherwise no venue, flagged for review.
 * @returns {{venue: object|null, needsReview?: boolean, drop?: boolean}}
 */
export function resolveVenue(description = '') {
  const text = String(description ?? '')
  const stated = findAddressedVenue(text)
  // The Foodbank's own address, written out: the one canonical record.
  if (stated && /\b350\s+opportunity\b/i.test(stated.address)) return { venue: MAIN_VENUE }
  if (stated) {
    const where = classifySummitLocation({ city: stated.city })
    if (where === 'out') return { venue: null, drop: true }
    return {
      venue: { name: stated.name, details: { address: stated.address, city: stated.city, state: 'OH' } },
      needsReview: where === 'unknown' ? true : undefined,
    }
  }
  const akron = AKRON_CAMPUS_RE.test(text)
  if (STARK_RE.test(text) && !akron) return { venue: null, drop: true }
  if (akron) return { venue: MAIN_VENUE }
  return { venue: null, needsReview: true }
}

/** One list item + its detail page → { row, venue } or { skip }. */
export function buildRow(item, detail) {
  if (!detail?.dateStr) return { skip: 'undatable' }
  const { venue, needsReview, drop } = resolveVenue(detail.description)
  if (drop) return { skip: 'out_of_county' }

  const time = proseTime(detail.description)
  const startAt = easternToIso(detail.dateStr, time?.startTime ?? '12:00:00')
  if (!startAt) return { skip: 'undatable' }
  let endAt = time?.endTime ? easternToIso(detail.dateStr, time.endTime) : null
  if (endAt && Date.parse(endAt) <= Date.parse(startAt)) endAt = null

  return {
    row: {
      title: item.title,
      description: detail.description,
      start_at: startAt,
      end_at: endAt,
      is_fundraiser: true,
      tags: ['foodbank', 'hunger-relief', 'fundraiser', 'akron'],
      price_min: null,
      price_max: null,
      age_restriction: 'not_specified',
      image_url: item.imageUrl,
      ticket_url: absolute(item.href),
      source: SOURCE_KEY,
      source_id: `${item.slug}-${detail.dateStr.slice(0, 4)}`,
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
    label: 'Akron-Canton Regional Foodbank',
    emoji: '🥫',
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
