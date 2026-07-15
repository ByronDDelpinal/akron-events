/**
 * scrape-barnes-noble-akron.js
 *
 * Barnes & Noble — Akron store (store #2902, 4015 Medina Road, Akron OH 44333,
 * the Montrose/Fairlawn location). Ingests the store's in-house programming:
 * storytimes, book clubs, and author signings.
 *
 * Platform / strategy:
 *   The public store page (stores.barnesandnoble.com/store/2902) is a Next.js
 *   SPA that fetches events from an internal JSON endpoint:
 *     GET /locator-api/v1/events?lat=<lat>&lng=<lng>&size=<n>
 *   We hit that endpoint directly (server-rendered HTML has no event list, and
 *   the page host stalls plain GET requests behind bot protection, so scraping
 *   the JSON API is both cleaner and more reliable).
 *
 * Feed quirks (important):
 *   - The API's `storeId` query param is IGNORED. The endpoint returns events
 *     for stores NEAR a lat/lng (default Kansas City when no geo is supplied),
 *     sorted by distance. We therefore query with the Akron store's own
 *     coordinates and filter the response down to `storeId === 2902`.
 *   - Each event object already carries the full store address, a concrete
 *     `date` + `time`/`time24`, an event type, and a `descriptionText`.
 *   - Recurring programs (weekly storytime, monthly book clubs) arrive as
 *     discrete occurrences, each with its own stable `eventId` — no RRULE
 *     expansion needed.
 *   - `largeIcon` is only a generic category placeholder (a stock SVG/JPG per
 *     event type), never an event-specific image, so we leave image_url null
 *     and let the shared fallback-image system handle it.
 *   - The API exposes no end time and no price.
 *
 * Usage:
 *   node scripts/scrape-barnes-noble-akron.js
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
  easternToIso,
  upsertEventSafe,
  enrichWithImageDimensions,
  ensureVenue,
  ensureOrganization,
  linkEventVenue,
  linkEventOrganization,
  linkOrganizationVenue,
} from './lib/normalize.js'

// ── Constants ─────────────────────────────────────────────────────────────
export const SOURCE = 'barnes_noble_akron'
const STORE_ID = 2902
// The events API ignores its storeId param, so we query by the store's own
// coordinates and filter the result to STORE_ID (see file header).
const STORE_LAT = 41.136137
const STORE_LNG = -81.641904
const EVENTS_API = 'https://stores.barnesandnoble.com/locator-api/v1/events'
const STORE_URL = 'https://stores.barnesandnoble.com/store/2902'
const PAGE_SIZE = 1000
const HORIZON_DAYS = 180

const STORE = {
  name:    'Barnes & Noble - Akron',
  address: '4015 Medina Road',
  city:    'Akron',
  state:   'OH',
  zip:     '44333',
  lat:     STORE_LAT,
  lng:     STORE_LNG,
}

// ── Date helpers (anchored to America/New_York, never local Date) ───────────

/** Today's date as 'YYYY-MM-DD' in Eastern time. */
export function easternTodayStr(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/** Add `days` (may be negative) to a 'YYYY-MM-DD' string; returns 'YYYY-MM-DD'. */
export function addDaysStr(str, days) {
  const [y, m, d] = str.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d, 12)) // noon UTC dodges DST edges
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

// ── Pure parsers (exported for tests) ───────────────────────────────────────

/** Public detail-page URL for a B&N event id. */
export function eventUrl(eventId) {
  return `https://stores.barnesandnoble.com/event/${encodeURIComponent(eventId)}`
}

/** Storytimes are the store's kid-programmed events → family. */
export function isStorytime(raw) {
  return Boolean(
    raw.isStoryTime ||
    (raw.types || []).some(t => t.typeCode === 'ST')
  )
}

/**
 * Build the tag list. Every B&N event is book/literary programming, so we tag
 * 'books' plus the human-readable event type, and mark storytimes for the kids
 * audience filter.
 */
export function buildTags(raw) {
  const tags = ['books']
  for (const t of raw.types || []) {
    if (t.text) tags.push(t.text.toLowerCase())
  }
  if (isStorytime(raw)) tags.push('storytime', 'kids')
  return [...new Set(tags)]
}

/**
 * Keep only genuine, current, in-store events for THIS store:
 *   - storeId matches the Akron store,
 *   - not a national/virtual (store-agnostic) listing,
 *   - starts no earlier than yesterday and within the horizon.
 * Pure so the filtering rules are unit-testable.
 */
export function filterStoreEvents(content, {
  storeId = STORE_ID,
  todayStr = easternTodayStr(),
  horizonDays = HORIZON_DAYS,
} = {}) {
  const cutoff = addDaysStr(todayStr, -1)
  const maxStr = addDaysStr(todayStr, horizonDays)
  return (content || []).filter(e => {
    if (e.storeId !== storeId) return false
    if (e.isNationalEvent || e.isVirtualEvent) return false
    if (!e.date) return false
    if (e.date < cutoff) return false
    if (e.date > maxStr) return false
    return true
  })
}

/**
 * Map a raw API event to an Akron Pulse event row. Returns null when the
 * date/time cannot be resolved (never silently synthesizes a time — the API
 * always supplies one, so a missing time means a malformed record we skip).
 */
export function mapEvent(raw) {
  const title = stripHtml(raw.name || '')
  if (!title) return null

  // Prefer the explicit 24-hour clock; fall back to the "7:00 PM" string.
  const timeToken = raw.time24 || raw.time || ''
  const startAt = easternToIso(raw.date, timeToken)
  if (!startAt) return null

  const description = stripHtml(raw.descriptionText || '') || null

  return {
    title,
    description,
    start_at:        startAt,
    end_at:          null, // API exposes no end time
    // Every listing here is the bookstore's literary programming.
    category:        'learning',
    // Storytimes are explicitly kid-programmed; undefined (not false) elsewhere
    // so text inference can still flag a family event we missed.
    is_family:       isStorytime(raw) ? true : undefined,
    tags:            buildTags(raw),
    // Source states neither price — never assume free.
    price_min:       null,
    price_max:       null,
    age_restriction: 'not_specified',
    // largeIcon is only a generic category placeholder — leave null for fallback.
    image_url:       null,
    ticket_url:      eventUrl(raw.eventId),
    source:          SOURCE,
    source_id:       String(raw.eventId),
    status:          'published',
    featured:        false,
  }
}

// ── Fetch ───────────────────────────────────────────────────────────────────

async function fetchEvents() {
  const url = `${EVENTS_API}?lat=${STORE_LAT}&lng=${STORE_LNG}&size=${PAGE_SIZE}`
  console.log(`\n🔍  Fetching Barnes & Noble events near store #${STORE_ID}…`)
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`B&N events API error ${res.status}: ${await res.text()}`)
  const data = await res.json()
  const content = Array.isArray(data.content) ? data.content : []
  console.log(`  Received ${content.length} nearby events (all stores)`)
  return content
}

// ── Venue / organization ─────────────────────────────────────────────────────

async function ensureOrg() {
  return ensureOrganization('Barnes & Noble', {
    website:     STORE_URL,
    description: 'National bookseller whose Akron store hosts storytimes, book clubs, and author signings.',
  })
}

async function ensureStoreVenue(orgId) {
  const venueId = await ensureVenue(STORE.name, {
    address:     STORE.address,
    city:        STORE.city,
    state:       STORE.state,
    zip:         STORE.zip,
    lat:         STORE.lat,
    lng:         STORE.lng,
    website:     STORE_URL,
    description: 'Barnes & Noble bookstore in the Montrose area of Akron, hosting storytimes, book clubs, and author events.',
  })
  if (venueId && orgId) await linkOrganizationVenue(orgId, venueId)
  return venueId
}

// ── Process ───────────────────────────────────────────────────────────────

async function processEvents(rawEvents, venueId, orgId) {
  let inserted = 0, skipped = 0

  for (const raw of rawEvents) {
    try {
      const row = mapEvent(raw)
      if (!row) { skipped++; continue }

      const enriched = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enriched)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, orgId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${raw?.name}":`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Barnes & Noble (Akron) ingestion…')
  const start = Date.now()

  try {
    const orgId    = await ensureOrg()
    const venueId  = await ensureStoreVenue(orgId)
    const content  = await fetchEvents()
    const events   = filterStoreEvents(content)
    console.log(`\n📥  ${events.length} events at store #${STORE_ID} within horizon`)

    const { inserted, skipped } = await processEvents(events, venueId, orgId)
    await logUpsertResult(SOURCE, inserted, 0, skipped, {
      eventsFound: events.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — inserted ${inserted}, skipped ${skipped}`)
  } catch (err) {
    await logScraperError(SOURCE, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly; importing for tests exposes the pure parsers
// without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
