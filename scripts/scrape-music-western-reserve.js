/**
 * scrape-music-western-reserve.js
 *
 * Music from The Western Reserve (musicwr.org) — a free chamber-music concert
 * series in downtown Hudson, Ohio (Summit County). Every concert is at Christ
 * Church Episcopal, 21 Aurora Street, on a Sunday at 5pm (4:30pm pre-concert
 * talk, post-concert reception), and admission is free.
 *
 * Platform: a Wix site — but NOT Wix Events. The season is a hand-rendered list
 * on the homepage, one concert per <h1><a href="/tickets"> heading whose text
 * Wix fragments across nested spans + <br>. The full line survives text
 * extraction (htmlToText), so we parse the flattened page text rather than the
 * brittle Wix markup:
 *
 *   "Sunday, September 27th | 5pm Irwin shung, piano FREE CONCERT! …"
 *    → { month: September, day: 27, program: "Irwin shung, piano" }
 *
 * Year: the season spans two calendar years (e.g. the 2026–2027 season runs
 * Sep–Dec 2026 and Jan–Apr 2027). We read the season's start year from the page
 * ("2026–2027" / "26/27 Season") and assign Sep–Dec → start year, Jan–Aug →
 * start year + 1 — robust regardless of when the scrape runs. Falls back to a
 * roll-forward-from-today only if the page has no season year.
 *
 * Usage:   node scripts/scrape-music-western-reserve.js
 *          node scripts/scrape-music-western-reserve.js --dry-run
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  htmlToText,
  easternToIso,
  easternTodayIso,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
} from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'
import { classifySummitLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'music_western_reserve'
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'

const ORIGIN = 'https://www.musicwr.org'
const HOMEPAGE = `${ORIGIN}/`

// Every concert: Sunday 5pm, Christ Church Episcopal, downtown Hudson.
const CONCERT_TIME = '5:00 PM'
const VENUE = {
  name: 'Christ Church Episcopal',
  address: '21 Aurora Street',
  city: 'Hudson',
  state: 'OH',
  zip: '44236',
}

// 1 day of grace so a same-day concert stays visible until midnight ET.
const PAST_GRACE_MS = 86_400_000

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}
const pad2 = (n) => String(n).padStart(2, '0')

/**
 * The season's starting calendar year. Prefers a 4-digit "2026–2027" range,
 * then a "26/27 Season" short form, else null (caller falls back). Exported.
 */
export function seasonStartYear(text) {
  const s = String(text || '')
  const full = s.match(/(20\d\d)\s*[‒-―/-]\s*20\d\d/)
  if (full) return parseInt(full[1], 10)
  const short = s.match(/\b(\d{2})\s*\/\s*(\d{2})\s+season/i)
  if (short) return 2000 + parseInt(short[1], 10)
  return null
}

/**
 * Resolve a concert month to its calendar year within a two-year season:
 * Sep–Dec → start year, Jan–Aug → start year + 1. Exported for tests.
 */
export function concertYear(month, startYear) {
  return month >= 9 ? startYear : startYear + 1
}

// One concert line: "Sunday, <Month> <Day>[st/nd/rd/th] | 5pm <program> FREE CONCERT!"
const CONCERT_RE = new RegExp(
  'Sunday,?\\s+(January|February|March|April|May|June|July|August|September|October|November|December)' +
    '\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*\\|\\s*5\\s*pm\\s+([\\s\\S]+?)\\s+FREE\\s+CONCERT',
  'gi',
)

/**
 * Parse the homepage into concert objects { month, day, program }. Pure over the
 * page text (Wix markup is flattened via htmlToText first). Exported for tests.
 */
export function parseConcerts(html) {
  const text = htmlToText(String(html || '')).replace(/\s+/g, ' ')
  const out = []
  const seen = new Set()
  let m
  CONCERT_RE.lastIndex = 0
  while ((m = CONCERT_RE.exec(text))) {
    const month = MONTHS[m[1].toLowerCase()]
    const day = parseInt(m[2], 10)
    const program = m[3].replace(/\s+/g, ' ').trim()
    if (!month || !day || !program) continue
    const key = `${month}-${day}-${program.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ month, day, program })
  }
  return out
}

/**
 * Build a DB row from a parsed concert. Returns null when the date can't be
 * resolved. Pure + exported for tests.
 */
export function buildRow(concert, startYear, now = new Date()) {
  if (!concert || !concert.month || !concert.day || !concert.program) return null

  const year = startYear != null
    ? concertYear(concert.month, startYear)
    : rollForwardYear(concert.month, concert.day, now)

  const dateStr = `${year}-${pad2(concert.month)}-${pad2(concert.day)}`
  const start_at = easternToIso(dateStr, CONCERT_TIME)
  if (!start_at) return null

  const title = concert.program

  return {
    venueSpec: VENUE,
    row: {
      title,
      description:
        'Free chamber-music concert presented by Music from The Western Reserve. ' +
        'Pre-concert talk at 4:30pm; complimentary reception to follow.',
      start_at,
      end_at: null,
      category: 'music',
      tags: ['music', 'classical', 'concert', 'hudson', 'free', 'summit-county'],
      price_min: 0,
      price_max: 0,
      age_restriction: 'all_ages',
      image_url: null,
      ticket_url: `${ORIGIN}/tickets`,
      source_url: `${ORIGIN}/season`,
      source: SOURCE_KEY,
      source_id: `mwr-${dateStr}`,
      status: 'published',
      featured: false,
    },
  }
}

/** Fallback year: next future occurrence of month/day anchored to Eastern today. */
function rollForwardYear(month, day, now) {
  const [ty, tm, td] = easternTodayIso(now).split('-').map(Number)
  let year = ty
  if (Date.UTC(year, month - 1, day) < Date.UTC(ty, tm - 1, td)) year++
  return year
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchHomepage() {
  const res = await fetchWithRetry(HOMEPAGE, { headers: { Accept: 'text/html' } })
  if (!res.ok) throw new Error(`Homepage HTTP ${res.status}`)
  return res.text()
}

// ── Venue / organizer ────────────────────────────────────────────────────────

async function ensureConcertVenue(organizerId) {
  const venueId = await ensureVenue(VENUE.name, {
    address: VENUE.address,
    city: VENUE.city,
    state: VENUE.state,
    zip: VENUE.zip,
  })
  if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)
  return venueId
}

async function ensureOrg() {
  return ensureOrganization('Music from The Western Reserve', {
    website: ORIGIN,
    description:
      'Music from The Western Reserve presents a free chamber-music concert ' +
      'series at Christ Church Episcopal in downtown Hudson, Ohio.',
  })
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🎼  Starting Music from The Western Reserve ingestion…')
  if (DRY_RUN) console.log('   [dry-run mode — fetch + parse only, no DB writes]')
  const start = Date.now()

  try {
    if (classifySummitLocation({ city: VENUE.city }) !== 'in') {
      throw new Error(`Venue city "${VENUE.city}" did not classify as in-county — refusing to publish`)
    }

    console.log('\n🔍  Fetching musicwr.org homepage…')
    const html = await fetchHomepage()

    const text = htmlToText(html).replace(/\s+/g, ' ')
    const startYear = seasonStartYear(text)
    console.log(`  Season start year: ${startYear ?? '(unknown — using roll-forward)'}`)

    const concerts = parseConcerts(html)
    console.log(`  Parsed ${concerts.length} concert(s) from the season schedule.`)
    if (!concerts.length) throw new Error('No concerts parsed — musicwr.org schedule format may have changed')

    const now = Date.now()
    const built = concerts.map((c) => buildRow(c, startYear)).filter(Boolean)
    const upcoming = built.filter((b) => new Date(b.row.start_at).getTime() >= now - PAST_GRACE_MS)
    console.log(`  ${upcoming.length} upcoming concert(s) after dropping past dates.`)

    if (DRY_RUN) {
      for (const { row } of upcoming) console.log(`     • ${row.title}  [${row.start_at}]`)
      console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s [dry-run]`)
      return
    }

    const organizerId = await ensureOrg()
    const venueId = await ensureConcertVenue(organizerId)

    let inserted = 0, skipped = 0
    for (const { row } of upcoming) {
      try {
        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`); skipped++; continue }
        if (venueId) await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on "${row.title}": ${err.message}`)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: upcoming.length,
      durationMs: Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — inserted ${inserted}, skipped ${skipped}`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
