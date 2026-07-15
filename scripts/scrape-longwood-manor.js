/**
 * scrape-longwood-manor.js
 *
 * Longwood Manor Historical Society — the volunteer group that stewards the
 * historic Longwood Manor house inside Longwood Park, 1566 East Aurora Road,
 * Macedonia, OH 44056 (Summit County). They run a small public calendar:
 * monthly open-house tours, an annual Ladies Tea, and a summer band concert on
 * the park lawn.
 *
 * Platform: GoDaddy "Websites + Marketing" (AIRO) static HTML — longwoodmanor.org.
 * There is NO calendar widget here (unlike the GoDaddy CALENDAR_EVENT data-aid
 * cards scrape-the-grove.js parses) and no feed/JSON-LD. Events live in a plain
 * GoDaddy "About" section titled "Upcoming Events": each event is an
 * ABOUT_HEADLINE_RENDERED{n} (title) + ABOUT_DESCRIPTION_RENDERED{n} (free-prose
 * body with the date/time written out) + ABOUT_IMAGE_RENDERED{n} (photo). Dates
 * and times are ONLY in the prose, so we parse them out:
 *   "Saturday, May 2, 2026"                       → date, no time
 *   "Thursday, July 15, 2026 at 7PM"              → date + time
 *   "…start on April 26, 2026 from 1-4 PM …last   → recurring monthly series
 *    Sunday of the month from April to October."     (last Sunday, Apr–Oct)
 *
 * The page carries a SECOND About section titled "Longwood Manor Historical
 * Society Meetings" (membership meetings, workdays) — internal org business, not
 * public events — so we scope strictly to the section titled "Upcoming Events".
 *
 * Each ABOUT_*_RENDERED{n} data-aid is emitted twice (desktop + mobile copies);
 * we take the first occurrence of each index, which dedupes naturally.
 *
 * Dates/times: easternToIso (Eastern-anchored). A timed event carries its clock
 * time; a date-only event (e.g. the Ladies Tea, whose page says only "Watch for
 * more information") becomes a midnight-ET row flagged needs_review — we never
 * silently synthesize a clock time. The recurring open-house series is expanded
 * from its stated rule (last <weekday> of each month across a month range),
 * anchored to the year printed in the prose, so re-scrapes follow if it changes.
 *
 * Venue: fixed — Longwood Manor, 1566 East Aurora Road, Macedonia (Summit
 * County), so rows publish directly (no classifySummitLocation needed). We reuse
 * the venue name/address the city_of_macedonia scraper already uses for this
 * park so ensureVenue dedupes against the canonical venue; the city calendar and
 * this society calendar overlap on some park events and downstream
 * dedupe/suppression reconciles them.
 *
 * Prices: left NULL — the site states none, and we never assume free.
 *
 * Usage:   node scripts/scrape-longwood-manor.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, easternToIso, stripHtml, htmlToText,
  titleCaseIfShouting, inferCategory, enrichWithImageDimensions, upsertEventSafe,
  ensureVenue, ensureOrganization, linkEventVenue, linkEventOrganization,
  linkOrganizationVenue,
} from './lib/normalize.js'

export const SOURCE_KEY = 'longwood_manor'
const EVENTS_URL = 'https://longwoodmanor.org/events'
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

const ORG_NAME = 'Longwood Manor Historical Society'
const ORG_DETAILS = {
  website: 'https://longwoodmanor.org',
  description:
    'Volunteer historical society that stewards the historic Longwood Manor in ' +
    "Macedonia's Longwood Park, hosting public open-house tours, an annual " +
    'Ladies Tea, and a summer band concert on the park lawn.',
}

// Fixed venue. Name/address mirror the city_of_macedonia scraper so ensureVenue
// resolves both calendars to the same canonical park venue by address.
const VENUE_NAME = 'Longwood Manor'
const VENUE_DETAILS = {
  address: '1566 East Aurora Road',
  city: 'Macedonia', state: 'OH', zip: '44056',
  website: 'https://www.macrec.com/facilities/longwood-manor',
  description:
    'Historic house museum inside Longwood Park in Macedonia (Summit County), ' +
    'operated by the Longwood Manor Historical Society.',
}

// ── Small text helpers ───────────────────────────────────────────────────────

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
}
const MONTH_ALT = Object.keys(MONTHS).join('|')

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}
const ORDINALS = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, last: -1 }

// A cancelled/postponed event names it in the headline or prose. Same title
// convention lib/civicplus.js uses — drop rather than publish.
const CANCELLED_RE = /\bcancell?ed\b|\bpostponed\b/i

/** Lowercase, hyphen-joined slug fragment. */
export function slugify(text) {
  return String(text || '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * Clean a headline into a display title. GoDaddy headlines are often all-caps
 * ("OPEN HOUSES", "BAND CONCERT"). titleCaseIfShouting only de-shouts titles
 * longer than 25 chars (to protect acronyms), so for a SHORT all-caps multi-word
 * headline we title-case it here (single all-caps words are left alone in case
 * they are an acronym).
 */
export function cleanTitle(raw) {
  const t = stripHtml(String(raw || '')).trim()
  if (!t) return t
  const isAllCaps = !/[a-z]/.test(t) && /[A-Z]/.test(t)
  const multiWord = /\s/.test(t.trim())
  if (isAllCaps && multiWord) {
    return t.toLowerCase().replace(/\b([a-z])/g, (_m, c) => c.toUpperCase())
  }
  return titleCaseIfShouting(t)
}

// ── Time parsing ─────────────────────────────────────────────────────────────

/** hour/min/meridiem → "HH:MM" 24-hour, or null if out of range. */
export function to24h(hourStr, minStr, ampm) {
  let hour = parseInt(hourStr, 10)
  if (Number.isNaN(hour) || hour > 23) return null
  const minute = minStr != null ? minStr : '00'
  if (ampm) {
    const isPm = /^p/i.test(ampm.replace(/\./g, ''))
    if (isPm && hour !== 12) hour += 12
    if (!isPm && hour === 12) hour = 0
  }
  if (hour > 23) return null
  return `${String(hour).padStart(2, '0')}:${minute}`
}

const RANGE_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/gi
const SINGLE_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i

/**
 * Pull a { start, end } (24-hour "HH:MM") from free prose. Requires an explicit
 * am/pm meridiem so bare numbers and years never register as a clock time. A
 * missing meridiem on one end of a range is inherited from the other end
 * ("1-4 PM" → 13:00–16:00). Returns null when no meridiem-anchored time exists.
 */
export function parseTimeFromProse(text) {
  const s = String(text || '')
  RANGE_RE.lastIndex = 0
  let m
  while ((m = RANGE_RE.exec(s)) !== null) {
    const [, sH, sMin, sAmPm, eH, eMin, eAmPm] = m
    if (!sAmPm && !eAmPm) continue // a range with no meridiem at all — not a time
    const startAmPm = sAmPm || eAmPm
    const endAmPm = eAmPm || sAmPm
    const start = to24h(sH, sMin, startAmPm)
    const end = to24h(eH, eMin, endAmPm)
    if (start) return { start, end: end || null }
  }
  const one = s.match(SINGLE_RE)
  if (one) {
    const start = to24h(one[1], one[2], one[3])
    if (start) return { start, end: null }
  }
  return null
}

// ── Date parsing ─────────────────────────────────────────────────────────────

const LONG_DATE_RE = new RegExp(
  `\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi',
)

/** All explicit "Month D, YYYY" dates in the text → sorted unique "YYYY-MM-DD". */
export function parseDatesFromProse(text) {
  const out = new Set()
  const s = String(text || '')
  let m
  LONG_DATE_RE.lastIndex = 0
  while ((m = LONG_DATE_RE.exec(s)) !== null) {
    const month = MONTHS[m[1].toLowerCase()]
    const day = parseInt(m[2], 10)
    const year = parseInt(m[3], 10)
    if (!month || !day || day > 31) continue
    out.add(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
  }
  return [...out].sort()
}

/** getUTCDay() for a calendar date, no timezone drift (pure calendar math). */
function weekdayOf(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** The date of the nth (or last, n=-1) given weekday in a month, or null. */
export function nthWeekdayDate(year, month, weekday, n) {
  const last = lastDayOfMonth(year, month)
  if (n === -1) {
    for (let d = last; d >= 1; d--) if (weekdayOf(year, month, d) === weekday) return d
    return null
  }
  const firstWd = weekdayOf(year, month, 1)
  const day = 1 + ((weekday - firstWd + 7) % 7) + (n - 1) * 7
  return day <= last ? day : null
}

const RECURRENCE_RE = new RegExp(
  `\\b(${Object.keys(ORDINALS).join('|')})\\s+(${Object.keys(WEEKDAYS).join('|')})\\s+of\\s+(?:the|each|every)\\s+month\\b`, 'i',
)
const MONTH_RANGE_RE = new RegExp(
  `\\bfrom\\s+(${MONTH_ALT})\\.?\\s+(?:to|through|thru|until|-|–|—)\\s+(${MONTH_ALT})\\.?`, 'i',
)

/**
 * Expand a stated monthly rule ("last Sunday of the month from April to
 * October") into concrete "YYYY-MM-DD" dates. Needs an ordinal+weekday rule AND
 * a month range; the year is taken from an explicit date in the same prose (or a
 * standalone 4-digit year). Returns null when the pattern isn't present, so the
 * caller falls back to explicit-date parsing.
 */
export function parseMonthlyRecurrence(text) {
  const s = String(text || '')
  const rule = s.match(RECURRENCE_RE)
  const range = s.match(MONTH_RANGE_RE)
  if (!rule || !range) return null

  const explicitDates = parseDatesFromProse(s)
  const year = explicitDates.length
    ? parseInt(explicitDates[0].slice(0, 4), 10)
    : parseInt((s.match(/\b(20\d{2})\b/) || [])[1] || '', 10)
  if (!year) return null

  const n = ORDINALS[rule[1].toLowerCase()]
  const weekday = WEEKDAYS[rule[2].toLowerCase()]
  const startMonth = MONTHS[range[1].toLowerCase()]
  const endMonth = MONTHS[range[2].toLowerCase()]
  if (!startMonth || !endMonth || endMonth < startMonth) return null

  const dates = []
  for (let month = startMonth; month <= endMonth; month++) {
    const day = nthWeekdayDate(year, month, weekday, n)
    if (day) dates.push(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
  }
  return dates.length ? dates : null
}

// ── HTML extraction ──────────────────────────────────────────────────────────

/** Text of the "About" section title at/after index → e.g. "Upcoming Events". */
function sectionTitleAt(html, idx) {
  const seg = html.slice(idx, idx + 4000)
  const stop = seg.search(/data-aid="ABOUT_HEADLINE_RENDERED/)
  return htmlToText(stop === -1 ? seg : seg.slice(0, stop)).split('\n')[0].trim()
}

/**
 * Slice out the GoDaddy "About" section whose title matches /upcoming events/i.
 * Sections are delimited by ABOUT_SECTION_TITLE_RENDERED markers; we return the
 * span from the matching marker to the next section marker (or end of doc).
 */
export function extractUpcomingSection(html) {
  const s = String(html)
  const marker = 'data-aid="ABOUT_SECTION_TITLE_RENDERED"'
  const starts = []
  for (let i = s.indexOf(marker); i !== -1; i = s.indexOf(marker, i + 1)) starts.push(i)
  for (let k = 0; k < starts.length; k++) {
    if (/upcoming events/i.test(sectionTitleAt(s, starts[k]))) {
      const end = k + 1 < starts.length ? starts[k + 1] : s.length
      return s.slice(starts[k], end)
    }
  }
  return null
}

/**
 * Parse the "Upcoming Events" section into raw event blocks:
 * [{ title, descText, imageUrl }] in document order. Takes the first render of
 * each ABOUT_*_RENDERED{n} index (the desktop/mobile duplicate is ignored).
 */
export function extractEventBlocks(html) {
  const section = extractUpcomingSection(html)
  if (!section) return []

  const seen = new Set()
  const blocks = []
  const headRe = /data-aid="ABOUT_HEADLINE_RENDERED(\d+)"[^>]*>([^<]*)/g
  let m
  while ((m = headRe.exec(section)) !== null) {
    const index = m[1]
    if (seen.has(index)) continue
    seen.add(index)

    const title = m[2]
    const descIdx = section.indexOf(`data-aid="ABOUT_DESCRIPTION_RENDERED${index}"`)
    let descText = ''
    if (descIdx !== -1) {
      const openEnd = section.indexOf('>', descIdx)
      const rest = section.slice(openEnd + 1)
      // The event photo and any following section markers carry their data-aid
      // mid-tag (src/attrs come first), so match the boundary then back up to
      // that tag's opening "<" — otherwise a half-tag leaks into the prose.
      const bound = rest.match(/<img\b|data-aid="(?:ABOUT_HEADLINE|ABOUT_SECTION_TITLE|GALLERY|FOOTER)/)
      const cut = bound ? rest.lastIndexOf('<', bound.index) : -1
      descText = htmlToText(cut === -1 ? rest : rest.slice(0, cut)).trim()
    }

    let imageUrl = null
    const imgRe = new RegExp(`<img\\b[^>]*data-aid="ABOUT_IMAGE_RENDERED${index}"[^>]*>`, 'i')
    const imgTag = section.match(imgRe)
    if (imgTag) {
      const src = imgTag[0].match(/\ssrc="([^"]+)"/i)
      if (src && !/^data:/i.test(src[1])) {
        imageUrl = src[1].startsWith('//') ? `https:${src[1]}` : src[1]
      }
    }

    blocks.push({ title, descText, imageUrl })
  }
  return blocks
}

// ── Occurrence + row assembly ────────────────────────────────────────────────

/**
 * Turn one raw block into concrete occurrences:
 * [{ title, description, category, imageUrl, date, time }]. A monthly-recurrence
 * rule expands to many dates; otherwise every explicit date in the prose is an
 * occurrence. Blocks with no parseable date yield nothing.
 */
export function blockToOccurrences(block) {
  const title = cleanTitle(block.title)
  if (!title) return []
  const description = block.descText || ''
  // Skip a cancelled/postponed event rather than publishing it.
  if (CANCELLED_RE.test(title) || CANCELLED_RE.test(description)) return []

  const dates = parseMonthlyRecurrence(description) || parseDatesFromProse(description)
  if (!dates.length) return []

  const time = parseTimeFromProse(description)
  const category = inferCategory(title, description)

  return dates.map((date) => ({
    title, description, category, imageUrl: block.imageUrl, date, time,
  }))
}

/** Build a DB row from an occurrence, or null if the timestamp can't be formed. */
export function buildEventRow(occ) {
  if (!occ?.date || !occ.title) return null
  const hasTime = Boolean(occ.time?.start)
  const startAt = easternToIso(occ.date, hasTime ? occ.time.start : '')
  if (!startAt) return null
  const endAt = hasTime && occ.time.end ? easternToIso(occ.date, occ.time.end) : null

  const tags = ['longwood-manor', 'macedonia', 'history', occ.category].filter(Boolean)

  return {
    title:           occ.title,
    description:     occ.description || null,
    start_at:        startAt,
    end_at:          endAt,
    category:        occ.category,
    tags:            [...new Set(tags)],
    price_min:       null,   // site states no price; never assume free
    price_max:       null,
    age_restriction: 'all_ages',
    image_url:       occ.imageUrl || null,
    ticket_url:      EVENTS_URL,
    source_url:      EVENTS_URL,
    source:          SOURCE_KEY,
    source_id:       `${SOURCE_KEY}-${slugify(occ.title)}-${occ.date}`,
    status:          'published',
    // Date-only rows carry an unknown time — surface them for a human glance.
    needs_review:    hasTime ? undefined : true,
    featured:        false,
  }
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🏛️  Starting Longwood Manor Historical Society ingestion…')
  const start = Date.now()
  const cutoffMs = Date.now() - 24 * 3600_000 // skip events ended > ~1 day ago
  try {
    const [organizerId, venueId] = await Promise.all([
      ensureOrganization(ORG_NAME, ORG_DETAILS),
      ensureVenue(VENUE_NAME, VENUE_DETAILS),
    ])
    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    const html = await fetchPage(EVENTS_URL)
    const blocks = extractEventBlocks(html)
    console.log(`  Parsed ${blocks.length} event block(s) from "Upcoming Events".`)

    let found = 0, inserted = 0, skipped = 0
    for (const block of blocks) {
      const occurrences = blockToOccurrences(block)
      if (!occurrences.length) {
        console.warn(`  ⚠ No parseable date for "${cleanTitle(block.title)}" — skipped.`)
        continue
      }
      for (const occ of occurrences) {
        found++
        const row = buildEventRow(occ)
        if (!row) { skipped++; continue }
        if (Date.parse(row.start_at) < cutoffMs) { skipped++; continue }

        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) {
          console.warn(`  ⚠ Upsert failed "${row.title}" (${occ.date}): ${error.message}`)
          skipped++
          continue
        }
        if (venueId) await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: found, durationMs: Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
