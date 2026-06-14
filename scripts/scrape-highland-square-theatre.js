/**
 * scrape-highland-square-theatre.js
 *
 * Fetches upcoming showtimes from Highland Square Theatre.
 *
 * Platform: WordPress (server-rendered HTML — plain fetch, no headless browser)
 * Site:     https://highlandsquaretheatre.com
 * Venue:    826 W. Market Street, Akron, OH 44303
 *
 * The homepage lists currently-playing films as plain-text blocks. Each block
 * contains a quoted title, MPAA rating, runtime, and one or more showtime
 * lines. Per the site footer: "All times are PM unless otherwise noted."
 *
 * We produce one event row per showtime slot.
 *
 * Showtime line formats handled:
 *   Standard:  "Monday June 8: 4:15, 7:00"
 *   Range:     "Mon thru Wed, June 15-17: 7:00"
 *   Packed:    "Monday June 8: 4:15, 7:00  Tuesday June 9: 4:15, 7:00"
 *              (multiple day segments on the same text line, separated by 2+ spaces)
 *
 * Usage:
 *   node scripts/scrape-highland-square-theatre.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { pathToFileURL } from 'node:url'
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

// ── Constants ─────────────────────────────────────────────────────────────

const SOURCE_KEY = 'highland_square_theatre'
const BASE_URL   = 'https://highlandsquaretheatre.com'

const VENUE_INFO = {
  name:    'Highland Square Theatre',
  address: '826 W. Market Street',
  city:    'Akron',
  state:   'OH',
  zip:     '44303',
  website: BASE_URL,
}

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

// ── HTTP ──────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*;q=0.8' },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Date helpers ──────────────────────────────────────────────────────────

/**
 * Resolve a month-name + day number to a YYYY-MM-DD Eastern-local string,
 * using the current year. If the resulting date is more than 7 days in the
 * past we roll forward to next year — handles end-of-year schedule overlap.
 */
export function resolveYear(monthName, day) {
  const month = MONTH_MAP[String(monthName).toLowerCase()]
  if (!month) return null

  const now  = new Date()
  const year = now.getFullYear()
  const mm   = String(month).padStart(2, '0')
  const dd   = String(day).padStart(2, '0')
  const candidate = `${year}-${mm}-${dd}`

  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10)
  if (candidate >= sevenDaysAgo) return candidate
  return `${year + 1}-${mm}-${dd}`
}

/**
 * Expand "June 15-17" into individual YYYY-MM-DD strings.
 */
export function expandDateRange(monthName, startDay, endDay) {
  const dates = []
  for (let d = startDay; d <= endDay; d++) {
    const ymd = resolveYear(monthName, d)
    if (ymd) dates.push(ymd)
  }
  return dates
}

/**
 * Convert a bare "H:MM" string to a 24-hour "HH:MM:SS" string.
 * Per site footer all times are PM, so values < 12 get +12 hours.
 */
export function parseShowtime(timeStr) {
  const m = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  let hour = parseInt(m[1], 10)
  if (hour < 12) hour += 12   // all times PM per site
  return `${String(hour).padStart(2, '0')}:${m[2]}:00`
}

// ── Showtime segment parser ───────────────────────────────────────────────

/**
 * Parse the date portion of a showtime segment into YYYY-MM-DD strings.
 *
 * Handles:
 *   "Monday June 8"              → single date
 *   "Mon thru Wed, June 15-17"   → date range (day names ignored, month + range used)
 *   "Monday June 15-17"          → date range without "thru" keyword
 */
export function parseDatePart(datePart) {
  // Range: month name + D-D  (e.g. "June 15-17")
  const rangeM = datePart.match(/([A-Za-z]+)\s+(\d{1,2})-(\d{1,2})/)
  if (rangeM && MONTH_MAP[rangeM[1].toLowerCase()]) {
    return expandDateRange(rangeM[1], parseInt(rangeM[2], 10), parseInt(rangeM[3], 10))
  }

  // Single: month name + D  (e.g. "June 8" or "Monday June 8")
  const singleM = datePart.match(/([A-Za-z]+)\s+(\d{1,2})$/)
  if (singleM && MONTH_MAP[singleM[1].toLowerCase()]) {
    const ymd = resolveYear(singleM[1], parseInt(singleM[2], 10))
    return ymd ? [ymd] : []
  }

  return []
}

/**
 * Parse a single showtime segment like "Monday June 8: 4:15, 7:00" or
 * "Mon thru Wed, June 15-17: 7:00" into an array of { dateYmd, timeStr24 }.
 */
export function parseShowtimeSegment(seg) {
  if (!seg) return []
  const colonIdx = seg.indexOf(':')
  if (colonIdx === -1) return []

  const datePart  = seg.slice(0, colonIdx).trim()
  const timesPart = seg.slice(colonIdx + 1).trim()

  const times = timesPart
    .split(/[,\s]+/)
    .map(t => t.trim())
    .filter(t => /^\d{1,2}:\d{2}$/.test(t))
    .map(parseShowtime)
    .filter(Boolean)

  if (times.length === 0) return []

  const dates = parseDatePart(datePart)
  if (dates.length === 0) return []

  const result = []
  for (const dateYmd of dates) {
    for (const timeStr24 of times) {
      result.push({ dateYmd, timeStr24 })
    }
  }
  return result
}

// ── Homepage parser ───────────────────────────────────────────────────────

/**
 * Parse the Highland Square Theatre homepage HTML into an array of movie
 * objects. Each movie has:
 *   { title, rating, runtimeMin, imageUrl, showtimes: [{ dateYmd, timeStr24 }] }
 *
 * The page content structure (one block per film):
 *   <img src="poster.jpg" />
 *   "Movie Title"
 *   Rated: PG13
 *   (132 min)
 *   Monday June 8: 4:15, 7:00  Tuesday June 9: 4:15, 7:00 ...
 */
export function parseHomepage(html) {
  if (!html) return []

  const text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    // Preserve poster image URLs as synthetic tokens before stripping tags
    .replace(/<img\b([^>]*)>/gi, (_, attrs) => {
      const m = attrs.match(/src=["']([^"']+)["']/i)
      return m ? `\n__IMG__${m[1]}\n` : '\n'
    })
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/section|\/article|\/td|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&ldquo;|&#8220;/g, '"')
    .replace(/&rdquo;|&#8221;/g, '"')
    .replace(/[“”„‟]/g, '"')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/[ \t]+/g, ' ')

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

  const TITLE_RE   = /^"(.+)"$/
  const RATED_RE   = /^Rated:\s*([A-Z0-9-]+)/i
  const RUNTIME_RE = /^\((\d+)\s*min\)/i
  const IMG_RE     = /^__IMG__(.+)$/
  const DAY_NAME_RE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)/i

  const movies = []
  let current = null
  let pendingImage = null   // poster seen before the title line

  const flush = () => {
    if (current?.title && current.showtimes.length > 0) movies.push(current)
    current = null
  }

  for (const line of lines) {
    // Poster image token
    if (IMG_RE.test(line)) {
      pendingImage = line.replace('__IMG__', '').trim()
      continue
    }

    // Movie title (quoted)
    const titleM = line.match(TITLE_RE)
    if (titleM) {
      flush()
      current = {
        title:      titleM[1].trim(),
        rating:     null,
        runtimeMin: null,
        imageUrl:   pendingImage || null,
        showtimes:  [],
      }
      pendingImage = null
      continue
    }

    if (!current) continue

    // Rating
    const ratedM = line.match(RATED_RE)
    if (ratedM) { current.rating = ratedM[1].trim(); continue }

    // Runtime
    const runtimeM = line.match(RUNTIME_RE)
    if (runtimeM) { current.runtimeMin = parseInt(runtimeM[1], 10); continue }

    // Showtime line — may pack multiple day segments separated by 2+ spaces
    if (DAY_NAME_RE.test(line)) {
      // Split on the boundary between segments: whitespace run before a day-name word
      const segments = line.split(/(?<=\d:\d{2})\s+(?=(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat))/i)
      for (const seg of segments) {
        current.showtimes.push(...parseShowtimeSegment(seg.trim()))
      }
    }
  }

  flush()
  return movies
}

// ── Age restriction ───────────────────────────────────────────────────────

/**
 * The homepage is a bare showtimes grid — it carries no per-film synopsis, so
 * there's nothing to scrape. Every entry is uniformly a $5 first-run screening
 * at the same historic cinema, so we compose an honest description of the
 * SCREENING (venue, format, runtime, rating) rather than leave it null. We do
 * not invent plot copy. Exported for tests.
 */
export function buildDescription({ rating, runtimeMin } = {}) {
  const facts = []
  if (runtimeMin) facts.push(`${runtimeMin} min`)
  if (rating) facts.push(`rated ${rating}`)
  const meta = facts.length ? ` (${facts.join(', ')})` : ''
  return `A first-run film screening at Highland Square Theatre, Akron's historic ` +
    `neighborhood cinema in Highland Square${meta}. General admission $5.`
}

export function mapAgeRestriction(rating) {
  if (!rating) return 'not_specified'
  const r = String(rating).toUpperCase().trim()
  if (r === 'G' || r === 'PG') return 'all_ages'
  if (r === 'R' || r === 'NC-17') return '18_plus'
  return 'not_specified'
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎬  Starting Highland Square Theatre ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization('Highland Square Theatre', {
      website:     BASE_URL,
      description: "Highland Square Theatre is an independent neighborhood movie theater at 826 W. Market St in Akron's Highland Square. Dating to 1938, it seats over 600 and shows first-run films at $5 admission.",
    })

    const venueId = await ensureVenue(VENUE_INFO.name, {
      address: VENUE_INFO.address,
      city:    VENUE_INFO.city,
      state:   VENUE_INFO.state,
      zip:     VENUE_INFO.zip,
      website: VENUE_INFO.website,
    })

    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    const html   = await fetchHtml(BASE_URL)
    const movies = parseHomepage(html)

    const totalShowtimes = movies.reduce((s, m) => s + m.showtimes.length, 0)
    console.log(`  Found ${movies.length} film(s), ${totalShowtimes} total showtimes`)

    if (movies.length === 0) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status:       'error',
        errorMessage: 'No films parsed from homepage — markup may have changed.',
        durationMs:   Date.now() - start,
        eventsFound:  0,
      })
      process.exit(0)
    }

    let inserted = 0, skipped = 0
    for (const movie of movies) {
      for (const { dateYmd, timeStr24 } of movie.showtimes) {
        try {
          const startAt = easternToIso(`${dateYmd} ${timeStr24}`)
          if (!startAt) { skipped++; continue }

          const endAt = movie.runtimeMin
            ? new Date(new Date(startAt).getTime() + movie.runtimeMin * 60_000).toISOString()
            : null

          const slug = movie.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

          const row = {
            title:           movie.title,
            description:     buildDescription(movie),
            start_at:        startAt,
            end_at:          endAt,
            category:        'film',
            tags:            ['film', 'cinema', 'highland-square', 'akron', '$5-movies'],
            price_min:       5,
            price_max:       5,
            age_restriction: mapAgeRestriction(movie.rating),
            image_url:       movie.imageUrl || null,
            ticket_url:      BASE_URL,
            source:          SOURCE_KEY,
            source_id:       `${SOURCE_KEY}-${slug}-${startAt}`,
            status:          'published',
            featured:        false,
          }

          const enriched = await enrichWithImageDimensions(row)
          const { data: upserted, error } = await upsertEventSafe(enriched)

          if (error) {
            console.warn(`  ⚠ Upsert failed for "${movie.title}" @ ${startAt}: ${error.message}`)
            skipped++
          } else {
            await linkEventVenue(upserted.id, venueId)
            await linkEventOrganization(upserted.id, organizerId)
            inserted++
          }
        } catch (err) {
          console.warn(`  ⚠ Error on "${movie.title}": ${err.message}`)
          skipped++
        }
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: totalShowtimes,
      durationMs:  Date.now() - start,
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
