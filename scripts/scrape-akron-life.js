/**
 * scrape-akron-life.js
 *
 * Fetches Akron Life Magazine's community events (publisher_id=11072) from the
 * Evvnt Discovery API directly.
 *
 * History — why we don't render the page:
 *   Akron Life's /events page embeds Evvnt's Discovery widget. Their inline
 *   bootstrap calls `evvnt_require("evvnt/discovery_plugin").init(...)` — an
 *   API the current plugin no longer exposes (it now exports
 *   window.DiscoveryPlugin). The plugin script loads, the global is missing,
 *   `evvntDiscoveryInit` throws, and the #evvnt-calendar div stays empty.
 *   Confirmed in a real Chrome browser, not just headless. Until Akron Life
 *   updates their integration code, the page is unscrapable via DOM.
 *
 *   Workaround: Evvnt's underlying API is unauthenticated and CORS-open. We
 *   call /api/publisher/11072/widget_events directly and skip the page
 *   entirely. Fewer moving parts, no Puppeteer, no widget timing flakes.
 *
 * Usage:
 *   node scripts/scrape-akron-life.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, inferCategory,
  upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'

const SOURCE_KEY    = 'akron_life'
const PUBLISHER_ID  = 11072
const API_BASE      = 'https://discovery.evvnt.com/api'
// The Evvnt API returns 30 events per page regardless of any per_page hint.
// 10 pages = up to 300 events with overlap, which more than covers the
// ~60–90 day window we care about. Increase only if events start getting
// truncated at the far end of the calendar.
const MAX_PAGES     = Number(process.env.AKRON_LIFE_MAX_PAGES) || 10
// Skip events farther out than this — Akron Life surfaces things ~6 months
// ahead, but most of our users won't browse beyond a few months.
const HORIZON_DAYS  = 180

// ── Akron-area geographic gate ────────────────────────────────────────────
// Evvnt's publisher_id=11072 feed mixes hyper-local Akron events with
// nationwide backfill from Ticketmaster, Eventbrite, etc. — Byron has
// confirmed events ~2 hours away in the calendar. We require every event
// to be within MAX_DISTANCE_MILES of downtown Akron. Matches the radius
// used by scrape-eventbrite.js and fetch-ticketmaster.js (40km / ~25 mi).
const AKRON_LAT          = 41.0814
const AKRON_LNG          = -81.5190
const MAX_DISTANCE_MILES = 25

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R  = 6_371_000  // Earth radius in metres
  const φ1 = lat1 * Math.PI / 180
  const φ2 = lat2 * Math.PI / 180
  const Δφ = (lat2 - lat1) * Math.PI / 180
  const Δλ = (lon2 - lon1) * Math.PI / 180
  const a  = Math.sin(Δφ/2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) ** 2
  return (2 * R * Math.asin(Math.sqrt(a))) / 1609.34
}

/**
 * Returns true when the event's venue lat/lng is within MAX_DISTANCE_MILES
 * of downtown Akron. False when coords are missing — without geography we
 * can't verify locality, and the venue.town / post_code fields are
 * unreliable (one Bath, OH venue had Bath, WV coordinates).
 */
function isInAkronArea(venue) {
  if (!venue) return false
  const lat = Number(venue.latitude), lng = Number(venue.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
  return haversineMiles(lat, lng, AKRON_LAT, AKRON_LNG) <= MAX_DISTANCE_MILES
}

// ── Cross-source dedupe via Evvnt's `sources` field ───────────────────────
//
// Evvnt aggregates events from many primary platforms (Ticketmaster,
// Eventbrite, AXS, Bandsintown, RunSignUp, etc.) and tags each event with a
// `sources: ['<platform>']` array. When that platform is one we ALSO scrape
// directly, ingesting the Evvnt copy creates a duplicate. We skip those
// events here and let the direct scraper own the canonical entry.
//
// Add a source to this set only when:
//   1. We have a working scraper that pulls from it directly (script in
//      scripts/scrape-<platform>.js), AND
//   2. That scraper's coverage of Akron-area events is at least as good as
//      what Evvnt would surface.
// If neither is true, leave the Evvnt copy alone — it's better than nothing.
const SOURCES_WE_SCRAPE_DIRECTLY = new Set([
  'ticketmaster',  // scripts/scrape-ticketmaster.js (via fetch-ticketmaster.js)
  'eventbrite',    // scripts/scrape-eventbrite.js
])

/** True when at least one entry in `sources` is a platform we own. */
function isBackfilledFromDirectScraper(rawEventSources) {
  if (!Array.isArray(rawEventSources)) return false
  for (const s of rawEventSources) {
    if (SOURCES_WE_SCRAPE_DIRECTLY.has(String(s).toLowerCase())) return true
  }
  return false
}

// ── Category mapping ──────────────────────────────────────────────────────

// Evvnt's human-readable category_name maps cleanly to our taxonomy for the
// common cases. Falls through to text-based inference when there's no match.
const EVVNT_CATEGORY_MAP = {
  'music':              'music',
  'performing arts':    'art',
  'visual arts':        'art',
  'film':               'art',
  'food / drink':       'food',
  'food and drink':     'food',
  'food':               'food',
  'sports':             'fitness',
  'sports / fitness':   'fitness',
  'health':             'fitness',
  'health / wellbeing': 'fitness',
  'education':          'education',
  'classes':            'education',
  'classes / workshops':'education',
  'lifestyle':          'community',
  'community':          'community',
  'festivals':          'community',
  'charity':            'community',
  'family':             'community',
  'exhibitions':        'art',
  'pets / animals':     'nature',
  'nature':             'nature',
  'outdoor':            'nature',
}

// Categories where Evvnt's tag is low-signal and text-based inference
// should be trusted over the source value. 'education' and 'community' are
// the two most frequently wrong values from the Evvnt backfill — concerts
// at Blossom, festivals, etc. often arrive tagged as one of these.
const EVVNT_OVERRIDABLE_CATEGORIES = new Set(['education', 'community'])

function mapCategory(evvntCategoryName, title, description) {
  const mapped = EVVNT_CATEGORY_MAP[(evvntCategoryName || '').toLowerCase().trim()]

  if (mapped) {
    // For low-signal source categories, run text inference as a sanity check.
    // If inference returns something more specific, trust it over Evvnt's tag.
    // This catches cases like a Hardy concert at Blossom arriving tagged
    // 'education' from the Evvnt backfill.
    if (EVVNT_OVERRIDABLE_CATEGORIES.has(mapped)) {
      const inferred = inferCategory(title, description)
      if (inferred !== 'other' && inferred !== mapped) {
        return inferred
      }
    }
    return mapped
  }

  // No map entry at all — fall through to text inference, defaulting to
  // 'community' since this is a community-magazine publisher.
  const inferred = inferCategory(title, description)
  return inferred === 'other' ? 'community' : inferred
}

function buildTags(category, evvntCategoryName) {
  const tags = ['akron-life', 'akron']
  if (category !== 'community') tags.push(category)
  if (evvntCategoryName) {
    const slug = evvntCategoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (slug && !tags.includes(slug)) tags.push(slug)
  }
  return tags
}

// ── Price parsing ─────────────────────────────────────────────────────────

/**
 * Evvnt's `prices` field is an object keyed by ticket tier, with values that
 * may be { amount: "12.50", currency_code: "USD" } or a bare number.
 *
 * Absence / empty object → null (unknown), NOT 0 (free). Evvnt often omits
 * this field entirely for paid ticketed events (e.g. Ticketmaster backfill),
 * so defaulting to 0 would incorrectly mark paid concerts as free. A
 * price_min of 0 is only written when Evvnt explicitly reports a 0-price
 * tier (i.e. the event genuinely has a free admission option).
 */
function parseEvvntPrices(prices) {
  if (!prices || typeof prices !== 'object') return { price_min: null, price_max: null }
  const nums = Object.values(prices)
    .map(v => {
      if (typeof v === 'number') return v
      if (typeof v === 'string') return parseFloat(v)
      if (v && typeof v === 'object') return parseFloat(v.amount ?? v.value ?? v.price)
      return NaN
    })
    .filter(n => !isNaN(n) && n >= 0)
  if (nums.length === 0) return { price_min: null, price_max: null }
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  return { price_min: min, price_max: max > min ? max : null }
}

// ── API fetch with pagination + dedup ─────────────────────────────────────

async function fetchAllEvvntEvents() {
  const seen = new Map() // source_id → event
  let pagesFetched = 0
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${API_BASE}/publisher/${PUBLISHER_ID}/widget_events?page=${page}`
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'akron-events-scraper/1.0' },
    })
    if (!res.ok) {
      throw new Error(`Evvnt API page ${page} returned HTTP ${res.status}`)
    }
    const body = await res.json()
    const events = body.rawEvents || body.events || []
    pagesFetched++
    if (events.length === 0) break

    let newOnThisPage = 0
    for (const e of events) {
      const id = String(e.source_id || e.objectID || `${e.title}|${e.start_time}`)
      if (!seen.has(id)) {
        seen.set(id, e)
        newOnThisPage++
      }
    }

    // If a full page came back entirely as duplicates, we've likely seen
    // everything Evvnt has for this publisher — stop paginating.
    if (newOnThisPage === 0) break
  }
  return { events: [...seen.values()], pagesFetched }
}

// ── Field mapping ─────────────────────────────────────────────────────────

/**
 * Pick the best image variant from Evvnt's images array. `original` is the
 * full-resolution upload; `hero` is the widget's hero crop; `featured` is the
 * smaller card crop. We prefer original, falling back outward. Returns
 * { url, width, height } or null.
 */
function pickImage(images) {
  if (!Array.isArray(images) || images.length === 0) return null
  const img = images[0]
  if (!img) return null
  // Original has explicit width/height. Other variants typically don't.
  const original = img.original
  if (original?.url) {
    return {
      url:    original.url,
      width:  Number.isFinite(original.width)  ? original.width  : null,
      height: Number.isFinite(original.height) ? original.height : null,
    }
  }
  const fallback = img.hero || img.featured || img.list_thumb
  return fallback?.url ? { url: fallback.url, width: null, height: null } : null
}

/**
 * Pick a real external URL for the event. Evvnt exposes links under both
 * `links.*` (go.evvnt.com click-tracking redirectors) and `original_links.*`
 * (the actual destination URLs). Prefer `original_links` so users land
 * straight at the source.
 *
 * NOTE: We intentionally do NOT fall back to `source_broadcast_url` — that
 * URL points to akronlife.com/events/?_evDiscoveryPath=… and the Akron
 * Life events page no longer renders event details (their Evvnt widget
 * integration is broken; see project_akron_life_scraper memory). Linking
 * users there would just show them an empty calendar.
 *
 * Returns null when no usable external URL exists. Callers must then
 * decide whether to drop the event entirely (Byron's policy: yes).
 */
// Link key priority: specific ticketing platforms first (highest quality —
// direct to purchase), then generic ticket/booking keys, then the event
// website, then social as an absolute last resort.
// AXS is Live Nation's platform and handles Blossom Music Center events;
// it must be listed explicitly or Evvnt's original_links.AXS gets skipped.
const USEFUL_LINK_KEYS = [
  // Named ticketing platforms — Evvnt stores these as exact keys
  'AXS', 'Ticketmaster', 'Eventbrite', 'Dice', 'Bandsintown',
  'SeatGeek', 'StubHub', 'TicketWeb', 'Brown Paper Tickets',
  // Generic ticket keys
  'Tickets', 'tickets', 'Buy Tickets', 'Booking',
  // Event website
  'Website',
  // Social — last resort only; better than nothing for small local events
  'Facebook', 'Instagram',
]

function pickExternalUrl(raw) {
  for (const bag of [raw.original_links || {}, raw.links || {}]) {
    for (const k of USEFUL_LINK_KEYS) {
      const url = bag[k]
      if (typeof url === 'string' && url && !/akronlife\.com/i.test(url)) {
        return url
      }
    }
  }
  return null
}

/** Convert an Evvnt ISO timestamp (with TZ offset) to UTC ISO. */
function toUtcIso(s) {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Akron Life ingestion (Evvnt API direct)…')
  const start = Date.now()

  try {
    const organizerId = await ensureOrganization('Akron Life Magazine', {
      website:     'https://www.akronlife.com',
      description: 'Akron Life is a regional lifestyle magazine covering dining, arts, culture, and community events across Greater Akron.',
    })

    console.log(`  → Fetching widget_events for publisher ${PUBLISHER_ID} (up to ${MAX_PAGES} pages)…`)
    const { events: rawEvents, pagesFetched } = await fetchAllEvvntEvents()
    console.log(`  → ${rawEvents.length} unique events from ${pagesFetched} page(s)`)

    if (rawEvents.length === 0) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status:       'error',
        errorMessage: 'Evvnt API returned 0 events',
        durationMs:   Date.now() - start,
        eventsFound:  0,
      })
      console.warn('  ⚠ No events returned — exiting clean')
      process.exit(0)
    }

    const now    = Date.now()
    const cutoff = now + HORIZON_DAYS * 24 * 60 * 60 * 1000

    let inserted = 0, skipped = 0
    const venueCache = new Map() // venue name → venue UUID

    // Pre-filter the raw API results down to events worth processing.
    // All filtering is purely in-memory (no DB calls) so it's cheap to be
    // strict here. Four drop reasons:
    //   1. outOfWindow — past or beyond the HORIZON_DAYS horizon
    //   2. outsideArea — venue lat/lng > MAX_DISTANCE_MILES from Akron, OR
    //                    coords missing (Evvnt's town field has been seen
    //                    misrepresenting West Virginia venues as Bath, OH)
    //   3. noLink      — no real external URL we could link the user to;
    //                    akronlife.com's broken event pages don't count
    //   4. dupSource   — backfilled from a platform we already scrape
    //                    directly (e.g. Ticketmaster); the direct scraper
    //                    owns the canonical entry
    let droppedOutOfWindow = 0, droppedOutsideArea = 0, droppedNoLink = 0, droppedDupSource = 0
    const toProcess = []
    for (const e of rawEvents) {
      const t = e.start_time ? new Date(e.start_time).getTime() : NaN
      if (!Number.isFinite(t) || t < now - 12 * 3600_000 || t > cutoff) {
        droppedOutOfWindow++; continue
      }
      if (!isInAkronArea(e.venue))               { droppedOutsideArea++; continue }
      if (!pickExternalUrl(e))                   { droppedNoLink++;      continue }
      if (isBackfilledFromDirectScraper(e.sources)) { droppedDupSource++; continue }
      // Log the sources array for events that pass the dedup guard so we can
      // identify any platforms (e.g. Ticketmaster without the expected tag)
      // that are slipping through and need to be added to SOURCES_WE_SCRAPE_DIRECTLY.
      if (Array.isArray(e.sources) && e.sources.length > 0) {
        const unknownSources = e.sources.filter(s => !SOURCES_WE_SCRAPE_DIRECTLY.has(String(s).toLowerCase()))
        if (unknownSources.length > 0) {
          console.log(`  ℹ️  Backfill slip-through: "${e.title}" has sources [${e.sources.join(', ')}]`)
        }
      }
      toProcess.push(e)
    }
    console.log(
      `\n📥  Processing ${toProcess.length} eligible events ` +
      `(dropped ${droppedOutOfWindow} out-of-window, ${droppedOutsideArea} outside Akron, ${droppedNoLink} no link, ${droppedDupSource} backfilled from direct source)…`
    )
    const PROGRESS_INTERVAL = 25
    let processed = 0
    for (const raw of toProcess) {
      processed++
      if (processed % PROGRESS_INTERVAL === 0) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1)
        // Use stderr (unbuffered) so progress lines stream to logs in real time
        // even when stdout is piped (cron, nohup) — block buffering on stdout
        // otherwise holds these until process exit.
        process.stderr.write(`  · ${processed}/${toProcess.length} processed (${inserted} ok, ${skipped} skipped) — ${elapsed}s\n`)
      }
      try {
        if (!raw.title) { skipped++; continue }

        const start_at = toUtcIso(raw.start_time)
        const end_at   = toUtcIso(raw.end_time)
        if (!start_at) {
          console.warn(`  ⚠ No parseable start for "${raw.title}"`)
          skipped++; continue
        }
        // Horizon filter already applied above — no double check needed.

        // Per-event venue
        let venueId = null
        const v = raw.venue
        if (v?.name) {
          const name = v.name.trim()
          if (venueCache.has(name)) {
            venueId = venueCache.get(name)
          } else {
            venueId = await ensureVenue(name, {
              address: v.address_1 || undefined,
              city:    v.town      || 'Akron',
              state:   'OH',
              zip:     v.post_code || undefined,
              lat:     Number.isFinite(v.latitude)  ? v.latitude  : undefined,
              lng:     Number.isFinite(v.longitude) ? v.longitude : undefined,
            })
            venueCache.set(name, venueId)
          }
        }

        const description = raw.description || raw.summary
          ? stripHtml(raw.description || raw.summary).slice(0, 5000)
          : null

        const category = mapCategory(raw.category_name, raw.title, description)
        const tags     = buildTags(category, raw.category_name)
        const image    = pickImage(raw.images)
        const { price_min, price_max } = parseEvvntPrices(raw.prices)

        const row = {
          title:           raw.title,
          description,
          start_at,
          end_at,
          category,
          tags,
          price_min,
          price_max,
          age_restriction: 'not_specified',
          image_url:       image?.url   || null,
          image_width:     image?.width || null,
          image_height:    image?.height || null,
          image_file_size: null,           // Evvnt doesn't give us byte size; leave null
          ticket_url:      pickExternalUrl(raw),
          source:          SOURCE_KEY,
          source_id:       String(raw.source_id || raw.objectID || `${raw.title.slice(0,40)}|${start_at}`),
          status:          'published',
          featured:        false,
        }

        const { data: upserted, error } = await upsertEventSafe(row)
        if (error) {
          console.warn(`  ⚠ Upsert failed for "${row.title}": ${error.message}`)
          skipped++; continue
        }

        if (venueId)     await linkEventVenue(upserted.id, venueId)

        // Prefer the event-specific organiser when present.
        // Fall back to Akron Life Magazine ONLY when the event has no organiser
        // AND shows no cross-platform backfill signals. Backfilled events
        // (e.g. a Ticketmaster concert that Evvnt surfaced in this feed) have
        // their own real promoter/venue; crediting Akron Life as the presenter
        // is misleading and confuses users (see: Hardy at Blossom incident).
        let eventOrgId = null
        if (raw.organiser_name && raw.organiser_name.trim()) {
          eventOrgId = await ensureOrganization(raw.organiser_name.trim())
        }
        const isBackfilled = Array.isArray(raw.sources) && raw.sources.length > 0
        if (!eventOrgId && !isBackfilled) {
          // Genuinely Akron Life-originated event with no other organiser info.
          eventOrgId = organizerId
        }
        if (eventOrgId) await linkEventOrganization(upserted.id, eventOrgId)
        if (venueId && eventOrgId) await linkOrganizationVenue(eventOrgId, venueId).catch(() => {})

        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error processing "${raw.title}":`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: rawEvents.length,
      durationMs:  Date.now() - start,
    })
    const droppedTotal = droppedOutOfWindow + droppedOutsideArea + droppedNoLink + droppedDupSource
    console.log(
      `\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ` +
      `inserted ${inserted}, skipped ${skipped}, dropped ${droppedTotal} ` +
      `(${droppedOutOfWindow} out-of-window, ${droppedOutsideArea} outside Akron, ${droppedNoLink} no link, ${droppedDupSource} dup of direct source)`
    )
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

main()
