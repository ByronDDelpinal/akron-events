/**
 * scrape-stow-library.js
 *
 * Stow-Munroe Falls Public Library — a standalone Summit County library
 * (separate from the Akron-Summit and Cuyahoga Falls systems). Its public
 * event calendar runs on LibCal (Springshare), served from
 * https://events.smfpl.org/ (calendar id `cid=15865`).
 *
 * Feed strategy — LibCal's calendar JSON, not the HTML:
 *   The public listing renders event cards, but the calendar/grid views are a
 *   client-side FullCalendar widget backed by a clean JSON endpoint (the same
 *   one the widget's jQuery.ajax call hits):
 *
 *     GET /ajax/calendar/list?c=<cid>&date=0000-00-00&perpage=100&page=<n>
 *         &audience=&cats=&camps=&inc=0
 *
 *   `date=0000-00-00` is the widget's "Upcoming Events" mode: it returns every
 *   upcoming event (starting from the beginning of the current month), ordered
 *   by date and paginated (`perpage` caps at 100 server-side; `total_results`
 *   tells us how many pages to pull). Each result object carries everything we
 *   need already parsed: `startdt`/`enddt` as Eastern-local "YYYY-MM-DD HH:MM:SS"
 *   strings, `all_day`, `location` + `locations[]`, `audiences[]` (authoritative
 *   audience signal), `categories_arr[]` (controlled program-type vocabulary),
 *   `featured_image` (an absolute CDN URL), `registration_cost`, and the
 *   `/event/{id}` detail url. This is far cleaner than the HTML cards or the
 *   per-event iCal (`/event/{id}/ical`, which requires knowing every id first).
 *
 * Venues — the library is one fixed Summit County building in Stow, but the
 * feed also lists off-site program locations. `location` is either an internal
 * room name ("Community Room", "Stow-Munroe Falls Room" — all collapse to the
 * one library venue) or an addressed off-site venue ("Stow Community and Senior
 * Center, 5344 Fishcreek Rd, Stow, OH 44224"). Online talks and "Off Site
 * Location" placeholders get no venue but are still ingested.
 *
 * Geography — the library serves only Stow and Munroe Falls (both Summit
 * County), so as a first-party single-institution source (NOT a regional
 * aggregator) every program it runs is Summit by organizer. We still guard
 * off-site venues with classifySummitLocation and DROP any whose explicit city
 * is known non-Summit ('out'); venues with no parseable city ('unknown') are
 * published rather than sent to review, matching the akron_library /
 * cuyahoga_falls_library precedent. The strict "unknown → pending_review" rule
 * targets aggregators with untrusted geo, not a Summit library's own calendar.
 *
 * Non-events: Board of Trustees meetings (internal governance) and library
 * closures ("Library Closed", "Library Closed for Staff Training") are skipped.
 * Price: library programs are free; the feed's `registration_cost` field is the
 * explicit signal (empty across the feed = free) and is parsed if ever populated.
 *
 * Usage:  node scripts/scrape-stow-library.js
 * Env:    VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, htmlToText, easternToIso,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'
import { classifySummitLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'stow_library'
const ORIGIN = 'https://events.smfpl.org'
const CID = 15865
const API = `${ORIGIN}/ajax/calendar/list`
const PER_PAGE = 100          // server-side cap; larger requests are clamped to 100
const MAX_PAGES = 8           // safety bound (~800 events) against a pagination bug
const HORIZON_DAYS = 400      // ignore anything further out than this (parser sanity)

const ORG_NAME = 'Stow-Munroe Falls Public Library'
const ORG_WEBSITE = 'https://www.smfpl.org'

const MAIN_VENUE = {
  name: 'Stow-Munroe Falls Public Library',
  details: {
    address: '3512 Darrow Rd', city: 'Stow', state: 'OH', zip: '44224',
    lat: 41.1616, lng: -81.4405,
    website: ORG_WEBSITE,
    description: 'The Stow-Munroe Falls Public Library serves Stow and Munroe Falls with programs, classes, and events for all ages.',
    parking_type: 'lot', parking_notes: 'Free on-site parking.',
  },
}

// ── Pure parsers (unit-tested) ────────────────────────────────────────────────

// Controlled LibCal program-type vocabulary (categories_arr[].name) + title →
// v2 content category. First match wins; specific phrases before generic
// keywords. Audience-shaped categories (Adult Program, Teen Program, Childrens
// Program, Monthly Program, All Ages, Contest, Off-Site Community Event, …) are
// deliberately unmapped — they describe who/where, not content — so text
// inference decides and the honest long tail lands on 'other'.
const CATEGORY_MAP = [
  [/book sale/i,                                            'market'],
  [/story ?time/i,                                          'learning'],
  [/summer reading|reading program/i,                       'learning'],
  [/book (discussion|club|talk)|author talk|writing|poetry|literary/i, 'learning'],
  [/craft|maker|\bdiy\b/i,                                  'visual-art'],
  [/movie|film|cinema/i,                                    'film'],
  [/concert|\bmusic\b|recital|live performance/i,           'music'],
  [/yoga|fitness|exercise|wellness|tai chi/i,               'fitness'],
  [/cooking|culinary|nutrition|\bfood\b/i,                  'food'],
  [/nature|garden|outdoor/i,                                'outdoors'],
  [/computer|technology|\bstem\b|coding|digital literacy/i, 'learning'],
]

/** Map the controlled category names (+ title fallback) to a v2 slug, or null. */
export function mapCategory(categoryNames = [], title = '') {
  const s = `${Array.isArray(categoryNames) ? categoryNames.join(' ') : categoryNames} ${title}`
  for (const [re, cat] of CATEGORY_MAP) if (re.test(s)) return cat
  return null
}

/**
 * Not community events: internal governance meetings, library closures (which
 * the feed publishes as all-day entries — e.g. "Library Closed", "Library
 * Closed for Staff Training"), and events the library has canceled (LibCal
 * keeps the entry but prefixes the title, e.g. "(Canceled) Job Seeker Station").
 */
export function isSkippable(categoryNames = [], title = '') {
  const s = `${Array.isArray(categoryNames) ? categoryNames.join(' ') : categoryNames} ${title}`
  if (/^\s*\(cancell?ed\)/i.test(title)) return true
  return /board of trustees|staff (?:in-?service|training)|library closed|closed for/i.test(s)
}

/**
 * The library's Audience field is the authoritative audience signal. Returns
 * true for youth/family-programmed audiences (baby through teen, "All Ages",
 * "Family"), otherwise undefined (never false) so inference can still flag
 * family events the field misses. Mirrors akron_library (teen/youth included).
 */
export function parseIsFamily(audienceNames = []) {
  const s = (Array.isArray(audienceNames) ? audienceNames.join(' ') : String(audienceNames)).toLowerCase()
  return /\b(bab(y|ies)|toddlers?|preschool|kids?|child(ren)?|family|families|school.?age|grades?|tweens?|teens?|youth|all ages)\b/.test(s) || undefined
}

/** Build the tags array from the audience names. */
export function parseTags(audienceNames = [], online = false) {
  const tags = ['free', 'library', 'stow']
  for (const a of (Array.isArray(audienceNames) ? audienceNames : [audienceNames]).map((x) => String(x).toLowerCase())) {
    if (/preschool|toddler|bab(y|ies)|child|school.?age/.test(a)) tags.push('kids')
    if (/teen|tween/.test(a)) tags.push('teens')
    if (/\badult\b/.test(a)) tags.push('adults')
    if (/senior|older/.test(a)) tags.push('seniors')
  }
  if (online) tags.push('online')
  return [...new Set(tags)]
}

/** Parse the LibCal registration_cost string. Library programs are free, so an
 *  empty/absent value → 0. A populated value (rare materials fee) is parsed. */
export function parsePrice(cost = '') {
  const nums = String(cost || '').match(/\d+(\.\d+)?/g)?.map(Number).filter((n) => !Number.isNaN(n))
  if (!nums || !nums.length) return { price_min: 0, price_max: null }
  const min = Math.min(...nums), max = Math.max(...nums)
  return { price_min: min, price_max: max > min ? max : null }
}

/**
 * Resolve a LibCal `location` string to a venue.
 *   • online / empty / "Off Site Location" → null (event ingested venue-less)
 *   • an addressed off-site location ("Name, 5344 Fishcreek Rd, Stow, OH 44224")
 *     → its own venue, parsing name/address/city/state/zip
 *   • anything else is an internal room name → the one library venue
 * The address heuristic requires a comma followed by a house number, so
 * multi-room strings like "Pavilion, Stow-Munroe Falls Room" stay internal.
 */
export function resolveVenue(location = '', online = false) {
  const loc = String(location || '').replace(/\s+/g, ' ').trim()
  if (online || !loc) return null
  if (/^off.?site\b/i.test(loc)) return null

  if (/,\s*\d+\s+\S/.test(loc)) {
    const parts = loc.split(',').map((s) => s.trim()).filter(Boolean)
    const name = parts[0]
    const details = { state: 'OH' }
    const addr = parts.find((p) => /^\d+\s+\S/.test(p))
    if (addr) details.address = addr
    const sz = parts.find((p) => /^[A-Za-z]{2}\s+\d{5}\b/.test(p))
    if (sz) {
      const m = sz.match(/^([A-Za-z]{2})\s+(\d{5})/)
      details.state = m[1].toUpperCase()
      details.zip = m[2]
    }
    const cityPart = parts.slice(1).find(
      (p) => p !== addr && !/^[A-Za-z]{2}\s+\d{5}\b/.test(p) && /[A-Za-z]/.test(p) && !/^\d/.test(p),
    )
    // The library only programs off-site within its Stow/Munroe Falls service
    // area (all Summit County). When the location string omits a city, default
    // to Stow — much more accurate than the venues table's 'Akron' column
    // default, and it keeps the venue correctly in-county.
    details.city = cityPart || 'Stow'
    return { name, details }
  }
  return MAIN_VENUE
}

/**
 * Geo decision for a resolved venue. The library and venue-less events always
 * publish (Summit institution). Off-site venues are dropped only when their
 * EXPLICIT city is known non-Summit; unknown-city off-site venues publish
 * (see the header's geography note).
 */
export function shouldDropForGeo(venue) {
  if (!venue || venue === MAIN_VENUE) return false
  return classifySummitLocation({ city: venue.details.city }) === 'out'
}

/**
 * Build an event row (+ resolved venue) from one LibCal feed object. Returns
 * null when the event is unusable (missing/undatable) or should be skipped
 * (internal meeting). `startdt`/`enddt` are Eastern-local strings the platform
 * already parsed, so easternToIso converts them directly — no time is ever
 * synthesized.
 */
export function buildRow(e = {}) {
  const title = htmlToText(e.title || '').trim()
  const categoryNames = (e.categories_arr || []).map((c) => c && c.name).filter(Boolean)
  const audienceNames = (e.audiences || []).map((a) => a && a.name).filter(Boolean)
  if (!title) return null
  if (isSkippable(categoryNames, title)) return null

  const startAt = easternToIso(e.startdt)
  if (!startAt) return null
  const endAt = e.enddt ? easternToIso(e.enddt) : null

  const online = e.online_event === true
  const venue = resolveVenue(e.location, online)
  const { price_min, price_max } = parsePrice(e.registration_cost)
  const desc = e.description ? htmlToText(e.description).slice(0, 5000) || null : null
  const ymd = e.ymd || String(startAt).slice(0, 10).replace(/-/g, '')

  return {
    row: {
      title,
      description: desc,
      start_at: startAt,
      end_at: endAt,
      category: mapCategory(categoryNames, title),
      is_family: parseIsFamily(audienceNames),
      tags: parseTags(audienceNames, online),
      price_min,
      price_max,
      age_restriction: 'not_specified',
      image_url: /^https?:\/\//i.test(e.featured_image || '') ? e.featured_image : null,
      ticket_url: e.url || `${ORIGIN}/event/${e.id}`,
      source: SOURCE_KEY,
      source_id: `smfpl_${e.id}_${ymd}`,
      status: 'published',
      featured: false,
    },
    venue,
  }
}

// ── JSON feed ─────────────────────────────────────────────────────────────────

async function fetchPage(page) {
  const url = `${API}?c=${CID}&date=0000-00-00&perpage=${PER_PAGE}&page=${page}&audience=&cats=&camps=&inc=0`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching LibCal list page ${page}`)
  const data = await res.json()
  if (!data || !Array.isArray(data.results)) throw new Error('LibCal feed missing results array')
  return data
}

/** Pull every upcoming page (paginating on total_results, capped by MAX_PAGES). */
async function fetchAllEvents() {
  const first = await fetchPage(1)
  const total = Number(first.total_results) || first.results.length
  const perpage = Number(first.perpage) || PER_PAGE
  const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / perpage)))
  const all = [...first.results]
  for (let p = 2; p <= pages; p++) {
    const data = await fetchPage(p)
    if (!data.results.length) break
    all.push(...data.results)
  }
  return { events: all, total }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('📚  Starting Stow-Munroe Falls Library (LibCal JSON feed) scrape…')
  const start = Date.now()

  try {
    const { events, total } = await fetchAllEvents()
    console.log(`\n📥  Fetched ${events.length} of ${total} upcoming events…`)
    if (!events.length) {
      console.warn('  ⚠ LibCal feed returned 0 upcoming events.')
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, { durationMs: Date.now() - start, eventsFound: 0 })
      return
    }

    const organizerId = await ensureOrganization(ORG_NAME, {
      website: ORG_WEBSITE,
      description: 'The Stow-Munroe Falls Public Library serves Stow and Munroe Falls with programs, classes, and events for all ages.',
    })

    const nowMs = Date.now()
    const cutoffPast = nowMs - 86_400_000
    const cutoffFuture = nowMs + HORIZON_DAYS * 86_400_000
    const venueCache = new Map()
    let inserted = 0, skipped = 0

    for (const e of events) {
      try {
        const built = buildRow(e)
        if (!built) { skipped++; continue }

        const startMs = Date.parse(built.row.start_at)
        if (startMs < cutoffPast || startMs > cutoffFuture) { skipped++; continue }
        if (shouldDropForGeo(built.venue)) { skipped++; continue }

        const enriched = await enrichWithImageDimensions(built.row)
        const { data: upserted, error } = await upsertEventSafe(enriched)
        if (error) { console.warn(`  ⚠ Upsert failed "${built.row.title}": ${error.message}`); skipped++; continue }

        if (built.venue) {
          const vKey = built.venue.name
          let venueId = venueCache.get(vKey)
          if (venueId === undefined) {
            venueId = await ensureVenue(built.venue.name, built.venue.details)
            venueCache.set(vKey, venueId)
            if (built.venue === MAIN_VENUE && organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)
          }
          if (venueId) await linkEventVenue(upserted.id, venueId)
        }
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on "${e && e.title}": ${err.message}`)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: events.length, durationMs: Date.now() - start })
    console.log(`\n✅  Stow-Munroe Falls Library: ${inserted} posted, ${skipped} skipped in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
