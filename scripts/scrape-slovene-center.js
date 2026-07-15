/**
 * scrape-slovene-center.js
 *
 * Slovene Performance & Events Center — a Slovenian cultural hall at
 * 70 14th St NW, Barberton (Summit County). It runs a public community
 * calendar: the weekly Jitterbug Club social dance, DJ Johnny Dance ballroom /
 * line-dance nights, and Atomic Rodeo art-&-music festival tie-ins (cruise-ins,
 * kick-off parties). (There are unrelated Slovenian halls in Greater Cleveland;
 * this scraper is scoped to the Barberton center only.)
 *
 * Platform: Wix Events, surfaced through the site's /calendar widget. Like the
 * other Wix Events sources (wolf_creek_winery, akron_soul_train), the page
 * server-renders a <script id="wix-warmup-data"> JSON blob carrying the full
 * upcoming-event objects (title, scheduling.config start/end as UTC ISO +
 * timeZoneId, description prose, mainImage, location, slug). We read that blob
 * via the shared lib/wix-events.js. The widget reports `hasMore:false` — every
 * upcoming event fits on the single rendered page — and the site exposes no
 * event-pages sitemap (404), so unlike Wolf Creek there is no detail-page tail
 * to crawl: the warmup blob is the complete upcoming set.
 *
 * Location / venue: Wix geocodes EVERY event to the same point (the center's own
 * 41.0128,-81.6212), even the rare offsite listing whose address text differs.
 * The coordinates are therefore unreliable as a per-event signal, so we gate on
 * the event's ADDRESS city — the trustworthy field — via classifySummitLocation
 * (city-only): a non-Summit city → skip; an unknown/absent city → ingest as
 * pending_review; Summit → published. Events at the center's own street address
 * pin to the single canonical venue; an event at a genuinely different address
 * that also carries a real venue name mints/uses that venue; otherwise the event
 * is ingested venue-less (documented — the raw location.name here is just the
 * city "Barberton", which is not a usable venue name).
 *
 * Price: the descriptions state cover charges in prose ("The cover charge for
 * this event is $10.") and occasionally "free event". We parse those explicit
 * amounts and never otherwise assume a price — "Purchase at the door" with no
 * figure stays null.
 *
 * source_id: the Wix event slug. Recurring occurrences (the weekly Jitterbug
 * Club) already carry a `-YYYY-MM-DD-HH-MM` stamp in the slug, so each week is a
 * distinct, stable id; one-off dances have their own unique slugs.
 *
 * Usage:   node scripts/scrape-slovene-center.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, decodeEntities, inferCategory,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue,
  linkEventOrganization, ensureVenue, ensureOrganization, linkOrganizationVenue,
  normalizeStreetAddress, looksLikeStreetAddress,
} from './lib/normalize.js'
import {
  parseWixWarmupEvents, parseWixLocation, normaliseWixEvent,
} from './lib/wix-events.js'
import { classifySummitLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'slovene_center'
const SITE         = 'https://www.slovenecenter.com'
const CALENDAR_URL = `${SITE}/calendar`

const MAX_DAYS_AHEAD = 180

const USER_AGENT =
  'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

// Single canonical venue — the cultural hall itself. Most events happen here;
// deduped by address in ensureVenue. Coordinates from the Wix geocode.
export const CENTER = {
  name:    'Slovene Performance & Events Center',
  address: '70 14th St NW',
  city:    'Barberton',
  state:   'OH',
  zip:     '44203',
  lat:     41.0127622,
  lng:     -81.6211899,
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchText(url) {
  const res = await fetch(url, {
    headers:  { Accept: 'text/html', 'User-Agent': USER_AGENT },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── URL / title helpers ───────────────────────────────────────────────────────

/** Public detail URL for a Wix event slug (this site uses /event-details/). */
export function eventDetailUrl(slug) {
  return slug ? `${SITE}/event-details/${slug}` : null
}

/**
 * Clean a raw Wix event title: decode HTML entities (feeds carry `&amp;`) and
 * drop Wix's duplicate-title `(n)` suffix. The slug keeps its own suffix, so
 * source_ids stay distinct.
 */
export function cleanTitle(title) {
  return decodeEntities(String(title || '')).replace(/\s*\(\d+\)\s*$/, '').trim()
}

// Cancelled/postponed events are left on the Wix calendar with a title marker
// rather than removed. Title-scoped (never description) per the shared convention.
export const CANCELLED_RE = /\bcancel?led\b|\bpostponed\b/i

// ── Categorisation ────────────────────────────────────────────────────────────

/**
 * Map a cultural-hall event to a v2 category. Per the source's programming:
 * concerts / social dances → music; heritage festivals / kick-off parties →
 * festival; community dinners / fish fries → food. Anything else falls back to
 * keyword inference over title + description.
 */
export function mapCategory(title = '', description = '') {
  const t = `${title} ${description}`.toLowerCase()
  if (/\b(fish fry|fish-fry|dinner|breakfast|pancake|sausage|klobas|goulash|potica|spaghetti|luncheon)\b/.test(t)) return 'food'
  if (/\bfestival\b/.test(t)) return 'festival'
  if (/\b(danc(e|ing)|jitterbug|ballroom|waltz|polka|dj|concert|\bband\b|live music|karaoke)\b/.test(t)) return 'music'
  return inferCategory(title, description || '')
}

/** Title/description-scoped topic tags. */
export function mapTags(title = '', description = '') {
  const t    = `${title} ${description}`.toLowerCase()
  const tags = ['slovene-center', 'barberton']
  if (/\b(danc(e|ing)|jitterbug|ballroom|waltz|line danc)\b/.test(t)) tags.push('dance')
  if (/\b(dj|live music|band|concert|polka|karaoke)\b/.test(t))       tags.push('music')
  if (/\bfestival\b/.test(t))                                         tags.push('festival')
  if (/\b(cruise-?in|car show|vintage)\b/.test(t))                    tags.push('car-show')
  return [...new Set(tags)]
}

/**
 * Parse an explicit price from description prose. Reads dollar figures
 * ("cover charge … is $10", "$10 at the door", "$10–$15") and the literal word
 * "free". Returns { price_min: null, price_max: null } when nothing is stated —
 * never assumes a price.
 */
export function parsePrice(description = '') {
  const text = String(description || '')
  const nums = [...text.matchAll(/\$\s?(\d+(?:\.\d{1,2})?)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n) && n >= 0)
  if (nums.length) {
    const min = Math.min(...nums)
    const max = Math.max(...nums)
    return { price_min: min, price_max: max > min ? max : null }
  }
  if (/\bfree\b/i.test(text)) return { price_min: 0, price_max: 0 }
  return { price_min: null, price_max: null }
}

// ── Location / venue ──────────────────────────────────────────────────────────

/**
 * Summit-County classification for a parsed Wix location. Gates on the ADDRESS
 * CITY, not coordinates: Wix reuses the center's geocode for every event, so the
 * coords can't distinguish an offsite listing. 'in' → publish; 'out' → skip;
 * 'unknown' (city absent) → pending_review.
 */
export function classifyEventLocation(loc) {
  return classifySummitLocation({ city: loc?.city })
}

const streetOf = (address) => String(address || '').split(',')[0].trim()

/**
 * Decide which venue an event belongs to from its parsed location:
 *   'center' — address matches the hall's own street → canonical CENTER venue.
 *   'named'  — a different, real venue name is present → mint/use that venue.
 *   'none'   — offsite with no usable venue name (raw name is just the city) →
 *              ingest the event venue-less.
 */
export function venueKind(loc) {
  const street = streetOf(loc?.address)
  if (!street || normalizeStreetAddress(street) === normalizeStreetAddress(CENTER.address)) {
    return 'center'
  }
  const name = String(loc?.name || '').trim()
  const isRealName =
    name &&
    name.toLowerCase() !== String(loc?.city || '').toLowerCase() &&
    !looksLikeStreetAddress(name)
  return isRealName ? 'named' : 'none'
}

// ── Row builder (exported for tests) ──────────────────────────────────────────

/**
 * Map a raw Wix warmup event to an events row. Returns null when the title or
 * start time is missing (TBD-scheduled events have no start).
 */
export function rowFromWarmup(ev) {
  const row = normaliseWixEvent(ev, {
    source:      SOURCE_KEY,
    mapTags:     () => [],
    siteBaseUrl: SITE,
  })
  if (!row.title || !row.start_at) return null

  row.title = cleanTitle(row.title)
  if (CANCELLED_RE.test(row.title)) return null   // scratched — drop
  row.category = mapCategory(row.title, row.description || '')
  row.tags = mapTags(row.title, row.description || '')

  const { price_min, price_max } = parsePrice(row.description || '')
  row.price_min = price_min
  row.price_max = price_max

  const url = eventDetailUrl(ev.slug)
  if (url) { row.ticket_url = url; row.source_url = url }
  row.source_id = ev.slug || row.source_id
  return row
}

// ── Upsert one row ────────────────────────────────────────────────────────────

async function upsertRow(row, venueId, { organizerId, now, horizon }) {
  const startMs = Date.parse(row.start_at)
  if (!Number.isFinite(startMs) || startMs < now - 86_400_000 || startMs > horizon) return false
  const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
  if (error) { console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`); return false }
  if (venueId)             await linkEventVenue(upserted.id, venueId)
  if (organizerId)         await linkEventOrganization(upserted.id, organizerId)
  console.log(`  ✓ ${row.title} (${row.start_at.slice(0, 10)}${row.status === 'pending_review' ? ', review' : ''})`)
  return true
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  console.log('🎻  Starting Slovene Performance & Events Center (Wix Events) ingestion…')
  const start = Date.now()
  try {
    const [centerVenueId, organizerId] = await Promise.all([
      ensureVenue(CENTER.name, {
        address: CENTER.address, city: CENTER.city, state: CENTER.state,
        zip: CENTER.zip, lat: CENTER.lat, lng: CENTER.lng, website: SITE,
      }),
      ensureOrganization(CENTER.name, {
        website: SITE,
        description:
          'The Slovene Performance & Events Center is a Slovenian cultural hall in Barberton, ' +
          'Summit County, hosting social dances, live music, and heritage festivals.',
      }),
    ])
    if (centerVenueId && organizerId) await linkOrganizationVenue(organizerId, centerVenueId)

    const now     = Date.now()
    const horizon = now + MAX_DAYS_AHEAD * 86_400_000
    const ctx     = { organizerId, now, horizon }

    console.log(`\n🔍  Fetching calendar ${CALENDAR_URL}…`)
    const warmup = parseWixWarmupEvents(await fetchText(CALENDAR_URL))
    console.log(`  Found ${warmup.length} event(s) in warmup data`)
    // The warmup blob is the ONLY source here (no sitemap tail like Wolf Creek).
    // A 0-length blob is the signature of Wix changing the warmup layout — warn
    // loudly rather than silently posting nothing.
    if (warmup.length === 0) {
      console.warn('  ⚠ 0 warmup events — the Wix warmup blob may have changed shape (silent-zero guard)')
    }

    const seen = new Set()
    let inserted = 0, skipped = 0, found = 0

    for (const ev of warmup) {
      const loc = parseWixLocation(ev.location) || {}
      const geo = classifyEventLocation(loc)
      if (geo === 'out') { skipped++; continue }         // strict-mandate: non-Summit → skip

      const row = rowFromWarmup(ev)
      if (!row || !row.source_id || seen.has(row.source_id)) { skipped++; continue }
      seen.add(row.source_id)

      if (geo === 'unknown') { row.status = 'pending_review'; row.needs_review = true }

      // Resolve the venue from the event's own address.
      let venueId = null
      const kind = venueKind(loc)
      if (kind === 'center') {
        venueId = centerVenueId
      } else if (kind === 'named') {
        venueId = await ensureVenue(loc.name, {
          address: streetOf(loc.address), city: loc.city, state: loc.state, zip: loc.zip,
          lat: loc.lat, lng: loc.lng,
        })
      } // 'none' → left venue-less (documented)

      found++
      try {
        if (await upsertRow(row, venueId, ctx)) inserted++; else skipped++
      } catch (err) { console.warn(`  ⚠ ${row.title}: ${err.message}`); skipped++ }
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
