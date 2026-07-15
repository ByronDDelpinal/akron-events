/**
 * scrape-beaus-on-the-river.js
 *
 * Beau's on the River — a waterfront restaurant inside the Sheraton Suites
 * Akron/Cuyahoga Falls (1989 Front Street, Cuyahoga Falls — Summit County),
 * overlooking the Cuyahoga River falls. Beyond dining it runs a steady public
 * entertainment calendar: weekend live-music sets in the lounge (Rolando Pizana,
 * Danny Clark, Steve'o, etc.), plus the occasional dinner event or tasting.
 * Those public events are what Akron Pulse surfaces.
 *
 * Platform: WordPress + The Events Calendar (Tribe) REST API — same shape as the
 * Peninsula Coffee House / Peninsula Foundation / Royal Palace scrapers.
 *   https://beausontheriver.com/wp-json/tribe/events/v1/events
 * The public /entertainment/ and /events/ pages are two front-ends onto this one
 * Tribe install (the scraper census listed them as duplicate rows); the single
 * REST endpoint returns every published event, so one scraper covers both.
 *
 * Feed quirks (verified 2026-07-14):
 *   • The default bot User-Agent is rejected (403); a normal desktop browser UA
 *     + Accept: application/json is required.
 *   • TIMEZONE IS CORRECTLY CONFIGURED here (unlike Peninsula Coffee House): the
 *     install reports timezone "America/New_York" and its `utc_start_date` fields
 *     are properly offset from the local `start_date` (e.g. 19:00 EDT start →
 *     23:00 UTC). Rather than depend on that staying correct, we take the
 *     robust path used by the Peninsula Coffee House scraper: treat the local
 *     `start_date` wall-clock string as Eastern and run it through easternToIso.
 *     That yields the correct UTC instant whether or not the install's timezone
 *     is ever misconfigured — start_date carries the real posted show time.
 *   • Every event's `venue` array is empty and `organizer` is empty — the calendar
 *     is a single-location restaurant calendar, so every event pins to the one
 *     canonical Beau's on the River venue record.
 *   • Titles are inconsistently entity-encoded ("Steve&#8217;o"); stripHtml
 *     decodes entities, so titles come out clean ("Steve'o").
 *   • `cost` is empty on every event — price_min/price_max stay null (never
 *     assume free).
 *   • Cuyahoga Falls is fixed in Summit County, so no per-event geo classification
 *     is needed.
 *
 * Category: the calendar's sole category to date is "Entertainment" (live music)
 * → 'music'. Dinner events / tastings / wine dinners → 'food'. Non-events (happy
 * hour, standing drink/food specials) are skipped. Anything unmapped falls
 * through to inferCategory.
 *
 * Usage:   node scripts/scrape-beaus-on-the-river.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, easternToIso,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
  parseCostFromTribe, parseTagsFromTribe,
} from './lib/normalize.js'
import { inferCategory } from './lib/category-inference.js'

export const SOURCE_KEY = 'beaus_on_the_river'
const BASE_URL   = 'https://beausontheriver.com/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180
// The default bot UA gets a 403; use a normal desktop browser UA.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const ORG_NAME   = "Beau's on the River"
const VENUE_NAME = "Beau's on the River"
const VENUE_DETAILS = {
  address: '1989 Front St',
  city: 'Cuyahoga Falls', state: 'OH', zip: '44221',
  website: 'https://beausontheriver.com',
  parking_type: 'lot',
  description:
    "Waterfront restaurant inside the Sheraton Suites Akron/Cuyahoga Falls, overlooking the Cuyahoga River falls, hosting weekend live music in the lounge plus dinner events and tastings.",
}

// ── Categorization ───────────────────────────────────────────────────────────

// Standing food/drink specials that are not discrete events (a happy hour or a
// perpetual daily/weekly special), which should be skipped rather than ingested.
const SKIP_TITLE_RE = /\b(happy hour|daily special|weekly special|drink special|food special|lunch special)\b/i

/** True when a title is a standing special / non-event that should be skipped. */
export function shouldSkip(title = '') {
  return SKIP_TITLE_RE.test(title)
}

/**
 * Tribe categories → our category. This is a restaurant entertainment calendar:
 * "Entertainment" (and live-music variants) map to 'music'; dinner events,
 * tastings, and wine dinners map to 'food'. Returns null when no confident
 * mapping applies, so inferCategory decides. Exported for tests.
 */
export function parseCategory(categories = []) {
  const slugs = categories.map((c) => `${c.slug ?? ''} ${c.name ?? ''}`.toLowerCase())
  const has = (frag) => slugs.some((s) => s.includes(frag))
  if (has('entertainment') || has('music') || has('live') || has('concert') || has('karaoke') || has('open mic')) return 'music'
  if (has('dinner') || has('tasting') || has('brunch') || has('food') || has('wine')) return 'food'
  return null
}

/**
 * Convert the feed's local wall-clock string to a correct UTC ISO instant.
 * The local `start_date`/`end_date` strings are Eastern wall-clock times;
 * easternToIso's combined form parses "YYYY-MM-DD HH:MM:SS" and applies the
 * Eastern offset (DST-aware). Robust whether or not the install's timezone is
 * correctly configured. Returns null if the field is missing/unparseable.
 */
export function toEasternIso(localDateTime) {
  if (!localDateTime) return null
  return easternToIso(String(localDateTime).replace('T', ' '))
}

/** Stable per-occurrence source_id (Tribe recurring series can repeat ids). */
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
  const startDate = new Date().toISOString().split('T')[0]
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]

  let page = 1, hasMore = true
  const all = []
  console.log('\n🔍  Fetching Beau\'s on the River events via Tribe REST API…')

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
    if (!res.ok) throw new Error(`Beau's on the River API error ${res.status}: ${(await res.text()).slice(0, 200)}`)

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
      const title   = stripHtml(ev.title ?? '')
      const startAt = toEasternIso(ev.start_date)
      if (!title || !startAt) { skipped++; continue }
      if (shouldSkip(title)) { skipped++; continue }
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
        tags:            parseTagsFromTribe(ev.categories, ev.tags, ['cuyahoga-falls', 'beaus-on-the-river']),
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
  console.log('🍽️  Starting Beau\'s on the River ingestion…')
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
