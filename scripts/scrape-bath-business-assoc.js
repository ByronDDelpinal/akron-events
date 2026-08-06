/**
 * scrape-bath-business-assoc.js
 *
 * Bath Business Association — a business/civic association in Bath Township
 * (Akron 44333, Summit County). Their Wix Events calendar mixes internal
 * association business (members-only guest speakers, monthly business/general
 * meetings, the members-only picnic) with genuine PUBLIC community events
 * (garage-sale map, Wye Road bridge lighting, the America 250 road rally, an
 * open house / scholarship announcement, a township employee-appreciation
 * brunch). We publish only the public ones.
 *
 * Platform: Wix Events → parsed via the shared lib/wix-events.js (reads the
 * server-rendered #wix-warmup-data blob). Each event carries its own location
 * (the trustee's room, a member business, a partner venue like Crown Point
 * Ecology Center), so we build a per-event venue from the Wix location and
 * route it through the Summit-county gate defensively — every event should be
 * in-county (all 44333) but we never trust a source's own geo scope.
 *
 * Price is left null (never assume free). Category is inferred per event since
 * the public slate is varied (community festival, holiday lighting, road rally).
 *
 * Usage:   node scripts/scrape-bath-business-assoc.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, inferCategory, enrichWithImageDimensions,
  upsertEventSafe, linkEventVenue, linkEventOrganization, ensureVenue, ensureOrganization,
  linkOrganizationVenue,
} from './lib/normalize.js'
import { fetchWixEvents, normaliseWixEvent } from './lib/wix-events.js'
import { classifySummitLocation, preloadSummitCountyBoundary } from './lib/summit-county.js'

export const SOURCE_KEY = 'bath_business_assoc'
const SITE       = 'https://www.bathbusinessassociation.com'
const EVENTS_URL = `${SITE}/event-list`
const ORG_NAME   = 'Bath Business Association'

// ── Public-vs-internal filter (exported for tests) ───────────────────────────

// Members-only association business: "… - Members Only", "BBA Member Only
// Picnic". Matches singular/plural and an optional dash so "Member Only" and
// "- Members Only" both hit.
const MEMBERS_ONLY = /members?\s*[-–—]?\s*only/i

// Internal association meetings we never publish: the monthly business meeting,
// the general meeting, board/committee meetings. Shape-matched, not by a
// hardcoded title, so next month's "BUSINESS MEETING (2)" is caught too.
const INTERNAL_MEETING = /\b(business|general|board|committee|monthly)\s+meeting\b/i

/**
 * True when a title is a genuine PUBLIC event we want to publish. Drops the
 * association's internal / members-only items and civic business meetings while
 * keeping community events. Pure — exported for tests.
 *
 * @param {string} title
 * @returns {boolean}
 */
export function isPublicEvent(title) {
  const t = String(title || '').trim()
  if (!t) return false
  if (MEMBERS_ONLY.test(t)) return false
  if (INTERNAL_MEETING.test(t)) return false
  return true
}

// ── Per-event venue ──────────────────────────────────────────────────────────

/**
 * Derive a postal city from a Wix `address.formatted` string. The BBA feed
 * gives a single formatted line rather than a structured fullAddress, e.g.
 * "3864 W Bath Rd, Akron, OH 44333, USA", "Bath Township, OH, USA", or the
 * bare "Bath Township". We strip a trailing country, then a trailing "ST 12345"
 * / "ST" segment, and take what remains as the city (falling back to the prior
 * comma segment when the last one was pure state/zip).
 *
 * @param {string|null} formatted
 * @returns {string|null}
 */
export function cityFromFormatted(formatted) {
  if (!formatted || typeof formatted !== 'string') return null
  let parts = formatted.split(',').map((s) => s.trim()).filter(Boolean)
  parts = parts.filter((p) => !/^(usa|united states)$/i.test(p))
  if (!parts.length) return null
  const last = parts[parts.length - 1]
  const cleaned = last
    .replace(/\b[A-Za-z]{2}\b\s*\d{5}(?:-\d{4})?$/, '') // "OH 44333"
    .replace(/\s*\d{5}(?:-\d{4})?$/, '')                // trailing zip alone
    .replace(/\b[A-Za-z]{2}\b$/, '')                    // trailing state alone
    .trim()
  if (cleaned) return cleaned                           // e.g. "AKRON" from "AKRON OH 44333"
  if (parts.length >= 2) return parts[parts.length - 2] // last segment was state/zip only
  return parts[0]
}

/**
 * Flatten a Wix event `location` into the venue fields we ingest. Unlike the
 * shared parseWixLocation(), the BBA feed nests the address as
 * `location.address.formatted` (a string) with no structured fullAddress, so we
 * parse the city/zip out of that line ourselves.
 *
 * @param {object|null} location
 * @returns {object|null} — { name, address, city, state, zip, lat, lng }
 */
export function venueFor(location) {
  if (!location || typeof location !== 'object') return null
  const name = typeof location.name === 'string' ? location.name.trim() : null
  const formatted = location.address?.formatted || location.address?.formattedAddress
    || (typeof location.address === 'string' ? location.address : null)
  const zipMatch = formatted ? String(formatted).match(/\b(\d{5})(?:-\d{4})?\b/) : null
  return {
    name,
    address: typeof formatted === 'string' ? formatted.trim() : null,
    city:    cityFromFormatted(formatted),
    state:   'OH',
    zip:     zipMatch ? zipMatch[1] : null,
    lat:     location.coordinates?.lat ?? null,
    lng:     location.coordinates?.lng ?? null,
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const venueCache = new Map()
async function ensureEventVenue(v, organizerId) {
  if (!v?.name) return null
  if (venueCache.has(v.name)) return venueCache.get(v.name)
  const id = await ensureVenue(v.name, {
    address: v.address ?? undefined, city: v.city ?? undefined, state: v.state ?? undefined,
    zip: v.zip ?? undefined, lat: v.lat ?? undefined, lng: v.lng ?? undefined,
  })
  if (id && organizerId) await linkOrganizationVenue(organizerId, id)
  venueCache.set(v.name, id)
  return id
}

async function main() {
  console.log('🏘️  Starting Bath Business Association (Wix Events) ingestion…')
  const start = Date.now()
  try {
    await preloadSummitCountyBoundary()

    const organizerId = await ensureOrganization(ORG_NAME, {
      website: SITE,
      description: 'The Bath Business Association is a business and civic association in Bath Township (Akron 44333) hosting community events including the annual garage-sale weekend, the Wye Road bridge lighting, and a road rally.',
    })

    const all = await fetchWixEvents(EVENTS_URL)
    const events = all.filter((ev) => isPublicEvent(ev?.title))
    console.log(`  ${all.length} event(s) on the calendar → ${events.length} public event(s) to publish`)

    let inserted = 0, skipped = 0
    for (const raw of events) {
      try {
        const v = venueFor(raw.location)
        // Defensive Summit gate — every BBA event is 44333, but never trust the
        // source's own scope. Coord-less venues fall back to the city allowlist.
        if (classifySummitLocation({ lat: v?.lat, lng: v?.lng, city: v?.city }) !== 'in') {
          console.log(`  – skip (out of county): ${raw.title}`)
          skipped++
          continue
        }

        const row = normaliseWixEvent(raw, {
          source:          SOURCE_KEY,
          mapTags:         () => ['bath-business-association', 'bath', 'community', 'akron'],
          defaultPriceMin: null, // never assume free
          ageRestriction:  'all_ages',
          siteBaseUrl:     SITE,
        })
        if (!row.title || !row.start_at) { skipped++; continue }
        row.category = inferCategory(row.title, row.description || '')

        const venueId = await ensureEventVenue(v, organizerId)
        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`); skipped++; continue }
        if (venueId) await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
        console.log(`  ✓ ${row.title} (${row.start_at.slice(0, 10)})`)
      } catch (err) {
        console.warn(`  ⚠ Error on "${raw?.title}": ${err.message}`)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: events.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
