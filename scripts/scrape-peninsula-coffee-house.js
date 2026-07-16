/**
 * scrape-peninsula-coffee-house.js
 *
 * Peninsula Coffee House — a coffee shop and wine cellar at 1653 Main St in the
 * village of Peninsula (Summit County), inside the Cuyahoga Valley. Beyond
 * serving coffee and wine it runs a steady public-events calendar: weekly-ish
 * live music, karaoke nights, trivia nights, and deck yoga. Those community
 * events are exactly what Akron Pulse surfaces.
 *
 * Platform: WordPress + The Events Calendar (Tribe) REST API — same shape as the
 * Wine Mill / Royal Palace scrapers.
 *   https://peninsulacoffeehouse.com/wp-json/tribe/events/v1/events
 *
 * Feed quirks (verified 2026-07-14):
 *   • Mod_Security blocks non-browser User-Agents (the default bot UA gets a
 *     406 "Not Acceptable"). We send a normal desktop browser UA + Accept:
 *     application/json.
 *   • TIMEZONE IS MISCONFIGURED. The install reports timezone "UTC+0" and its
 *     `utc_start_date` fields are byte-identical to the local `start_date`
 *     fields — i.e. the "UTC" times are really Eastern wall-clock times. Cross-
 *     checking the descriptions confirms it (Trivia "6-8 PM" is stored as
 *     18:00:00; Yoga "8-9AM" as 08:00:00). So we do NOT append 'Z' to the utc_
 *     fields (that would shift every event 4-5h early). Instead we treat the
 *     local `start_date` / `end_date` wall-clock strings as Eastern and run them
 *     through easternToIso, which yields the correct UTC instant.
 *   • Two venue records share one address ("Peninsula Coffee House" and
 *     "Peninsula Wine Cellar", both 1653 Main St), and some events carry no
 *     venue object. It's one physical location and one business, so every event
 *     pins to the single canonical Peninsula Coffee House venue record.
 *   • Peninsula is fixed in Summit County (Boston Township), so no per-event geo
 *     classification is needed.
 *   • cost is empty on every event — price_min/price_max stay null (never
 *     assume free).
 *
 * Category: live music / karaoke → music via feed categories; other gatherings
 * (trivia → games, yoga → fitness) fall through to inferCategory.
 *
 * Usage:   node scripts/scrape-peninsula-coffee-house.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, easternToIso,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
  parseCostFromTribe, parseTagsFromTribe,
  easternTodayIso,
} from './lib/normalize.js'
import { inferCategory } from './lib/category-inference.js'

export const SOURCE_KEY = 'peninsula_coffee_house'
const BASE_URL   = 'https://peninsulacoffeehouse.com/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180
// Mod_Security rejects the default bot UA; use a normal desktop browser UA.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const ORG_NAME   = 'Peninsula Coffee House'
const VENUE_NAME = 'Peninsula Coffee House'
const VENUE_DETAILS = {
  address: '1653 Main St',
  city: 'Peninsula', state: 'OH', zip: '44264',
  website: 'https://peninsulacoffeehouse.com',
  parking_type: 'lot',
  description: 'Coffee shop and wine cellar on Main St in the village of Peninsula, hosting live music, karaoke, trivia, and deck yoga.',
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/**
 * Convert the feed's local wall-clock string to a correct UTC ISO instant.
 * The install's timezone is misconfigured to "UTC+0" (utc_start_date ===
 * start_date), so the local `start_date` string is the real Eastern time.
 * easternToIso's combined form parses "YYYY-MM-DD HH:MM:SS" and applies the
 * Eastern offset (DST-aware). Returns null if the field is missing/unparseable.
 */
export function toEasternIso(localDateTime) {
  if (!localDateTime) return null
  return easternToIso(String(localDateTime).replace('T', ' '))
}

/**
 * Tribe categories → our category. Music-forward calendar: live music and
 * karaoke map to 'music'; trivia and yoga are left null so inferCategory
 * (games / fitness) decides. Returns null when no confident mapping applies.
 */
export function parseCategory(categories = []) {
  const slugs = categories.map((c) => `${c.slug ?? ''} ${c.name ?? ''}`.toLowerCase())
  const has = (frag) => slugs.some((s) => s.includes(frag))
  if (has('music') || has('karaoke') || has('open mic') || has('open-mic') || has('concert') || has('live')) return 'music'
  if (has('trivia') || has('game')) return 'games'
  if (has('yoga') || has('fitness')) return 'fitness'
  return null
}

/** Per-occurrence source_id — recurring weekly series reuse the same event id. */
export function buildSourceId(ev) {
  const day = (ev.start_date ?? ev.utc_start_date ?? '').slice(0, 10)
  return day ? `${ev.id}-${day}` : String(ev.id)
}

/** Image from a Tribe image object (may be `false`), falling back to inline <img>. */
export function parseImage(imageObj, descriptionHtml = '') {
  if (imageObj && imageObj.url) return imageObj.url
  return String(descriptionHtml).match(/<img[^>]+src="([^"]+)"/)?.[1] ?? null
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = easternTodayIso()
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]

  let page = 1, hasMore = true
  const all = []
  console.log('\n🔍  Fetching Peninsula Coffee House events via Tribe REST API…')

  while (hasMore) {
    const url = new URL(BASE_URL)
    url.searchParams.set('per_page',   PER_PAGE)
    url.searchParams.set('page',       page)
    url.searchParams.set('start_date', startDate)
    url.searchParams.set('end_date',   endDate)
    url.searchParams.set('status',     'publish')

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': BROWSER_UA },
      redirect: 'follow',
    })
    // Tribe returns 400 with a "no results" code when the window is empty —
    // treat that as zero events rather than an error.
    if (res.status === 400) break
    if (!res.ok) throw new Error(`Peninsula Coffee House API error ${res.status}: ${(await res.text()).slice(0, 200)}`)

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
  const cutoff = Date.now() - 86400_000 // skip anything ended > ~1 day ago

  for (const ev of rawEvents) {
    try {
      const title    = stripHtml(ev.title ?? '')
      const startAt  = toEasternIso(ev.start_date)
      if (!title || !startAt) { skipped++; continue }
      if (new Date(startAt).getTime() < cutoff) { skipped++; continue }

      const description = stripHtml(ev.description ?? '') || null
      const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
      const category = parseCategory(ev.categories) || inferCategory(title, description ?? '')

      const row = {
        title,
        description,
        start_at:        startAt,
        end_at:          ev.all_day ? null : toEasternIso(ev.end_date),
        category,
        tags:            parseTagsFromTribe(ev.categories, ev.tags, ['peninsula', 'coffee-house', 'cuyahoga-valley']),
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       parseImage(ev.image, ev.description),
        ticket_url:      ev.website || ev.url || null,
        source:          SOURCE_KEY,
        source_id:       buildSourceId(ev),
        status:          'published',
        featured:        ev.featured ?? false,
      }

      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing event ${ev.id}:`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('☕  Starting Peninsula Coffee House ingestion…')
  const start = Date.now()
  try {
    const [organizerId, venueId] = await Promise.all([
      ensureOrganization(ORG_NAME, { website: VENUE_DETAILS.website, description: VENUE_DETAILS.description }),
      ensureVenue(VENUE_NAME, VENUE_DETAILS),
    ])
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
