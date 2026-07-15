/**
 * scrape-akron-fossils.js
 *
 * Fetches upcoming events from the Akron Fossils & Science Center — a small
 * natural-history museum in Copley/Akron that runs kids' day camps, drop-in
 * "Super Science Saturday" family science days, adult craft nights, and an
 * annual golf-outing fundraiser.
 *
 * Platform: Squarespace (native "Events" collection — ?format=json&view=upcoming).
 *
 * Why this strategy:
 *   The public "Upcoming Events" page (/upcoming-events) is only a Squarespace
 *   *summary block* that mirrors a separate Events collection living at /events.
 *   That collection exposes the full structured feed (title, epoch start/end,
 *   body HTML, location, image) via ?format=json — far more reliable than
 *   scraping the summary block's server-rendered markup. We fetch /events
 *   through the shared lib/squarespace.js pipeline.
 *
 * Feed / markup quirks:
 *   - Cloudflare fronts this site and CHALLENGES the default bot User-Agent
 *     ("…The330-bot/1.0") with a "Just a moment…" interstitial, which parses as
 *     HTML and yields zero events. A browser-like UA passes cleanly, so we send
 *     one explicitly (see BROWSER_UA).
 *   - Every event is at the museum's single fixed address, so there is one
 *     venue. The site's own location record reads "2080 South Cleveland
 *     Massillon Road, Akron, OH 44321" (Copley border) — used verbatim.
 *   - Event bodies are wrapped in Squarespace layout <div>/<style> blocks;
 *     stripHtml (via normaliseSquarespaceEvent) drops those, leaving clean prose.
 *   - Prices are stated in the description prose for Super Science Saturdays
 *     ("Cost is $18 per non-member/$12 per member") and nowhere structured, so
 *     we parse them out; events with no stated price keep price_min/max = null.
 *   - Start/end times come from the feed's epoch millis (real ET times), so no
 *     midnight/default-time synthesis is ever needed.
 *
 * Categorization:
 *   Museum kids' programming — day camps and "Super Science Saturday" family
 *   science days — is flagged is_family with a 'learning' category hint. All
 *   other events (adult craft night, golf-outing fundraiser, wilderness trip)
 *   fall through to text inference.
 *
 * Geography:
 *   Single fixed venue confirmed inside Summit County (Akron 44321), so no
 *   per-event locality gating is required.
 *
 * Usage:
 *   node scripts/scrape-akron-fossils.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  enrichWithImageDimensions,
  ensureOrganization,
  ensureVenue,
  linkEventOrganization,
  linkEventVenue,
  linkOrganizationVenue,
  logScraperError,
  logUpsertResult,
  upsertEventSafe,
} from './lib/normalize.js'
import {
  fetchSquarespaceEvents,
  normaliseSquarespaceEvent,
  buildSquarespaceEventUrl,
} from './lib/squarespace.js'

// ── Configuration ─────────────────────────────────────────────────────────

const SITE_BASE_URL  = 'https://www.akronfossils.org'
const COLLECTION_URL = `${SITE_BASE_URL}/events`
const SOURCE_KEY     = 'akron_fossils'

// Cloudflare challenges the lib's default bot UA; a browser UA passes.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// Fixed venue — every event is at the museum's single address (Summit County).
const VENUE_INFO = {
  name:    'Akron Fossils & Science Center',
  address: '2080 South Cleveland Massillon Road',
  city:    'Akron',
  state:   'OH',
  zip:     '44321',
  lat:     41.0814904,
  lng:     -81.6433838,
  website: SITE_BASE_URL,
}

// ── Kids' / family program detection ────────────────────────────────────────

/**
 * True when the event is museum kids' programming — a themed day camp or a
 * drop-in "Super Science Saturday" family science day. These get is_family +
 * a 'learning' category hint. Adult craft nights, the golf outing, and the
 * wilderness trip deliberately do NOT match.
 */
export function isKidsProgram(item) {
  const t = item?.title ?? ''
  return /\b(camps?|super science saturday|homeschool|home ?school|kids?|children|preschool|toddlers?|little explorers)\b/i.test(t)
}

// ── Category / tag mapping ──────────────────────────────────────────────────

/**
 * Category hint (primary content axis; facet flags like is_fundraiser are
 * handled separately downstream):
 *   - Kids'/family science programming (camps, Super Science Saturday) → learning
 *   - Adult craft/printmaking classes → visual-art (text inference otherwise
 *     mis-scores these indoor art classes as 'outdoors' on their heavy "nature"
 *     wording — "gather natural materials", "connect with nature")
 *   - Golf outing → sports (inference alone leaves it a bare 'other'; the
 *     fundraiser facet is still set independently by text inference)
 *   - Everything else → null, so inference decides (e.g. canoe trip → outdoors)
 */
export function mapCategory(item) {
  const t = (item?.title ?? '').toLowerCase()
  if (isKidsProgram(item)) return 'learning'
  if (/craft/.test(t))     return 'visual-art'
  if (/\bgolf\b/.test(t))  return 'sports'
  return null
}

export function mapTags(item) {
  const t = (item?.title ?? '').toLowerCase()
  const tags = ['akron-fossils', 'copley', 'museum', 'science']

  if (/\bcamp/.test(t))                        tags.push('summer-camp', 'kids')
  if (/super science saturday/.test(t))        tags.push('family', 'science-program')
  if (/\bgolf\b/.test(t))                       tags.push('golf', 'fundraiser')
  if (/craft/.test(t))                          tags.push('craft', 'adults')
  if (/canoe|boundary waters/.test(t))          tags.push('outdoors', 'adventure')

  return [...new Set(tags)]
}

// ── Price parsing ───────────────────────────────────────────────────────────

/**
 * Pull explicit member/non-member pricing out of the description prose, e.g.
 * "Cost is $18 per non-member/$12 per member" → { price_min: 12, price_max: 18 }.
 * Returns nulls when no dollar amount is stated — we never assume a price.
 */
export function parsePrice(text = '') {
  if (!/\$/.test(text)) return { price_min: null, price_max: null }
  const amounts = [...text.matchAll(/\$\s?(\d+(?:\.\d{1,2})?)/g)].map((m) => parseFloat(m[1]))
  if (!amounts.length) return { price_min: null, price_max: null }
  const min = Math.min(...amounts)
  const max = Math.max(...amounts)
  return { price_min: min, price_max: max > min ? max : null }
}

// ── Row builder (pure) ──────────────────────────────────────────────────────

/**
 * Convert a raw Squarespace event item into a fully-normalised event row.
 * Mirrors processEvents() below — exported so tests exercise the exact logic.
 */
export function buildRow(item) {
  const row = normaliseSquarespaceEvent(item, {
    source:      SOURCE_KEY,
    mapCategory,
    mapTags,
  })

  // Full public URL for the event detail page.
  row.ticket_url = buildSquarespaceEventUrl(SITE_BASE_URL, item) || row.ticket_url

  // Museum kids'/family programming — flag it explicitly rather than leaning on
  // text inference alone (a bare "Super Science Saturday" title has no kid word).
  if (isKidsProgram(item)) row.is_family = true

  // Price from the description prose (null when unstated).
  const { price_min, price_max } = parsePrice(row.description || '')
  row.price_min = price_min
  row.price_max = price_max

  return row
}

// ── Process events ──────────────────────────────────────────────────────────

async function processEvents(rawEvents, organizerId, venueId) {
  let inserted = 0, skipped = 0

  for (const item of rawEvents) {
    try {
      const row = buildRow(item)

      if (!row.title || !row.start_at) {
        skipped++
        continue
      }

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)

      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${item.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log('🦕  Starting Akron Fossils & Science Center ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization(VENUE_INFO.name, {
      website:     SITE_BASE_URL,
      description: 'The Akron Fossils & Science Center is a natural-history museum in Copley offering hands-on exhibits, kids\' day camps, and family science programming.',
    })

    const venueId = await ensureVenue(VENUE_INFO.name, {
      address: VENUE_INFO.address,
      city:    VENUE_INFO.city,
      state:   VENUE_INFO.state,
      zip:     VENUE_INFO.zip,
      lat:     VENUE_INFO.lat,
      lng:     VENUE_INFO.lng,
      website: VENUE_INFO.website,
    })

    if (venueId && organizerId) {
      await linkOrganizationVenue(organizerId, venueId)
    }

    console.log(`\n🔍  Fetching events from ${COLLECTION_URL}…`)
    const events = await fetchSquarespaceEvents(COLLECTION_URL, { userAgent: BROWSER_UA })
    console.log(`  Found ${events.length} upcoming events`)

    const { inserted, skipped } = await processEvents(events, organizerId, venueId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: events.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly; importing for tests exposes the pure parsers
// without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
