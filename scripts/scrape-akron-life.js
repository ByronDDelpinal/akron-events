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
 * Cross-source dedup:
 *   Akron Life is high-volume (~300 events / 30 days) but low-fidelity —
 *   categories are often wrong, the `sources` field is uniformly "evvnt"
 *   (gives us no upstream-platform signal), and many events are backfilled
 *   from venues we already scrape directly. We avoid duplicating those by
 *   matching each event's `original_links` hostnames and `organiser_name`
 *   against COVERED_BY_DIRECT_SCRAPER below — any hit drops the Evvnt copy
 *   so the dedicated scraper owns the canonical row.
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
  fetchSchemaDescription,
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

// ── Cross-source dedupe by hostname + organiser ──────────────────────────
//
// History — why we don't read `sources`:
//   The Evvnt API exposes a `sources: ['<platform>']` array per event, but a
//   live audit of publisher 11072 in 2026-06 found *every* event had
//   `sources: ['evvnt']` regardless of where the upstream actually came
//   from. The platform-string guard never matched, so it was a no-op.
//
// What works instead: inspect `original_links` URL hostnames and
// `organiser_name` against a known list of scrapers we already run. When
// Akron Life surfaces (e.g.) an event whose website lives at
// `services.akronlibrary.org` or whose organiser is "Akron-Summit County
// Public Library", the direct scrape-akron-library.js scraper already owns
// the canonical row — we skip the Evvnt copy.
//
// Calibration note: a live survey of 300 events showed only ~2 currently
// overlap with existing scrapers (eventbrite + ticketmaster). The map below
// is mostly future-proofing as we add more direct scrapers — but it lets
// any new scraper claim its events on Akron Life automatically.
//
// Each entry has:
//   - scraper:    the scrape-<name>.js key (for log readability)
//   - domains:    substrings to match against original_links hostnames
//   - organisers: substrings to match against organiser_name (lowercase)
const COVERED_BY_DIRECT_SCRAPER = [
  { scraper: 'eventbrite',             domains: ['eventbrite.com'],                                  organisers: [] },
  { scraper: 'ticketmaster',           domains: ['ticketmaster.com', 'livenation.com', 'axs.com'],   organisers: [] },
  { scraper: 'akron_library',          domains: ['akronlibrary.org'],                                organisers: ['akron-summit county public library', 'akron public library', 'akron library', 'green branch library'] },
  { scraper: 'summit_metro_parks',     domains: ['summitmetroparks.org'],                            organisers: ['summit metro parks'] },
  { scraper: 'cvnp_conservancy',       domains: ['conservancyforcvnp.org'],                          organisers: ['conservancy for cuyahoga', 'cuyahoga valley national park'] },
  { scraper: 'akron_art_museum',       domains: ['akronartmuseum.org'],                              organisers: ['akron art museum'] },
  { scraper: 'akron_civic',            domains: ['akroncivic.com', 'akroncivictheatre.com', 'theatreakron.com'], organisers: ['akron civic'] },
  { scraper: 'akron_zoo',              domains: ['akronzoo.org'],                                    organisers: ['akron zoo'] },
  { scraper: 'akron_childrens_museum', domains: ['akronchildrensmuseum.org'],                        organisers: ["akron children's museum", 'akron childrens museum'] },
  { scraper: 'akron_symphony',         domains: ['akronsymphony.org'],                               organisers: ['akron symphony'] },
  { scraper: 'weathervane',            domains: ['weathervaneplayhouse.com', 'weathervane.my.salesforce-sites.com'], organisers: ['weathervane playhouse'] },
  { scraper: 'stan_hywet',             domains: ['stanhywet.org', 'stanhywet.ticketapp.org'],        organisers: ['stan hywet'] },
  { scraper: 'blu_jazz',               domains: ['blujazzakron.com', 'blu-jazz.turntabletickets.com'], organisers: ['blu jazz'] },
  { scraper: 'jillys_music_room',      domains: ['jillysmusicroom.com'],                             organisers: ["jilly's music room", 'jillys music room'] },
  { scraper: 'akronym_brewing',        domains: ['akronymbrewing.com'],                              organisers: ['akronym brewing'] },
  { scraper: 'missing_falls',          domains: ['missingfallsbrewery.com'],                         organisers: ['missing falls'] },
  { scraper: 'players_guild',          domains: ['playersguildtheatre.com'],                         organisers: ['players guild'] },
  { scraper: 'ohio_shakespeare',       domains: ['ohioshakespearefestival.com'],                     organisers: ['ohio shakespeare festival'] },
  { scraper: 'painting_twist',         domains: ['paintingwithatwist.com'],                          organisers: ['painting with a twist'] },
  { scraper: 'nightlight_cinema',      domains: ['nightlightcinema.com'],                            organisers: ['the nightlight', 'nightlight cinema'] },
  { scraper: 'visit_akron_cvb',        domains: ['visitakron-summit.org', 'visitakronsummit.com'],   organisers: ['visit akron', 'summit county cvb'] },
  { scraper: 'downtown_akron',         domains: ['downtownakron.com'],                               organisers: ['downtown akron partnership'] },
  { scraper: 'torchbearers',           domains: ['torchbearersakron.org'],                           organisers: ['torchbearers'] },
  { scraper: 'leadership_akron',       domains: ['leadershipakron.org'],                             organisers: ['leadership akron'] },
  { scraper: 'akron_urban_league',     domains: ['akronurbanleague.org'],                            organisers: ['akron urban league'] },
  { scraper: 'akron_public_schools',   domains: ['akronschools.com'],                                organisers: ['akron public schools'] },
  { scraper: 'city_of_akron_lock3',    domains: ['akronohio.gov', 'lock3live.com'],                  organisers: ['city of akron', 'lock 3'] },
  { scraper: 'north_hill_cdc',         domains: ['northhillcdc.org'],                                organisers: ['north hill cdc', 'north hill community development'] },
  { scraper: 'rialto',                 domains: ['therialtotheatre.com'],                            organisers: ['rialto theatre', 'the rialto'] },
  { scraper: 'rubberducks',            domains: ['milb.com'],                                        organisers: ['akron rubberducks', 'rubberducks'] },
  { scraper: 'life_gurukula',          domains: ['lifegurukula.org'],                                organisers: ['life gurukula'] },
  { scraper: 'crown_point_ecology',    domains: ['crownpointecology.org'],                           organisers: ['crown point ecology'] },
  { scraper: 'summit_artspace',        domains: ['summitartspace.org'],                              organisers: ['summit artspace'] },
  { scraper: 'killbox_comedy',         domains: ['thekillboxcomedyclub.com'],                        organisers: ['killbox comedy club', 'the killbox'] },
  { scraper: 'hale_farm',              domains: ['wrhs.org'],                                        organisers: ['hale farm', 'western reserve historical society', 'wrhs'] },
  { scraper: 'kent_stage',             domains: ['kentstage.org'],                                   organisers: ['kent stage', 'the kent stage'] },
  { scraper: 'cvart',                  domains: ['cvart.org'],                                       organisers: ['cuyahoga valley art center', 'cvac'] },
  { scraper: 'cascade_locks',          domains: ['cascadelocks.org'],                                organisers: ['cascade locks park association', 'cascade locks'] },
  // LiveWhale (UAkron) sub-sources all surface through uakron.edu
  { scraper: 'uakron_calendar',        domains: ['uakron.edu', 'ejthomashall.com'],                  organisers: ['university of akron', 'e.j. thomas', 'ej thomas', 'myers school of art', 'cummings center'] },
]

// Title-keyword belt-and-suspenders for sources whose ticket links and
// organiser strings vary too much to be enumerated above (RubberDucks
// games show up under MiLB ticket vendors and partner promoters, for
// example).
const DEDICATED_SCRAPER_KEYWORDS = [
  'rubberducks',  // scrape-rubberducks.js owns all Akron RubberDucks home games
]

function isDedicatedlyScraped(title) {
  const lower = (title ?? '').toLowerCase()
  return DEDICATED_SCRAPER_KEYWORDS.some(kw => lower.includes(kw))
}

/**
 * Examine an Evvnt event's hostnames + organiser name against
 * COVERED_BY_DIRECT_SCRAPER. Returns the matching scraper key when the
 * event is already owned by one of our direct scrapers, or null otherwise.
 */
function findCoveringScraper(rawEvent) {
  const links = rawEvent?.original_links || {}
  const hosts = []
  for (const url of Object.values(links)) {
    if (typeof url !== 'string') continue
    try {
      hosts.push(new URL(url).hostname.replace(/^www\./, '').toLowerCase())
    } catch { /* skip malformed URLs */ }
  }
  const organiser = String(rawEvent?.organiser_name ?? '').toLowerCase().trim()

  for (const entry of COVERED_BY_DIRECT_SCRAPER) {
    for (const dom of entry.domains) {
      if (hosts.some(h => h.endsWith(dom))) return entry.scraper
    }
    for (const kw of entry.organisers) {
      if (organiser.includes(kw)) return entry.scraper
    }
  }
  return null
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
    //   4. dupSource   — already covered by a scrape-<name>.js we run
    //                    directly. Detected by matching original_links
    //                    hostnames or organiser_name against
    //                    COVERED_BY_DIRECT_SCRAPER above.
    let droppedOutOfWindow = 0, droppedOutsideArea = 0, droppedNoLink = 0, droppedDupSource = 0
    const dupSourceByScraper = {}   // for end-of-run reporting
    const toProcess = []
    for (const e of rawEvents) {
      const t = e.start_time ? new Date(e.start_time).getTime() : NaN
      if (!Number.isFinite(t) || t < now - 12 * 3600_000 || t > cutoff) {
        droppedOutOfWindow++; continue
      }
      if (!isInAkronArea(e.venue))      { droppedOutsideArea++; continue }
      if (!pickExternalUrl(e))          { droppedNoLink++;      continue }
      const coveredBy = findCoveringScraper(e)
      if (coveredBy) {
        droppedDupSource++
        dupSourceByScraper[coveredBy] = (dupSourceByScraper[coveredBy] || 0) + 1
        continue
      }
      if (isDedicatedlyScraped(e.title)) {
        droppedDupSource++
        dupSourceByScraper['(title-keyword)'] = (dupSourceByScraper['(title-keyword)'] || 0) + 1
        continue
      }
      toProcess.push(e)
    }
    const dupBreakdown = Object.entries(dupSourceByScraper)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
    console.log(
      `\n📥  Processing ${toProcess.length} eligible events ` +
      `(dropped ${droppedOutOfWindow} out-of-window, ${droppedOutsideArea} outside Akron, ${droppedNoLink} no link, ${droppedDupSource} covered by direct scraper${dupBreakdown ? ' [' + dupBreakdown + ']' : ''})…`
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

        let description = raw.description || raw.summary
          ? stripHtml(raw.description || raw.summary).slice(0, 5000)
          : null
        // Evvnt frequently returns empty body fields for events it
        // sources from third parties (axs, eventbrite, ticketmaster).
        // Pull the Schema.org Event description off the external page
        // so users don't see a blank "About this event" block.
        if (!description) {
          const external = pickExternalUrl(raw)
          if (external) description = await fetchSchemaDescription(external)
        }

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
