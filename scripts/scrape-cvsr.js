/**
 * scrape-cvsr.js
 *
 * Scrapes upcoming excursion departures from the Cuyahoga Valley Scenic
 * Railroad (CVSR).
 *
 * Platform: CVSR runs its own server-rendered booking calendar (a bespoke
 * "Lucy" CMS) at /book-tickets/calendar/YYYY/MM, NOT FareHarbor or Eventbrite.
 * Tickets are sold through Etix. The month grid is fully server-rendered HTML,
 * so no headless browser is needed — we walk the `<td>` day cells directly.
 *
 * Markup shape (one filled day cell):
 *   <td class=" filled">
 *     <p class="day">15</p>
 *     <p class="time">9:00am</p>
 *     <div class="event">
 *       <span>RS</span>                          ← station code
 *       <p class="title">National Park Scenic </p>
 *       <a href="excursions/…/national-park-scenic">Details</a>
 *       <a href="https://www.etix.com/…">Tix</a>
 *     </div>
 *     <p class="time">10:00am</p><div class="event"><span>PN</span>…</div>
 *     …
 *   </td>
 * The `<p class="time">` immediately precedes the `<div class="event">` it
 * belongs to; a single day cell carries many departures. Some events (sold-out
 * / info-only) carry no Details or Tix link.
 *
 * GEOGRAPHY (critical): excursions depart from three stations, encoded in the
 * `<span>` code AND the Etix URL:
 *   PN → Peninsula Depot            — Peninsula, OH 44264   (Summit County — IN)
 *   AN → Akron Northside Station    — Akron, OH 44308       (Summit County — IN)
 *   RS → Rockside Station           — Independence, OH 44131 (Cuyahoga — OUT)
 * Rockside departures are dropped entirely (out of county). We gate every event
 * with classifySummitLocation() on the departure station's city so the Summit
 * mandate is enforced from the single source of truth, and an unrecognized
 * station code lands in the review queue rather than publishing blind.
 *
 * RECURRENCE: the same excursion runs many departures per day from a station
 * (e.g. National Park Scenic from Peninsula at 10:00am, 12:20pm, 2:45pm). We
 * COLLAPSE all same-day departures of one (excursion, station) into ONE event —
 * start_at = the earliest departure, and every departure time is listed in the
 * description. source_id = "{excursion-slug}-{station}-{YYYY-MM-DD}" so it is
 * stable and unique per departure date. This mirrors how a rider thinks ("the
 * National Park Scenic from Peninsula on the 15th") and avoids minting three
 * near-identical rows for one train on one day.
 *
 * Per-excursion enrichment (description, hero image, price) is fetched ONCE per
 * excursion detail page and cached, since dozens of departures share it.
 *
 * Usage:
 *   node scripts/scrape-cvsr.js
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
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  linkOrganizationVenue,
  ensureVenue,
  ensureOrganization,
  enrichWithImageDimensions,
  easternToIso,
} from './lib/normalize.js'
import { classifySummitLocation } from './lib/summit-county.js'

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_KEY  = 'cvsr'
const BASE_DOMAIN = 'https://www.cvsr.org'
const SOURCE_URL  = 'https://www.cvsr.org/book-tickets'

// How many months forward (including the current one) to page through. CVSR
// publishes a rolling few months of departures; ~7 months covers the ~180-day
// horizon and captures the seasonal Fall Scenic / Oktoberfest runs.
const MONTHS_AHEAD = 7

// Departure station code → canonical venue. Addresses come from the TrainStation
// JSON-LD on the excursion detail pages (authoritative). Coordinates are for the
// map pin only; the Summit gate keys on `city`, not the coordinates, so a slight
// pin offset can never mis-gate an event.
const STATION_VENUES = {
  PN: {
    name: 'CVSR Peninsula Depot',
    address: '1630 Mill Street West', city: 'Peninsula', state: 'OH', zip: '44264',
    lat: 41.2426, lng: -81.5527,
  },
  AN: {
    name: 'CVSR Akron Northside Station',
    address: '27 Ridge St', city: 'Akron', state: 'OH', zip: '44308',
    lat: 41.0899, lng: -81.5147,
  },
  RS: {
    name: 'CVSR Rockside Station',
    address: '7900 Old Rockside Rd', city: 'Independence', state: 'OH', zip: '44131',
    lat: 41.3737, lng: -81.6668,
  },
}

// Excursion-category path segment → a confident v2 category hint. Left unmapped
// (family-fun-loop, themed-events) means "let text inference decide" — those
// buckets mix scenic rides, games, and crafts. resolveEventCategories merges the
// hint with title/description inference, so a hint never overrides a confident
// text classification.
const CATEGORY_BY_PATH = {
  'national-park-excursions': 'outdoors',
  'fall-scenic':             'outdoors',
  'beverage-food-tastings':  'food',
  'fun-games':               'games',
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronEventsBot/1.0; +https://akronpulse.com)',
      'Accept':     'text/html,application/xhtml+xml',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

function resolveUrl(href) {
  if (!href) return null
  const trimmed = href.trim()
  if (/^https?:/i.test(trimmed)) return trimmed
  return `${BASE_DOMAIN}/${trimmed.replace(/^\/+/, '')}`
}

// ── Grid parsing (pure) ──────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// A scratched departure is left in the grid with a title marker rather than
// removed. Title-scoped (never description) per the shared convention.
const CANCELLED_RE = /\bcancel?led\b|\bpostponed\b/i

/**
 * Convert a CVSR clock token ("9:00am", "11:20am", "1:45pm") to "HH:MM:SS".
 * Returns null when no meridiem-qualified time is present, so callers never
 * silently invent a midnight departure.
 */
export function parseGridTime(raw) {
  if (!raw) return null
  const m = String(raw).trim().match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)
  if (!m) return null
  let hr = parseInt(m[1], 10)
  const min = m[2] ? parseInt(m[2], 10) : 0
  if (Number.isNaN(hr) || hr < 1 || hr > 12) return null
  const pm = /pm/i.test(m[3])
  if (pm && hr !== 12) hr += 12
  if (!pm && hr === 12) hr = 0
  return `${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}:00`
}

/** Extract the leaf slug from an excursion Details href, or null. */
export function excursionSlug(detailsHref) {
  if (!detailsHref) return null
  const m = detailsHref.match(/excursions\/[^"']*?\/([a-z0-9-]+)\/?$/i)
  return m ? m[1] : null
}

/** Slugify a title as a stable fallback id when no Details link is present. */
function slugifyTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Parse a single month's calendar HTML into raw departure records:
 *   { date: 'YYYY-MM-DD', time: 'HH:MM:SS', stationCode, title,
 *     detailsHref, ticketUrl, categoryPath, slug }
 * One record per departure (grouping happens later). Adjacent-month overflow
 * cells (class contains "outside") and event-less cells are skipped.
 */
export function parseMonthGrid(html, year, month) {
  const records = []
  const cellRe = /<td class="([^"]*)">([\s\S]*?)<\/td>/gi
  let cell
  while ((cell = cellRe.exec(html)) !== null) {
    const cls = cell[1]
    const body = cell[2]
    if (/\boutside\b/.test(cls)) continue // adjacent-month overflow day
    const dayMatch = body.match(/<p class="day">\s*(\d{1,2})\s*<\/p>/i)
    if (!dayMatch) continue
    const day = parseInt(dayMatch[1], 10)
    if (!day) continue
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

    // Each departure is a "time" paragraph immediately followed by its event div.
    const evRe = /<p class="time">([^<]*)<\/p>\s*<div class="event">([\s\S]*?)<\/div>/gi
    let ev
    while ((ev = evRe.exec(body)) !== null) {
      const time = parseGridTime(ev[1])
      const inner = ev[2]
      const codeM  = inner.match(/<span>([^<]*)<\/span>/i)
      const titleM = inner.match(/<p class="title">([\s\S]*?)<\/p>/i)
      if (!titleM) continue
      const title = stripHtml(titleM[1])
      if (!title) continue
      if (CANCELLED_RE.test(title)) continue   // scratched departure — drop
      const stationCode = codeM ? stripHtml(codeM[1]).toUpperCase() : null
      const detailsM = inner.match(/<a href="(excursions\/[^"]+)"[^>]*>\s*Details\s*<\/a>/i)
      const detailsHref = detailsM ? detailsM[1] : null
      const tixM = inner.match(/<a href="(https:\/\/www\.etix\.com\/[^"]+)"/i)
      const ticketUrl = tixM ? tixM[1].trim() : null
      const catPathM = detailsHref ? detailsHref.match(/excursions\/([^/]+)\//i) : null
      const categoryPath = catPathM ? catPathM[1] : null
      const slug = excursionSlug(detailsHref) || slugifyTitle(title)

      records.push({ date, time, stationCode, title, detailsHref, ticketUrl, categoryPath, slug })
    }
  }
  return records
}

/**
 * Collapse many same-day departures of the same (excursion, station) into one
 * grouped event. Key = slug|stationCode|date. Returns an array of:
 *   { key, date, times: ['HH:MM:SS', …] (sorted, earliest first), stationCode,
 *     title, detailsHref, ticketUrl, categoryPath, slug }
 * Pure — exported for tests.
 */
export function groupDepartures(records) {
  const groups = new Map()
  for (const r of records) {
    const key = `${r.slug}|${r.stationCode}|${r.date}`
    let g = groups.get(key)
    if (!g) {
      g = {
        key, date: r.date, times: [], stationCode: r.stationCode, title: r.title,
        detailsHref: r.detailsHref, ticketUrl: r.ticketUrl,
        categoryPath: r.categoryPath, slug: r.slug,
      }
      groups.set(key, g)
    }
    if (r.time && !g.times.includes(r.time)) g.times.push(r.time)
    // Prefer any non-null details/ticket link across the day's departures.
    if (!g.detailsHref && r.detailsHref) g.detailsHref = r.detailsHref
    if (!g.ticketUrl && r.ticketUrl) g.ticketUrl = r.ticketUrl
  }
  for (const g of groups.values()) g.times.sort()
  return [...groups.values()]
}

/** Format "HH:MM:SS" → "9:00 AM" for human-readable departure lists. */
export function formatClock(hhmmss) {
  const [h, m] = hhmmss.split(':').map(Number)
  const mer = h >= 12 ? 'PM' : 'AM'
  const hr = h % 12 === 0 ? 12 : h % 12
  return `${hr}:${String(m).padStart(2, '0')} ${mer}`
}

/** Build a human departure summary line for the description. */
export function departuresLine(stationName, times) {
  if (!times.length) return `Departs from ${stationName}.`
  const label = times.length === 1 ? 'Departure' : 'Departures'
  return `${label} from ${stationName}: ${times.map(formatClock).join(', ')}.`
}

// ── Excursion detail enrichment ──────────────────────────────────────────────

const HEADER_IMG_RE = /https:\/\/cvsr\.b-cdn\.net\/files\/excursions\/header\/[^"'\s)]+\.(?:png|jpe?g|webp)/i

/**
 * Parse an excursion detail page for { description, imageUrl, priceMin,
 * priceMax }. Pure — exported for tests. The detail page exposes:
 *   - og:description  → the human write-up
 *   - a CSS-background hero at /files/excursions/header/…  → image_url
 *   - an optional Schema.org AggregateOffer with low/highPrice → price range
 */
export function parseExcursionDetail(html) {
  const out = { description: null, imageUrl: null, priceMin: null, priceMax: null }

  const desc = html.match(/<meta property="og:description" content="([^"]*)"/i)
  if (desc && desc[1].trim()) out.description = stripHtml(desc[1]).trim()

  const img = html.match(HEADER_IMG_RE)
  if (img) out.imageUrl = img[0]

  const offer = html.match(/"AggregateOffer"[\s\S]{0,200}?"lowPrice":"?([\d.]+)"?(?:[\s\S]{0,120}?"highPrice":"?([\d.]+)"?)?/i)
  if (offer) {
    const low = parseFloat(offer[1])
    if (!Number.isNaN(low)) out.priceMin = low
    if (offer[2] != null) {
      const high = parseFloat(offer[2])
      if (!Number.isNaN(high) && high > low) out.priceMax = high
    }
  }
  return out
}

const _detailCache = new Map() // detailsHref → parsed detail (or null)

async function getExcursionDetail(detailsHref) {
  if (!detailsHref) return null
  if (_detailCache.has(detailsHref)) return _detailCache.get(detailsHref)
  let parsed = null
  try {
    const html = await fetchHtml(resolveUrl(detailsHref))
    parsed = parseExcursionDetail(html)
  } catch (err) {
    console.warn(`  ⚠ Could not fetch excursion detail ${detailsHref}: ${err.message}`)
  }
  _detailCache.set(detailsHref, parsed)
  return parsed
}

// ── Tags ─────────────────────────────────────────────────────────────────────

function buildTags(title, categoryPath) {
  const text = title.toLowerCase()
  const tags = ['scenic-railroad', 'train']
  if (categoryPath === 'national-park-excursions' || categoryPath === 'fall-scenic') tags.push('national-park', 'outdoors')
  if (categoryPath === 'beverage-food-tastings') tags.push('food-and-drink')
  if (categoryPath === 'fun-games') tags.push('games')
  if (categoryPath === 'family-fun-loop') tags.push('family')
  if (/holiday|christmas|santa|polar|halloween|oktoberfest|mardi gras/.test(text)) tags.push('seasonal')
  if (/murder mystery|trivia|bingo|board game/.test(text)) tags.push('games')
  return [...new Set(tags)]
}

// ── Date helpers ─────────────────────────────────────────────────────────────

/** Today's date in America/New_York as 'YYYY-MM-DD' (never local Date + ISO). */
function easternTodayYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/** { year, month(1-12) } list for the current Eastern month + N-1 following. */
export function monthsToFetch(startYmd, count) {
  const [y, m] = startYmd.split('-').map(Number)
  const out = []
  let year = y, month = m
  for (let i = 0; i < count; i++) {
    out.push({ year, month })
    month++
    if (month > 12) { month = 1; year++ }
  }
  return out
}

// ── Venue / Organizer ────────────────────────────────────────────────────────

async function ensureCvsrOrganizer() {
  return ensureOrganization('Cuyahoga Valley Scenic Railroad', {
    website: 'https://www.cvsr.org',
    description: 'Nonprofit excursion railroad running heritage train rides through Cuyahoga Valley National Park, departing from stations in Peninsula, Akron, and Independence.',
  })
}

async function ensureStationVenue(stationCode) {
  const v = STATION_VENUES[stationCode]
  if (!v) return null
  return ensureVenue(v.name, {
    address: v.address, city: v.city, state: v.state, zip: v.zip,
    lat: v.lat, lng: v.lng,
    parking_type: 'lot',
    website: 'https://www.cvsr.org',
    description: 'Cuyahoga Valley Scenic Railroad boarding station.',
  })
}

// ── Process ──────────────────────────────────────────────────────────────────

// Dozens of departures share one excursion hero image. enrichWithImageDimensions
// probes the image over the network, so calling it once per event would issue
// hundreds of redundant probes for ~15 distinct URLs. Memoize the resolved image
// fields by source image URL and reuse them; only the first event with a given
// image pays the probe cost.
const _imageMetaCache = new Map() // sourceImageUrl → { image_url, image_width, image_height, image_file_size }

async function enrichImageCached(row) {
  if (!row.image_url) return enrichWithImageDimensions(row)
  const cached = _imageMetaCache.get(row.image_url)
  if (cached) return { ...row, ...cached }
  const enriched = await enrichWithImageDimensions(row)
  _imageMetaCache.set(row.image_url, {
    image_url:       enriched.image_url,
    image_width:     enriched.image_width,
    image_height:    enriched.image_height,
    image_file_size: enriched.image_file_size,
  })
  return enriched
}

async function processGroups(groups, organizerId) {
  let inserted = 0, skipped = 0
  const todayYmd = easternTodayYmd()
  // Skip anything that ended more than ~1 day ago (keep yesterday's departures).
  const cutoff = (() => {
    const d = new Date(`${todayYmd}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - 1)
    return d.toISOString().slice(0, 10)
  })()

  const venueCache = new Map() // stationCode → venueId

  for (const g of groups) {
    try {
      if (g.date < cutoff) { skipped++; continue }

      const station = STATION_VENUES[g.stationCode] || null
      // Gate on the departure station's CITY (single source of truth). Rockside
      // (Independence) → 'out' → drop. Peninsula/Akron → 'in' → publish. An
      // unrecognized station code has no city → 'unknown' → review queue.
      const locality = classifySummitLocation({ city: station?.city })
      if (locality === 'out') { skipped++; continue }

      const startTime = g.times[0] || null
      if (!startTime) {
        console.warn(`  ⚠ Skipping "${g.title}" ${g.date} — no departure time`)
        skipped++
        continue
      }
      const startAt = easternToIso(g.date, startTime)
      if (!startAt) { skipped++; continue }

      const detail = await getExcursionDetail(g.detailsHref)
      const stationName = station ? station.name : 'CVSR'
      const parts = []
      if (detail?.description) parts.push(detail.description)
      parts.push(departuresLine(stationName, g.times))
      const description = parts.join('\n\n')

      const status = locality === 'in' ? 'published' : 'pending_review'
      const needsReview = locality !== 'in'

      const row = {
        title:           g.title,
        description,
        start_at:        startAt,
        end_at:          null,
        category:        g.categoryPath ? CATEGORY_BY_PATH[g.categoryPath] ?? undefined : undefined,
        tags:            buildTags(g.title, g.categoryPath),
        price_min:       detail?.priceMin ?? null,
        price_max:       detail?.priceMax ?? null,
        age_restriction: 'all_ages',
        image_url:       detail?.imageUrl ?? null,
        ticket_url:      g.ticketUrl ?? SOURCE_URL,
        source:          SOURCE_KEY,
        source_id:       `${g.slug}-${g.stationCode || 'na'}-${g.date}`,
        status,
        needs_review:    needsReview,
        featured:        false,
      }

      const enriched = await enrichImageCached(row)
      const { data: upserted, error } = await upsertEventSafe(enriched)
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}" ${g.date}:`, error.message)
        skipped++
        continue
      }

      // Link venue only for placeable (known) stations. Organization→venue
      // ownership is claimed once per venue (not per event) to avoid hundreds
      // of redundant writes.
      if (station) {
        let venueId = venueCache.get(g.stationCode)
        if (venueId === undefined) {
          venueId = await ensureStationVenue(g.stationCode)
          venueCache.set(g.stationCode, venueId)
          if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)
        }
        if (venueId) await linkEventVenue(upserted.id, venueId)
      }
      if (organizerId) await linkEventOrganization(upserted.id, organizerId)
      inserted++
    } catch (err) {
      console.warn(`  ⚠ Error processing "${g.title}" ${g.date}:`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting CVSR ingestion…')
  const start = Date.now()

  try {
    const organizerId = await ensureCvsrOrganizer()

    const months = monthsToFetch(easternTodayYmd(), MONTHS_AHEAD)
    const allRecords = []
    for (const { year, month } of months) {
      const url = `${BASE_DOMAIN}/book-tickets/calendar/${year}/${String(month).padStart(2, '0')}`
      try {
        console.log(`\n🔍  Fetching ${MONTH_NAMES[month - 1]} ${year}…`)
        const html = await fetchHtml(url)
        const recs = parseMonthGrid(html, year, month)
        console.log(`  Found ${recs.length} departures`)
        allRecords.push(...recs)
      } catch (err) {
        console.warn(`  ⚠ Could not fetch ${url}: ${err.message}`)
      }
    }

    const groups = groupDepartures(allRecords)
    console.log(`\n📥  ${allRecords.length} departures → ${groups.length} grouped events…`)

    const { inserted, skipped } = await processGroups(groups, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: groups.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s`)
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
