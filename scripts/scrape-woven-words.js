/**
 * scrape-woven-words.js
 *
 * Woven Words Bookshop - an independent bookshop at 843 N. Cleveland
 * Massillon Rd. in northwest Akron (Montrose, 44333) whose calendar is
 * exactly the grassroots programming Akron Pulse exists to surface: author
 * signings, book clubs, knit nights, paper-quilling and DIY craft classes,
 * book swaps, and storytimes.
 *
 * Platform: WordPress + The Events Calendar (Tribe) REST API, the same shape
 * as the Stewart's Caring Place / Indivisible Akron / Royal Palace scrapers.
 *   https://www.wovenwordsbookshop.com/wp-json/tribe/events/v1/events
 *
 * Feed notes (verified 2026-08-07):
 *   • 13 upcoming events, total_pages=1 - a small single-venue calendar.
 *   • categories and tags arrays are EMPTY on every event, so category comes
 *     from title inference (inferCategory below), never from Tribe taxonomy.
 *   • cost strings look like "$45.00" / "Free" / "" and parse via
 *     parseCostFromTribe; an empty cost stays null (never assume free).
 *   • custom_fields is empty. When an event is ticketed, the checkout link
 *     (square.link) arrives in the event's `website` field, which wins over
 *     the post URL for ticket_url.
 *   • Single venue record (id 163): the shop itself. Venue-less events pin
 *     to the shop record; the Summit gate and the virtual-venue regex still
 *     run in case the feed ever grows satellite or online sessions.
 *   • Recurring clubs currently publish under distinct post ids, but Tribe
 *     reuses ids per occurrence for true series, so source_id is
 *     `${id}-${YYYY-MM-DD}` (the Stewart's / Indivisible pattern).
 *
 * Usage:   node scripts/scrape-woven-words.js
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
import { fetchTribeEvents } from './lib/tribe-events.js'
import { isSummitCountyLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'woven_words'
const BASE_URL   = 'https://www.wovenwordsbookshop.com/wp-json/tribe/events/v1/events'
const PER_PAGE   = 50
const DAYS_AHEAD = 180

const ORG_NAME   = 'Woven Words Bookshop'
const VENUE_NAME = 'Woven Words Bookshop'
const VENUE_DETAILS = {
  address: '843 N. Cleveland Massillon Rd.',
  city: 'Akron', state: 'OH', zip: '44333',
  website: 'https://www.wovenwordsbookshop.com',
  description: 'Independent bookshop in northwest Akron hosting author signings, book clubs, craft nights, and community book swaps.',
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/**
 * Category from the event title - the feed's Tribe categories array is empty
 * on every event, so this is the only signal. Craft signals run FIRST so
 * "Book Club and Crafternoon" lands on the craft session it is, not the
 * book-club fallback; swaps/fairs are markets; author/book programming is
 * learning; trivia and game nights stay 'other'. A bookshop's unlabelled
 * long tail is book programming, so the fallback is 'learning'.
 */
export function inferCategory(title = '') {
  const t = String(title).toLowerCase()
  if (/\b(knit|crochet|quilling|craft|diy|garland|paint|collage)/.test(t)) return 'visual-art'
  if (/\b(swap|fair|sale)\b/.test(t))                                      return 'market'
  if (/\b(author|signing|book club|read|poetry|writing|storytime)/.test(t)) return 'learning'
  if (/\b(trivia|game)/.test(t))                                            return 'other'
  return 'learning'
}

/**
 * Per-occurrence source_id: Tribe recurring series repeat the event id across
 * occurrences, so append the local start date (the Stewart's pattern).
 */
export function buildSourceId(ev) {
  const day = (ev.start_date ?? ev.utc_start_date ?? '').slice(0, 10)
  return day ? `${ev.id}-${day}` : String(ev.id)
}

/** Ticket link: the event website (square.link checkout) wins over the post URL. */
export function parseTicketUrl(ev = {}) {
  return ev.website || ev.url || null
}

/** Venue names that are meeting links, not places ("Virtual Zoom Call"). */
const VIRTUAL_VENUE_RE = /\b(virtual|zoom|online|webinar|teams|google meet)\b/i

/**
 * Locality/eligibility gate: skip virtual sessions and any event whose venue
 * sits outside Summit County. Venue-less events pass - they default to the
 * shop record. The virtual-venue name check backs up is_virtual because Tribe
 * installs routinely leave the flag false on "Virtual Zoom Call" venues
 * (verified on the Stewart's feed 2026-07-08).
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

// ── Fetch all pages ──────────────────────────────────────────────────────────

async function fetchAllPages() {
  const startDate = easternTodayIso()
  const endDate   = new Date(Date.now() + DAYS_AHEAD * 86400_000).toISOString().split('T')[0]

  console.log('\n🔍  Fetching Woven Words Bookshop events via Tribe REST API…')

  return fetchTribeEvents({
    baseUrl:   BASE_URL,
    label:     "Woven Words",
    startDate,
    endDate,
    perPage:   PER_PAGE,
    userAgent: 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)',
  })
}

// ── Process events ───────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId, shopVenueId) {
  let inserted = 0, skipped = 0

  for (const ev of rawEvents) {
    try {
      if (!includeEvent(ev)) {
        const reason = ev.is_virtual || VIRTUAL_VENUE_RE.test(ev.venue?.venue ?? '')
          ? 'virtual session'
          : `outside Summit County (${ev.venue?.city})`
        console.log(`  ⛔ Skipping "${stripHtml(ev.title ?? '')}" - ${reason}`)
        skipped++
        continue
      }

      const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
      const title    = stripHtml(ev.title ?? '')
      const category = inferCategory(title)
      const tags     = parseTagsFromTribe(ev.categories, ev.tags, ['books', 'woven-words'])
      const imageUrl = parseImage(ev.image, ev.description)

      const row = {
        title,
        description:     stripHtml(ev.description ?? '') || null,
        start_at:        ev.utc_start_date ? ev.utc_start_date.replace(' ', 'T') + 'Z' : null,
        end_at:          ev.utc_end_date   ? ev.utc_end_date.replace(' ', 'T') + 'Z'   : null,
        category,
        tags,
        price_min,
        price_max,
        age_restriction: 'not_specified',
        image_url:       imageUrl,
        ticket_url:      parseTicketUrl(ev),
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
        await linkEventVenue(upserted.id, shopVenueId)
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
  console.log('🚀  Starting Woven Words Bookshop ingestion…')
  const start = Date.now()
  try {
    const [organizerId, shopVenueId] = await Promise.all([
      // First-party self-credit is legitimate here: the shop hosts its own
      // programming (unlike aggregators, which must never self-credit).
      ensureOrganization(ORG_NAME, {
        website: 'https://www.wovenwordsbookshop.com',
        description: VENUE_DETAILS.description,
      }),
      ensureVenue(VENUE_NAME, VENUE_DETAILS),
    ])
    await linkOrganizationVenue(organizerId, shopVenueId)

    const rawEvents = await fetchAllPages()
    console.log(`\n📥  Processing ${rawEvents.length} events…`)

    const { inserted, skipped } = await processEvents(rawEvents, organizerId, shopVenueId)
    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s - ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
