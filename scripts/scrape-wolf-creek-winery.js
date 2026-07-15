/**
 * scrape-wolf-creek-winery.js
 *
 * The Winery at Wolf Creek — a family winery + event venue at 2637 S Cleveland
 * Massillon Rd on the Norton/Barberton line in Summit County. It runs a busy
 * public calendar: live music, rotating food trucks, "Yappy Hours" (dog
 * socials), paint-&-sip and craft workshops, tarot nights, and the Paws &
 * Prayers fundraiser.
 *
 * Platform: Wix Events. Two server-rendered sources are combined:
 *
 *   1. The /events-1 LIST page renders a <script id="wix-warmup-data"> blob
 *      carrying the FIRST page of upcoming events as fully-structured objects
 *      (title, scheduling.config start/end ISO, location w/ fullAddress + geo,
 *      description, image, slug). This is the primary source — read via the
 *      shared lib/wix-events.js, exactly like akron_soul_train / southgate_farm.
 *
 *   2. That warmup blob carries `hasMore:true` — the widget paginates and only
 *      the first ~18 events render server-side. Wix's private "load more" API
 *      is WAF-blocked to non-browser clients (403), so we can't page it. To
 *      catch upcoming events beyond page one we read the Wix event sitemap
 *      (event-pages-sitemap.xml) and, for any DATE-STAMPED slug whose encoded
 *      Eastern date is in the future and isn't already in the warmup, fetch its
 *      detail page and read the schema.org Event JSON-LD (authoritative ISO
 *      start/end with TZ offset), via lib/json-ld.js — the helens_studio path.
 *
 *   Wix stamps most event slugs with `-YYYY-MM-DD-HH-MM` (each recurrence is
 *   its own dated event), so this catches the great majority of the tail with
 *   ~a few dozen targeted fetches instead of crawling all ~800 sitemap URLs.
 *   The rare UN-dated future event past page one (e.g. an annual fundraiser) is
 *   picked up automatically on a later twice-daily run as its date enters the
 *   warmup window — self-healing, and we never bulk-fetch hundreds of past
 *   detail pages.
 *
 * Location: every event resolves to the single winery address (Wix geocodes it
 * to Barberton; the business brands as Norton, OH — same place, both Summit
 * County). We therefore pin all events to one canonical venue. As a strict-
 * mandate guard, any warmup event whose own coordinates fall OUTSIDE Summit
 * County is skipped (never happens today, but protects against a stray offsite
 * listing). The location.name in the raw data is the bare street address, which
 * ensureVenue's address-named guard would rightly refuse — hence the canonical
 * pin.
 *
 * Price: left null unless a detail page's JSON-LD offers state one — never
 * assume free (many events are free-entry but the ticketed workshops are not).
 *
 * Some entries RSVP out to Eventbrite; we still ingest them because this
 * winery listing is canonical for its own events — the cross-source dedupe
 * handles any Eventbrite overlap.
 *
 * Usage:   node scripts/scrape-wolf-creek-winery.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, decodeEntities, inferCategory,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue,
  linkEventOrganization, ensureVenue, ensureOrganization, linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'
import { extractJsonLd, findSchemaObjects, firstImageUrl } from './lib/json-ld.js'
import {
  parseWixWarmupEvents, parseWixLocation, normaliseWixEvent,
} from './lib/wix-events.js'
import { classifySummitLocation, preloadSummitCountyBoundary } from './lib/summit-county.js'

export const SOURCE_KEY = 'wolf_creek_winery'
const SITE        = 'https://www.wineryatwolfcreek.com'
const EVENTS_URL  = `${SITE}/events-1`
const SITEMAP_URL = `${SITE}/event-pages-sitemap.xml`

const MAX_DAYS_AHEAD   = 180
const MAX_TAIL_FETCHES = 80    // safety cap on detail-page fetches per run
const FETCH_DELAY_MS   = 250   // politeness delay between detail-page fetches

const USER_AGENT =
  'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

// Single canonical venue — every event is at the winery. Deduped by address in
// ensureVenue. Coordinates from Wix; municipality = Norton per the business's
// own branding (Wix's geocoder labels the shared 44203 zip "Barberton").
export const WINERY = {
  name:    'The Winery at Wolf Creek',
  address: '2637 S Cleveland Massillon Rd',
  city:    'Norton',
  state:   'OH',
  zip:     '44203',
  lat:     41.0672546,
  lng:     -81.6374887,
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

// ── URL / slug helpers ──────────────────────────────────────────────────────

/** Public detail URL for a Wix event slug (this site uses /event-info/). */
export function eventInfoUrl(slug) {
  return slug ? `${SITE}/event-info/${slug}` : null
}

/** Stable source_id: the Wix event slug (last path segment of a detail URL). */
export function slugFromEventUrl(url) {
  const m = String(url || '').match(/\/event-info\/([^/?#]+)/)
  return m ? m[1] : null
}

/**
 * Extract event slugs from the Wix event sitemap. Throws on structurally-wrong
 * input (not a urlset) so a Wix platform change surfaces as a scraper error
 * rather than a silent zero-run; an empty urlset legitimately returns [].
 */
export function parseEventSitemapSlugs(xml) {
  const s = String(xml || '')
  if (!/<urlset[\s>]/i.test(s)) {
    throw new Error('event-pages-sitemap.xml is not a <urlset> — Wix may have changed its sitemap layout')
  }
  const slugs = [...s.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
    .map((m) => slugFromEventUrl(m[1]))
    .filter(Boolean)
  return [...new Set(slugs)]
}

/**
 * Parse the Eastern date/time encoded in a Wix event slug's `-YYYY-MM-DD-HH-MM`
 * suffix into epoch ms, or null when the slug carries no date stamp.
 * (Un-dated slugs are workshops/annual events Wix didn't stamp — we don't try
 * to date them from the slug.)
 */
export function slugStartMs(slug) {
  const m = String(slug || '').match(/-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const [, y, mo, d, hh, mm] = m
  const iso = easternToIso(`${y}-${mo}-${d}`, `${hh}:${mm}`)
  const ms = Date.parse(iso ?? '')
  return Number.isFinite(ms) ? ms : null
}

/**
 * Pick the date-stamped sitemap slugs that (a) start within [now-1d, horizon],
 * and (b) aren't already covered by the warmup page — those are the detail
 * pages worth fetching to complete the upcoming set.
 */
export function tailSlugs(sitemapSlugs, warmupSlugs, nowMs, horizonMs) {
  const have = new Set(warmupSlugs)
  const out = []
  for (const slug of sitemapSlugs) {
    if (have.has(slug)) continue
    const ms = slugStartMs(slug)
    if (ms == null) continue                       // undated → self-heals later
    if (ms < nowMs - 86_400_000 || ms > horizonMs) continue
    out.push(slug)
  }
  return out
}

// ── Categorisation ──────────────────────────────────────────────────────────

/**
 * Clean a raw Wix event title: decode HTML entities (feeds carry `&amp;`) and
 * drop Wix's duplicate-title `(n)` suffix — reusing an event name makes Wix
 * store "Live Music with Robin Roseberry (1)"; the "(1)" is CMS noise, not
 * content. The slug keeps the suffix, so source_ids stay distinct.
 */
export function cleanTitle(title) {
  return decodeEntities(String(title || '')).replace(/\s*\(\d+\)\s*$/, '').trim()
}

/** Title-scoped family flag (per repo policy — title only, not description). */
export function isFamilyTitle(title) {
  return /\b(kid'?s?|children'?s?|family|toddler)\b/i.test(String(title || ''))
}

// Cancelled/postponed events are left on the Wix calendar with a title marker
// rather than removed. Title-scoped (never description) per the shared
// convention; exported so both row builders share it.
export const CANCELLED_RE = /\bcancel?led\b|\bpostponed\b/i

export function mapTags(title = '') {
  const t    = title.toLowerCase()
  const tags = ['wolf-creek-winery', 'winery', 'norton']
  if (/\b(live music|music|band|acoustic|dj)\b/.test(t))          tags.push('live-music')
  if (/\bfood truck\b/.test(t))                                   tags.push('food-truck')
  if (/\b(paint|sip|workshop|class|craft|make|making)\b/.test(t)) tags.push('workshop')
  if (/\b(yappy|paws|cat|dog|pup)\b/.test(t))                     tags.push('dogs')
  if (/\bfundraiser|benefit|charity\b/.test(t))                   tags.push('fundraiser')
  if (/\byoga\b/.test(t))                                         tags.push('yoga')
  if (/\bwine\b/.test(t))                                         tags.push('wine')
  return [...new Set(tags)]
}

// ── Row builders (exported for tests) ───────────────────────────────────────

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
 * Map a schema.org Event JSON-LD object (+ its page URL) to an events row.
 * Returns null when required fields are missing.
 */
export function eventFromJsonLd(ld, pageUrl) {
  const title = typeof ld?.name === 'string' ? cleanTitle(ld.name) : null
  if (!title) return null
  if (CANCELLED_RE.test(title)) return null   // scratched — drop

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
    source_id:       slugFromEventUrl(pageUrl),
    status:          'published',
    featured:        false,
  }
}

/**
 * Map a raw Wix warmup event object to an events row (via lib/wix-events.js),
 * correcting the detail URL for this site's /event-info/ path and applying our
 * category/tag/family logic. Returns null when title or start time is missing.
 */
export function rowFromWarmup(ev) {
  const row = normaliseWixEvent(ev, {
    source:          SOURCE_KEY,
    mapTags:         (e) => mapTags(e.title),
    defaultPriceMin: null,           // never assume free
    ageRestriction:  'not_specified',
    siteBaseUrl:     SITE,
  })
  if (!row.title || !row.start_at) return null
  row.title = cleanTitle(row.title)
  if (CANCELLED_RE.test(row.title)) return null   // scratched — drop

  const url = eventInfoUrl(ev.slug)
  if (url) { row.ticket_url = url; row.source_url = url }
  row.source_id = ev.slug || row.source_id
  row.category  = inferCategory(row.title, row.description || '')
  if (isFamilyTitle(row.title)) row.is_family = true
  return row
}

/**
 * Strict Summit-County guard for a warmup event: false only when the event's
 * OWN coordinates place it outside the county (a stray offsite listing). Events
 * with no coords, or coords inside Summit, pass — they pin to the winery.
 */
export function warmupIsSummit(ev) {
  const loc = parseWixLocation(ev.location) || {}
  return classifySummitLocation({ lat: loc.lat, lng: loc.lng, city: loc.city }) !== 'out'
}

/**
 * Upsert one already-built row (inside the date horizon) and link it to the
 * winery venue + organizer. Returns true when a row was written. Upserting per
 * event (rather than batching at the end) keeps a long or interrupted run's
 * progress durable.
 */
async function upsertRow(row, { venueId, organizerId, now, horizon }) {
  const startMs = Date.parse(row.start_at)
  if (!Number.isFinite(startMs) || startMs < now - 86_400_000 || startMs > horizon) return false
  const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
  if (error) { console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`); return false }
  if (venueId)     await linkEventVenue(upserted.id, venueId)
  if (organizerId) await linkEventOrganization(upserted.id, organizerId)
  console.log(`  ✓ ${row.title} (${row.start_at.slice(0, 10)})`)
  return true
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log('🍷  Starting The Winery at Wolf Creek (Wix Events) ingestion…')
  const start = Date.now()
  try {
    await preloadSummitCountyBoundary()   // required before any coord-based classify

    const [venueId, organizerId] = await Promise.all([
      ensureVenue(WINERY.name, {
        address: WINERY.address, city: WINERY.city, state: WINERY.state,
        zip: WINERY.zip, lat: WINERY.lat, lng: WINERY.lng, website: SITE,
      }),
      ensureOrganization(WINERY.name, {
        website: SITE,
        description:
          'The Winery at Wolf Creek is a family winery and event venue in Norton, Summit County, ' +
          'hosting live music, food trucks, dog-friendly Yappy Hours, paint-and-sip workshops, and fundraisers.',
      }),
    ])
    if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)

    const now     = Date.now()
    const horizon = now + MAX_DAYS_AHEAD * 86_400_000

    const ctx = { venueId, organizerId, now, horizon }
    const seen = new Set()          // source_ids handled this run (warmup wins)
    let inserted = 0, skipped = 0, found = 0

    // 1) Primary: the list-page warmup blob (first page of upcoming events).
    //    Upserted first so the near-term set is durable even if the tail crawl
    //    is interrupted.
    console.log(`\n🔍  Fetching event list ${EVENTS_URL}…`)
    const warmupRaw = parseWixWarmupEvents(await fetchText(EVENTS_URL))
    console.log(`  Found ${warmupRaw.length} event(s) in warmup data`)

    for (const ev of warmupRaw) {
      if (!warmupIsSummit(ev)) { skipped++; continue }   // strict-mandate guard
      const row = rowFromWarmup(ev)
      if (!row || !row.source_id || seen.has(row.source_id)) { skipped++; continue }
      seen.add(row.source_id)
      found++
      try {
        if (await upsertRow(row, ctx)) inserted++; else skipped++
      } catch (err) { console.warn(`  ⚠ ${row.title}: ${err.message}`); skipped++ }
    }

    // 2) Tail: date-stamped sitemap slugs beyond the warmup page, read from
    //    each detail page's schema.org JSON-LD.
    console.log(`\n🔍  Fetching event sitemap ${SITEMAP_URL}…`)
    const sitemapSlugs = parseEventSitemapSlugs(await fetchText(SITEMAP_URL))
    const tail = tailSlugs(sitemapSlugs, [...seen], now, horizon).slice(0, MAX_TAIL_FETCHES)
    console.log(`  ${sitemapSlugs.length} slug(s) in sitemap; ${tail.length} future-dated tail event(s) to fetch`)

    for (const slug of tail) {
      const url = eventInfoUrl(slug)
      try {
        const ld  = findSchemaObjects(extractJsonLd(await fetchText(url)), 'Event')[0]
        const row = ld ? eventFromJsonLd(ld, url) : null
        if (!row?.source_id || seen.has(row.source_id)) { skipped++; continue }
        seen.add(row.source_id)
        found++
        if (await upsertRow(row, ctx)) inserted++; else skipped++
      } catch (err) {
        console.warn(`  ⚠ Error on ${url}: ${err.message}`)
        skipped++
      }
      await sleep(FETCH_DELAY_MS)
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: found, durationMs: Date.now() - start,
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
