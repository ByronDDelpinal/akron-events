/**
 * scrape-helens-studio.js
 *
 * Helen's Ceramic and Art Studio — a family-run paint-your-own-pottery and
 * art studio at 2102 State Rd in Cuyahoga Falls, running ticketed kids' paint
 * camps, paint nights, and seasonal craft events (source discovered via the
 * intake email pipeline, 2026-07-09).
 *
 * Platform: Wix, using the Wix Events & Tickets app — but unlike our other
 * Wix Events sources (akron_soul_train, southgate_farm) the /events LIST page
 * warmup blob carries no event objects on this site; only the per-event detail
 * pages are server-rendered with data. So instead of lib/wix-events.js on the
 * list page, we:
 *
 *   1. Enumerate event detail URLs from the Wix-generated event sitemap:
 *        https://www.helens.studio/event-pages-sitemap.xml
 *      (one <loc> per event page, updated by Wix as events are added/removed)
 *   2. Fetch each detail page and read its schema.org Event JSON-LD — this
 *      site's Wix build emits one complete block per page (name, description,
 *      startDate/endDate with TZ offsets, offers with prices, location,
 *      image), parsed via the shared lib/json-ld.js.
 *   3. Fall back to the page's #wix-warmup-data blob (lib/wix-events.js) for
 *      any page whose JSON-LD is missing or malformed — Wix builds vary.
 *
 * Every event is at the one studio address (the JSON-LD location.name is the
 * bare street address, which ensureVenue's address-named guard would rightly
 * refuse), so we pin all events to the canonical "Helen's Ceramic and Art
 * Studio" venue, matching the venue row created by the intake pipeline.
 *
 * Price comes from the JSON-LD offers (AggregateOffer lowPrice/highPrice or a
 * single offer price); left null when absent — never assume free.
 *
 * Usage:   node scripts/scrape-helens-studio.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, inferCategory,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue,
  linkEventOrganization, ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'
import { extractJsonLd, findSchemaObjects, firstImageUrl } from './lib/json-ld.js'
import { parseWixWarmupEvents, normaliseWixEvent } from './lib/wix-events.js'

export const SOURCE_KEY = 'helens_studio'
const SITE        = 'https://www.helens.studio'
const SITEMAP_URL = `${SITE}/event-pages-sitemap.xml`

const MAX_EVENT_PAGES  = 40    // sitemap safety cap (site currently lists ~6)
const FETCH_DELAY_MS   = 250   // politeness delay between detail-page fetches
const MAX_DAYS_AHEAD   = 365

const USER_AGENT =
  'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

// Single canonical venue — every event is at the studio. Matches the venue
// row already minted by the intake pipeline (deduped by address in ensureVenue).
export const STUDIO = {
  name:    "Helen's Ceramic and Art Studio",
  address: '2102 State Rd',
  city:    'Cuyahoga Falls',
  state:   'OH',
  zip:     '44223',
}

// ── Fetch helpers ───────────────────────────────────────────────────────────

async function fetchText(url) {
  const res = await fetch(url, {
    headers:  { Accept: 'text/html,application/xml;q=0.9,*/*;q=0.8', 'User-Agent': USER_AGENT },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Pure parsers (exported for tests) ───────────────────────────────────────

/**
 * Extract event detail URLs from the Wix event sitemap.
 * Throws on structurally-wrong input (not a urlset) so a Wix platform change
 * surfaces as a scraper error instead of a silent clean-zero run; an empty
 * urlset (no events published) legitimately returns [].
 */
export function parseSitemapUrls(xml) {
  const s = String(xml || '')
  if (!/<urlset[\s>]/i.test(s)) {
    throw new Error('event-pages-sitemap.xml is not a <urlset> — Wix may have changed its sitemap layout')
  }
  const urls = [...s.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1])
  // Only event detail pages; the guard keeps us from crawling arbitrary URLs
  // if Wix ever mixes other page types into this sitemap.
  return [...new Set(urls.filter((u) => u.includes('/event-details-registration/')))]
}

/** Stable source_id: the Wix event slug (last path segment of the detail URL). */
export function slugFromUrl(url) {
  const m = String(url || '').match(/\/event-details-registration\/([^/?#]+)/)
  return m ? m[1] : null
}

/** Price bounds from a schema.org offers property (AggregateOffer or Offer). */
export function parseOffers(offers) {
  if (!offers) return { price_min: null, price_max: null }
  const o = Array.isArray(offers) ? offers[0] : offers
  if (!o || typeof o !== 'object') return { price_min: null, price_max: null }
  const num = (v) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const low  = num(o.lowPrice)  ?? num(o.price)
  const high = num(o.highPrice)
  return {
    price_min: low,
    price_max: high != null && low != null && high > low ? high : null,
  }
}

/**
 * Drop Wix's duplicate-title suffix: reusing an event name makes Wix store
 * "Silly Snake Kid's Painting Camp (1)" — the "(1)" is CMS noise, not content.
 * (The slug keeps the suffix, so source_ids stay distinct.)
 */
export function cleanTitle(title) {
  return String(title || '').replace(/\s*\(\d+\)\s*$/, '').trim()
}

/** Title-scoped family flag (per repo policy, title only — not description). */
export function isFamilyTitle(title) {
  return /\b(kid'?s?|children'?s?|family|toddler)\b/i.test(String(title || ''))
}

function mapTags(title = '') {
  const t    = title.toLowerCase()
  const tags = ['helens-studio', 'cuyahoga-falls', 'art-studio']
  if (/\bkid|child|toddler|family\b/.test(t))  tags.push('kids')
  if (/\bpaint/.test(t))                       tags.push('painting')
  if (/\bceramic|pottery|clay\b/.test(t))      tags.push('ceramics')
  if (/\bcamp\b/.test(t))                      tags.push('camp')
  return [...new Set(tags)]
}

/**
 * Map a schema.org Event JSON-LD object (+ its page URL) to an events row.
 * Returns null when required fields are missing.
 */
export function eventFromJsonLd(ld, pageUrl) {
  const title = typeof ld?.name === 'string' ? cleanTitle(ld.name) : null
  if (!title) return null

  const startMs = Date.parse(ld.startDate ?? '')
  if (!Number.isFinite(startMs)) return null
  const start_at = new Date(startMs).toISOString()

  const endMs  = Date.parse(ld.endDate ?? '')
  const end_at = Number.isFinite(endMs) && endMs > startMs ? new Date(endMs).toISOString() : null

  const rawDesc     = typeof ld.description === 'string' ? ld.description : null
  const description = rawDesc ? stripHtml(rawDesc).slice(0, 5000) || null : null

  const { price_min, price_max } = parseOffers(ld.offers)

  return {
    title,
    description,
    start_at,
    end_at,
    category:        inferCategory(title, description || ''),
    tags:            mapTags(title),
    is_family:       isFamilyTitle(title) || undefined,
    price_min,
    price_max,
    age_restriction: 'not_specified',
    image_url:       firstImageUrl(ld.image),
    ticket_url:      pageUrl,
    source_url:      pageUrl,
    source:          SOURCE_KEY,
    source_id:       slugFromUrl(pageUrl),
    status:          'published',
    featured:        false,
  }
}

/**
 * Parse one detail page's HTML into an events row: JSON-LD first, warmup-data
 * fallback. Returns null when neither yields a usable event.
 */
export function eventFromDetailPage(html, pageUrl) {
  const ldEvents = findSchemaObjects(extractJsonLd(html), 'Event')
  if (ldEvents.length > 0) {
    const row = eventFromJsonLd(ldEvents[0], pageUrl)
    if (row) return row
  }
  // Fallback: the server-rendered Wix warmup blob (shape varies by build).
  const warm = parseWixWarmupEvents(html)
  if (warm.length > 0) {
    const row = normaliseWixEvent(warm[0], {
      source: SOURCE_KEY, mapTags: (ev) => mapTags(ev.title), siteBaseUrl: SITE,
    })
    if (row?.title && row.start_at) {
      row.title      = cleanTitle(row.title)
      row.category   = inferCategory(row.title, row.description || '')
      row.is_family  = isFamilyTitle(row.title) || undefined
      // This site's detail URLs use /event-details-registration/, not the
      // /event-details/ default that buildWixEventUrl assumes.
      row.ticket_url = pageUrl
      row.source_url = pageUrl
      row.source_id  = slugFromUrl(pageUrl) ?? row.source_id
      return row
    }
  }
  return null
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log("🎨  Starting Helen's Ceramic and Art Studio (Wix Events) ingestion…")
  const start = Date.now()
  try {
    const [venueId, organizerId] = await Promise.all([
      ensureVenue(STUDIO.name, {
        address: STUDIO.address, city: STUDIO.city, state: STUDIO.state, zip: STUDIO.zip,
        website: SITE,
      }),
      ensureOrganization(STUDIO.name, {
        website: SITE,
        description:
          "Helen's Ceramic and Art Studio is a family-run paint-your-own-pottery and art studio " +
          "in Cuyahoga Falls hosting kids' paint camps, paint nights, and seasonal craft events.",
      }),
    ])
    if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)

    console.log(`\n🔍  Fetching event sitemap ${SITEMAP_URL}…`)
    const urls = parseSitemapUrls(await fetchText(SITEMAP_URL)).slice(0, MAX_EVENT_PAGES)
    console.log(`  Found ${urls.length} event page(s) in sitemap`)

    const now    = Date.now()
    const cutoff = now + MAX_DAYS_AHEAD * 86_400_000
    let inserted = 0, skipped = 0

    for (const url of urls) {
      try {
        const row = eventFromDetailPage(await fetchText(url), url)
        if (!row) {
          console.warn(`  ⚠ No parseable event data at ${url}`)
          skipped++
          continue
        }

        const startMs = Date.parse(row.start_at)
        if (startMs < now - 86_400_000 || startMs > cutoff) { skipped++; continue } // past / too far out

        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`); skipped++; continue }
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
        console.log(`  ✓ ${row.title} (${row.start_at.slice(0, 10)})`)
      } catch (err) {
        console.warn(`  ⚠ Error on ${url}: ${err.message}`)
        skipped++
      }
      await sleep(FETCH_DELAY_MS)
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: urls.length, durationMs: Date.now() - start,
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
