/**
 * scrape-portage-lakes-kiwanis.js
 *
 * Portage Lakes Kiwanis — service club whose Civic Center (725 Portage Lakes
 * Dr) doubles as the Portage Lakes community's rental hall. The Tribe
 * calendar is therefore a FACILITY calendar (verified 2026-07-08, ~325
 * entries): mostly private/member bookings — weekly Kiwanis meetings, Sea
 * Scouts, AARP, Orchid Society, Purple Martin Club, private memorials — with
 * real public events mixed in (Portage Lakes Fireworks, pancake breakfasts,
 * craft shows).
 *
 * FILTER PHILOSOPHY: ALLOWLIST, not excludelist. Every other municipal/org
 * calendar we ingest defaults-in and drops known admin noise, but a rental
 * hall's default booking is private (memorials, member meetings, parties),
 * so here an event must LOOK public to ingest — same reasoning as the
 * faith-event allowlist (lib/faith-events.js): public-community events only.
 * Expect a low but high-quality yield (~5-15/yr); volume never disqualifies.
 *
 * Platform: WordPress + The Events Calendar REST API — healthy install,
 * date windows respected.
 *
 * Usage:   node scripts/scrape-portage-lakes-kiwanis.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
  parseCostFromTribe, parseTagsFromTribe,
  easternTodayIso,
} from './lib/normalize.js'
import { isSummitCountyLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'portage_lakes_kiwanis'
const BASE_URL   = 'https://plkiwanis.org/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180

const ORG_NAME   = 'Portage Lakes Kiwanis'
const VENUE_NAME = 'Portage Lakes Kiwanis Civic Center'
const VENUE_DETAILS = {
  address: '725 Portage Lakes Dr',
  city: 'Akron', state: 'OH', zip: '44319',
  website: 'https://plkiwanis.org',
  parking_type: 'lot',
  description: 'Kiwanis-run civic center and community hall in the Portage Lakes.',
}

// ── Allowlist filter (exported for tests) ───────────────────────────────────

// Public-community signals. A rental-hall booking must match one of these to
// ingest; everything else (member meetings, private memorials, club nights)
// is skipped by default.
const PUBLIC_RE = new RegExp(
  [
    'fireworks', 'pancake', 'breakfast', 'fish fry', 'spaghetti', 'chicken paprikash',
    'craft show', 'craft fair', 'bazaar', 'rummage', 'garage sale', 'book sale',
    'festival', 'fair\\b', 'carnival', 'concert', 'live music', 'car show',
    'open house', 'fundraiser', 'benefit', 'charity', 'blood drive',
    'santa', 'easter egg', 'trick.or.treat', 'trunk.or.treat', 'holiday market',
  ].join('|'),
  'i'
)

// Hard private markers beat the allowlist ("Memorial Craft Show" is unlikely,
// but a "MEMORIAL" funeral booking must never ingest).
// "closed" catches facility-closure notices ("CLOSED SANTA DELIEVERY" leaked
// through the santa allowlist on the first live run, 2026-07-08).
const PRIVATE_RE = /\bclosed\b|\bmemorial\b(?!\s+day)|\bfuneral\b|\bcelebration of life\b|\bprivate\b|\brental\b|\bwedding\b|\bshower\b|\bgraduation\b|\bbirthday\b/i

export function includeEvent(ev = {}) {
  const title = stripHtml(ev.title ?? '')
  if (PRIVATE_RE.test(title)) return false
  if (!PUBLIC_RE.test(title)) return false
  // Locality: fireworks etc. sometimes carry their own venue (Portage Lakes
  // State Park). Gate any explicit out-of-county venue; venue-less events
  // default to the Civic Center.
  const city = ev.venue?.city
  if (city && !isSummitCountyLocation({ city })) return false
  return true
}

/** Why an event was skipped — for the run log. */
export function skipReason(ev = {}) {
  const title = stripHtml(ev.title ?? '')
  if (PRIVATE_RE.test(title)) return 'private booking'
  if (!PUBLIC_RE.test(title)) return 'no public-event signal (rental-hall default)'
  return 'outside Summit County'
}

export function buildSourceId(ev) {
  const day = (ev.start_date ?? ev.utc_start_date ?? '').slice(0, 10)
  return day ? `${ev.id}-${day}` : String(ev.id)
}

function parseImage(imageObj, descriptionHtml = '') {
  if (imageObj && imageObj.url) return imageObj.url
  return String(descriptionHtml).match(/<img[^>]+src="([^"]+)"/)?.[1] ?? null
}

// ── Venue cache ──────────────────────────────────────────────────────────────

const venueCache = new Map()

async function ensureEventVenue(tribeVenue, fallbackVenueId) {
  if (!tribeVenue || !tribeVenue.venue) return fallbackVenueId
  const venueName = stripHtml(tribeVenue.venue).trim()
  if (!venueName) return fallbackVenueId
  if (venueCache.has(venueName)) return venueCache.get(venueName)

  const venueId = await ensureVenue(venueName, {
    address: tribeVenue.address       ?? null,
    city:    tribeVenue.city          ?? 'Akron',
    state:   tribeVenue.stateprovince ?? tribeVenue.state ?? 'OH',
    zip:     tribeVenue.zip           ?? null,
    website: tribeVenue.website       ?? null,
  })
  venueCache.set(venueName, venueId)
  return venueId ?? fallbackVenueId
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = easternTodayIso()
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]

  let page = 1, hasMore = true
  const all = []
  console.log('\n🔍  Fetching Portage Lakes Kiwanis events via Tribe REST API…')

  while (hasMore) {
    const url = new URL(BASE_URL)
    url.searchParams.set('per_page',   PER_PAGE)
    url.searchParams.set('page',       page)
    url.searchParams.set('start_date', startDate)
    url.searchParams.set('end_date',   endDate)
    url.searchParams.set('status',     'publish')

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)' },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`PL Kiwanis API error ${res.status}: ${(await res.text()).slice(0, 200)}`)

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

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🎆  Starting Portage Lakes Kiwanis ingestion…')
  const start = Date.now()
  try {
    const [organizerId, hqVenueId] = await Promise.all([
      ensureOrganization(ORG_NAME, { website: VENUE_DETAILS.website, description: 'Portage Lakes Kiwanis service club — community events at the Kiwanis Civic Center and around the lakes.' }),
      ensureVenue(VENUE_NAME, VENUE_DETAILS),
    ])
    await linkOrganizationVenue(organizerId, hqVenueId)

    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events (allowlist filter)…`)

    let inserted = 0, skipped = 0
    for (const ev of rawEvents) {
      try {
        if (!includeEvent(ev)) {
          skipped++ // rental-hall default; logging every member meeting would drown the run log
          continue
        }
        console.log(`  ✓ Public event: "${stripHtml(ev.title ?? '')}"`)

        const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
        const venueId = await ensureEventVenue(ev.venue, hqVenueId)
        const row = {
          title:           stripHtml(ev.title ?? ''),
          description:     stripHtml(ev.description ?? '') || null,
          start_at:        ev.utc_start_date ? ev.utc_start_date.replace(' ', 'T') + 'Z' : null,
          end_at:          ev.utc_end_date   ? ev.utc_end_date.replace(' ', 'T') + 'Z'   : null,
          tags:            parseTagsFromTribe(ev.categories, ev.tags, ['portage-lakes', 'kiwanis', 'community']),
          price_min,
          price_max,
          age_restriction: 'not_specified',
          image_url:       parseImage(ev.image, ev.description),
          ticket_url:      ev.website || ev.url || null,
          source:          SOURCE_KEY,
          source_id:       buildSourceId(ev),
          status:          'published',
          featured:        false,
        }
        if (!row.title || !row.start_at) { skipped++; continue }

        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) {
          console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
          skipped++
        } else {
          if (venueId) await linkEventVenue(upserted.id, venueId)
          await linkEventOrganization(upserted.id, organizerId)
          inserted++
        }
      } catch (err) {
        console.warn(`  ⚠ Error processing event ${ev.id}:`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: rawEvents.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped (rental-hall allowlist)`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
