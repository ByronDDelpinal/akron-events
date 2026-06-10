/**
 * scrape-kent-stage.js
 *
 * Fetches upcoming shows from The Kent Stage — a 600-seat independent
 * concert venue and listening room at 175 E Main St in Kent, Ohio
 * (~13 mi NE of downtown Akron, comfortably inside our 25-mile geo gate).
 * Kent Stage books touring folk, country, blues, Americana, indie, and
 * comedy acts; their schedule is one of the longest-running music
 * calendars in the region.
 *
 * Platform: kentstage.org is a WordPress / Elementor site. Each /event/
 * detail page emits a Schema.org Event JSON-LD block with name,
 * startDate (ISO + TZ offset), location, offers (price + ticket URL to
 * etix.com), image, and description. The listing page (/events/) is
 * server-rendered HTML and yields every event's permalink; we walk it
 * once and follow each detail link to extract the structured fields.
 *
 * Strategy:
 *   1. GET /events/, scrape every distinct /event/<slug>/the-kent-stage/kent-ohio/
 *      anchor.
 *   2. For each detail URL, GET the page and parse the @type:Event JSON-LD.
 *   3. HTML-entity-decode the name (WordPress emits &#8211; &#038; etc.),
 *      convert startDate to UTC ISO, pull price/ticket url from offers[0],
 *      fall back to the body's first `$N` pattern when the LD price is 0
 *      AND offers point at a real ticketing platform (etix), since
 *      "free entry but ticketed" is exceedingly rare here and a 0 in that
 *      shape signals "price not specified in the structured data".
 *   4. Upsert one row per event.
 *
 * Why this avoids Akron Life: Kent Stage is priority #2 in the Akron Life
 * dwindle plan — Evvnt surfaces ~4 of their shows but the venue books
 * ~25 per quarter. Direct ingestion captures everything and lets us
 * skip the Evvnt copies via COVERED_BY_DIRECT_SCRAPER.
 *
 * Usage:
 *   node scripts/scrape-kent-stage.js
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
  inferCategory,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
} from './lib/normalize.js'

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_KEY    = 'kent_stage'
const BASE_URL      = 'https://kentstage.org'
const LISTING_URL   = `${BASE_URL}/events/`
const HORIZON_DAYS  = 365             // their season is published a year out
const USER_AGENT    = 'Mozilla/5.0 (compatible; AkronPulseBot/1.0; +https://akronpulse.com)'

const VENUE_INFO = {
  name:    'The Kent Stage',
  address: '175 E Main St',
  city:    'Kent',
  state:   'OH',
  zip:     '44240',
  lat:     41.1537,
  lng:     -81.3576,
  website: BASE_URL,
  description:
    'Independent 600-seat concert venue and listening room in downtown Kent, ~13 miles ' +
    'northeast of Akron. Books touring folk, country, blues, Americana, indie, and ' +
    'comedy acts year-round.',
  parking_type:  'street',
  parking_notes: 'On-street parking on E Main St plus nearby downtown lots.',
}

const ORG_INFO = {
  name: 'The Kent Stage',
  details: {
    website: BASE_URL,
    description:
      'Independent concert venue and listening room in Kent, OH. Ticketing through etix.com.',
  },
}

// ── HTML helpers ──────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

/**
 * Decode the common HTML entities WordPress emits inside JSON-LD strings —
 * &#8211; (en-dash), &#8217; (right curly apostrophe), &#038; (ampersand),
 * &amp; (escaped ampersand), &quot;, &lt;, &gt;. Skips a full parser so we
 * stay zero-dep; this list covers everything we've actually seen.
 */
function decodeEntities(s) {
  if (!s) return s
  return String(s)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

// ── Listing parse ─────────────────────────────────────────────────────────

/**
 * Pull every distinct /event/<slug>/the-kent-stage/kent-ohio/ URL out of
 * the listing HTML. The "gift card" permalink uses the same pattern, so we
 * drop it explicitly — it's a perpetual product page, not a date-bound
 * event.
 */
function parseEventUrls(html) {
  const seen = new Set()
  const re = /href="([^"]*\/event\/([^"/]+)\/[^"/]+\/[^"/]+\/?)"/gi
  for (const m of html.matchAll(re)) {
    const url = m[1]
    const slug = m[2]
    if (slug.includes('gift-card')) continue
    // Normalise to absolute URL.
    const abs = url.startsWith('http') ? url : `${BASE_URL}${url}`
    seen.add(abs)
  }
  return [...seen]
}

// ── Detail page parse ────────────────────────────────────────────────────

/**
 * Walk every <script type="application/ld+json"> block in the page and
 * return the first one whose flattened @graph entries include an Event.
 * Returns the Event object or null.
 */
function extractEventJsonLd(html) {
  const blocks = html.matchAll(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)
  for (const m of blocks) {
    let parsed
    try { parsed = JSON.parse(m[1]) } catch { continue }
    const items = Array.isArray(parsed) ? parsed : [parsed]
    for (const item of items) {
      const entries = item && item['@graph'] ? item['@graph'] : [item]
      for (const e of entries) {
        const t = e?.['@type']
        if (t === 'Event' || (Array.isArray(t) && t.includes('Event'))) return e
      }
    }
  }
  return null
}

/**
 * First "$N" or "$N - $M" amount found in stripped body text. Used only as
 * a sanity-fallback when the JSON-LD offers.price is 0 (which Kent Stage
 * uses for "not specified in structured data" rather than actually free).
 */
function parsePriceFromBody(html) {
  const text = stripHtml(html)
  const range = text.match(/\$([\d.,]+)\s*[-–—]\s*\$([\d.,]+)/)
  if (range) {
    return {
      min: parseFloat(range[1].replace(/,/g, '')),
      max: parseFloat(range[2].replace(/,/g, '')),
    }
  }
  const single = text.match(/\$([\d.,]+)/)
  if (single) return { min: parseFloat(single[1].replace(/,/g, '')), max: null }
  return { min: null, max: null }
}

// ── Category / tag mapping ───────────────────────────────────────────────

// Category: infer from title + description; Kent Stage defaults to 'music'.
function mapCategory(title = '', description = '') {
  const cat = inferCategory(title, description)
  return (cat === 'other' || cat === 'civic') ? 'music' : cat
}

function mapTags(title = '') {
  const t = title.toLowerCase()
  const tags = ['kent-stage', 'kent', 'live-music', 'concert-venue']
  if (/comedy|comedian|stand[- ]?up/i.test(t))           tags.push('comedy')
  if (/tribute/i.test(t))                                tags.push('tribute')
  if (/blues/i.test(t))                                  tags.push('blues')
  if (/folk|americana/i.test(t))                         tags.push('folk', 'americana')
  if (/country/i.test(t))                                tags.push('country')
  if (/jazz/i.test(t))                                   tags.push('jazz')
  return [...new Set(tags)]
}

// ── Process ──────────────────────────────────────────────────────────────

async function processEvents(detailPages, venueId, organizerId) {
  let inserted = 0, skipped = 0
  const horizonMs = Date.now() + HORIZON_DAYS * 86_400_000

  for (const { url, html } of detailPages) {
    try {
      const ld = extractEventJsonLd(html)
      if (!ld) { skipped++; continue }

      const title = decodeEntities(ld.name)
      if (!title) { skipped++; continue }

      const startAt = ld.startDate ? new Date(ld.startDate).toISOString() : null
      const endAt   = ld.endDate   ? new Date(ld.endDate).toISOString()   : null
      if (!startAt) { skipped++; continue }

      // Past + horizon filter
      const startMs = new Date(startAt).getTime()
      if (startMs < Date.now() - 86_400_000) { skipped++; continue }
      if (startMs > horizonMs)                { skipped++; continue }

      const description = decodeEntities(typeof ld.description === 'string' ? ld.description : null)
      const imageUrl    = typeof ld.image === 'string'
        ? ld.image
        : Array.isArray(ld.image) ? ld.image[0] : (ld.image?.url ?? null)

      // Offers → ticket URL + price. Kent Stage emits price:0 even for paid
      // shows; treat 0 as "unknown" when the offer URL points at a real
      // ticketing host (etix.com today), and fall through to a body-text
      // dollar-amount sniff in that case.
      const offers = Array.isArray(ld.offers) ? ld.offers : (ld.offers ? [ld.offers] : [])
      const offer  = offers[0] || {}
      const ticketUrl = offer.url || url
      let priceMin = null, priceMax = null
      const rawPrice = offer.price === 0 || offer.price ? Number(offer.price) : NaN
      const ticketedHost = offer.url && /etix\.com|ticketweb\.com|seatengine\.com/i.test(offer.url)
      if (Number.isFinite(rawPrice) && rawPrice > 0) {
        priceMin = rawPrice
      } else if (Number.isFinite(rawPrice) && rawPrice === 0 && !ticketedHost) {
        // Genuinely free admission — no ticket platform pointer.
        priceMin = 0; priceMax = 0
      } else {
        // 0-with-ticket-link or missing — fall back to body sniff.
        const sniff = parsePriceFromBody(html)
        priceMin = sniff.min
        priceMax = sniff.max
      }

      const row = {
        title,
        description,
        start_at:        startAt,
        end_at:          endAt,
        category:        mapCategory(title, description ?? ''),
        tags:            mapTags(title),
        price_min:       priceMin,
        price_max:       priceMax,
        age_restriction: 'all_ages',
        image_url:       imageUrl,
        ticket_url:      ticketUrl,
        source:          SOURCE_KEY,
        // The detail URL slug is stable per event; strip the trailing
        // venue/city path noise so source_id stays compact.
        source_id:       url.match(/\/event\/([^/]+)\//)?.[1] ?? url,
        status:          'published',
        featured:        false,
      }

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${title}":`, error.message)
        skipped++
        continue
      }
      if (venueId)     await linkEventVenue(upserted.id, venueId)
      if (organizerId) await linkEventOrganization(upserted.id, organizerId)
      inserted++
    } catch (err) {
      console.warn(`  ⚠ Error processing ${url}:`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Entry point ──────────────────────────────────────────────────────────

async function main() {
  console.log('🎤  Starting Kent Stage ingestion…')
  const start = Date.now()

  try {
    const venueId = await ensureVenue(VENUE_INFO.name, {
      address:       VENUE_INFO.address,
      city:          VENUE_INFO.city,
      state:         VENUE_INFO.state,
      zip:           VENUE_INFO.zip,
      lat:           VENUE_INFO.lat,
      lng:           VENUE_INFO.lng,
      website:       VENUE_INFO.website,
      description:   VENUE_INFO.description,
      parking_type:  VENUE_INFO.parking_type,
      parking_notes: VENUE_INFO.parking_notes,
    })
    const organizerId = await ensureOrganization(ORG_INFO.name, ORG_INFO.details)
    if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)

    console.log(`\n🔍  Fetching ${LISTING_URL}…`)
    const listingHtml = await fetchHtml(LISTING_URL)
    const eventUrls = parseEventUrls(listingHtml)
    console.log(`  Found ${eventUrls.length} event URLs`)

    const detailPages = []
    for (const url of eventUrls) {
      try {
        const html = await fetchHtml(url)
        detailPages.push({ url, html })
      } catch (err) {
        console.warn(`  ⚠ Failed to fetch ${url}: ${err.message}`)
      }
    }

    console.log(`\n📥  Processing ${detailPages.length} events…`)
    const { inserted, skipped } = await processEvents(detailPages, venueId, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: detailPages.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly (`node scripts/scrape-kent-stage.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
