/**
 * scrape-explore-hudson.js
 *
 * Source:   Explore Hudson — Hudson Area Chamber of Commerce event calendar
 *           (https://www.explorehudson.com/events/eventcalendar)
 * Platform: ChamberMate (chambermate.com) — a React SPA whose event calendar
 *           is server-fed by a public JSON API at api.chambermate.com.
 *
 * Why this strategy:
 *   The public page renders nothing without JS (empty `#root`), so HTML
 *   scraping is a dead end. The SPA calls a clean, un-authenticated JSON
 *   endpoint that returns the full event list with structured dates, rich
 *   text, addresses and image keys — far better than parsing rendered DOM.
 *   Discovered by observing the site's own XHR:
 *     GET {CORE}/biz/webPresence/getEventsInfo
 *         ?websiteShorthand=explorehudson
 *         &websiteDomain=www.explorehudson.com
 *         &isPortal=false&includeCategories=true
 *         &includePastEvents=false&rowCount=200
 *   where CORE = https://api.chambermate.com/core (from the site's
 *   /envConfig.js → PSX_CORE_API_URL).
 *
 * Aggregator note:
 *   This is the Hudson chamber's calendar — a light aggregator listing member
 *   businesses' events across town. Per-event venues therefore vary, so every
 *   event is gated with classifySummitLocation() on its resolved city:
 *   'out' → skip, 'unknown' → pending_review, 'in' → published. Hudson is in
 *   Summit County, so most events publish. Some events may also appear on our
 *   direct Hudson sources (city_of_hudson, hudson_library); downstream
 *   dedupe/suppression handles any overlap.
 *
 * Feed quirks handled:
 *   • Dates (`startDateTime`/`endDateTime`) are naive local Eastern strings
 *     ("2026-07-14T16:00:00"); converted with easternToIso (DST-aware).
 *   • Location comes in three shapes keyed by `addressCode`:
 *       - "Other Address"      → real street address in `address` (the venue
 *                                name lives in `address.name`, often null).
 *       - "Warehouse Address"  → the chamber's own PO Box fallback (organizer
 *                                left location blank). Not a real venue.
 *       - "Freeform Custom Text" → a venue name string in `customAddress`,
 *                                with NO street/city.
 *     To recover missing data we cross-reference within the same feed: a
 *     street→name index fills blank venue names, and a name→address index
 *     recovers a city (hence the geo gate) for freeform-text venues.
 *   • `admission` is free-text ("Free" / "0" / null) — mapped to price 0 only
 *     when it unambiguously says free; otherwise left null (never assumed).
 *   • Per-event images are private S3 objects reached through a stable
 *     redirect endpoint ({CORE}/shared/query/avatarDirectView); we store that
 *     URL (it re-signs on every load) rather than the short-lived S3 link.
 *
 * Usage:
 *   node scripts/scrape-explore-hudson.js
 *   node scripts/scrape-explore-hudson.js --debug   # verbose per-event log
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  preloadSummitCountyBoundary,
  classifySummitLocation,
} from './lib/summit-county.js'
import {
  easternToIso,
  stripHtml,
  htmlToText,
  ensureVenue,
  linkEventVenue,
  enrichWithImageDimensions,
  upsertEventSafe,
  logUpsertResult,
  logScraperError,
} from './lib/normalize.js'

const SOURCE = 'explore_hudson'
const DEBUG  = process.argv.includes('--debug')

// api.chambermate.com base for the "core" service (from site /envConfig.js).
const CORE_API = 'https://api.chambermate.com/core'

// ChamberMate resolves the tenant from these query params, not a header.
const WEBSITE_SHORTHAND = 'explorehudson'
const WEBSITE_DOMAIN    = 'www.explorehudson.com'

// Don't ingest events implausibly far out (the feed is naturally bounded to a
// forward window, but this is a cheap defensive cap).
const HORIZON_DAYS = 400
// Keep events that ended within the last day (still worth showing same-day).
const PAST_GRACE_MS = 24 * 60 * 60 * 1000

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://www.explorehudson.com',
  'Referer': 'https://www.explorehudson.com/',
}

// ── URL builders ─────────────────────────────────────────────────────────────

/** The JSON events endpoint for the Hudson chamber. */
export function buildEventsUrl({ rowCount = 200 } = {}) {
  const qs = new URLSearchParams({
    websiteShorthand: WEBSITE_SHORTHAND,
    websiteDomain:    WEBSITE_DOMAIN,
    isPortal:         'false',
    includeCategories: 'true',
    includePastEvents: 'false',
    rowCount:         String(rowCount),
  })
  return `${CORE_API}/biz/webPresence/getEventsInfo?${qs.toString()}`
}

/**
 * Stable image URL for an event. ChamberMate's avatarDirectView 302-redirects
 * to a short-lived signed S3 object; we store the redirect URL because it is
 * stable (keyed by the event's activityKey + avatarStorageKey) and re-signs on
 * every request. Our image pipeline follows redirects to read dimensions.
 * Returns null when the event has no avatar (noFallback → 404 rather than a
 * generic placeholder, which enrichWithImageDimensions treats as "no image").
 */
export function buildImageUrl(raw) {
  if (!raw?.avatarStorageKey || !raw?.activityKey) return null
  const key = encodeURIComponent(raw.activityKey)
  // avatarStorageKey is already URL-safe (e.g. "EVENT/<uuid>"); the slash is a
  // legal query-value character and the origin expects it unescaped.
  return `${CORE_API}/shared/query/avatarDirectView` +
    `?entityKey=${key}&entityName=Event&avatarStorageKey=${raw.avatarStorageKey}&noFallback=true`
}

// ── Date / time ──────────────────────────────────────────────────────────────

/**
 * Convert the feed's naive-Eastern datetime strings to UTC ISO.
 * Returns { start_at, end_at }. end_at is null when the event has no end time
 * (`noEndTime`) or the field is missing. `noTimes` (all-day) events keep only
 * the date — a documented midnight fallback, used only when the feed itself
 * declares the event time-less.
 */
export function parseDateTimes(raw) {
  const start = raw?.startDateTime
  if (!start) return { start_at: null, end_at: null }

  const startDate = String(start).slice(0, 10)
  const startTime = raw?.noTimes ? '' : String(start).slice(11)
  const start_at  = easternToIso(startDate, startTime)

  let end_at = null
  if (!raw?.noEndTime && !raw?.noTimes && raw?.endDateTime) {
    const endDate = String(raw.endDateTime).slice(0, 10)
    const endTime = String(raw.endDateTime).slice(11)
    end_at = easternToIso(endDate, endTime)
  }
  return { start_at, end_at }
}

/** True when an event should be ingested given its resolved times + now. */
export function isIngestable(start_at, end_at, now = Date.now()) {
  if (!start_at) return false
  const start = Date.parse(start_at)
  if (Number.isNaN(start)) return false
  const effectiveEnd = end_at ? Date.parse(end_at) : start
  if (!Number.isNaN(effectiveEnd) && effectiveEnd < now - PAST_GRACE_MS) return false
  if (start > now + HORIZON_DAYS * 86_400_000) return false
  return true
}

// ── Price ────────────────────────────────────────────────────────────────────

/**
 * Interpret the free-text `admission` field. Returns { price_min, price_max }.
 * Only an unambiguous "free"/"0" sets 0; a dollar amount is parsed; anything
 * else (null, prose, a range we can't safely split) leaves both null — we
 * never assume free or invent a number.
 */
export function parsePrice(admission) {
  if (admission == null) return { price_min: null, price_max: null }
  const s = String(admission).trim().toLowerCase()
  if (!s) return { price_min: null, price_max: null }
  if (s === 'free' || s === '0' || s === '$0' || s === '$0.00' || s === 'no charge') {
    return { price_min: 0, price_max: 0 }
  }
  // A single clean dollar amount like "$25" or "25".
  const m = s.match(/^\$?\s*(\d+(?:\.\d{1,2})?)$/)
  if (m) {
    const v = parseFloat(m[1])
    if (Number.isFinite(v)) return { price_min: v, price_max: v }
  }
  return { price_min: null, price_max: null }
}

// ── Location ─────────────────────────────────────────────────────────────────

/** Normalize a street string into a stable index key. */
function streetKey(street) {
  return String(street ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** True for the chamber's PO-Box fallback address (not a real venue). */
function isPoBox(street) {
  return /\bp\.?\s*o\.?\s*box\b/i.test(String(street ?? '')) ||
         /\bpost\s+office\s+box\b/i.test(String(street ?? ''))
}

/**
 * Build two cross-reference indexes over the raw feed so events with partial
 * location data can borrow from siblings that carry the full record:
 *   • byStreet: normalized street1 → venue name   (fills blank `address.name`)
 *   • byName:   lower(name) → {address,city,state,zip}
 *               (recovers a city/address for freeform-text venues)
 * Only named, non-PO-Box, street-bearing rows seed the indexes.
 */
export function buildLocationIndexes(rawEvents = []) {
  const byStreet = new Map()
  const byName   = new Map()
  for (const raw of rawEvents) {
    const a = raw?.address
    if (!a || !a.street1 || isPoBox(a.street1)) continue
    const name = a.name ? stripHtml(String(a.name)) : null
    if (name) {
      const sk = streetKey(a.street1)
      if (sk && !byStreet.has(sk)) byStreet.set(sk, name)
      const nk = name.toLowerCase()
      if (!byName.has(nk)) {
        byName.set(nk, {
          address: a.street1,
          city:    a.city ?? null,
          state:   a.stateCode ?? a.stateName ?? null,
          zip:     a.zip ?? null,
        })
      }
    }
  }
  return { byStreet, byName }
}

/**
 * Resolve an event's location into { venueName, address, city, state, zip }.
 * venueName/address are null when the source has no real venue (PO-Box
 * fallback, or a bare street with no name we can recover). city drives the
 * Summit-County gate, so we preserve it wherever the feed provides it.
 */
export function resolveLocation(raw, indexes = { byStreet: new Map(), byName: new Map() }) {
  const empty = { venueName: null, address: null, city: null, state: null, zip: null }
  const a = raw?.address

  // Real structured address.
  if (a && a.street1) {
    const city = a.city ?? null
    const state = a.stateCode ?? a.stateName ?? null
    const zip = a.zip ?? null
    if (isPoBox(a.street1)) {
      // Chamber PO-Box fallback: keep the (real) city for the geo gate, but
      // don't mint a venue or store a PO-Box address.
      return { venueName: null, address: null, city, state, zip }
    }
    let venueName = a.name ? stripHtml(String(a.name)) : null
    if (!venueName) {
      const recovered = indexes.byStreet?.get(streetKey(a.street1))
      if (recovered) venueName = recovered
    }
    return { venueName, address: a.street1, city, state, zip }
  }

  // Freeform custom text — a venue name string, no structured address.
  const custom = raw?.customAddress ? stripHtml(String(raw.customAddress)) : null
  if (custom) {
    const recovered = indexes.byName?.get(custom.toLowerCase())
    if (recovered) {
      return {
        venueName: custom,
        address: recovered.address,
        city: recovered.city,
        state: recovered.state,
        zip: recovered.zip,
      }
    }
    // No address recoverable → geo unknown (→ review queue downstream).
    return { venueName: custom, address: null, city: null, state: null, zip: null }
  }

  return empty
}

// ── Event row ────────────────────────────────────────────────────────────────

/**
 * Build the description from the plain-text field, falling back to the
 * (usually empty) rich HTML field. Returns null when nothing usable exists.
 */
function buildDescription(raw) {
  const plain = raw?.eventDescription ? stripHtml(String(raw.eventDescription)) : ''
  if (plain) return plain
  const rich = raw?.eventFullDescription ? htmlToText(String(raw.eventFullDescription)).trim() : ''
  return rich || null
}

/**
 * Map a raw feed event + resolved location + geo verdict into an upsert row.
 * `geo` is 'in' | 'unknown' (an 'out' event is dropped before this is called).
 * Returns null when the event lacks a parseable start time.
 */
export function toEventRow(raw, indexes, geo) {
  const { start_at, end_at } = parseDateTimes(raw)
  if (!start_at) return null

  const { price_min, price_max } = parsePrice(raw?.admission)
  const title = raw?.eventName ? stripHtml(String(raw.eventName)) : ''
  // Cancelled/postponed events are left in the chamber feed with a title marker
  // rather than removed. Title-scoped drop per the shared convention.
  if (/\bcancel?led\b|\bpostponed\b/i.test(title)) return null

  return {
    title,
    description:     buildDescription(raw),
    start_at,
    end_at,
    tags:            [],
    price_min,
    price_max,
    age_restriction: 'not_specified',
    image_url:       buildImageUrl(raw),
    source_url:      raw?.eventDetailUrl ?? null,
    ticket_url:      raw?.registrationUrl ?? raw?.eventUrl ?? raw?.learnMoreURL ?? null,
    source:          SOURCE,
    source_id:       String(raw?.activityKey ?? ''),
    // Unknown locality → review queue (never the public calendar); an admin
    // publish locks status via manual_overrides. 'in' → published.
    status:          geo === 'unknown' ? 'pending_review' : 'published',
    needs_review:    geo === 'unknown' ? true : undefined,
    featured:        false,
  }
}

/** Mint/link the venue for a resolved location, or null when there is none. */
async function upsertVenue(location) {
  if (!location?.venueName) return null
  return ensureVenue(location.venueName, {
    address: location.address ?? null,
    city:    location.city ?? null,
    state:   location.state ?? 'OH',
    zip:     location.zip ?? null,
    parking_type: 'unknown',
  })
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchEvents() {
  const url = buildEventsUrl()
  const res = await fetch(url, { headers: REQUEST_HEADERS })
  if (!res.ok) throw new Error(`getEventsInfo HTTP ${res.status}`)
  const json = await res.json()
  const events = json?.data?.events
  if (!Array.isArray(events)) throw new Error('unexpected response shape (no data.events array)')
  return events
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Explore Hudson scrape…')
  const startMs = Date.now()

  try {
    await preloadSummitCountyBoundary()

    const rawEvents = await fetchEvents()
    console.log(`   Fetched ${rawEvents.length} events from the chamber feed.`)

    const indexes = buildLocationIndexes(rawEvents)

    let inserted = 0, updated = 0, skipped = 0
    let skippedOut = 0, pendingReview = 0

    for (const raw of rawEvents) {
      try {
        const location = resolveLocation(raw, indexes)
        const geo = classifySummitLocation({ city: location.city })

        if (geo === 'out') {
          if (DEBUG) console.log(`  ⏭  out-of-county: "${raw.eventName}" (${location.city})`)
          skippedOut++
          skipped++
          continue
        }

        const { start_at, end_at } = parseDateTimes(raw)
        if (!isIngestable(start_at, end_at)) {
          if (DEBUG) console.log(`  ⏭  past/too-far: "${raw.eventName}" (${start_at})`)
          skipped++
          continue
        }

        const row = toEventRow(raw, indexes, geo)
        if (!row || !row.title) { skipped++; continue }
        if (geo === 'unknown') pendingReview++

        const venueId = await upsertVenue(location)
        const enriched = await enrichWithImageDimensions(row)
        const { data: upserted, error, isNew } = await upsertEventSafe(enriched)

        if (error) {
          console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`)
          skipped++
          continue
        }
        if (venueId) await linkEventVenue(upserted.id, venueId)
        if (isNew) inserted++
        else updated++

        if (DEBUG) {
          console.log(`  ✓ ${geo === 'unknown' ? '[review] ' : ''}${row.title} — ${row.start_at}` +
            `${location.venueName ? ` @ ${location.venueName}` : ''}`)
        }
      } catch (err) {
        console.warn(`  ⚠ Error processing "${raw?.eventName}": ${err.message}`)
        skipped++
      }
    }

    console.log(
      `\n✅  Explore Hudson: ${inserted} inserted, ${updated} updated, ${skipped} skipped ` +
      `(${skippedOut} out-of-county, ${pendingReview} → review).`,
    )
    await logUpsertResult(SOURCE, inserted, updated, skipped, { durationMs: Date.now() - startMs })
  } catch (err) {
    console.error(`❌  Explore Hudson scrape failed: ${err.message}`)
    await logScraperError(SOURCE, err, startMs)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
