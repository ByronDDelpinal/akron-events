/**
 * scrape-rock-mill.js
 *
 * Rock Mill Climbing — indoor climbing gym, yoga studio and coffee bar in
 * downtown Akron (677 Carroll St, Akron, OH 44304 — Summit County). One fixed
 * venue; every event here happens on-site.
 *
 * Platform: Webflow. The "Happening Now" page (/happening-now) renders a
 * Webflow CMS collection whose items are baked into the static HTML as
 * `role="listitem" class="w-dyn-item"` blocks (a plain `fetch().text()` returns
 * the full markup — no JS execution needed). Each item carries a consistent
 * shape:
 *   • .tagline_text            — the schedule line ("Saturday, July 18 | 5-8 PM",
 *                                "Wednesdays | 9:00 AM - Noon", "First Friday of
 *                                the month", …)
 *   • h2[blocks-name=heading-2]— the title
 *   • .happening-now-rich-text — an HTML description
 *   • .event12_image-wrapper img — the card image
 *   • .button-group a          — a "Sign Up"/"Register" CTA (a second, empty
 *                                button carries class w-dyn-bind-empty)
 *
 * Event model: the tagline is the ONLY schedule signal, and it comes in three
 * shapes — one-time ("Weekday, Month Day [| time]"), weekly ("Weekday[s] &
 * Weekday[s] | time range"), and monthly/promotional ("First Friday of the
 * month", "The first weekend of every month"). We parse the first two into
 * concrete, time-stamped occurrences; weekly cadences are generated forward via
 * lib/weekly-occurrences.js (Eastern-anchored, immune to the UTC-rollover
 * footgun). MONTHLY / promotional cards carry NO time anywhere (verified on
 * their detail pages too), so — per the no-silent-midnight mandate — they are
 * skipped rather than pinned to 00:00. That rule also naturally drops the Beta
 * Blog card (no date) and the "Youth Climbing Club" series (a registration-only
 * program listed with a month window but no time). A one-time card missing a
 * tagline time falls back to a time range parsed from its description prose
 * (e.g. Rock the Mill Fest's "Vendors 11:30-5 PM / Musicians 5-8 PM") before it
 * would ever be skipped.
 *
 * Categories: climbing comps / clinics / yoga / open-climb → fitness; a
 * festival card → festival; anything else defers to text inference. Prices are
 * left null — the descriptions state discounts ("$2 off", "$5 off day passes")
 * and per-child rates, not a single admission price, so parsing them would be
 * misleading. source_ids are slug+date keyed so the twice-daily run is
 * idempotent and an annually-recurring comp gets a fresh row each year.
 *
 * The markup is Webflow div soup, so descriptions are extracted from the
 * .w-richtext block and run through htmlToText (paragraph-preserving). Fixture
 * captured from the live raw source (fetch().text(), not the rendered DOM) on
 * 2026-07-14.
 *
 * Usage:   node scripts/scrape-rock-mill.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, easternToIso, htmlToText,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'
import { WEEKDAY, nextWeeklyOccurrences, easternTodayYmd } from './lib/weekly-occurrences.js'

export const SOURCE_KEY = 'rock_mill'
const PAGE_URL = 'https://www.rockmillclimbing.com/happening-now'
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

const ORG_NAME   = 'Rock Mill Climbing'
const VENUE_NAME = 'Rock Mill Climbing'
const VENUE_DETAILS = {
  address: '677 Carroll St',
  city: 'Akron', state: 'OH', zip: '44304',
  lat: 41.077, lng: -81.508,
  website: 'https://www.rockmillclimbing.com',
  description: 'Indoor climbing gym, bouldering, yoga and fitness studio, and the Basecamp coffee bar in downtown Akron.',
}

// How many weekly occurrences to generate per standing schedule (~3 months).
const OCCURRENCE_COUNT = 12

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}
const MONTH_ALT = Object.keys(MONTHS).join('|')
const WEEKDAY_ALT = Object.keys(WEEKDAY).join('|')

// Non-breaking / narrow-no-break spaces some CMS text carries; folded to a
// normal space so the time/date regexes below match. Escapes (not literals)
// keep the source free of irregular whitespace.
const NBSP_RE = /[\u00a0\u2007\u202f]/g

// Cancelled/postponed items name it in the title ("Bouldering Sucks \u2014 CANCELED").
// Same title convention lib/civicplus.js uses \u2014 drop rather than publish.
const CANCELLED_RE = /\bcancell?ed\b|\bpostponed\b/i

// ── Pure parsers (exported for tests) ───────────────────────────────────────

/** URL-safe slug from a title, for stable source_ids. */
export function slugify(text = '') {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Drop a promotional "Call for Vendors | " (etc.) prefix so the public title is
 *  the event's real name. Only fires on known recruitment prefixes. */
export function cleanTitle(title = '') {
  const m = String(title).match(/^(?:call for vendors|vendors wanted|now hiring)\s*\|\s*(.+)$/i)
  return (m ? m[1] : String(title)).trim()
}

/**
 * Parse each Webflow CMS collection item out of the raw page HTML.
 * Returns [{ tagline, title, description, imageUrl, ctaUrl }].
 */
export function parseItems(html = '') {
  const blocks = String(html).split('role="listitem" class="w-dyn-item"').slice(1)
  const items = []
  for (const block of blocks) {
    const tagline = matchText(block, /tagline_text">([^<]*)</)
    const title   = matchText(block, /blocks-name="heading-2"[^>]*>([^<]*)</)
    if (!title) continue
    const richMatch = block.match(/w-richtext">([\s\S]*?)<\/div>/)
    const description = richMatch ? htmlToText(richMatch[1]) : ''
    const imageUrl = matchAttr(block, /<img\b[^>]*\bsrc="([^"]+)"/)
    // First real CTA link: a button that isn't the empty "#" bind placeholder.
    let ctaUrl = null
    const linkRe = /<a\b[^>]*href="([^"]+)"[^>]*class="button[^"]*w-button"/g
    let lm
    while ((lm = linkRe.exec(block)) !== null) {
      const href = decodeAmp(lm[1])
      if (href && href !== '#' && !/w-dyn-bind-empty/.test(lm[0])) { ctaUrl = href; break }
    }
    items.push({ tagline, title, description, imageUrl, ctaUrl })
  }
  return items
}

function matchText(block, re) {
  const m = block.match(re)
  return m ? decodeAmp(m[1]).replace(/\s+/g, ' ').trim() : null
}
function matchAttr(block, re) {
  const m = block.match(re)
  return m ? decodeAmp(m[1]) : null
}
function decodeAmp(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&#38;/g, '&')
}

/** Parse a single clock token ("5", "9:00 am", "11:30", "noon") into
 *  { hour, minute, mer } where mer is 'am' | 'pm' | null. Returns null if no
 *  numeric time is present. */
function parseClock(raw) {
  const s = String(raw).trim().toLowerCase()
  if (/^noon$/.test(s)) return { hour: 12, minute: 0, mer: 'pm' }
  if (/^midnight$/.test(s)) return { hour: 12, minute: 0, mer: 'am' }
  const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/)
  if (!m) return null
  const hour = parseInt(m[1], 10)
  if (Number.isNaN(hour)) return null
  const minute = m[2] != null ? parseInt(m[2], 10) : 0
  const mer = m[3] ? (/^p/.test(m[3]) ? 'pm' : 'am') : null
  return { hour, minute, mer }
}

/** Format a resolved clock into the "h:mm am/pm" string easternToIso wants. */
function fmtClock(c) {
  return `${c.hour}:${String(c.minute).padStart(2, '0')} ${c.mer}`
}

/**
 * Parse a time RANGE ("5-8 PM", "9:00 AM - Noon", "9:00 - 11:00 AM", "11:30-5
 * PM") into { start, end } as "h:mm am/pm" strings, resolving meridiems:
 *   • an end meridiem propagates to a bare start ("5-8 PM" → 5 pm / 8 pm), UNLESS
 *     the start hour is numerically later than a PM end hour, in which case the
 *     start is morning ("11:30-5 PM" → 11:30 am / 5 pm);
 *   • a start meridiem propagates forward to a bare end ("9:00 AM - Noon" is
 *     explicit; "9-11 AM" → end inherits am).
 * A single time (no dash) yields { start, end: null }. Returns null when no
 * numeric time is present (e.g. "September - November 2026", a month window).
 */
export function parseTimeRange(text = '') {
  const s = String(text).toLowerCase().replace(NBSP_RE, ' ')
  const rangeRe = /(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon|midnight)\s*(?:[-–—]+|to)\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon|midnight)/
  const rm = s.match(rangeRe)
  if (rm) {
    const start = parseClock(rm[1])
    const end = parseClock(rm[2])
    if (!start || !end) return null
    resolveMeridiems(start, end)
    if (!start.mer || !end.mer) return null
    return { start: fmtClock(start), end: fmtClock(end) }
  }
  // Single time.
  const single = s.match(/(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|noon|midnight)/)
  if (single) {
    const c = parseClock(single[1])
    if (c && c.mer) return { start: fmtClock(c), end: null }
  }
  return null
}

/** Fill in missing am/pm on a start/end pair (mutates in place). */
function resolveMeridiems(start, end) {
  if (!start.mer && end.mer) {
    if (end.mer === 'pm') {
      // Assume the bare start is also PM, then sanity-check the ordering: if a
      // PM start would land at or after the PM end, the range must actually
      // open in the morning. This is anchored in minutes (not a raw hour
      // compare) so it stays correct at the noon boundary:
      //   "11:30-5 PM" → 11:30 am   "9-12 PM" → 9 am (morning → noon)
      //   "5-8 PM"     → 5 pm       "12-5 PM" → 12 pm (noon start)
      const toMin = (h, m) => (h % 12) * 60 + m + 720 // minutes since midnight, PM
      start.mer = toMin(start.hour, start.minute) >= toMin(end.hour, end.minute) ? 'am' : 'pm'
    } else {
      start.mer = end.mer
    }
  }
  if (start.mer && !end.mer) end.mer = start.mer
}

/** Scan a description for the widest time window across all ranges it mentions.
 *  Used only as the fallback when a one-time card's tagline omits the time. */
export function parseTimesFromText(text = '') {
  const found = []
  const re = /(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon)\s*(?:[-–—]+|to)\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon)/gi
  let m
  while ((m = re.exec(String(text).replace(NBSP_RE, ' '))) !== null) {
    const r = parseTimeRange(m[0])
    if (r) found.push(r)
  }
  if (!found.length) return null
  const toMin = (t) => { const c = parseClock(t); return (c.hour % 12) * 60 + c.minute + (c.mer === 'pm' ? 720 : 0) }
  let start = found[0].start, end = found[0].end
  for (const r of found) {
    if (toMin(r.start) < toMin(start)) start = r.start
    if (r.end && (!end || toMin(r.end) > toMin(end))) end = r.end
  }
  return { start, end }
}

/**
 * Year inference for a month/day-only date: current Eastern year, rolled
 * forward when the date would sit >45 days in the past.
 */
function inferYmd(month, day, now) {
  const [y, m, d] = easternTodayYmd(now).split('-').map(Number)
  const todayMs = Date.UTC(y, m - 1, d)
  let year = y
  if (Date.UTC(year, month - 1, day) < todayMs - 45 * 86400_000) year += 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Content category hint from the title/description; undefined → defer to
 *  text inference. */
function categoryFor(title, description) {
  const t = `${title} ${description}`.toLowerCase()
  if (/\bfest(ival)?\b/.test(t)) return 'festival'
  if (/\b(comp(etition)?|clinic|yoga|boulder|climb)/.test(t)) return 'fitness'
  return undefined
}

/** Family-audience flag from the title/description. */
function familyFor(title, description) {
  return /\b(youth|kids?|child(ren)?|family|families|homeschool)\b/i.test(`${title} ${description}`)
}

/**
 * Turn one parsed CMS item into zero or more time-stamped event occurrences.
 * Returns [{ title, description, startIso, endIso, ymd, sourceId, category,
 * isFamily, imageUrl, ctaUrl }].
 */
export function buildItemEvents(item, now = new Date()) {
  const title = cleanTitle(item.title)
  const description = item.description || ''
  // Skip a cancelled/postponed item rather than generating occurrences for it.
  if (CANCELLED_RE.test(title) || CANCELLED_RE.test(item.tagline || '')) return []
  const category = categoryFor(title, description)
  const isFamily = familyFor(title, description)
  const baseSlug = slugify(title)
  const mk = (ymd, range) => ({
    title,
    description,
    startIso: easternToIso(ymd, range.start),
    endIso: range.end ? easternToIso(ymd, range.end) : null,
    ymd,
    sourceId: `${baseSlug}-${ymd}`,
    category,
    isFamily,
    imageUrl: item.imageUrl,
    ctaUrl: item.ctaUrl,
  })

  const tagline = (item.tagline || '').replace(NBSP_RE, ' ').trim()
  if (!tagline) return []

  // ── One-time: "Weekday, Month Day [| time]" ───────────────────────────────
  const oneTime = tagline.match(
    new RegExp(`^(?:${WEEKDAY_ALT}),\\s+(${MONTH_ALT})\\s+(\\d{1,2})(?:\\s*\\|\\s*(.+))?$`, 'i'),
  )
  if (oneTime) {
    const ymd = inferYmd(MONTHS[oneTime[1].toLowerCase()], Number(oneTime[2]), now)
    const range = (oneTime[3] && parseTimeRange(oneTime[3])) || parseTimesFromText(description)
    if (!range) return [] // no resolvable time anywhere → skip, never midnight
    return [mk(ymd, range)]
  }

  // ── Weekly: "Weekday[s][ & Weekday[s]] | time range" ──────────────────────
  const weekly = tagline.match(
    new RegExp(`^(${WEEKDAY_ALT})s(?:\\s*&\\s*(${WEEKDAY_ALT})s)?\\s*\\|\\s*(.+)$`, 'i'),
  )
  if (weekly) {
    const range = parseTimeRange(weekly[3])
    if (!range) return [] // e.g. "Mondays & Thursdays | September - November 2026"
    const days = [weekly[1], weekly[2]].filter(Boolean).map((w) => WEEKDAY[w.toLowerCase()])
    const ymds = new Set()
    for (const dow of days) {
      for (const ymd of nextWeeklyOccurrences(dow, { count: OCCURRENCE_COUNT, now })) ymds.add(ymd)
    }
    return [...ymds].sort().map((ymd) => mk(ymd, range))
  }

  // Monthly ("First Friday of the month"), promotional, or undated (blog):
  // no reliable per-date time — skip.
  return []
}

/** Assemble the full run across every parsed item, sorted by start date. */
export function buildEvents(html, now = new Date()) {
  return parseItems(html)
    .flatMap((item) => buildItemEvents(item, now))
    .sort((a, b) => (a.startIso || '').localeCompare(b.startIso || ''))
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🧗  Starting Rock Mill Climbing ingestion…')
  const start = Date.now()
  try {
    const [organizerId, venueId] = await Promise.all([
      ensureOrganization(ORG_NAME, {
        website: VENUE_DETAILS.website,
        description: VENUE_DETAILS.description,
      }),
      ensureVenue(VENUE_NAME, VENUE_DETAILS),
    ])
    await linkOrganizationVenue(organizerId, venueId)

    const events = buildEvents(await fetchPage(PAGE_URL))
    console.log(`  ${PAGE_URL} → ${events.length} event occurrences`)

    let inserted = 0, updated = 0, skipped = 0
    for (const ev of events) {
      if (!ev.startIso || Date.parse(ev.startIso) < Date.now() - 3 * 3600_000) { skipped++; continue }
      const isForm = /docs\.google\.com|forms\.gle/.test(ev.ctaUrl || '')
      const detailUrl = (ev.ctaUrl && !isForm)
        ? ev.ctaUrl.replace(/^http:\/\/www\.rockmillclimbing/, 'https://www.rockmillclimbing')
        : PAGE_URL
      const row = {
        title:       ev.title,
        description: ev.description,
        start_at:    ev.startIso,
        end_at:      ev.endIso,
        category:    ev.category,           // undefined → text inference decides
        is_family:   ev.isFamily || undefined,
        tags:        ['climbing', 'rock mill'],
        price_min:   null,                  // descriptions state discounts, not admission
        price_max:   null,
        image_url:   ev.imageUrl || null,
        ticket_url:  (ev.ctaUrl && !isForm) ? detailUrl : null,
        source_url:  detailUrl,
        source:      SOURCE_KEY,
        source_id:   ev.sourceId,
        status:      'published',
        featured:    false,
      }
      const { data: upserted, error, isNew } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) {
        console.warn(`  ⚠ Upsert failed "${row.title}" (${ev.ymd}):`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        if (isNew) inserted++; else updated++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, updated, skipped, {
      eventsFound: events.length, durationMs: Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${updated} updated, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
