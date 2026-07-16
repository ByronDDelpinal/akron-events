/**
 * scrape-royal-palace.js
 *
 * Royal Palace Akron — a banquet/event venue, bar, and lounge at 134 E Tallmadge
 * Ave in Akron's North Hill neighborhood. Beyond private bookings (weddings,
 * parties) it hosts a steady run of public LIVE shows: Latin bailazos and banda
 * concerts, Nepali music nights, and cultural celebrations. Those public events
 * are exactly what Akron Pulse surfaces; the private-rental side never hits the
 * public calendar.
 *
 * Platform: WordPress + The Events Calendar (Tribe) REST API — same shape as the
 * Indivisible Akron / Summit Artspace scrapers.
 *   https://royalpalaceakron.com/wp-json/tribe/events/v1/events
 *
 * Single physical venue, so every event is pinned to the canonical Royal Palace
 * record (North Hill). Price comes from the Tribe cost field and is left null
 * when unstated (never assume free). Note: the venue also promotes shows on
 * Eventbrite, which we already ingest — overlaps are handled by the shared
 * cross-source dedupe (same venue + date), which is why the venue record is
 * unified rather than minting a Tribe-specific one.
 *
 * Usage:   node scripts/scrape-royal-palace.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, fetchSchemaDescription,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
  parseCostFromTribe, parseTagsFromTribe,
  easternTodayIso,
} from './lib/normalize.js'

export const SOURCE_KEY = 'royal_palace'
const BASE_URL   = 'https://royalpalaceakron.com/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180

const ORG_NAME = 'Royal Palace Akron'
const VENUE_NAME = 'Royal Palace'
const VENUE_DETAILS = {
  address: '134 E Tallmadge Ave', city: 'Akron', state: 'OH', zip: '44310',
  neighborhood_slug: 'north-hill',
  website: 'https://royalpalaceakron.com',
  description: 'Banquet hall, bar, and lounge in Akron\'s North Hill neighborhood hosting live Latin, Nepali, and cultural concerts.',
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Image from a Tribe image object, falling back to the first <img> in the HTML. */
function parseImage(imageObj, descriptionHtml = '') {
  if (imageObj && imageObj.url) return imageObj.url
  return descriptionHtml.match(/<img[^>]+src="([^"]+)"/)?.[1] ?? null
}

/**
 * Category hint from Tribe categories. Royal Palace's public calendar is live
 * music / concerts / dance nights, so music-ish categories map to 'music';
 * anything else returns null so text inference decides (manifest defaultCategory
 * 'music' rescues a bare 'other' since this is a music venue).
 */
export function parseCategory(categories = []) {
  const slugs = categories.map((c) => `${c.slug ?? ''} ${c.name ?? ''}`.toLowerCase())
  const has = (kw) => slugs.some((s) => s.includes(kw))
  if (has('music') || has('concert') || has('bailazo') || has('live') ||
      has('banda') || has('dance') || has('dj')) return 'music'
  return null
}

/** Stable per-occurrence source_id (Tribe recurring series can repeat ids). */
export function buildSourceId(ev) {
  const day = (ev.start_date ?? ev.utc_start_date ?? '').slice(0, 10)
  return day ? `${ev.id}-${day}` : String(ev.id)
}

// ── Fetch ──────────────────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = easternTodayIso()
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]

  let page = 1, hasMore = true
  const all = []
  console.log('\n🔍  Fetching Royal Palace events via Tribe REST API…')

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
    // Tribe returns 400 with a "no results" code when the window is empty —
    // treat that as zero events rather than an error.
    if (res.status === 400) break
    if (!res.ok) throw new Error(`Royal Palace API error ${res.status}: ${(await res.text()).slice(0, 200)}`)

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

// ── Process ──────────────────────────────────────────────────────────────────

async function processEvents(rawEvents, venueId, organizerId) {
  let inserted = 0, skipped = 0

  for (const ev of rawEvents) {
    try {
      const startAt = ev.utc_start_date ? ev.utc_start_date.replace(' ', 'T') + 'Z' : null
      if (!startAt) { skipped++; continue }

      const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
      const tags = parseTagsFromTribe(ev.categories, ev.tags, ['royal-palace', 'north-hill', 'akron', 'live-music'])
      const imageUrl = parseImage(ev.image, ev.description)

      let descText = stripHtml(ev.description)
      if (!descText && ev.url) descText = (await fetchSchemaDescription(ev.url)) ?? ''

      const row = {
        title:           ev.title,
        description:     descText || null,
        start_at:        startAt,
        end_at:          ev.utc_end_date ? ev.utc_end_date.replace(' ', 'T') + 'Z' : null,
        category:        parseCategory(ev.categories),
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

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${ev.title}":`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('👑  Starting Royal Palace ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization(ORG_NAME, {
      website: 'https://royalpalaceakron.com',
      description: 'Royal Palace Akron is a North Hill banquet hall, bar, and lounge hosting live Latin, Nepali, and cultural concerts and dance nights.',
    })
    const venueId = await ensureVenue(VENUE_NAME, VENUE_DETAILS)
    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)
    const { inserted, skipped } = await processEvents(rawEvents, venueId, organizerId)

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
