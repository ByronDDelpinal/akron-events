/**
 * scrape-torchbearers.js
 *
 * Fetches upcoming events from Torchbearers Akron via The Events Calendar
 * (Tribe) REST API.
 *
 * Platform: WordPress + The Events Calendar (Tribe Events) REST API
 *
 * ⏸ PAUSED (2026-06-05): removed from `scrape:all`. The public Tribe feed
 * surfaces too many members-only INTERNAL events — committee meetings, board
 * meetings, and general membership meetings (GMMs) — as public events, which
 * flood the calendar with items not open to the general public. Re-enable only
 * after adding a public/internal filter (similar to lib/civicplus.js
 * isPublicCivicPlusEvent) so internal org business is excluded. The script
 * still runs standalone via `npm run scrape:torchbearers` for testing.
 *
 * Usage:
 *   node scripts/scrape-torchbearers.js
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
  linkOrganizationVenue,
  parseCostFromTribe,
  parseTagsFromTribe,
} from './lib/normalize.js'

const BASE_URL   = 'https://torchbearersakron.com/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180
const SOURCE_KEY = 'torchbearers'

// ── Helpers ──────────────────────────────────────────────────────────────

/** Extract image URL from Tribe image object or description HTML */
function parseImage(imageObj, descriptionHtml = '') {
  if (imageObj && imageObj.url) return imageObj.url
  const match = descriptionHtml.match(/<img[^>]+src="([^"]+)"/)
  return match?.[1] ?? null
}

/** Map Tribe category slugs to our category enum */
function parseCategory(categories = []) {
  const slugs = categories.map(c => (c.slug ?? c.name ?? '').toLowerCase())
  const has = (kw) => slugs.some(s => s.includes(kw))
  const hasWord = (kw) => slugs.some(s => new RegExp(`\\b${kw}\\b`).test(s))

  if (has('music') || has('concert'))         return 'music'
  if (has('art') || has('gallery'))           return 'art'
  if (has('food') || has('culinary'))         return 'food'
  if (has('fitness'))                         return 'fitness'
  if (hasWord('sport'))                       return 'sports'
  if (has('educat') || has('workshop'))       return 'education'
  if (has('nonprofit') || has('fundrais'))    return 'nonprofit'
  if (has('social') || has('happy-hour'))     return 'community'
  if (has('volunteer') || has('service'))     return 'nonprofit'
  if (has('committee') || has('meeting'))     return 'community'
  if (has('gmm') || has('general-member'))    return 'community'

  // Torchbearers is a leadership/community org — default to 'community'
  return 'community'
}

// ── Venue cache ──────────────────────────────────────────────────────────

const venueCache = new Map()

async function ensureEventVenue(tribeVenue, fallbackVenueId, organizerId) {
  if (!tribeVenue || !tribeVenue.venue) return fallbackVenueId

  const venueName = tribeVenue.venue.trim()
  if (!venueName) return fallbackVenueId

  if (venueCache.has(venueName)) return venueCache.get(venueName)

  const venueId = await ensureVenue(venueName, {
    address: tribeVenue.address   ?? null,
    city:    tribeVenue.city      ?? 'Akron',
    state:   tribeVenue.stateprovince ?? tribeVenue.state ?? 'OH',
    zip:     tribeVenue.zip       ?? null,
    lat:     tribeVenue.geo_lat ? parseFloat(tribeVenue.geo_lat) : null,
    lng:     tribeVenue.geo_lng ? parseFloat(tribeVenue.geo_lng) : null,
    website: tribeVenue.website   ?? null,
  })

  venueCache.set(venueName, venueId)
  return venueId ?? fallbackVenueId
}

// ── Fetch all pages ──────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = new Date().toISOString().split('T')[0]
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]

  let page    = 1
  let hasMore = true
  const all   = []

  console.log(`\n🔍  Fetching Torchbearers events via Tribe REST API…`)

  while (hasMore) {
    const url = new URL(BASE_URL)
    url.searchParams.set('per_page',   PER_PAGE)
    url.searchParams.set('page',       page)
    url.searchParams.set('start_date', startDate)
    url.searchParams.set('end_date',   endDate)
    url.searchParams.set('status',     'publish')

    const res = await fetch(url.toString(), {
      headers: {
        Accept:       'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; The330-bot/1.0)',
      },
      redirect: 'follow',
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Torchbearers API error ${res.status}: ${body}`)
    }

    const data   = await res.json()
    const events = data.events ?? []

    all.push(...events)
    console.log(`  Page ${page}/${data.total_pages}: ${events.length} events (total: ${all.length})`)

    hasMore = page < (data.total_pages ?? 1)
    page++

    if (hasMore) await new Promise(r => setTimeout(r, 200))
  }

  return all
}

// ── Process events ───────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId) {
  let inserted = 0, skipped = 0

  for (const ev of rawEvents) {
    try {
      const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
      const category  = parseCategory(ev.categories)
      const tags      = parseTagsFromTribe(ev.categories, ev.tags, ['akron', 'young-professionals', 'leadership'])
      const imageUrl  = parseImage(ev.image, ev.description)
      let   descText  = stripHtml(ev.description)
      // Tribe API often returns an empty description even when the event's
      // detail page on torchbearersakron.com has a full write-up. Fall
      // back to the Schema.org Event JSON-LD on the detail page so the
      // Akron Pulse event page doesn't render "No description available."
      if (!descText && ev.url) {
        descText = (await fetchSchemaDescription(ev.url)) ?? ''
      }

      const venueId = await ensureEventVenue(ev.venue, null, organizerId)

      const row = {
        title:           ev.title,
        description:     descText || null,
        start_at:        ev.utc_start_date ? ev.utc_start_date.replace(' ', 'T') + 'Z' : null,
        end_at:          ev.utc_end_date   ? ev.utc_end_date.replace(' ', 'T') + 'Z'   : null,
        category,
        tags,
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      ev.website || ev.url || null,
        source:          SOURCE_KEY,
        source_id:       String(ev.id),
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
  console.log('🚀  Starting Torchbearers ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization('Torchbearers', {
      website:     'https://torchbearersakron.com',
      description: 'Torchbearers strengthens the connection between Akron-area nonprofits and emerging leaders, attracting and retaining young professionals in Greater Akron through service, social, and professional development events.',
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

// Run only when invoked directly (`node scripts/scrape-torchbearers.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
