/**
 * scrape-akron-marathon.js
 *
 * Fetches Akron Marathon Race Series events — three race weekends per
 * year run by the Akron Marathon Charitable Corporation:
 *
 *   • Akron 8K & 1M  (June)
 *   • Akron Half Marathon & 10K  (August)
 *   • Akron Marathon  (September; includes the relay)
 *
 * Platform: akronmarathon.org is WordPress + Divi. The /future-race-dates/
 * page is a static, lightweight listing of upcoming race dates ordered
 * 8K → Half → Marathon, with the same three slots repeated for next
 * year. We scrape that page directly (no JSON-LD), parse the date
 * lines in order, and pair each date with its race-series detail URL
 * for the ticket link.
 *
 * Why a dedicated scraper: the Akron Marathon races register through
 * raceroster.com and don't surface on the consumer ticketing platforms
 * we scrape directly (Ticketmaster, Eventbrite). They DO show up in
 * the Akron Life Evvnt feed, but Evvnt's categorisation often tags
 * them "community" rather than "fitness" — direct ingestion lets us
 * own the category and skips the Evvnt copies via COVERED_BY_DIRECT_SCRAPER.
 *
 * Usage:
 *   node scripts/scrape-akron-marathon.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_KEY      = 'akron_marathon'
const BASE_URL        = 'https://www.akronmarathon.org'
const FUTURE_DATES    = `${BASE_URL}/future-race-dates/`
const USER_AGENT      = 'Mozilla/5.0 (compatible; AkronPulseBot/1.0; +https://akronpulse.com)'

// The three race series in the order /future-race-dates/ lists them.
// First date = 8K, second = Half/10K, third = Marathon. The page lists
// next year's dates immediately after the current year's in the same
// order, so we iterate dates and cycle the labels with modulo 3.
const RACE_SERIES = [
  {
    label:       'Akron 8K & 1M',
    slug:        'akron-8k-1m',
    seriesUrl:   `${BASE_URL}/race-series/8k-1m/`,
    description: 'The Akron 8K plus a 1-mile family event — the kick-off race of the Akron Marathon Race Series. Late-June 8K through downtown Akron, with the 1M running ahead of it.',
    tags:        ['8k', '1-mile', 'family'],
    startTime:   '07:00:00',   // typical 7am gun
  },
  {
    label:       'Akron Half Marathon & 10K',
    slug:        'akron-half-marathon-10k',
    seriesUrl:   `${BASE_URL}/race-series/half-marathon-10k/`,
    description: 'The Akron Half Marathon and 10K — the second of three Race Series weekends. Both distances roll through downtown Akron in mid-summer.',
    tags:        ['half-marathon', '10k'],
    startTime:   '07:00:00',
  },
  {
    label:       'Akron Marathon',
    slug:        'akron-marathon',
    seriesUrl:   `${BASE_URL}/race-series/akron-marathon/`,
    description: 'The Akron Marathon — the flagship race of the Akron Marathon Race Series. Includes the full marathon and the team relay. Downtown Akron, late September.',
    tags:        ['marathon', 'relay'],
    startTime:   '07:00:00',
  },
]

const VENUE_INFO = {
  // The actual race-day venues vary (Canal Park / downtown street courses).
  // Akron Marathon Charitable Corporation's HQ is the canonical venue
  // until per-race start lines get separately tracked.
  name:    'Akron Marathon — Downtown Akron Course',
  address: '155 E Voris St',
  city:    'Akron',
  state:   'OH',
  zip:     '44311',
  // HQ address; the course start lines are nearby in downtown.
  lat:     41.0719,
  lng:     -81.5175,
  website: BASE_URL,
  description:
    'Downtown Akron road-race course used by the Akron Marathon Charitable Corporation ' +
    'for the three-event Race Series each year (8K & 1M, Half Marathon & 10K, full Marathon).',
  parking_type:  'street',
  parking_notes: 'Race-day parking varies by event — see the race-series page on akronmarathon.org for the year\'s parking guide.',
}

const ORG_INFO = {
  name: 'Akron Marathon Charitable Corporation',
  details: {
    website: BASE_URL,
    description:
      'Nonprofit producing the three-race Akron Marathon Race Series each year, plus training ' +
      'and community programs supporting running in Greater Akron.',
  },
}

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

// ── Fetch + parse ─────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

/**
 * Pull every "Month DD, YYYY" string out of the future-race-dates page
 * in document order. The page is tidy — only the three race dates per
 * year appear in this format.
 */
function parseRaceDates(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
  const dates = []
  const re = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/gi
  for (const m of text.matchAll(re)) {
    const [, mon, day, year] = m
    const monthNum = MONTH_MAP[mon.toLowerCase()]
    if (!monthNum) continue
    dates.push({
      iso: `${year}-${String(monthNum).padStart(2,'0')}-${String(parseInt(day,10)).padStart(2,'0')}`,
      year: parseInt(year, 10),
      month: monthNum,
      day: parseInt(day, 10),
    })
  }
  return dates
}

/**
 * Bucket the dates by year so we can pair each year's 3 dates with the
 * three race-series rows in order. Returns:
 *   [{ year: 2026, dates: [d1, d2, d3] }, ...]
 */
function bucketByYear(dates) {
  const map = new Map()
  for (const d of dates) {
    if (!map.has(d.year)) map.set(d.year, [])
    map.get(d.year).push(d)
  }
  // Sort each year's dates ascending so the first → 8K, second → Half, third → Marathon
  const buckets = []
  for (const [year, list] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => (a.month - b.month) || (a.day - b.day))
    if (list.length === 3) buckets.push({ year, dates: list })
  }
  return buckets
}

// ── Process + upsert ─────────────────────────────────────────────────────

async function processRaces(buckets, venueId, organizerId) {
  let inserted = 0, skipped = 0
  const now = Date.now()

  for (const { year, dates } of buckets) {
    for (let i = 0; i < RACE_SERIES.length; i++) {
      const race = RACE_SERIES[i]
      const date = dates[i]
      if (!date) { skipped++; continue }

      const startAt = easternToIso(`${date.iso} ${race.startTime}`)
      if (!startAt) { skipped++; continue }

      // Past-date guard — keep events for a day after the start so the
      // morning-of view doesn't immediately drop a same-day race.
      if (new Date(startAt).getTime() < now - 86_400_000) {
        skipped++
        continue
      }

      const sourceId = `${race.slug}-${year}`
      const row = {
        title:           `${race.label} ${year}`,
        description:     race.description,
        start_at:        startAt,
        end_at:          null,
        category:        'fitness',
        tags:            ['akron-marathon', 'running', 'race', 'downtown-akron', ...race.tags],
        price_min:       null,           // varies by registration window
        price_max:       null,
        age_restriction: 'all_ages',
        image_url:       null,
        ticket_url:      race.seriesUrl,
        source:          SOURCE_KEY,
        source_id:       sourceId,
        status:          'published',
        featured:        false,
      }

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
        continue
      }
      if (venueId)     await linkEventVenue(upserted.id, venueId)
      if (organizerId) await linkEventOrganization(upserted.id, organizerId)
      inserted++
    }
  }
  return { inserted, skipped }
}

// ── Entry point ──────────────────────────────────────────────────────────

async function main() {
  console.log('🏃  Starting Akron Marathon Race Series ingestion…')
  const start = Date.now()

  try {
    const venueId = await ensureVenue(VENUE_INFO.name, {
      address:       VENUE_INFO.address,
      city:          VENUE_INFO.city,
      state:         VENUE_INFO.state,
      zip:           VENUE_INFO.zip,
      lat:           VENUE_INFO.lat,
      lng:           VENUE_INFO.lng,
      website:       VENUE_INFO.website,
      description:   VENUE_INFO.description,
      parking_type:  VENUE_INFO.parking_type,
      parking_notes: VENUE_INFO.parking_notes,
    })
    const organizerId = await ensureOrganization(ORG_INFO.name, ORG_INFO.details)
    if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)

    console.log(`\n🔍  Fetching ${FUTURE_DATES}…`)
    const html = await fetchHtml(FUTURE_DATES)
    const dates = parseRaceDates(html)
    console.log(`  Found ${dates.length} race dates`)

    const buckets = bucketByYear(dates)
    console.log(`  Bucketed into ${buckets.length} years × 3 races`)

    const { inserted, skipped } = await processRaces(buckets, venueId, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: dates.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

main()
