/**
 * scrape-hudson-bandstand.js
 *
 * Scrapes the Hudson Bandstand summer concert series — a free, family-friendly
 * live-music series (since 1977) on the Hudson Green in downtown Hudson, Ohio
 * (Summit County). Published on the Hudson Community Foundation's WordPress site.
 *
 * Platform: WordPress (Goodlayers "gdlr-core" page builder). No events plugin,
 * no JSON-LD, no iCal — the season schedule is a single hand-maintained static
 * page. The schedule lives inside one <ul> under the "Hudson Bandstand YYYY
 * Schedule" heading, each concert its own <li> shaped like:
 *     "<Weekday>, <Month> <Day> | <Band Name> – <description>"
 *     e.g. "Sunday, July 19 | Blue Lunch – Performing blues, soul, ... jazz."
 * A nested <ul><li>Sponsored by …</li></ul> follows each concert (ignored). A
 * few entries carry NO trailing dash/description (e.g. "Western Reserve
 * Community Band").
 *
 * Strategy:
 *   1. Fetch the page and convert to line-based text via htmlToText (each <li>
 *      becomes its own "• …" line; stripHtml would flatten them into one blob).
 *   2. Parse the season year from the "Hudson Bandstand YYYY Schedule" heading
 *      (the per-entry dates carry month+day but no year), falling back to the
 *      current Eastern year.
 *   3. Parse the ONE universal start time the page states for the whole series
 *      ("All concerts begin at 6:30 p.m.") — a stated default, not a fabricated
 *      one. If that sentence can't be parsed we skip rather than invent a time.
 *   4. Walk the lines: a line matching "<Weekday>, <Month> <Day> | <rest>" is a
 *      concert; the pipe requirement is a strong filter (prose sentences that
 *      mention a weekday have no "|"). Band name is whatever precedes the first
 *      en/em-dash; the remainder is the description.
 *
 * Geography: single fixed venue — the Hudson Green in downtown Hudson (44236),
 * Summit County — so every event publishes directly (no classifySummitLocation).
 * Reuses the existing "Hudson Green" venue that scrape-city-of-hudson mints so
 * the two Hudson sources share one venue row (dedupe buckets by venue).
 *
 * Pricing: the page states the series is free ("Free Concerts on the Green",
 * "keep these concerts free") — so price is set to 0 explicitly, not assumed.
 *
 * Images: the page carries no per-concert photos (only a few generic series
 * banners), so image_url is left null. A curated static fallback can be added
 * for this source in lib/fallback-images.js if a series image is wanted.
 *
 * Rain caveat: if rain is forecast a concert moves to Hudson Middle School (83
 * N. Oviatt St). We always store the Green as the venue; the per-day relocation
 * is announced same-day on the committee's Facebook and isn't in the schedule
 * markup for future dates, so we can't reliably reflect it here.
 *
 * Usage:
 *   node scripts/scrape-hudson-bandstand.js
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

const SOURCE_KEY = 'hudson_bandstand'
const SOURCE_URL = 'https://myhcf.org/hudson-bandstand-2/'
const DAYS_AHEAD = 180

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

const WEEKDAYS = 'sunday|monday|tuesday|wednesday|thursday|friday|saturday'

// A cancelled/postponed concert names it in the band slot ("… | CANCELED").
// Same title convention lib/civicplus.js uses — drop rather than publish.
const CANCELLED_RE = /\bcancell?ed\b|\bpostponed\b/i

// ── Pure parsers (exported for tests) ──────────────────────────────────────

/**
 * Extract the season year from the "Hudson Bandstand YYYY Schedule" heading.
 * Returns the 4-digit year as a Number, or null when the heading isn't present
 * so the caller can fall back to the current Eastern year.
 */
export function parseSeasonYear(text = '') {
  const m = text.match(/Hudson Bandstand\s+(20\d{2})\s+Schedule/i)
  return m ? parseInt(m[1], 10) : null
}

/** America/New_York calendar year for now (fallback when the heading lacks one). */
export function easternYear(date = new Date()) {
  return parseInt(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric' }).format(date),
    10,
  )
}

/**
 * Parse the single universal start time the page states for the whole series
 * ("All concerts begin at 6:30 p.m.") into an easternToIso-friendly
 * "H:MM am|pm" string. Returns null when no such sentence is found — the caller
 * then skips rather than fabricating a time (the stan_hywet default-time lesson).
 */
export function parseSeriesDefaultTime(text = '') {
  const m = text.match(/concerts?\s+begin\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i)
  if (!m) return null
  const hour = parseInt(m[1], 10)
  if (Number.isNaN(hour) || hour < 1 || hour > 12) return null
  const minute = m[2] ?? '00'
  const mer = /^p/i.test(m[3]) ? 'pm' : 'am'
  return `${hour}:${minute} ${mer}`
}

/**
 * Split a concert's "rest" text (everything after the "|") into
 * { band, description }. The band name precedes the first en/em-dash (or a
 * space-delimited hyphen); the remainder is the free-text description. When no
 * separator is present the whole string is the band and description is ''.
 */
export function splitBandDescription(rest = '') {
  const trimmed = rest.trim()
  const m = trimmed.match(/^(.*?)\s*[–—]\s*(.*)$/) || trimmed.match(/^(.*?)\s+-\s+(.*)$/)
  if (m) {
    return { band: m[1].trim().replace(/[|]+$/, '').trim(), description: m[2].trim() }
  }
  return { band: trimmed.replace(/[|]+$/, '').trim(), description: '' }
}

/**
 * Parse the htmlToText render into raw concert records:
 *   { month (1-12), monthName, day, band, description, rawLine }
 * A line shaped "<Weekday>, <Month> <Day> | <band> [– <description>]" is a
 * concert. The "|" requirement filters out prose sentences that merely mention
 * a weekday (e.g. "The summer series kicks off … on Monday, May 25th …"), and
 * the nested "Sponsored by …" bullets never match (no leading weekday).
 */
export function parseSchedule(text = '') {
  const records = []
  const lineRe = new RegExp(
    `^(?:${WEEKDAYS}),?\\s+([A-Za-z]+)\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*\\|\\s*(.+)$`,
    'i',
  )

  for (const rawLine of text.split('\n')) {
    // Drop a leading list bullet ("• ") that htmlToText prepends to <li> items.
    const line = rawLine.replace(/^[•\s]+/, '').trim()
    if (!line) continue

    const m = line.match(lineRe)
    if (!m) continue

    const month = MONTHS[m[1].toLowerCase()]
    if (!month) continue
    const day = parseInt(m[2], 10)
    if (day < 1 || day > 31) continue

    const { band, description } = splitBandDescription(m[3])
    if (!band) continue

    records.push({ month, monthName: m[1], day, band, description, rawLine: line })
  }

  return records
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

async function ensureBandstandVenue() {
  // Name/address match scrape-city-of-hudson's defaultVenue so both Hudson
  // sources share ONE venue row (ensureVenue matches by exact name).
  return ensureVenue('Hudson Green', {
    address: '1 Clinton St',
    city: 'Hudson',
    state: 'OH',
    zip: '44236',
    lat: 41.2423,
    lng: -81.4405,
    website: 'https://www.hudson.oh.us',
    description:
      'The historic town green in downtown Hudson, Ohio, home to the Hudson ' +
      'Bandstand gazebo and host to free community concerts, festivals, and ' +
      'markets through the summer season.',
  })
}

async function ensureBandstandOrganizer() {
  return ensureOrganization('Hudson Bandstand', {
    website: SOURCE_URL,
    description:
      'All-volunteer committee that has presented the free Hudson Bandstand ' +
      'summer concert series on the Hudson Green since 1977, supported by ' +
      'sponsors and donors through the Hudson Community Foundation.',
  })
}

// ── Process ─────────────────────────────────────────────────────────────────

export function buildRow(record, year, defaultTime) {
  // Skip a cancelled/postponed concert rather than publishing it.
  if (CANCELLED_RE.test(record.band) || CANCELLED_RE.test(record.description)) return null

  const dateStr = `${year}-${String(record.month).padStart(2, '0')}-${String(record.day).padStart(2, '0')}`

  // The page states one universal start time for the whole series. If we
  // couldn't parse it, skip rather than fabricate a time.
  if (!defaultTime) return null
  const startAt = easternToIso(dateStr, defaultTime)
  if (!startAt) return null

  const descParts = [
    `${record.band} performs live at the Hudson Bandstand free summer concert ` +
    `series on the Hudson Green in downtown Hudson, Ohio.`,
  ]
  if (record.description) descParts.push(record.description)

  return {
    row: {
      title: `Hudson Bandstand: ${record.band}`,
      description: descParts.join(' '),
      start_at: startAt,
      end_at: null,
      // Assert the category explicitly (not a `category` hint) so text inference
      // can't add spurious tags from band names — e.g. "80's Vinyl Arcade"
      // otherwise trips the 'games' classifier on "Arcade". Every event in this
      // source is unambiguously a live concert.
      categories: ['music'],
      tags: ['live-music', 'concert', 'hudson-ohio', 'summit-county', 'free'],
      // Page explicitly states the series is free — set 0, don't assume.
      price_min: 0,
      price_max: 0,
      // Page describes "family-friendly concerts" — flag the facet.
      is_family: true,
      age_restriction: 'all_ages',
      // The page has no per-concert photos (only 3 generic series banners), so
      // we leave image_url null rather than probing one slow remote banner once
      // per event on every run. A curated static image can be registered for
      // this source in lib/fallback-images.js if desired.
      image_url: null,
      ticket_url: SOURCE_URL,
      source: SOURCE_KEY,
      source_id: `hudson-bandstand-${dateStr}`,
      status: 'published',
      featured: false,
    },
    startMs: new Date(startAt).getTime(),
  }
}

async function processEvents(records, year, defaultTime, venueId, organizerId) {
  const now = Date.now()
  const horizon = now + DAYS_AHEAD * 86400_000
  let inserted = 0
  let skipped = 0
  const seenIds = new Set()

  for (const record of records) {
    try {
      const built = buildRow(record, year, defaultTime)
      if (!built) {
        skipped++
        continue
      }
      const { row, startMs } = built

      // Skip past concerts (ended > ~1 day ago) and anything beyond the horizon.
      if (startMs < now - 86400_000 || startMs > horizon) {
        skipped++
        continue
      }

      // One concert per date in practice; guard against a duplicate date anyway.
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
  console.log('🚀  Starting Hudson Bandstand ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([
      ensureBandstandVenue(),
      ensureBandstandOrganizer(),
    ])
    if (venueId && organizerId) {
      await linkOrganizationVenue(organizerId, venueId)
    }

    console.log(`\n🔍  Fetching ${SOURCE_URL}…`)
    const html = await fetchHtml(SOURCE_URL)
    const text = htmlToText(html)

    const year = parseSeasonYear(text) ?? easternYear()
    const defaultTime = parseSeriesDefaultTime(text)
    if (!defaultTime) {
      console.warn('  ⚠ Could not parse the series start time from the page — every entry will skip. Inspect the "All concerts begin at …" sentence.')
    }

    const records = parseSchedule(text)
    console.log(`  Parsed ${records.length} concert entries (season ${year}, start ${defaultTime ?? 'UNKNOWN'})`)

    if (records.length === 0) {
      console.warn('  ⚠ No concert entries parsed. If unexpected, inspect the page — the schedule markup may have changed.')
    }

    console.log(`\n📥  Processing ${records.length} entries…`)
    const { inserted, skipped } = await processEvents(records, year, defaultTime, venueId, organizerId)

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
