/**
 * scrape-village-of-clinton.js
 *
 * Village of Clinton, Ohio — a small village in Summit County (on the
 * SUMMIT_COUNTY_CITIES allowlist), on the border with Stark County along the
 * Tuscarawas River. The village runs a WordPress + The Events Calendar (Tribe)
 * site whose public calendar is dominated by municipal governance (Council and
 * Zoning Board of Appeals meetings). We surface only the genuine public
 * community events (festivals, park events, cleanups) and drop the government
 * meetings, matching the pattern the Bath / Cuyahoga Falls township scrapers use.
 *
 * Platform: WordPress + The Events Calendar (Tribe) REST API — same shape as the
 * Peninsula Coffee House / Raintree Golf / Torchbearers scrapers.
 *   https://clintonoh.gov/wp-json/tribe/events/v1/events
 *
 * Feed quirks (verified 2026-07-15):
 *   • TIMEZONE CONFIG IS CORRECT (unlike Peninsula Coffee House). The install
 *     reports timezone "America/New_York" and its utc_start_date is the true UTC
 *     instant (start_date 18:00 EDT → utc_start_date 22:00, i.e. +4h). Even so,
 *     to be robust against the misconfiguration seen on sibling Tribe installs
 *     (where utc_start_date === start_date, i.e. Eastern-labelled-UTC), we do NOT
 *     append 'Z' to the utc_ fields. Instead we take the LOCAL `start_date`
 *     wall-clock string — which is Eastern in BOTH configs — and run it through
 *     easternToIso, yielding the correct UTC instant universally.
 *   • MOSTLY GOVERNMENT MEETINGS. As of the build date the entire feed is Council
 *     Meetings and a Zoning Board of Appeals meeting — all dropped by the meeting
 *     filter (isPublicCommunityEvent). The scraper is built to pass through the
 *     community events (festivals, park events, cleanups) the village adds
 *     seasonally; a run with zero survivors is expected and correct when the feed
 *     carries only governance rows.
 *   • Events carry NO venue object and NO cost. price_min/price_max stay null
 *     (never assume free); events with no per-event venue pin to the canonical
 *     "Village of Clinton" municipal venue.
 *   • image is `false` on the governance rows; community events may embed a
 *     banner <img> in the description (parseImage falls back to it).
 *
 * Geography: Clinton is fixed in Summit County. We still route the resolved
 * venue's city through classifySummitLocation so the strict Summit gate is
 * honoured uniformly should the village ever list an event in a neighbouring
 * (Stark County) town — 'in' → published, 'unknown' → pending_review, 'out' →
 * skip.
 *
 * Category: municipal community programming leans civic. We infer from the
 * title + description and, when inference can only reach the generic 'other'
 * bucket, default a village-hosted event to 'civic'.
 *
 * Usage:   node scripts/scrape-village-of-clinton.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, htmlToText, easternToIso,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
  parseCostFromTribe, parseTagsFromTribe,
  easternTodayIso,
} from './lib/normalize.js'
import { inferCategory } from './lib/category-inference.js'
import { classifySummitLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'village_of_clinton'
const BASE_URL   = 'https://clintonoh.gov/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180
// WordPress/Tribe installs behind WAFs reject non-browser User-Agents with a 406.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const ORG_NAME   = 'Village of Clinton'
const ORIGIN     = 'https://clintonoh.gov'
const DEFAULT_VENUE = {
  name: 'Village of Clinton',
  city: 'Clinton', state: 'OH', zip: '44216',
  website: ORIGIN,
}
const ORG_DETAILS = {
  website: ORIGIN,
  description: 'Village of Clinton, Ohio (Summit County) municipal government — hosts community events including village festivals, park programming, and clean-up days.',
}

// ── Non-event filter ─────────────────────────────────────────────────────────
//
// This is a municipal calendar dominated by governance. We drop Council and
// board/commission meetings, zoning hearings, mayor's court, work sessions,
// caucuses, and holiday office closures on the title — the same title-gate the
// Bath Township and Cuyahoga Falls scrapers use. What survives is the village's
// public community programming (festivals, park events, clean-ups).
const MEETING_RE = new RegExp(
  [
    'city council', '\\bcouncil\\b', 'board of trustees', '\\btrustees?\\b',
    'zoning board', 'board of zoning', 'zoning appeals?', 'zoning commission',
    'planning commission', 'appearance review', 'park board', 'board of health',
    'water and sewer', "mayor'?’?s court", '\\bcourt\\b', '\\bcommittee\\b',
    '\\bcommission\\b', '\\bcaucus\\b', 'work session', 'public hearing',
    'special meeting', 'regular meeting', 'executive session', 'board meeting',
    '\\bhearing\\b', '\\bboard\\b',
  ].join('|'),
  'i',
)

// Holiday / office-closure markers.
const CLOSURE_RE = /offices?\s+closed|holiday\s+closure|\bnew\s+year'?’?s\s+(eve|day)\b/i

/** True for public community events; false for governance rows / closures. Exported for tests. */
export function isPublicCommunityEvent(title) {
  const t = stripHtml(String(title || '')).trim().toLowerCase()
  if (!t) return false
  if (CLOSURE_RE.test(t)) return false
  if (MEETING_RE.test(t)) return false
  return true
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/**
 * Convert the feed's local `start_date`/`end_date` wall-clock string to a correct
 * UTC ISO instant. The string is Eastern in every timezone config this feed
 * emits (see header), so easternToIso is universally correct. Returns null if the
 * field is missing/unparseable.
 */
export function toEasternIso(localDateTime) {
  if (!localDateTime) return null
  return easternToIso(String(localDateTime).replace('T', ' '))
}

/**
 * Content category. Municipal community programming leans civic; we infer from
 * title + description and default the generic 'other' bucket to 'civic' since a
 * village-hosted public event is civic by default. Exported for tests.
 */
export function resolveCategory(title = '', description = '') {
  const inferred = inferCategory(title, description || '')
  return (!inferred || inferred === 'other') ? 'civic' : inferred
}

/**
 * Per-occurrence source_id. Community events are one-off posts today, but a
 * recurring Tribe series returns multiple occurrences sharing one event id with
 * distinct start dates — appending the occurrence date keeps ids collision-free.
 * Exported for tests.
 */
export function buildSourceId(ev) {
  const day = String(ev.start_date ?? ev.utc_start_date ?? '').slice(0, 10)
  return day ? `${ev.id}-${day}` : String(ev.id)
}

/** Image from a Tribe image object (may be `false`), falling back to an inline <img>. */
export function parseImage(imageObj, descriptionHtml = '') {
  if (imageObj && imageObj.url) return imageObj.url
  return String(descriptionHtml).match(/<img[^>]+src="([^"]+)"/)?.[1] ?? null
}

/**
 * Resolve a Tribe `venue` value to a venue spec. Tribe returns `[]` when the
 * event has no venue and an object ({ venue, address, city, … }) when it does.
 * Empty / nameless → the canonical Village of Clinton municipal venue.
 * Exported for tests.
 */
export function resolveVenueSpec(tribeVenue) {
  const v = Array.isArray(tribeVenue) ? tribeVenue[0] : tribeVenue
  const name = v && typeof v.venue === 'string' ? v.venue.trim() : ''
  if (!name) return { ...DEFAULT_VENUE }
  return {
    name,
    address: v.address ?? null,
    city:    v.city ?? 'Clinton',
    state:   v.stateprovince ?? v.state ?? 'OH',
    zip:     v.zip ?? null,
    lat:     v.geo_lat ? parseFloat(v.geo_lat) : null,
    lng:     v.geo_lng ? parseFloat(v.geo_lng) : null,
    website: v.website ?? null,
  }
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = easternTodayIso()
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]

  let page = 1, hasMore = true
  const all = []
  console.log('\n🔍  Fetching Village of Clinton events via Tribe REST API…')

  while (hasMore) {
    const url = new URL(BASE_URL)
    url.searchParams.set('per_page',   PER_PAGE)
    url.searchParams.set('page',       page)
    url.searchParams.set('start_date', startDate)
    url.searchParams.set('end_date',   endDate)
    url.searchParams.set('status',     'publish')

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA },
      redirect: 'follow',
    })
    // Tribe returns 400 with a "no results" code when the window is empty —
    // treat that as zero events rather than an error.
    if (res.status === 400) break
    if (!res.ok) throw new Error(`Village of Clinton API error ${res.status}: ${(await res.text()).slice(0, 200)}`)

    const data   = await res.json()
    const events = data.events ?? []
    all.push(...events)
    console.log(`  Page ${page}/${data.total_pages ?? 1}: ${events.length} events (total: ${all.length})`)

    hasMore = page < (data.total_pages ?? 1)
    page++
    if (hasMore) await new Promise((r) => setTimeout(r, 200))
  }
  return all
}

// ── Venue resolution ─────────────────────────────────────────────────────────

const venueCache = new Map()

async function ensureEventVenue(venueSpec, organizerId) {
  const key = venueSpec.name
  if (venueCache.has(key)) return venueCache.get(key)

  const venueId = await ensureVenue(venueSpec.name, {
    address: venueSpec.address ?? undefined,
    city:    venueSpec.city,
    state:   venueSpec.state,
    zip:     venueSpec.zip ?? undefined,
    lat:     venueSpec.lat ?? undefined,
    lng:     venueSpec.lng ?? undefined,
    website: venueSpec.website ?? ORIGIN,
  })
  if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)
  venueCache.set(key, venueId)
  return venueId
}

// ── Process ──────────────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId) {
  let inserted = 0, skipped = 0
  const cutoff = Date.now() - 86400_000 // skip anything ended > ~1 day ago

  for (const ev of rawEvents) {
    try {
      const title = stripHtml(ev.title ?? '').replace(/\s+/g, ' ').trim()
      if (!title) { skipped++; continue }
      if (!isPublicCommunityEvent(title)) { skipped++; continue }

      const startAt = toEasternIso(ev.start_date)
      if (!startAt) { skipped++; continue }
      if (new Date(startAt).getTime() < cutoff) { skipped++; continue }

      const description = htmlToText(ev.description ?? '') || null
      const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
      const venueSpec = resolveVenueSpec(ev.venue)

      // Strict Summit gate on the resolved venue's city. Clinton → 'in'; a
      // neighbouring Stark-County town would land 'out' (skip) or 'unknown'.
      const geo = classifySummitLocation({ city: venueSpec.city, lat: venueSpec.lat, lng: venueSpec.lng })
      if (geo === 'out') { skipped++; continue }

      const row = {
        title,
        description,
        start_at:        startAt,
        end_at:          ev.all_day ? null : toEasternIso(ev.end_date),
        category:        resolveCategory(title, description ?? ''),
        tags:            parseTagsFromTribe(ev.categories, ev.tags, ['village-of-clinton', 'summit-county', 'clinton']),
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       parseImage(ev.image, ev.description),
        ticket_url:      ev.website || ev.url || null,
        source:          SOURCE_KEY,
        source_id:       buildSourceId(ev),
        status:          geo === 'unknown' ? 'pending_review' : 'published',
        ...(geo === 'unknown' ? { needs_review: true } : {}),
        featured:        ev.featured ?? false,
      }

      const venueId = await ensureEventVenue(venueSpec, organizerId)
      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing event ${ev.id}:`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🏛️  Starting Village of Clinton ingestion…')
  const start = Date.now()
  try {
    const organizerId = await ensureOrganization(ORG_NAME, ORG_DETAILS)

    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skipped } = await processEvents(rawEvents, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: rawEvents.length,
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
