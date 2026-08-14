/**
 * scrape-wine-mill.js
 *
 * The Wine Mill — winery and live-music patio on Akron-Cleveland Rd in
 * Peninsula (Boston Township). The calendar is dominated by weekend live
 * music (solo acts and duos on the patio) plus the occasional special.
 *
 * Platform: WordPress + The Events Calendar REST API — a HEALTHY modern
 * install (verified 2026-07-08: date windows respected, per-occurrence
 * entries with current dates), unlike Main Street Barberton's legacy one.
 *
 * Feed notes:
 *   • Most entries are ALL-DAY (`all_day: true`, start_date "…00:00:00",
 *     end_date "…23:59:59"): the venue lists the day, not a set time. There is
 *     NO real start time, so we keep the DATE and flag `needs_review` for a
 *     human to supply the hour — we never publish a fabricated midnight as if
 *     it were the door time.
 *   • Timed entries (`all_day: false`) do carry a real clock time — no review
 *     flag — but their UTC is wrong too, see below.
 *   • NEVER trust `utc_start_date`/`utc_end_date`: the site declares a fixed
 *     "UTC-4" timezone rather than America/New_York, so every UTC value it
 *     publishes is an hour early across the EST half of the year (verified
 *     2026-07-27: local 2026-12-02 08:00 was published as 12:00Z = 07:00 EST),
 *     and all-day rows land at 03:00Z, i.e. the PREVIOUS day at 11pm ET.
 *     We anchor to the local `start_date`/`end_date` with easternToIso instead.
 *   • The "drink-special" category (House Wine Wednesday etc.) is a pricing
 *     promo, not an event — skipped, same reasoning that kept Fun'N'Stuff's
 *     specials page out of the census Build list.
 *   • No venue objects in the feed — everything pins to the single Wine Mill
 *     venue record.
 *
 * Usage:   node scripts/scrape-wine-mill.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
  parseCostFromTribe, parseTagsFromTribe,
  easternTodayIso, easternToIso,
} from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'

export const SOURCE_KEY = 'wine_mill'
const BASE_URL   = 'https://www.thewinemill.com/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180

const ORG_NAME   = 'The Wine Mill'
const VENUE_NAME = 'The Wine Mill'
const VENUE_DETAILS = {
  address: '4964 Akron-Cleveland Rd',
  city: 'Peninsula', state: 'OH', zip: '44264',
  website: 'https://www.thewinemill.com',
  parking_type: 'lot',
  description: 'Winery with a live-music patio on Akron-Cleveland Rd in the Cuyahoga Valley.',
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** Skip pricing promos — "drink-special" category entries are not events. */
export function includeEvent(ev = {}) {
  const slugs = (ev.categories ?? []).map((c) => (c.slug ?? '').toLowerCase())
  return !slugs.includes('drink-special')
}

/** Tribe categories → our category. The calendar is music-first. */
export function parseCategory(tribeCategories = []) {
  const slugs = tribeCategories.map((c) => (c.slug ?? c.name ?? '').toLowerCase())
  const has = (frag) => slugs.some((s) => s.includes(frag))
  if (has('music') || has('live')) return 'music'
  if (has('trivia') || has('game')) return 'games'
  if (has('food') || has('tasting') || has('pairing')) return 'food'
  return null // inference decides; manifest default backs it up
}

/** Per-occurrence source_id (recurring weekly series repeat event ids). */
export function buildSourceId(ev) {
  const day = (ev.start_date ?? ev.utc_start_date ?? '').slice(0, 10)
  return day ? `${ev.id}-${day}` : String(ev.id)
}

/**
 * True when Tribe marks the entry as all-day — the feed's own authoritative
 * flag. Such rows carry no real time of day; callers keep the date, flag
 * `needs_review`, and never synthesize or round a clock time.
 */
export function isAllDayEvent(ev = {}) {
  return ev.all_day === true
}

function parseImage(imageObj, descriptionHtml = '') {
  if (imageObj && imageObj.url) return imageObj.url
  return String(descriptionHtml).match(/<img[^>]+src="([^"]+)"/)?.[1] ?? null
}

/**
 * Build an event row from one Tribe REST event. Pure (no I/O) so tests can
 * exercise the real start-time path against captured feed shapes.
 *
 * Times anchor to the LOCAL `start_date`/`end_date` via easternToIso (single-arg
 * combined form handles "2026-07-31 00:00:00"). The feed's `utc_start_date` is
 * NOT usable: the site declares a hardcoded "UTC-4" timezone, so every UTC value
 * it publishes is an hour early once the calendar crosses into EST (verified
 * live 2026-07-27: local 2026-12-02 08:00 was published as 12:00Z, i.e. 07:00
 * EST), and all-day rows come through as 03:00Z — the previous evening in ET.
 *
 * All-day rows additionally get `needs_review`: the DATE is real, the midnight
 * is a placeholder the venue never stated. Never round or invent an hour.
 */
export function buildRow(ev = {}) {
  const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
  const allDay = isAllDayEvent(ev)

  return {
    title:           stripHtml(ev.title ?? ''),
    description:     stripHtml(ev.description ?? '') || null,
    start_at:        easternToIso(ev.start_date),
    end_at:          allDay ? null : (ev.end_date ? easternToIso(ev.end_date) : null),
    category:        parseCategory(ev.categories),
    tags:            parseTagsFromTribe(ev.categories, ev.tags, ['winery', 'live-music', 'wine-mill', 'peninsula']),
    price_min,
    price_max,
    age_restriction: 'not_specified',
    image_url:       parseImage(ev.image, ev.description),
    ticket_url:      ev.website || ev.url || null,
    source:          SOURCE_KEY,
    source_id:       buildSourceId(ev),
    status:          'published',
    // No real time of day — surface for a human, never fabricate one.
    // `undefined` (not false) so normalize.js's own default still applies.
    needs_review:    allDay ? true : undefined,
    featured:        false,
  }
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = easternTodayIso()
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]

  let page = 1, hasMore = true
  const all = []
  console.log('\n🔍  Fetching The Wine Mill events via Tribe REST API…')

  while (hasMore) {
    const url = new URL(BASE_URL)
    url.searchParams.set('per_page',   PER_PAGE)
    url.searchParams.set('page',       page)
    url.searchParams.set('start_date', startDate)
    url.searchParams.set('end_date',   endDate)
    url.searchParams.set('status',     'publish')

    const res = await fetchWithRetry(url.toString(), {
      headers: { Accept: 'application/json' },
      redirect: 'follow',
      useProxy: true,
      treatBotChallengeAsRetryable: true,
    })
    if (!res.ok) throw new Error(`Wine Mill API error ${res.status}: ${(await res.text()).slice(0, 200)}`)

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
  console.log('🍷  Starting The Wine Mill ingestion…')
  const start = Date.now()
  try {
    const [organizerId, venueId] = await Promise.all([
      ensureOrganization(ORG_NAME, { website: VENUE_DETAILS.website, description: VENUE_DETAILS.description }),
      ensureVenue(VENUE_NAME, VENUE_DETAILS),
    ])
    await linkOrganizationVenue(organizerId, venueId)

    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)

    let inserted = 0, skipped = 0
    for (const ev of rawEvents) {
      try {
        if (!includeEvent(ev)) {
          console.log(`  ⛔ Skipping "${stripHtml(ev.title ?? '')}" — drink special, not an event`)
          skipped++
          continue
        }
        const row = buildRow(ev)
        if (!row.title || !row.start_at) { skipped++; continue }

        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) {
          console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
          skipped++
        } else {
          await linkEventVenue(upserted.id, venueId)
          await linkEventOrganization(upserted.id, organizerId)
          inserted++
        }
      } catch (err) {
        console.warn(`  ⚠ Error processing event ${ev.id}:`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: rawEvents.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
