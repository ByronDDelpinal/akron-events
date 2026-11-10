/**
 * scrape-fair-housing-akron.js
 *
 * Fair Housing Contact Service (fairhousingakron.org) — an Akron nonprofit that
 * runs free Renter's Rights and Landlord workshops plus an annual event, mostly
 * at The Well CDC and Akron-area libraries.
 *
 * Platform: Wix Events, read from the server-rendered #wix-warmup-data blob on
 * /event-list via the shared lib/wix-events.js. The site moved from Squarespace
 * to Wix in 2026-09; the old /events?format=json endpoint now answers with the
 * Wix page shell (HTML), which is why this source logged "Unexpected token '<'"
 * every night from 2026-09-18 until this rewrite.
 *
 * GEOGRAPHY (this source needs per-event gating):
 *   Most workshops are in Akron (Summit County), but the series also travels to
 *   Kent (Kent Free Library — Portage County, OUT of scope).
 *     • An event with a real location is gated on its coordinates and city.
 *     • An event with no usable location (Wix "location TBD", or one the
 *       organizer left blank) cannot be gated on a pin, so we scan the title +
 *       description for a recognized city: a NOT_SUMMIT city ("Kent") → out
 *       (dropped); a Summit city ("Akron") → in; neither → pending_review.
 *
 * VENUES: the organizer sometimes types a street address as the Wix location
 * name ("21 W North St"). That is handed to ensureVenue as-is, whose
 * address-named guard resolves it to an existing venue at that address or
 * leaves the event venue-less, rather than minting a venue called "21 W North St".
 *
 * ZERO EVENTS: the widget keeps recent past events in the blob. A page that
 * parses to at least one event object, none of them upcoming, is a healthy
 * quiet calendar and logs success with 0 found. A page with NO event objects
 * at all is indistinguishable from a markup change and logs an error.
 *
 * Usage:   node scripts/scrape-fair-housing-akron.js
 *          node scripts/scrape-fair-housing-akron.js --dry-run
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  enrichWithImageDimensions,
  ensureOrganization,
  ensureVenue,
  linkEventOrganization,
  linkEventVenue,
  logScraperError,
  logUpsertResult,
  stripHtml,
  upsertEventSafe,
} from './lib/normalize.js'
import { fetchWixEvents, normaliseWixEvent, parseWixLocation } from './lib/wix-events.js'
import {
  classifySummitLocation,
  preloadSummitCountyBoundary,
  SUMMIT_COUNTY_CITIES,
  NOT_SUMMIT_COUNTY_CITIES,
} from './lib/summit-county.js'

// ── Configuration ────────────────────────────────────────────────────────────

const SITE_BASE_URL = 'https://www.fairhousingakron.org'
const EVENTS_URL = `${SITE_BASE_URL}/event-list`
const SOURCE_KEY = 'fair_housing_akron'
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'

// ── Location ─────────────────────────────────────────────────────────────────

/**
 * Flatten a Wix event `location` into venue fields, or null when it carries
 * nothing usable: absent, flagged TBD, or with no name, city or coordinates.
 * Exported for tests.
 */
export function parseFairHousingLocation(loc) {
  if (!loc || typeof loc !== 'object' || loc.tbd === true) return null
  const flat = parseWixLocation(loc)
  if (!flat) return null
  const name = typeof flat.name === 'string' ? stripHtml(flat.name).trim() || null : null
  const hasCoords = typeof flat.lat === 'number' && typeof flat.lng === 'number'
  if (!name && !flat.city && !hasCoords) return null
  return {
    name,
    address: flat.address || null,
    city: flat.city || null,
    state: flat.state || null,
    zip: flat.zip || null,
    lat: hasCoords ? flat.lat : null,
    lng: hasCoords ? flat.lng : null,
  }
}

/** Title + description + long-form "about" text of a Wix event, as plain text. */
function eventText(ev) {
  return [ev?.title, ev?.description, ev?.about]
    .filter((s) => typeof s === 'string' && s)
    .map((s) => stripHtml(s))
    .join(' ')
}

/** Find the first recognized city from `citySet` mentioned in `text` (word-bounded). */
function cityMentioned(text, citySet) {
  const t = ` ${String(text || '').toLowerCase()} `
  for (const c of citySet) {
    const re = new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    if (re.test(t)) return c
  }
  return null
}

/**
 * Classify an event 'in' | 'out' | 'unknown'. Prefers the structured location
 * (coordinates + city); when there is none, falls back to scanning the event
 * text for a recognized city (NOT_SUMMIT → out, Summit → in). Exported for tests.
 */
export function classifyEventLocation(ev) {
  const loc = parseFairHousingLocation(ev?.location)
  if (loc && (loc.lat != null || loc.city)) {
    return classifySummitLocation({ lat: loc.lat, lng: loc.lng, city: loc.city })
  }
  const text = eventText(ev)
  if (cityMentioned(text, NOT_SUMMIT_COUNTY_CITIES)) return 'out'
  if (cityMentioned(text, SUMMIT_COUNTY_CITIES)) return 'in'
  return 'unknown'
}

/** True when the event is explicitly free (the workshops all say "FREE"). */
export function isFreeEvent(ev) {
  return /\bfree\b/i.test(eventText(ev))
}

/**
 * True when the event has not finished yet. An event with a published end time
 * stays in until that end passes; one without is judged on its start. Events
 * with no date at all (Wix "schedule TBD") are not upcoming. Exported for tests.
 */
export function isUpcoming(ev, nowMs = Date.now()) {
  const cfg = ev?.scheduling?.config
  if (!cfg || cfg.scheduleTbd || !cfg.startDate) return false
  const start = Date.parse(cfg.startDate)
  if (!Number.isFinite(start)) return false
  const end = cfg.endDate && !cfg.endDateHidden ? Date.parse(cfg.endDate) : NaN
  return (Number.isFinite(end) ? end : start) >= nowMs
}

export function mapCategory() {
  return 'civic'
}

export function mapTags(ev) {
  const tags = ['fair-housing', 'housing', 'akron']
  if (/workshop/i.test(ev?.title || '')) tags.push('workshop')
  return tags
}

/**
 * Build the row for one raw Wix event, or null when it has no title or date.
 * Pure (no I/O), so the whole row shape is testable. Exported for tests.
 */
export function buildRow(ev, geo = classifyEventLocation(ev)) {
  const row = normaliseWixEvent(ev, {
    source: SOURCE_KEY,
    mapCategory,
    mapTags,
    ageRestriction: 'all_ages',
    siteBaseUrl: SITE_BASE_URL,
  })
  if (!row.title || !row.start_at || !row.source_id) return null
  if (isFreeEvent(ev)) { row.price_min = 0; row.price_max = 0 }
  if (geo === 'unknown') { row.status = 'pending_review'; row.needs_review = true }
  return row
}

// ── Process events ───────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId) {
  let inserted = 0, skippedOut = 0, skippedNoData = 0, review = 0
  const venueCache = new Map()

  for (const ev of rawEvents) {
    try {
      const geo = classifyEventLocation(ev)
      if (geo === 'out') { skippedOut++; continue }

      const row = buildRow(ev, geo)
      if (!row) { skippedNoData++; continue }

      // Per-event venue from the structured location. Location-less events
      // publish without a venue.
      let venueId = null
      const loc = parseFairHousingLocation(ev.location)
      if (loc && loc.name) {
        const key = `${loc.name}|${loc.address || ''}`
        if (venueCache.has(key)) {
          venueId = venueCache.get(key)
        } else {
          venueId = await ensureVenue(loc.name, {
            address: loc.address || undefined,
            city: loc.city || 'Akron',
            state: loc.state || 'OH',
            zip: loc.zip || undefined,
            lat: loc.lat ?? undefined,
            lng: loc.lng ?? undefined,
          })
          venueCache.set(key, venueId)
        }
      }

      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) { console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`); skippedNoData++; continue }
      if (venueId) await linkEventVenue(upserted.id, venueId)
      if (organizerId) await linkEventOrganization(upserted.id, organizerId)
      if (geo === 'unknown') review++
      inserted++
    } catch (err) {
      console.warn(`  ⚠ Error processing "${ev?.title}": ${err.message}`)
      skippedNoData++
    }
  }

  return { inserted, skippedOut, skippedNoData, review }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🏠  Starting Fair Housing Contact Service ingestion…')
  if (DRY_RUN) console.log('   [dry-run mode — fetch + parse only, no DB writes]')
  const start = Date.now()

  try {
    await preloadSummitCountyBoundary() // required before any coordinate-based gate

    console.log(`\n🔍  Fetching events from ${EVENTS_URL}…`)
    const all = await fetchWixEvents(EVENTS_URL)
    const events = all.filter((ev) => isUpcoming(ev))
    console.log(`  ${all.length} event(s) on the page → ${events.length} upcoming`)

    if (DRY_RUN) {
      for (const ev of all) {
        const when = ev?.scheduling?.config?.startDate || 'no date'
        console.log(`     • [${isUpcoming(ev) ? classifyEventLocation(ev) : 'past'}] ${ev.title}  (${when})`)
      }
      console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s [dry-run]`)
      return
    }

    if (all.length === 0) {
      // No event objects at all: a markup change looks exactly like this.
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: 'error',
        errorMessage: `Wix page fetched but carried 0 event objects — the #wix-warmup-data blob at ${EVENTS_URL} may have changed shape`,
        eventsFound: 0,
        durationMs: Date.now() - start,
      })
      console.warn('  ⚠ No event objects on the page — logged as an error run.')
      return
    }

    const organizerId = await ensureOrganization('Fair Housing Contact Service', {
      website: SITE_BASE_URL,
      description:
        'Fair Housing Contact Service is an Akron nonprofit providing housing ' +
        'discrimination assistance, counseling, and free tenant/landlord education workshops.',
    })

    const { inserted, skippedOut, skippedNoData, review } = await processEvents(events, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skippedOut + skippedNoData, {
      eventsFound: events.length,
      durationMs: Date.now() - start,
    })
    console.log(
      `\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ` +
      `${inserted} upserted (${review} to review), ${skippedOut} out-of-county, ${skippedNoData} skipped`,
    )
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

export { SITE_BASE_URL, SOURCE_KEY, EVENTS_URL }
