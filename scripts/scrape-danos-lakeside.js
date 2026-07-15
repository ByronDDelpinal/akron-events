/**
 * scrape-danos-lakeside.js
 *
 * Scrapes the live-music schedule from Dano's Lakeside Pub — a lakeside
 * bar/restaurant in the Portage Lakes area of Akron (Summit County).
 *
 * Platform: WordPress + Divi page builder (no events plugin, no JSON-LD, no
 * iCal). The /events/ page is a hand-maintained, month-by-month schedule where
 * each month is an <h2> header (MAY, JUNE, …) followed by a <ul> of <li> lines
 * shaped like:
 *     "1ST – TYLER HAWES 6PM-9PM"
 *     "10TH – CLEVELAND'S ROCK BAR (CRB) 3:30PM-6:30PM"
 *     "20TH – PRIME TRIO 3:30PM-6:30PM *LAST BAND FOR SUMMER"
 * i.e. "<day-ordinal> – <BAND NAME> <start>-<end>". The band name is the event.
 *
 * Strategy:
 *   1. Fetch the page and convert to line-based text via htmlToText (which turns
 *      </h2> into a blank line and each <li> into its own "• …" line — so month
 *      headers and entries separate cleanly; stripHtml would flatten them).
 *   2. Walk the lines: a line that is exactly a month name sets the current
 *      month; a "<day-ordinal> – …" line under a month is parsed into an event.
 *   3. Times are ranges quoting the meridiem on the END ("3:30PM-6:30PM"); the
 *      START inherits the end's am/pm (see extractTimeRange). The band name is
 *      whatever precedes the time; a trailing "*note" (after the time) is dropped.
 *
 * Year inference: the schedule carries NO explicit year. The season banner image
 * is uploaded under wp-content/uploads/2026/06, confirming the 2026 season, so we
 * anchor each month/day to the CURRENT Eastern year (rolling forward only when a
 * date is >200 days stale, which never resurrects a recently-passed show). Past
 * shows are filtered out normally; a fully-past season simply yields 0 events.
 * See the caveat in the report: if the venue leaves a stale season up past
 * year-end, dates could mis-infer until they post the new season (re-scrapes
 * self-correct).
 *
 * Geography: single fixed venue in Portage Lakes (Akron, 44319) — Summit County
 * — so every event is published directly (no classifySummitLocation needed).
 *
 * Usage:
 *   node scripts/scrape-danos-lakeside.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  htmlToText,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  linkOrganizationVenue,
  ensureVenue,
  ensureOrganization,
  easternToIso,
} from './lib/normalize.js'

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_KEY = 'danos_lakeside'
const SOURCE_URL = 'https://danosportagelakes.com/events/'
const DAYS_AHEAD = 180

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

// Short all-caps tokens that are acronyms rather than shouted words, so they
// survive title-casing intact. Detected generically by "all-caps + no vowel +
// short" too (CRB/CBR/DLP), but this keeps a couple that would otherwise slip.
const KEEP_UPPER = new Set(['CRB', 'CBR', 'DLP', 'DJ'])
// Connector words that stay lowercase in a band name (except first/last token).
const MINOR_WORDS = new Set(['and', 'of', 'the', 'for', 'a', 'an', 'to', '&'])
// Cancelled/postponed shows carry the word in the band slot ("20TH – CANCELED").
// Same title convention lib/civicplus.js uses — drop them rather than publish.
const CANCELLED_RE = /\bcancell?ed\b|\bpostponed\b/i

// ── Pure parsers (exported for tests) ──────────────────────────────────────

/**
 * Normalize a clock token to "H:MM am|pm" for easternToIso. Returns null when
 * the meridiem is unknown (we never guess am vs pm) or the hour is invalid.
 */
export function normalizeClock(hour, minute, meridiem) {
  if (!meridiem) return null
  const h = parseInt(hour, 10)
  if (Number.isNaN(h) || h < 1 || h > 12) return null
  const mer = meridiem.toLowerCase()
  if (mer !== 'am' && mer !== 'pm') return null
  return `${h}:${minute ?? '00'} ${mer}`
}

/**
 * Parse a "3:30PM-6:30PM" / "6PM-9PM" style range → { start, end } where each
 * is an easternToIso-friendly "H:MM am|pm" string. The START may omit its
 * meridiem ("6-9PM") and inherits it from the END. Returns null when no
 * meridiem-qualified range is present.
 */
export function extractTimeRange(text = '') {
  const m = text.match(
    /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i,
  )
  if (!m) return null
  const endMer = m[6]
  const startMer = m[3] || endMer
  const start = normalizeClock(m[1], m[2], startMer)
  const end = normalizeClock(m[4], m[5], endMer)
  if (!start) return null
  return { start, end, index: m.index }
}

/**
 * Title-case an ALL-CAPS band name while preserving short acronyms (CRB, DLP,
 * "(CRB)") and lowercasing interior connector words. "CLEVELAND'S ROCK BAR
 * (CRB)" → "Cleveland's Rock Bar (CRB)"; "EAST OF SEATTLE" → "East of Seattle".
 */
export function titleCaseBand(raw = '') {
  const tokens = raw.trim().split(/\s+/).filter(Boolean)
  const n = tokens.length
  return tokens
    .map((tok, i) => {
      const bare = tok.replace(/[()]/g, '')
      const isAllUpper = /^[A-Z][A-Z'&.]*$/.test(bare)
      const hasNoVowel = !/[AEIOU]/.test(bare)
      if (bare && isAllUpper && (KEEP_UPPER.has(bare) || (hasNoVowel && bare.length <= 4))) {
        return tok // acronym — keep as-is (with any parens)
      }
      const lower = tok.toLowerCase()
      if (i !== 0 && i !== n - 1 && MINOR_WORDS.has(lower)) return lower
      // Capitalize the first alphabetic character, preserving leading quotes.
      return lower.replace(/^([^a-z]*)([a-z])/, (_m, pre, c) => pre + c.toUpperCase())
    })
    .join(' ')
}

/**
 * Parse the month-by-month schedule text (htmlToText output) into raw records:
 *   { month (1-12), monthName, day, band, startTime, endTime, rawLine }
 * A line equal to a month name sets the running month; each "<day-ordinal> –
 * …" line under a month becomes a record. Lines outside that shape (the special
 * "Antique Boat Show" blurbs, bar hours, nav, footer) are ignored.
 */
export function parseSchedule(text = '') {
  const records = []
  let month = null
  let monthName = null

  for (const rawLine of text.split('\n')) {
    // Drop a leading list bullet ("• ") that htmlToText prepends to <li> items.
    const line = rawLine.replace(/^[••\s]+/, '').trim()
    if (!line) continue

    // Month header? (exact month name, tolerating an optional trailing year)
    const headerMatch = line.match(/^([A-Za-z]+)(?:\s+\d{4})?$/)
    if (headerMatch && MONTHS[headerMatch[1].toLowerCase()]) {
      month = MONTHS[headerMatch[1].toLowerCase()]
      monthName = headerMatch[1]
      continue
    }

    if (!month) continue

    // Entry: "<day><ordinal> – <band> <time-range> [*note]"
    const entry = line.match(/^(\d{1,2})(?:st|nd|rd|th)\s*[–—-]\s*(.+)$/i)
    if (!entry) continue

    const day = parseInt(entry[1], 10)
    if (day < 1 || day > 31) continue

    const rest = entry[2]
    const times = extractTimeRange(rest)
    // Band name is whatever precedes the time range (drops a trailing "*note").
    const band = (times ? rest.slice(0, times.index) : rest)
      .replace(/[–—-]\s*$/, '')
      .trim()
    if (!band) continue

    records.push({
      month,
      monthName,
      day,
      band,
      startTime: times?.start ?? null,
      endTime: times?.end ?? null,
      rawLine: line,
    })
  }

  return records
}

/** America/New_York calendar date "YYYY-MM-DD" for now (year-rollover anchor). */
export function easternTodayYmd(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date)
}

/**
 * Infer the calendar year for a month/day that the source states without one.
 * Anchor to the current Eastern year; roll forward only when the date is more
 * than ~200 days stale (so a recently-passed show is never pushed a year out,
 * but a genuinely next-cycle month resolves correctly). See the year-inference
 * note in the file header.
 */
export function inferYear(month, day, todayYmd = easternTodayYmd()) {
  const [ty, tm, td] = todayYmd.split('-').map(Number)
  const todayMs = Date.UTC(ty, tm - 1, td)
  let year = ty
  const ms = Date.UTC(year, month - 1, day)
  if (ms < todayMs - 200 * 86400_000) year += 1
  return year
}

// ── HTTP ────────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronEventsBot/1.0; +https://akronpulse.com)',
      Accept: 'text/html,application/xhtml+xml',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Venue / Organizer ───────────────────────────────────────────────────────

async function ensureDanosVenue() {
  return ensureVenue("Dano's Lakeside Pub", {
    address: '4856 Coleman Dr',
    city: 'Akron',
    state: 'OH',
    zip: '44319',
    lat: 40.96098,
    lng: -81.540891,
    website: 'https://danosportagelakes.com',
    description:
      'Lakeside bar and restaurant in the Portage Lakes area of Akron, Ohio, ' +
      'hosting live music several nights a week through the summer season.',
  })
}

async function ensureDanosOrganizer() {
  return ensureOrganization("Dano's Lakeside Pub", {
    website: 'https://danosportagelakes.com',
    description:
      'Portage Lakes bar and restaurant presenting local live-music performances.',
  })
}

// ── Process ─────────────────────────────────────────────────────────────────

export function buildRow(record, venueId, organizerId, todayYmd) {
  // Skip a cancelled/postponed show rather than publishing it as a live gig.
  if (CANCELLED_RE.test(record.band)) return null

  const year = inferYear(record.month, record.day, todayYmd)
  const dateStr = `${year}-${String(record.month).padStart(2, '0')}-${String(record.day).padStart(2, '0')}`

  // Never synthesize a midnight (repo mandate): a record with no parseable,
  // meridiem-qualified time would make easternToIso(date, '') return a 00:00 ET
  // timestamp, which would be published silently. Every live entry carries a
  // range in practice, so a missing time is a parse/markup regression — skip it
  // (raising the skipped count) rather than ingesting a fake midnight show.
  if (!record.startTime) return null

  const startAt = easternToIso(dateStr, record.startTime)
  if (!startAt) return null

  let endAt = null
  if (record.endTime) {
    endAt = easternToIso(dateStr, record.endTime)
    // Guard against a range that crosses midnight (none in the data today).
    if (endAt && endAt <= startAt) {
      endAt = new Date(new Date(endAt).getTime() + 86400_000).toISOString()
    }
  }

  const bandTitle = titleCaseBand(record.band)

  return {
    row: {
      title: `Live Music: ${bandTitle}`,
      description: `${bandTitle} performing live at Dano's Lakeside Pub in the Portage Lakes area of Akron.`,
      start_at: startAt,
      end_at: endAt,
      category: 'music',
      tags: ['live-music', 'portage-lakes', 'bar'],
      price_min: null,
      price_max: null,
      age_restriction: 'not_specified',
      image_url: null,
      ticket_url: SOURCE_URL,
      source: SOURCE_KEY,
      source_id: `danos-${dateStr}`,
      status: 'published',
      featured: false,
    },
    dateStr,
    startMs: new Date(startAt).getTime(),
  }
}

async function processEvents(records, venueId, organizerId) {
  const now = Date.now()
  const horizon = now + DAYS_AHEAD * 86400_000
  const todayYmd = easternTodayYmd()
  let inserted = 0
  let skipped = 0

  const seenIds = new Set()

  for (const record of records) {
    try {
      const built = buildRow(record, venueId, organizerId, todayYmd)
      if (!built) {
        skipped++
        continue
      }
      const { row, startMs } = built

      // Skip past shows (ended > ~1 day ago) and anything beyond the horizon.
      if (startMs < now - 86400_000 || startMs > horizon) {
        skipped++
        continue
      }

      // Same-day double-booking guard: two bands on one date would collide on
      // the date-based source_id. None occur today, but disambiguate defensively.
      if (seenIds.has(row.source_id)) {
        const slug = record.band.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        row.source_id = `${row.source_id}-${slug}`
      }
      seenIds.add(row.source_id)

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${record.rawLine}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀  Starting Dano's Lakeside Pub ingestion…")
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([
      ensureDanosVenue(),
      ensureDanosOrganizer(),
    ])
    if (venueId && organizerId) {
      await linkOrganizationVenue(organizerId, venueId)
    }

    console.log(`\n🔍  Fetching ${SOURCE_URL}…`)
    const html = await fetchHtml(SOURCE_URL)
    const text = htmlToText(html)
    const records = parseSchedule(text)
    console.log(`  Parsed ${records.length} schedule entries`)

    if (records.length === 0) {
      console.warn('  ⚠ No schedule entries parsed. If unexpected, inspect /events/ — the Divi markup may have changed.')
    }

    console.log(`\n📥  Processing ${records.length} entries…`)
    const { inserted, skipped } = await processEvents(records, venueId, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: records.length,
      durationMs: Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly; importing for tests exposes the pure parsers
// without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
