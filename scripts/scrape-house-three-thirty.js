/**
 * scrape-house-three-thirty.js
 *
 * Fetches upcoming events from House Three Thirty — the LeBron James Family
 * Foundation's community arts, music, and event space at 532 W Market St in
 * Akron — directly from the venue's own calendar API.
 *
 * Why a direct scraper when HTH is already in the citywide Eventbrite geo-feed
 * (data source `eb_house_three_thirty`): the Eventbrite feed only catches HTH's
 * *ticketed* programming. The house's own calendar also lists free / community
 * events — e.g. the "Akron Knits" needle-arts meetups — that never go through
 * Eventbrite. This is the primary source for that long tail.
 *
 * Platform: custom "VTL" JSON API (the site's Vue front end, built on LeBron's
 *   LRMR platform, renders an `LrmrEvents` component that fetches this feed).
 *
 *   GET https://www.housethreethirty.com/api/vtl/events  (no auth)
 *     → { "results": [ { title, date, displayTime, cost, location,
 *                        image, urlTitle, ticketLink }, … ], "success": true }
 *
 *   The feed exposes only display strings (`date` is "MMMM D", `displayTime` is
 *   a clock string like "7:00 PM"), so we parse them back into Eastern ISO
 *   timestamps. The feed can legitimately be empty between programming cycles —
 *   an empty result set is handled gracefully, not treated as an error.
 *
 *   Verified 2026-07-10: the feed has returned `results: []` since this scraper
 *   first ran (2026-06-13). The venue's own /events page consumes the identical
 *   endpoint and shows visitors "Sorry! No events" — the zero-row census flag is
 *   a source-side content gap, not a scraper bug. Re-check if HTH resumes
 *   publishing; their ticketed events still arrive via the eventbrite source.
 *
 * Usage:
 *   node scripts/scrape-house-three-thirty.js
 *   HTH_DEBUG=1 node scripts/scrape-house-three-thirty.js   # dump first raw event
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
  stripHtml,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
  easternToIso,
  parseCostFromTribe,
} from './lib/normalize.js'

// ── Configuration ─────────────────────────────────────────────────────────

const SITE_BASE_URL = 'https://www.housethreethirty.com'
const API_URL       = `${SITE_BASE_URL}/api/vtl/events`
const SOURCE_KEY    = 'house_three_thirty'

const VENUE_NAME    = 'House Three Thirty'
const VENUE_DETAILS = {
  address: '532 W Market St',
  city:    'Akron',
  state:   'OH',
  zip:     '44303',
  website: SITE_BASE_URL,
}

const USER_AGENT =
  'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

// ── Date / time parsing ─────────────────────────────────────────────────────
//
// The feed gives human display strings, not ISO. `date` is "MMMM D" (the Vue
// component compares it against dayjs().format('MMMM D')), so it has no year —
// we infer the upcoming year. `displayTime` is a clock string, optionally a
// range ("7:00 PM – 9:00 PM"); we take the first time as the start and a
// trailing time as the end when present.

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
}

const pad = (n) => String(n).padStart(2, '0')

/**
 * When a feed date omits the year ("June 14"), assume the next occurrence: the
 * current year, rolled forward if that date is already more than a day past.
 */
function inferYear(month, day) {
  const now      = new Date()
  const today    = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let   year     = now.getFullYear()
  const candidate = new Date(year, month - 1, day)
  if (candidate.getTime() < today.getTime() - 86_400_000) year += 1
  return year
}

/** Normalise a feed `date` string to "YYYY-MM-DD", or null if unparseable. */
export function parseDisplayDate(dateStr) {
  if (!dateStr) return null
  const s = String(dateStr).trim()

  // Already ISO (defensive — in case the feed ever returns sortable dates).
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`

  // Drop an optional leading weekday ("Saturday, ").
  const cleaned = s.replace(/^[A-Za-z]+,\s*/, '')
  const m = cleaned.match(/([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/)
  if (!m) return null

  const month = MONTHS[m[1].toLowerCase()]
  if (!month) return null
  const day  = parseInt(m[2], 10)
  if (!day || day > 31) return null
  const year = m[3] ? parseInt(m[3], 10) : inferYear(month, day)

  return `${year}-${pad(month)}-${pad(day)}`
}

/**
 * Resolve a feed entry's start/end as Eastern ISO timestamps.
 * Returns { start_at, end_at } (end_at null unless a valid later time is given).
 */
export function parseEventTimes(entry) {
  const datePart = parseDisplayDate(entry?.date)
  if (!datePart) return { start_at: null, end_at: null }

  const display = String(entry?.displayTime ?? '').trim()
  // Split on dash variants to separate a "start – end" range. parseClockToken
  // (inside easternToIso) grabs the first clock token of whatever it's given,
  // so passing the whole first segment is safe.
  const [startTok, endTok] = display.split(/\s*[–—-]\s*/)

  const start_at = easternToIso(datePart, startTok || display)
  let   end_at   = null
  if (endTok && endTok.trim()) {
    const candidate = easternToIso(datePart, endTok)
    // Only honor an end that lands after the start (guards "6 - 9 PM" parsing
    // the bare "6" as AM, etc.). validateEvent would otherwise reject it.
    if (candidate && start_at && Date.parse(candidate) > Date.parse(start_at)) {
      end_at = candidate
    }
  }
  return { start_at, end_at }
}

// ── Field mapping ─────────────────────────────────────────────────────────

/** Absolutise a possibly-relative image path against the site origin. */
function absoluteImage(image) {
  if (!image || typeof image !== 'string') return null
  const trimmed = image.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `${SITE_BASE_URL}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`
}

const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/**
 * Stable per-occurrence source_id. HTH reuses a detail-page slug (`urlTitle`)
 * across the recurring meetups (e.g. weekly "Akron Knits"), so we append the
 * local date to keep each occurrence its own row. Falls back to a slug of the
 * title when `urlTitle` is missing.
 */
function buildSourceId(entry, datePart) {
  const base = entry?.urlTitle ? slugify(entry.urlTitle) : slugify(entry?.title ?? '')
  if (!base) return null
  return datePart ? `${base}-${datePart}` : base
}

function mapTags(entry) {
  const t    = (entry?.title ?? '').toLowerCase()
  const tags = ['house-three-thirty', 'akron']
  // The feed's `location` is the room/space within the building; keep it as a
  // tag so the sub-venue isn't lost when every event links to the one venue.
  if (entry?.location) tags.push(slugify(entry.location))
  if (/\b(open mic|live music|concert|music|dj|band)\b/.test(t)) tags.push('live-music')
  if (/\bknit|needle|crochet|fiber|yarn\b/.test(t))             tags.push('needle-arts', 'community')
  if (/\bmarket|pop-?up|vendor\b/.test(t))                       tags.push('market')
  if (/\bworkshop|class|seminar|learn\b/.test(t))               tags.push('workshop')
  return [...new Set(tags.filter(Boolean))]
}

/** Map a raw VTL feed entry to an events-table row (or null if unusable). */
export function normaliseEvent(entry) {
  const { start_at, end_at } = parseEventTimes(entry)
  if (!start_at) return null

  const datePart = start_at.slice(0, 10)
  const urlTitle = entry?.urlTitle ? slugify(entry.urlTitle) : null

  const { price_min, price_max } = parseCostFromTribe(entry?.cost ?? '')

  return {
    title:           (entry?.title ?? '').trim(),
    description:     stripHtml(entry?.detail ?? entry?.description ?? '') || null,
    start_at,
    end_at,
    tags:            mapTags(entry),
    price_min,
    price_max,
    age_restriction: 'not_specified',
    image_url:       absoluteImage(entry?.image),
    ticket_url:      entry?.ticketLink || null,
    source_url:      urlTitle ? `${SITE_BASE_URL}/event/${urlTitle}` : SITE_BASE_URL,
    source:          SOURCE_KEY,
    source_id:       buildSourceId(entry, datePart),
    status:          'published',
  }
}

// ── Fetch ───────────────────────────────────────────────────────────────────

async function fetchEvents() {
  console.log(`\n🔍  Fetching House Three Thirty events from ${API_URL}…`)
  const res = await fetch(API_URL, {
    headers:  { Accept: 'application/json', 'User-Agent': USER_AGENT },
    redirect: 'follow',
  })
  if (!res.ok) {
    throw new Error(`House Three Thirty API error ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const data = await res.json()
  const results = Array.isArray(data?.results) ? data.results : []
  console.log(`  Found ${results.length} events in feed`)
  return results
}

// ── Process ──────────────────────────────────────────────────────────────────

async function processEvents(rawEvents, venueId, organizerId) {
  let inserted = 0, skipped = 0
  const now = Date.now()

  for (const entry of rawEvents) {
    try {
      const row = normaliseEvent(entry)
      if (!row || !row.title || !row.start_at) { skipped++; continue }
      if (Date.parse(row.start_at) < now - 86_400_000) { skipped++; continue } // past

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${entry?.title}":`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting House Three Thirty ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([
      ensureVenue(VENUE_NAME, VENUE_DETAILS),
      ensureOrganization(VENUE_NAME, {
        website:     SITE_BASE_URL,
        description: "House Three Thirty is the LeBron James Family Foundation's community arts, music, and event space at 532 W Market St in Akron, hosting concerts, markets, workshops, and free community meetups.",
      }),
    ])
    if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)

    const rawEvents = await fetchEvents()

    if (process.env.HTH_DEBUG && rawEvents.length) {
      console.log('  DEBUG first raw event:\n', JSON.stringify(rawEvents[0], null, 2).slice(0, 2000))
    }

    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skipped } = await processEvents(rawEvents, venueId, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly; importing for tests exposes pure parsers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

export { mapTags, buildSourceId, SITE_BASE_URL, SOURCE_KEY }
