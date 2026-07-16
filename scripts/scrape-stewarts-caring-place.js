/**
 * scrape-stewarts-caring-place.js
 *
 * Stewart's Caring Place — a Fairlawn nonprofit cancer wellness center
 * (3501 Ridge Park Dr) offering FREE public programming for anyone touched by
 * cancer: yoga and group fitness, guided meditation, holistic-care sessions,
 * art and nutrition classes, and peer support groups. Registration is required
 * for most sessions but they are open community programming, the same class of
 * content as library and senior-center calendars we already carry.
 *
 * Platform: WordPress + The Events Calendar (Tribe) REST API — same shape as
 * the Indivisible Akron / Summit Artspace / Royal Palace scrapers.
 *   https://stewartscaringplace.org/wp-json/tribe/events/v1/events
 *
 * Feed notes (verified 2026-07-08):
 *   • Venues vary per event: most sessions run at the Fairlawn center, but the
 *     feed also carries sessions at Aunt Susie's Cancer Wellness Center in
 *     Canton (Stark County) — those are gated out by isSummitCountyLocation.
 *     Events with no venue default to the Fairlawn HQ record.
 *   • The registration link lives in custom_fields._ecp_custom_3.value (qgiv);
 *     it wins over the post URL for ticket_url.
 *   • is_virtual is set on online-only sessions — skipped (no resolvable
 *     Summit County location, same rule as Meetup).
 *   • Heavy weekly recurrence: Tribe repeats the event id per occurrence, so
 *     source_id is `${id}-${YYYY-MM-DD}` (the Indivisible pattern).
 *   • cost is empty on every event; programs are free to participants but we
 *     never assume free — price stays null.
 *
 * Usage:   node scripts/scrape-stewarts-caring-place.js
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

export const SOURCE_KEY = 'stewarts_caring_place'
const BASE_URL   = 'https://stewartscaringplace.org/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180

const ORG_NAME   = "Stewart's Caring Place"
const VENUE_NAME = "Stewart's Caring Place"
const VENUE_DETAILS = {
  address: '3501 Ridge Park Dr',
  city: 'Fairlawn', state: 'OH', zip: '44333',
  website: 'https://stewartscaringplace.org',
  description: 'Nonprofit cancer wellness center in Fairlawn offering free fitness, holistic-care, and support programming for anyone touched by cancer.',
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/**
 * Category from Tribe category slugs. The center's taxonomy is small and
 * stable: fitness/yoga and holistic care are wellness programming, cooking and
 * nutrition are food, art sessions are visual-art, education workshops are
 * learning; support groups and everything else fall to 'other' (the tags keep
 * them findable).
 */
export function parseCategory(tribeCategories = []) {
  const slugs = tribeCategories.map((c) => (c.slug ?? c.name ?? '').toLowerCase())
  const has = (frag) => slugs.some((s) => s.includes(frag))
  if (has('fitness') || has('yoga') || has('holistic') || has('meditation')) return 'fitness'
  if (has('cooking') || has('nutrition')) return 'food'
  if (has('art')) return 'visual-art'
  if (has('educat') || has('workshop') || has('class')) return 'learning'
  return 'other'
}

/** Registration link from Tribe custom fields (qgiv), else website, else post URL. */
export function parseRegistrationUrl(ev = {}) {
  const custom = ev.custom_fields ?? {}
  for (const field of Object.values(custom)) {
    const label = String(field?.label ?? '').toLowerCase()
    const value = String(field?.value ?? '').trim()
    if (label.includes('registration') && /^https?:\/\//.test(value)) return value
  }
  return ev.website || ev.url || null
}

/**
 * Per-occurrence source_id: Tribe recurring series repeat the event id across
 * occurrences, so append the local start date.
 */
export function buildSourceId(ev) {
  const day = (ev.start_date ?? ev.utc_start_date ?? '').slice(0, 10)
  return day ? `${ev.id}-${day}` : String(ev.id)
}

/** Venue names that are meeting links, not places ("Virtual Zoom Call"). */
const VIRTUAL_VENUE_RE = /\b(virtual|zoom|online|webinar|teams|google meet)\b/i

/**
 * Locality/eligibility gate: skip virtual sessions and any event whose venue
 * sits outside Summit County (the feed carries Canton sessions at Aunt
 * Susie's). The feed's is_virtual flag is UNRELIABLE — verified 2026-07-08
 * that "Virtual Zoom Call"-venue events carry is_virtual:false — so the venue
 * name is checked too. Venue-less events pass — they default to the Fairlawn
 * center.
 */
export function includeEvent(ev = {}) {
  if (ev.is_virtual) return false
  const venueName = ev.venue?.venue ?? ''
  if (VIRTUAL_VENUE_RE.test(venueName)) return false
  const city = ev.venue?.city
  if (!city) return true
  return isSummitCountyLocation({ city })
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
    city:    tribeVenue.city          ?? 'Fairlawn',
    state:   tribeVenue.stateprovince ?? tribeVenue.state ?? 'OH',
    zip:     tribeVenue.zip           ?? null,
    website: tribeVenue.website       ?? null,
  })
  venueCache.set(venueName, venueId)
  return venueId ?? fallbackVenueId
}

// ── Fetch all pages ──────────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = easternTodayIso()
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]

  let page = 1, hasMore = true
  const all = []
  console.log("\n🔍  Fetching Stewart's Caring Place events via Tribe REST API…")

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
    if (!res.ok) throw new Error(`Stewart's Caring Place API error ${res.status}: ${(await res.text()).slice(0, 200)}`)

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

// ── Process events ───────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId, hqVenueId) {
  let inserted = 0, skipped = 0

  for (const ev of rawEvents) {
    try {
      if (!includeEvent(ev)) {
        const reason = ev.is_virtual || VIRTUAL_VENUE_RE.test(ev.venue?.venue ?? '')
          ? 'virtual session'
          : `outside Summit County (${ev.venue?.city})`
        console.log(`  ⛔ Skipping "${stripHtml(ev.title ?? '')}" — ${reason}`)
        skipped++
        continue
      }

      const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
      const category = parseCategory(ev.categories)
      const tags     = parseTagsFromTribe(ev.categories, ev.tags, ['wellness', 'cancer-support', 'stewarts-caring-place'])
      const imageUrl = parseImage(ev.image, ev.description)

      const venueId = await ensureEventVenue(ev.venue, hqVenueId)

      const row = {
        title:           stripHtml(ev.title ?? ''),
        description:     stripHtml(ev.description ?? '') || null,
        start_at:        ev.utc_start_date ? ev.utc_start_date.replace(' ', 'T') + 'Z' : null,
        end_at:          ev.utc_end_date   ? ev.utc_end_date.replace(' ', 'T') + 'Z'   : null,
        category,
        tags,
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      parseRegistrationUrl(ev),
        source:          SOURCE_KEY,
        source_id:       buildSourceId(ev),
        status:          'published',
        featured:        false,
      }
      if (!row.title || !row.start_at) { skipped++; continue }

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)
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
  return { inserted, skipped }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀  Starting Stewart's Caring Place ingestion…")
  const start = Date.now()
  try {
    const [organizerId, hqVenueId] = await Promise.all([
      ensureOrganization(ORG_NAME, {
        website: 'https://stewartscaringplace.org',
        description: VENUE_DETAILS.description,
      }),
      ensureVenue(VENUE_NAME, VENUE_DETAILS),
    ])
    await linkOrganizationVenue(organizerId, hqVenueId)

    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)

    const { inserted, skipped } = await processEvents(rawEvents, organizerId, hqVenueId)
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
