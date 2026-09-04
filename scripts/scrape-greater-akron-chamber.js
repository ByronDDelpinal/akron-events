/**
 * scrape-greater-akron-chamber.js
 *
 * Source:   Greater Akron Chamber (greaterakronchamber.org) member event
 *           calendar, published through its member portal
 *           (members.greaterakronchamber.org/atlas/events).
 * Platform: GrowthZone (formerly ChamberMaster/WebLink) — the portal's SPA
 *           reads a shared, un-authenticated JSON API at
 *           api-internal.weblinkconnect.com, tenant-scoped by an `x-tenant`
 *           header. Shared fetch/shape helpers live in lib/growthzone.js
 *           (mirrors the lib/runsignup.js split: a tenant-parameterized
 *           platform module + a thin per-chamber scraper).
 *
 * Why this strategy:
 *   Same rationale as Explore Hudson (see scrape-explore-hudson.js): the
 *   public page is a JS-hydrated SPA, but its own XHR calls a clean JSON
 *   endpoint with structured dates, addresses, and a fee schedule — far
 *   better than parsing rendered DOM.
 *
 * Aggregator note:
 *   This is the Greater Akron Chamber's own member calendar — a light
 *   aggregator listing member businesses' networking events, workshops, and
 *   the chamber's own programming across the Akron area. Per-event venues
 *   therefore vary (member offices, hotels, restaurants, other venues we
 *   already scrape directly), so every event is gated with
 *   classifySummitLocation() on its resolved coordinates/city: 'out' → skip,
 *   'unknown' → pending_review, 'in' → published.
 *
 * Feed quirks handled:
 *   • `StartDateTimeUtc`/`EndDateTimeUtc` are already UTC (see
 *     growthZoneStartIso/EndIso in lib/growthzone.js) — never `easternToIso`
 *     these, only the IsAllDay calendar-date fallback below.
 *   • `IsAllDay: true` events carry no real time-of-day; we take the
 *     `StartDate` field's calendar-date portion (the feed's own day bucket,
 *     stable across all rows regardless of the event's real time) and mint a
 *     noon-ET placeholder via easternToIso, disclosed in the description via
 *     DATE_ONLY_TIME_NOTE (see scripts/lib/ics.js).
 *   • `Venue: "Online - Virtual Event"` doesn't match any generic virtual-venue
 *     guard elsewhere in the codebase, so it's matched here directly
 *     (/^online\b|\bvirtual\b/i) and skipped before a venue is ever minted —
 *     counted separately in the run summary.
 *   • Two curated venues are reachable under several member-facing display
 *     names (the space itself was renamed, or the chamber names its own
 *     event space inconsistently). VENUE_ALIASES folds those onto the
 *     canonical row: the Business Commons of Cuyahoga Falls's Ratliff space
 *     resolves to the EXISTING curated venue by name only (ensureVenue
 *     overwrites address/city/zip/lat/lng/description/website on an existing
 *     row, so passing stale details would clobber the curated data); the
 *     "7 17 (Credit Union) Event Space at GAC" names resolve to a NEW venue
 *     at the chamber's own office, where passing full details is safe.
 *   • Fee schedules (`Items[]`) mix real admission tiers with sponsorship and
 *     reserved-table line items that are technically `IsPublic: true` and
 *     priced — growthZonePriceRange() excludes anything whose description
 *     matches /sponsor|table/i so a $3,500 "Presenting Sponsor" tier never
 *     becomes the displayed price.
 *   • Descriptions end in the chamber's standing sponsor-logo block and a
 *     boilerplate photo/video consent notice — both stripped by
 *     cleanGrowthZoneDescription() before the shared 2000-char clamp.
 *   • Members-only events (`MembersOnly: true`) are not public content and
 *     are skipped before a venue/detail fetch, counted separately.
 *
 * Usage:
 *   node scripts/scrape-greater-akron-chamber.js
 *   node scripts/scrape-greater-akron-chamber.js --debug   # verbose per-event log
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
import { makeWindowFilter } from './lib/event-window.js'
import { withDateOnlyTimeNote } from './lib/ics.js'
import {
  easternToIso,
  stripHtml,
  ensureVenue,
  ensureOrganization,
  linkEventVenue,
  linkEventOrganization,
  enrichWithImageDimensions,
  upsertEventSafe,
  logUpsertResult,
  logScraperError,
} from './lib/normalize.js'
import {
  fetchGrowthZoneEvents,
  fetchGrowthZoneDetail,
  growthZoneStartIso,
  growthZoneEndIso,
  growthZonePriceRange,
  cleanGrowthZoneDescription,
} from './lib/growthzone.js'

const SOURCE = 'greater_akron_chamber'
const DEBUG  = process.argv.includes('--debug')

// GrowthZone tenant id for the Greater Akron Chamber's Atlas portal.
const TENANT = 'AkronOHCOC'

/** Public member-portal URL for an event, used for both source_url and ticket_url. */
const PUBLIC_EVENT_URL = (id) => `https://members.greaterakronchamber.org/atlas/events/${id}/details`

const ORG_NAME = 'Greater Akron Chamber'

// Don't ingest events implausibly far out. The list fetch itself is windowed
// to the same horizon (see fetchGrowthZoneEvents), this is the defensive
// per-event re-check shared with the other calendar scrapers.
const HORIZON_DAYS = 400
// Keep events that ended within the last day (still worth showing same-day).
const PAST_GRACE_MS = 24 * 60 * 60 * 1000

const isWithinWindow = makeWindowFilter({ horizonDays: HORIZON_DAYS, pastGraceMs: PAST_GRACE_MS })

// ── Location ─────────────────────────────────────────────────────────────

// "Online - Virtual Event" and similar — no generic virtual-venue guard in
// normalize.js matches this feed's exact phrasing, so it's matched here.
const VIRTUAL_VENUE_RE = /^online\b|\bvirtual\b/i

// Scraper-local venue-name aliases, applied before ensureVenue(). Keyed on
// lowercased, trimmed display name. See the module docblock for why the
// Business Commons aliases carry NO details (existing curated venue — passing
// details would let ensureVenue overwrite the curated address/coords) while
// the 7 17 aliases carry full details (a new venue, safe to seed).
const VENUE_ALIASES = new Map([
  ['the ratliff and company event space at the business commons of cuyahoga falls',
    { name: 'The Business Commons of Cuyahoga Falls' }],
  ['the business commons of cuyahoga falls - ratliff event space',
    { name: 'The Business Commons of Cuyahoga Falls' }],
  ['7 17 event space at the gac',
    { name: 'Greater Akron Chamber', address: '388 S Main St Ste 205', city: 'Akron', state: 'OH', zip: '44311' }],
  ['7 17 credit union event space at gac',
    { name: 'Greater Akron Chamber', address: '388 S Main St Ste 205', city: 'Akron', state: 'OH', zip: '44311' }],
])

/**
 * Resolve a raw list event's location into
 * { venueName, address, city, state, zip, isVirtual }.
 * venueName is null for a blank Venue field or a virtual event (isVirtual
 * true in the latter case) — callers skip virtual events before ever
 * minting a venue.
 */
export function resolveLocation(raw) {
  const rawName = raw?.Venue ? stripHtml(String(raw.Venue)).trim() : ''

  if (!rawName) {
    return {
      venueName: null, address: null,
      city: raw?.City || null, state: raw?.State || null, zip: raw?.Zip || null,
      isVirtual: false,
    }
  }

  if (VIRTUAL_VENUE_RE.test(rawName)) {
    return { venueName: null, address: null, city: null, state: null, zip: null, isVirtual: true }
  }

  const alias = VENUE_ALIASES.get(rawName.toLowerCase())
  if (alias) {
    return {
      venueName: alias.name,
      address: alias.address ?? null,
      city: alias.city ?? null,
      state: alias.state ?? null,
      zip: alias.zip ?? null,
      isVirtual: false,
    }
  }

  const address1 = raw?.Address1 ? String(raw.Address1).trim() : ''
  const address2 = raw?.Address2 ? String(raw.Address2).trim() : ''
  const address = [address1, address2].filter(Boolean).join(', ') || null

  return {
    venueName: rawName,
    address,
    city: raw?.City || null,
    state: raw?.State || null,
    zip: raw?.Zip || null,
    isVirtual: false,
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

// ── Category ─────────────────────────────────────────────────────────────

const CIVIC_TYPE_RE =
  /networking|after\s*5|ribbon\s*cutting|annual\s*meeting|general\s*membership|investor|government\s*affairs|\bnfp\b|30\s*ftf/i
const LEARNING_TYPE_RE =
  /workshop|seminar|training|academy|series|summit|conference|small\s*business|\bwnli\b|morning\s*buzz|economic\s*outlook|conxusneo|business\s*owner/i
const SPORTS_TYPE_RE = /golf\s*outing/i

/**
 * Map a raw event's EventType (falling back to title/description text) to a
 * category HINT — resolveEventCategories() in normalize.js prepends this to
 * the inferred categories, it never overrides a confident classification.
 * Returns undefined when nothing matches (source-default / text inference
 * decide instead).
 */
export function mapCategory(raw, title, descr) {
  for (const s of [raw?.EventType, title, descr]) {
    const text = String(s ?? '')
    if (!text) continue
    if (SPORTS_TYPE_RE.test(text)) return 'sports'
    if (CIVIC_TYPE_RE.test(text)) return 'civic'
    if (LEARNING_TYPE_RE.test(text)) return 'learning'
  }
  return undefined
}

// ── Event row ────────────────────────────────────────────────────────────

/**
 * Build the upsert row from a raw list event + its fetched detail + the geo
 * verdict. `geo` is 'in' | 'unknown' (an 'out' event is dropped before this
 * is called). Returns null when the event lacks a parseable start time or is
 * cancelled/postponed.
 */
export function toEventRow(raw, detail, geo) {
  const title = raw?.EventName ? stripHtml(String(raw.EventName)) : ''
  if (!title) return null
  // Cancelled/postponed events stay in the feed with a title marker rather
  // than being removed. Title-scoped drop per the shared convention.
  if (/\bcancel?led\b|\bpostponed\b/i.test(title)) return null

  const isAllDay = Boolean(detail?.IsAllDay ?? raw?.IsAllDay)

  let start_at, end_at
  if (isAllDay) {
    // No real time-of-day: take the feed's own calendar-date bucket
    // (StartDate's date portion is stable across rows regardless of the
    // event's actual start time) and mint a documented noon-ET placeholder.
    const dateStr = String(detail?.StartDate ?? raw?.StartDate ?? '').slice(0, 10)
    start_at = dateStr ? easternToIso(dateStr, '12:00') : null
    end_at = null
  } else {
    start_at = growthZoneStartIso(detail ?? raw)
    end_at = growthZoneEndIso(detail ?? raw)
  }
  if (!start_at) return null

  let description = cleanGrowthZoneDescription(detail?.Descr)
  if (isAllDay) description = withDateOnlyTimeNote(description)

  const { price_min, price_max } = growthZonePriceRange(detail?.Items)
  const category = mapCategory(raw, title, description)

  return {
    title,
    description,
    start_at,
    end_at,
    tags: [],
    price_min,
    price_max,
    age_restriction: 'not_specified',
    image_url:  null,
    source_url: PUBLIC_EVENT_URL(raw?.EventId),
    ticket_url: PUBLIC_EVENT_URL(raw?.EventId),
    source:     SOURCE,
    source_id:  String(raw?.EventId ?? ''),
    category,
    // Unknown locality → review queue (never the public calendar); an admin
    // publish locks status via manual_overrides. 'in' → published.
    status:       geo === 'unknown' ? 'pending_review' : 'published',
    needs_review: geo === 'unknown' ? true : undefined,
    featured:     false,
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log('🚀  Starting Greater Akron Chamber scrape…')
  const startMs = Date.now()

  try {
    await preloadSummitCountyBoundary()

    const rawEvents = await fetchGrowthZoneEvents({ tenant: TENANT, windowDays: HORIZON_DAYS })
    console.log(`   Fetched ${rawEvents.length} events from the chamber feed.`)

    // The chamber is the organizer of record for every event on its own
    // calendar (member businesses host individual sessions, but the GAC
    // convenes and publishes the calendar itself) — resolved once, not
    // per-event; ensureOrganization is fill-only against the existing row.
    const orgId = await ensureOrganization(ORG_NAME)

    let inserted = 0, updated = 0, skipped = 0
    let skippedOut = 0, skippedVirtual = 0, skippedMembersOnly = 0, pendingReview = 0

    for (const raw of rawEvents) {
      try {
        if (raw?.Internal === true || raw?.Closed === true) { skipped++; continue }

        if (raw?.MembersOnly === true) {
          if (DEBUG) console.log(`  ⏭  members-only: "${raw.EventName}"`)
          skippedMembersOnly++
          skipped++
          continue
        }

        const title = raw?.EventName ? stripHtml(String(raw.EventName)) : ''
        if (!title || /\bcancel?led\b|\bpostponed\b/i.test(title)) { skipped++; continue }

        const location = resolveLocation(raw)
        if (location.isVirtual) {
          if (DEBUG) console.log(`  ⏭  virtual: "${title}"`)
          skippedVirtual++
          skipped++
          continue
        }

        const startIso = growthZoneStartIso(raw)
        const endIso = growthZoneEndIso(raw)
        if (!isWithinWindow(startIso, endIso)) { skipped++; continue }

        // Sequential detail fetches with a small jitter — the feed is small
        // (~30 events/run), no need for concurrency or a proxy.
        await sleep(150 + Math.floor(Math.random() * 150))
        const detail = await fetchGrowthZoneDetail(raw.EventId, { tenant: TENANT })

        const geo = classifySummitLocation({
          lat: detail?.Latitude,
          lng: detail?.Longitude,
          city: location.city,
        })

        if (geo === 'out') {
          if (DEBUG) console.log(`  ⏭  out-of-county: "${title}"`)
          skippedOut++
          skipped++
          continue
        }

        const row = toEventRow(raw, detail, geo)
        if (!row) { skipped++; continue }
        if (geo === 'unknown') pendingReview++

        const venueId = await upsertVenue(location)
        const enriched = await enrichWithImageDimensions(row, { organizationId: orgId })
        const { data: upserted, error, isNew } = await upsertEventSafe(enriched)

        if (error) {
          console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`)
          skipped++
          continue
        }
        if (venueId) await linkEventVenue(upserted.id, venueId)
        if (orgId) await linkEventOrganization(upserted.id, orgId)
        if (isNew) inserted++
        else updated++

        if (DEBUG) {
          console.log(`  ✓ ${geo === 'unknown' ? '[review] ' : ''}${row.title} — ${row.start_at}` +
            `${location.venueName ? ` @ ${location.venueName}` : ''}`)
        }
      } catch (err) {
        console.warn(`  ⚠ Error processing "${raw?.EventName}": ${err.message}`)
        skipped++
      }
    }

    console.log(
      `\n✅  Greater Akron Chamber: ${inserted} inserted, ${updated} updated, ${skipped} skipped ` +
      `(${skippedOut} out-of-county, ${skippedVirtual} virtual, ${skippedMembersOnly} members-only, ${pendingReview} → review).`,
    )
    await logUpsertResult(SOURCE, inserted, updated, skipped, { durationMs: Date.now() - startMs })
  } catch (err) {
    console.error(`❌  Greater Akron Chamber scrape failed: ${err.message}`)
    await logScraperError(SOURCE, err, startMs)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
