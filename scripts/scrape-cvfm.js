/**
 * scrape-cvfm.js
 *
 * Cuyahoga Valley Farmers Market (cvfm.org) — a producer-only, year-round
 * farmers market held every Saturday 9am–12pm, "rain or shine." It runs two
 * seasonal locations, and we ingest BOTH:
 *   • SUMMER — Howe Meadow, 4040 Riverview Rd, Peninsula, OH 44264 (in CVNP)
 *   • WINTER — Old Trail School, 2315 Ira Rd, Akron, OH 44333 (Bath Township)
 * Both venues are in SUMMIT COUNTY (Peninsula village and Bath Township are
 * both Summit), so events publish directly — no classifySummitLocation gate.
 * The market name references the Cuyahoga *Valley* (the national park), not
 * Cuyahoga County.
 *
 * Platform: WordPress (cvfm.org, rebuilt 2025 on a Qode theme + WPEngine). The
 * market publishes NO per-date event listings — only a standing schedule stated
 * as prose in the GLOBAL site footer ("Stay Connected"), which renders on every
 * page (homepage, /summer-market/, /winter-market/, …):
 *   "SUMMER MARKET  May 2 - October 31, 2026   Howe Meadow 4040 Riverview Rd. …"
 *   "WINTER MARKET  November 7 - April 24, 2027   CLOSED: Nov 28, Dec 26, Jan 2
 *      Old Trail School 2315 Ira Rd. Akron, OH 44333"
 *   "HOURS  Every Saturday  9am - 12pm"
 * The footer is the richest structured source (full date ranges with printed
 * end-year, both venues with street + ZIP, and the winter holiday closures), so
 * we keep parsing it. What changed in the 2025 rebuild: the apex host
 * (https://cvfm.org/) began returning an empty/challenge body to non-browser
 * clients — that empty page is why the nightly run logged "No market seasons
 * parsed." The www host and the market subpages still serve the full footer. So
 * fetchSeasons() now walks a list of candidate URLs (www first, then the market
 * subpages) and uses the first page whose footer yields a season, instead of
 * betting the whole run on one apex fetch.
 * We parse those two season blocks live (so next year's dates/venues follow on
 * re-scrape) and expand each into the upcoming weekly Saturday occurrences via
 * lib/weekly-occurrences.js (Eastern-anchored calendar math, immune to the
 * UTC-rollover footgun), skipping the winter holiday closures. A Saturday that
 * falls in neither active season window (e.g. the Nov 1 gap between seasons) is
 * skipped. Date-keyed source_ids keep the twice-daily run idempotent.
 *
 * Price is left NULL — the market states no admission fee and we never assume
 * free. Category: food.
 *
 * Usage:   node scripts/scrape-cvfm.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, easternToIso, htmlToText,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'
import { nextWeeklyOccurrences, WEEKDAY } from './lib/weekly-occurrences.js'

export const SOURCE_KEY = 'cvfm'
const BASE_URL   = 'https://cvfm.org'
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'
const WEEKS_AHEAD = 14           // rolling window; twice-daily re-scrape extends it
const ORG_NAME    = 'Cuyahoga Valley Farmers Market'

// The global "Stay Connected" footer (with the season prose) renders on every
// page, so any of these will do — we take the first that actually parses. www is
// first because the apex host now returns an empty body to non-browser clients;
// the market subpages are further fallbacks if the homepage template shifts.
export const FETCH_CANDIDATES = Object.freeze([
  'https://www.cvfm.org/',
  'https://cvfm.org/',
  'https://www.cvfm.org/summer-market/',
  'https://www.cvfm.org/winter-market/',
])

// ── Date parsing ─────────────────────────────────────────────────────────────

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
}

/** "May 2" / "October 31" / "Nov 28" → { month, day } (0-based month), or null. */
export function parseMonthDay(str) {
  const m = String(str || '').trim().match(/^([A-Za-z]{3,})\.?\s+(\d{1,2})$/)
  if (!m) return null
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()]
  if (month === undefined) return null
  const day = parseInt(m[2], 10)
  if (day < 1 || day > 31) return null
  return { month, day }
}

/**
 * Split a market venue line into an address object.
 * "Howe Meadow 4040 Riverview Rd. Peninsula, OH 44264"
 *   → { name:'Howe Meadow', address:'4040 Riverview Rd.', city:'Peninsula', state:'OH', zip:'44264' }
 * The name is everything before the leading street number; the tail is a
 * standard "street, city, ST zip". Returns null if it doesn't match.
 */
export function parseVenueLine(line) {
  const m = String(line || '').trim().match(
    /^(.+?)\s+(\d+\s+.+?)[,]?\s+([A-Za-z][A-Za-z ]*?),\s*(OH|Ohio)\s+(\d{5})$/i,
  )
  if (!m) return null
  return {
    name:    m[1].trim(),
    address: m[2].trim().replace(/\.$/, ''),
    city:    m[3].trim(),
    state:   'OH',
    zip:     m[5],
  }
}

/**
 * Assign a full year to a season's start/end months given the year printed in
 * the range (which is always the END year). When the start month is LATER in
 * the calendar than the end month, the season spans a New Year, so the start is
 * the prior year (e.g. "November 7 - April 24, 2027" → starts Nov 2026, ends
 * Apr 2027). Otherwise both share the printed year.
 */
export function resolveSeasonYears(startMd, endMd, printedYear) {
  const spansNewYear = startMd.month > endMd.month
  return {
    startYear: spansNewYear ? printedYear - 1 : printedYear,
    endYear:   printedYear,
  }
}

/** ISO-ish 'YYYY-MM-DD' from a {month(0-based), day} + explicit year. */
function ymd(year, monthZeroBased, day) {
  return `${year}-${String(monthZeroBased + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Parse the two season blocks out of the homepage text.
 *
 * Tolerant to whitespace/newlines (htmlToText output). Each block yields:
 *   { label, startYmd, endYmd, closedYmds:Set, venue:{name,address,city,state,zip} }
 * A block that can't be fully parsed (missing range or venue) is dropped with a
 * warning rather than throwing, so one malformed season can't sink the other.
 */
export function parseSeasons(text) {
  const flat = String(text || '')
  const seasons = []

  for (const label of ['SUMMER', 'WINTER']) {
    // Capture from "<LABEL> MARKET" up to the next season header / HOURS / footer.
    const blockRe = new RegExp(
      `${label}\\s+MARKET([\\s\\S]*?)(?:SUMMER\\s+MARKET|WINTER\\s+MARKET|HOURS|©|$)`, 'i',
    )
    const block = flat.match(blockRe)?.[1]
    if (!block) continue

    // Date range: "May 2 - October 31, 2026"
    const range = block.match(
      /([A-Za-z]{3,}\.?\s+\d{1,2})\s*[-–—]\s*([A-Za-z]{3,}\.?\s+\d{1,2}),?\s*(\d{4})/,
    )

    // Winter closures: "CLOSED: Nov 28, Dec 26, Jan 2". Capture the whole clause
    // and strip it out before extracting the venue, so it can't bleed into the
    // venue name regardless of whether htmlToText line-breaks the footer.
    const closedMatch = block.match(/CLOSED:?\s*((?:[A-Za-z]{3,}\.?\s+\d{1,2}\s*,?\s*)+)/i)
    const blockNoClosed = closedMatch ? block.replace(closedMatch[0], ' ') : block

    // Venue: prefer a line that ends in "…, OH #####" (htmlToText usually keeps
    // the venue's <a> on its own line); otherwise pull the first "<Name>
    // <street#> …, OH #####" span out of the closure-stripped block. The name is
    // letters-only so it can't swallow the date range or a street number.
    const venueLine = blockNoClosed.split(/\n+/).map((l) => l.trim())
      .find((l) => /\d.*,\s*(?:OH|Ohio)\s+\d{5}$/i.test(l))
    const venueSpan = blockNoClosed.replace(/\s+/g, ' ')
      .match(/([A-Z][A-Za-z.'&]*(?: [A-Z][A-Za-z.'&]*)*\s+\d+\s+[^,]+,\s*(?:OH|Ohio)\s+\d{5})/)
    const venue = parseVenueLine(venueLine || venueSpan?.[1] || '')
    const startMd = range && parseMonthDay(range[1])
    const endMd   = range && parseMonthDay(range[2])
    if (!startMd || !endMd || !venue) {
      console.warn(`  ⚠ Could not parse ${label} MARKET block (range=${!!range}, venue=${!!venue})`)
      continue
    }

    const { startYear, endYear } = resolveSeasonYears(startMd, endMd, parseInt(range[3], 10))

    // Winter closures: "CLOSED: Nov 28, Dec 26, Jan 2" — assign each a year by
    // month relative to the season start month (>= start month → start year).
    const closedYmds = new Set()
    if (closedMatch) {
      for (const piece of closedMatch[1].split(',')) {
        const md = parseMonthDay(piece.trim())
        if (!md) continue
        const y = md.month >= startMd.month ? startYear : endYear
        closedYmds.add(ymd(y, md.month, md.day))
      }
    }

    seasons.push({
      label:    label[0] + label.slice(1).toLowerCase(),
      startYmd: ymd(startYear, startMd.month, startMd.day),
      endYmd:   ymd(endYear, endMd.month, endMd.day),
      closedYmds,
      venue,
    })
  }

  return seasons
}

/** The season whose [start,end] window contains `dateYmd` and that isn't a
 *  closed date, or null. Windows never overlap, so the first match wins. */
export function seasonForDate(seasons, dateYmd) {
  for (const s of seasons) {
    if (dateYmd >= s.startYmd && dateYmd <= s.endYmd && !s.closedYmds.has(dateYmd)) return s
  }
  return null
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

/**
 * Fetch the season schedule from the first candidate page that yields it.
 *
 * The season prose lives in the global footer, so every candidate carries the
 * same two blocks — we just need one page that returns a real body (the apex now
 * serves an empty/challenge page to bots) AND parses. Returns
 * { seasons, imageUrl } from the winning page. A candidate that fails to fetch
 * or yields zero seasons is logged and skipped so a single bad host or a
 * template tweak on one page can't sink the run. Returns { seasons: [] } only if
 * every candidate came up empty.
 */
export async function fetchSeasons(candidates = FETCH_CANDIDATES, fetchFn = fetchPage) {
  for (const url of candidates) {
    let html
    try {
      html = await fetchFn(url)
    } catch (err) {
      console.warn(`  ⚠ ${url} — fetch failed: ${err.message}`)
      continue
    }
    const seasons = parseSeasons(htmlToText(html))
    if (seasons.length) {
      console.log(`  ✓ Parsed ${seasons.length} season(s) from ${url}`)
      return { seasons, imageUrl: getMeta(html, 'og:image') }
    }
    console.warn(`  ⚠ ${url} — no season blocks found in this page`)
  }
  return { seasons: [], imageUrl: null }
}

/** Read a <meta property|name="…" content="…"> value (og:image et al.). */
export function getMeta(html, key) {
  const tag = String(html || '').match(
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i'),
  )
  const content = tag?.[0].match(/content=["']([\s\S]*?)["']\s*\/?>/i)?.[1]
  return content ? content.trim() : null
}

const START_TIME = '09:00'
const END_TIME   = '12:00'

function seasonDescription(season) {
  return `The Cuyahoga Valley Farmers Market is a producer-only, year-round farmers market with vendors from within a 100-mile radius — seasonal produce, ethically raised meat and eggs, locally grown flowers, freshly ground grains, baked goods, and vegan and gluten-free options. Open every Saturday 9am–12pm, rain or shine. ${season.label} market at ${season.venue.name} in ${season.venue.city}.`
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🥕  Starting Cuyahoga Valley Farmers Market ingestion…')
  const start = Date.now()
  try {
    const { seasons, imageUrl } = await fetchSeasons()
    console.log(`  Parsed ${seasons.length} season(s): ${seasons.map((s) => `${s.label}→${s.venue.name}`).join(', ')}`)
    if (!seasons.length) throw new Error('No market seasons parsed from cvfm.org — page format may have changed')

    const organizerId = await ensureOrganization(ORG_NAME, {
      website: BASE_URL,
      description: 'Producer-only, year-round Saturday farmers market in the Cuyahoga Valley (Summit County), with vendors from within a 100-mile radius.',
    })

    // Mint each season's venue once, keyed by name.
    const venueIds = new Map()
    for (const s of seasons) {
      if (venueIds.has(s.venue.name)) continue
      const vid = await ensureVenue(s.venue.name, {
        address: s.venue.address, city: s.venue.city, state: s.venue.state, zip: s.venue.zip,
        website: BASE_URL,
      })
      venueIds.set(s.venue.name, vid)
      if (organizerId && vid) await linkOrganizationVenue(organizerId, vid)
    }

    const occurrences = nextWeeklyOccurrences(WEEKDAY.saturday, { count: WEEKS_AHEAD })
    let found = 0, inserted = 0, skipped = 0

    for (const date of occurrences) {
      const season = seasonForDate(seasons, date)
      if (!season) continue          // between seasons or a closure — nothing to publish
      found++

      const startIso = easternToIso(date, START_TIME)
      if (!startIso || Date.parse(startIso) < Date.now() - 3 * 3600_000) { skipped++; continue }

      const row = {
        title:           'Cuyahoga Valley Farmers Market',
        description:     seasonDescription(season),
        start_at:        startIso,
        end_at:          easternToIso(date, END_TIME),
        category:        'food',
        tags:            ['farmers-market', 'food', 'local', 'shopping', season.venue.city.toLowerCase()],
        price_min:       null,          // no admission stated; never assume free
        price_max:       null,
        age_restriction: 'not_specified',
        image_url:       imageUrl || null,
        ticket_url:      BASE_URL,
        source:          SOURCE_KEY,
        source_id:       `${SOURCE_KEY}-${season.label.toLowerCase()}-${date}`,
        status:          'published',
        featured:        false,
      }

      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) { console.warn(`  ⚠ Upsert failed (${date}): ${error.message}`); skipped++; continue }
      const vid = venueIds.get(season.venue.name)
      if (vid)         await linkEventVenue(upserted.id, vid)
      if (organizerId) await linkEventOrganization(upserted.id, organizerId)
      inserted++
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
