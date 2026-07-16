/**
 * scrape-ohio-erie-canalway.js
 *
 * Ohio & Erie Canalway Coalition (ohioeriecanal.org) — the nonprofit that
 * stewards the Ohio & Erie Canal Towpath Trail. Its /events page is a Drupal 9
 * view: a short list of ~7 marquee programs (hikes, cleanups, bike rides,
 * races). Each listing row is a `<div class="item">` carrying a machine-readable
 * date:
 *
 *     <div class="item">
 *       <h4 class="title"><a href="/float">Summit Lake Float</a></h4>
 *       <time datetime="2026-07-11T12:00:00Z" class="datetime">July 11th 2026</time>
 *     </div>
 *
 * The listing itself has no time, location, or description, so we crawl each
 * event's detail page. The detail body carries a small "Event Details" block:
 *
 *     <strong>Date: </strong>Saturday, July 11<br>
 *     <strong>Time: </strong>8:00 a.m. to 4:00 p.m.<br>
 *     <strong>Location:</strong> Summit Lake NorthShore Park, 540 W. South Street, Akron
 *
 * from which we take the start time and the venue/city. Some pages omit the
 * structured block (the location only appears in prose), so we fall back to
 * scanning the body text for a known locality.
 *
 * Why the Summit County gate matters: the Canalway spans Cleveland → New
 * Philadelphia, so the Coalition runs events well outside Summit County (e.g.
 * "Bike, Hike and Brew" is at the Canal Tavern of Zoar, Tuscarawas County). We
 * gate every event to Summit County by city via isSummitCountyLocation
 * (lib/summit-county.js) and drop the rest. Events with no resolvable locality
 * are also dropped — an unknown location is never trusted.
 *
 * The authoritative date is the listing `<time datetime>` (YYYY-MM-DD); the
 * detail page only supplies the clock time. Price is never assumed. Organizer is
 * the Coalition; venue comes from the detail Location line when present.
 *
 * Usage:   node scripts/scrape-ohio-erie-canalway.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, htmlToText, stripHtml, decodeEntities,
  easternToIso, inferCategory, enrichWithImageDimensions, upsertEventSafe,
  ensureVenue, ensureOrganization, linkEventVenue, linkEventOrganization,
  splitCommaLocation,
} from './lib/normalize.js'
import { isSummitCountyLocation, SUMMIT_COUNTY_CITIES } from './lib/summit-county.js'

export const SOURCE_KEY = 'ohio_erie_canalway'
const SITE = 'https://www.ohioeriecanal.org'
const EVENTS_URL = `${SITE}/events`
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'
const DEFAULT_TIME = '9:00 AM'          // detail-less events: sensible morning default
const DEFAULT_VENUE = 'Ohio & Erie Canal Towpath Trail'
const MAX_DAYS_AHEAD = 450

// Localities we recognize when scanning free prose for an event's city. The
// Summit County allowlist is the source of truth for the gate; a few nearby
// Canalway towns (Tuscarawas/Stark) are listed too so prose-only events resolve
// to a real (out-of-county) locality and get correctly dropped rather than
// slipping through as "unknown".
const NON_SUMMIT_CANALWAY_CITIES = [
  'zoar', 'bolivar', 'navarre', 'canal fulton', 'massillon', 'canton',
  'new philadelphia', 'dover', 'brecksville', 'independence', 'valley view',
  'cleveland',
]
const KNOWN_CITIES = [
  ...SUMMIT_COUNTY_CITIES,
  ...NON_SUMMIT_CANALWAY_CITIES,
].sort((a, b) => b.length - a.length)   // longest-first so "canal fulton" beats "canal"

// ── Pure parsers (exported for tests) ───────────────────────────────────────

/**
 * Parse "July 11th 2026" → "YYYY-MM-DD". Kept as a fallback for the human date
 * text; the `<time datetime>` attribute is preferred when present.
 */
const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}
export function parseCanalwayDate(text) {
  const m = String(text || '').match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})/i,
  )
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  if (!month) return null
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`
}

/**
 * Parse the /events listing into rows: { title, path, url, ymd, dateText }.
 * Each event is a `<div class="item">` with an <h4 class="title"> link and a
 * <time datetime="…"> element (the authoritative date).
 */
export function parseEvents(html) {
  const s = String(html || '')
  const out = []
  const itemRe = /<div class="item">([\s\S]*?)<\/div>/gi
  for (const block of s.matchAll(itemRe)) {
    const chunk = block[1]
    const linkM = chunk.match(/<h4[^>]*class="title"[^>]*>\s*<a[^>]+href="([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!linkM) continue
    const title = stripHtml(linkM[2])
    if (!title) continue
    const path = linkM[1]
    const url = path.startsWith('http') ? path : `${SITE}${path}`

    const timeM = chunk.match(/<time[^>]*datetime="([^"]+)"[^>]*>([\s\S]*?)<\/time>/i)
    const dateText = timeM ? stripHtml(timeM[2]) : ''
    // Prefer the machine-readable datetime (take its YYYY-MM-DD prefix); fall
    // back to parsing the human date text.
    let ymd = null
    if (timeM) {
      const iso = decodeEntities(timeM[1]).trim()
      const dm = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
      if (dm) ymd = `${dm[1]}-${dm[2]}-${dm[3]}`
    }
    if (!ymd) ymd = parseCanalwayDate(dateText)
    if (!ymd) continue

    out.push({ title, path, url, ymd, dateText })
  }
  return out
}

/** Pull the trailing city out of a "Name, Address, City[, OH[ ZIP]]" line. */
export function cityFromLocationLine(line) {
  let parts = String(line || '').split(',').map((p) => p.trim()).filter(Boolean)
  if (!parts.length) return null
  // Drop a trailing state / ZIP segment ("OH", "Ohio", "OH 44301") so the city
  // is the last remaining part.
  const isStateZip = (p) => /^(oh|ohio)\b\.?\s*\d*$/i.test(p)
  while (parts.length > 1 && isStateZip(parts[parts.length - 1])) parts = parts.slice(0, -1)
  const last = parts[parts.length - 1]
  const c = last.toLowerCase().replace(/\b(oh|ohio)\b\.?/g, '').replace(/\d/g, '').replace(/\./g, '').trim()
  return c || null
}

/** Find the first known locality mentioned in a block of free text. */
export function cityFromProse(text) {
  const t = String(text || '').toLowerCase()
  for (const city of KNOWN_CITIES) {
    const re = new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    if (re.test(t)) return city
  }
  return null
}

/**
 * Parse an event detail page. Returns { time, location, city, description,
 * imageUrl }. `location` is the raw venue/address line; `city` is what the
 * Summit County gate consumes.
 */
export function parseDetail(html) {
  const s = String(html || '')
  const bodyText = htmlToText(s)

  const line = (label) => {
    const m = bodyText.match(new RegExp(`${label}:\\s*([^\\n]+)`, 'i'))
    return m ? m[1].trim() : null
  }
  const location = line('Location')
  const timeRaw = line('Time')

  // Start time = the first clock token on the Time line (ranges read "8:00 a.m.
  // to 4:00 p.m."; we want the opener).
  let time = null
  if (timeRaw) {
    const tm = timeRaw.match(/\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)/i)
    if (tm) time = tm[0].replace(/\s+/g, ' ').replace(/\./g, '').toUpperCase()
  }

  const city = (location && cityFromLocationLine(location)) || cityFromProse(bodyText)

  // Description: the meta description is the cleanest single-paragraph summary;
  // fall back to the first substantial body paragraph.
  let description = null
  const metaM = s.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i)
  if (metaM && metaM[1].trim()) {
    description = decodeEntities(metaM[1]).replace(/\s+/g, ' ').trim().slice(0, 2000)
  } else {
    const para = bodyText.split('\n').map((p) => p.trim()).find((p) => p.length > 60)
    if (para) description = para.slice(0, 2000)
  }

  // Image: og:image is the reliable social card.
  let imageUrl = null
  const ogM = s.match(/<meta[^>]+property="og:image"[^>]+content="([^"]*)"/i)
  if (ogM && ogM[1].trim()) imageUrl = decodeEntities(ogM[1]).trim()

  return { time, location, city, description, imageUrl }
}

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// ── Fetch ─────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚣  Starting Ohio & Erie Canalway Coalition ingestion…')
  const start = Date.now()
  try {
    const listHtml = await fetchHtml(EVENTS_URL)
    const rows = parseEvents(listHtml)
    console.log(`  Parsed ${rows.length} listing row(s)`)

    const organizerId = await ensureOrganization('Ohio & Erie Canalway Coalition', {
      website: SITE,
      description: 'The Ohio & Erie Canalway Coalition stewards the Ohio & Erie Canal Towpath Trail, running hikes, cleanups, bike rides, and races along the canal in and around Summit County.',
    })

    const now = Date.now()
    const cutoff = now + MAX_DAYS_AHEAD * 86_400_000
    const venueCache = new Map()
    let inserted = 0, skipped = 0

    for (const row of rows) {
      try {
        // Crawl the detail page for time, location, description, image.
        let detail = { time: null, location: null, city: null, description: null, imageUrl: null }
        try {
          detail = parseDetail(await fetchHtml(row.url))
        } catch (err) {
          console.warn(`  ⚠ Detail fetch failed "${row.title}":`, err.message)
        }

        // Summit County gate — city from the detail Location line or prose.
        if (!isSummitCountyLocation({ city: detail.city })) {
          console.log(`  ↷ Skipping "${row.title}" (city: ${detail.city || 'unknown'}) — not Summit County`)
          skipped++
          continue
        }

        const startIso = easternToIso(row.ymd, detail.time || DEFAULT_TIME)
        if (!startIso) { skipped++; continue }
        const ms = Date.parse(startIso)
        if (ms < now - 86_400_000 || ms > cutoff) { skipped++; continue }

        // The prose "Location:" line often comes comma-joined ("Summit Lake
        // NorthShore Park, 540 W. South Street, Akron") — split name/address
        // instead of minting the whole string as a venue name.
        const rawLocation = detail.location || DEFAULT_VENUE
        const split = splitCommaLocation(rawLocation)
        const venueName = split?.name ?? rawLocation
        let venueId = venueCache.get(rawLocation)
        if (venueId === undefined) {
          venueId = await ensureVenue(venueName, {
            ...(split?.address ? { address: split.address } : {}),
            city:  titleCaseCity(split?.city ?? detail.city),
            state: 'OH',
          })
          venueCache.set(rawLocation, venueId)
        }

        const category = inferCategory(row.title, detail.description || '') || 'other'
        const row_ = {
          title:           row.title,
          description:     detail.description || null,
          start_at:        startIso,
          end_at:          null,
          category:        category === 'other' ? 'community' : category,
          tags:            ['outdoors', 'towpath', 'canalway'],
          price_min:       null,           // never assume free
          price_max:       null,
          age_restriction: 'all_ages',
          image_url:       detail.imageUrl || null,
          ticket_url:      row.url,
          source:          SOURCE_KEY,
          source_id:       `${slugify(row.title)}-${row.ymd}`,
          status:          'published',
          featured:        false,
        }
        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row_))
        if (error) { console.warn(`  ⚠ Upsert failed "${row_.title}":`, error.message); skipped++; continue }
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on "${row.title}":`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: rows.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

/** Title-case a lowercased city for storage ("cuyahoga falls" → "Cuyahoga Falls"). */
function titleCaseCity(city) {
  if (!city) return null
  return city.replace(/\b\w/g, (c) => c.toUpperCase())
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
