/**
 * scrape-indivisible-akron.js
 *
 * Fetches upcoming events from Indivisible Akron (a local pro-democracy /
 * activism org) via The Events Calendar (Tribe) REST API.
 *
 * Platform: WordPress + The Events Calendar (Tribe Events) REST API
 *
 * Usage:
 *   node scripts/scrape-indivisible-akron.js
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
  fetchSchemaDescription,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  parseCostFromTribe,
  parseTagsFromTribe,
  easternTodayIso,
} from './lib/normalize.js'

const BASE_URL   = 'https://indivisibleakron.org/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180
const SOURCE_KEY = 'indivisible_akron'

// ── Helpers ──────────────────────────────────────────────────────────────

/** Extract image URL from a Tribe image object or the description HTML. */
function parseImage(imageObj, descriptionHtml = '') {
  if (imageObj && imageObj.url) return imageObj.url
  const match = descriptionHtml.match(/<img[^>]+src="([^"]+)"/)
  return match?.[1] ?? null
}

/**
 * Map Tribe category slugs to the event's specific TYPE. Indivisible Akron is
 * an activism org whose programming spans book/movie clubs (learning), benefit
 * concerts (music), and art builds / banner-making (visual-art) — but every
 * event is fundamentally civic. parseCategory returns the specific type;
 * eventCategories() then guarantees civic is always a label (see below).
 */
export function parseCategory(categories = []) {
  const slugs = categories.map((c) => (c.slug ?? c.name ?? '').toLowerCase())
  const has = (kw) => slugs.some((s) => s.includes(kw))
  if (has('music') || has('concert'))                       return 'music'
  if (has('art') || has('gallery'))                         return 'visual-art'
  if (has('workshop') || has('educat') || has('book') || has('class')) return 'learning'
  return 'civic'
}

/**
 * Categories for an Indivisible event: civic is ALWAYS present (it's a civic
 * org), with the specific type as a secondary when it differs. So an art build
 * is ['civic','visual-art'], a book club ['civic','learning'], a rally ['civic'].
 * Returned as an explicit list so it bypasses text inference (which otherwise
 * tags banner-making as plain visual-art and drops civic).
 */
export function eventCategories(tribeCategories = []) {
  const type = parseCategory(tribeCategories)
  return type === 'civic' ? ['civic'] : ['civic', type]
}

// ── Venue cache ──────────────────────────────────────────────────────────

const venueCache = new Map()

async function ensureEventVenue(tribeVenue, fallbackVenueId) {
  if (!tribeVenue || !tribeVenue.venue) return fallbackVenueId
  const venueName = tribeVenue.venue.trim()
  if (!venueName) return fallbackVenueId
  if (venueCache.has(venueName)) return venueCache.get(venueName)

  const venueId = await ensureVenue(venueName, {
    address: tribeVenue.address       ?? null,
    city:    tribeVenue.city          ?? 'Akron',
    state:   tribeVenue.stateprovince ?? tribeVenue.state ?? 'OH',
    zip:     tribeVenue.zip           ?? null,
    lat:     tribeVenue.geo_lat ? parseFloat(tribeVenue.geo_lat) : null,
    lng:     tribeVenue.geo_lng ? parseFloat(tribeVenue.geo_lng) : null,
    website: tribeVenue.website       ?? null,
  })
  venueCache.set(venueName, venueId)
  return venueId ?? fallbackVenueId
}

/**
 * Stable, per-occurrence source_id. Tribe recurring series (e.g. the weekly
 * Mustard Seed Meetup) can repeat an event id across occurrences, so we append
 * the local start date to guarantee each occurrence is its own row.
 */
function buildSourceId(ev) {
  const day = (ev.start_date ?? ev.utc_start_date ?? '').slice(0, 10)
  return day ? `${ev.id}-${day}` : String(ev.id)
}

// ── Fetch all pages ──────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = easternTodayIso()
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]

  let page = 1, hasMore = true
  const all = []
  console.log('\n🔍  Fetching Indivisible Akron events via Tribe REST API…')

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
    if (!res.ok) throw new Error(`Indivisible Akron API error ${res.status}: ${(await res.text()).slice(0, 200)}`)

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

// ── Process events ───────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId) {
  let inserted = 0, skipped = 0

  for (const ev of rawEvents) {
    try {
      const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
      const categories = eventCategories(ev.categories)
      const tags     = parseTagsFromTribe(ev.categories, ev.tags, ['activism', 'community', 'akron', 'indivisible-akron'])
      const imageUrl = parseImage(ev.image, ev.description)

      let descText = stripHtml(ev.description)
      if (!descText && ev.url) descText = (await fetchSchemaDescription(ev.url)) ?? ''

      const venueId = await ensureEventVenue(ev.venue, null)

      const row = {
        title:           ev.title,
        description:     descText || null,
        start_at:        ev.utc_start_date ? ev.utc_start_date.replace(' ', 'T') + 'Z' : null,
        end_at:          ev.utc_end_date   ? ev.utc_end_date.replace(' ', 'T') + 'Z'   : null,
        categories,
        tags,
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ev.website || ev.url || null,
        source:          SOURCE_KEY,
        source_id:       buildSourceId(ev),
        status:          'published',
        featured:        ev.featured ?? false,
      }
      if (!row.start_at) { skipped++; continue }

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
      console.warn(`  ⚠ Error processing "${ev.title}":`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Entry point ──────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Indivisible Akron ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization('Indivisible Akron', {
      website:     'https://indivisibleakron.org',
      description: 'Indivisible Akron is a local pro-democracy grassroots group organizing civic events, workshops, book and movie clubs, and community meetups in Greater Akron.',
    })

    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skipped } = await processEvents(rawEvents, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

export { buildSourceId, SOURCE_KEY }
