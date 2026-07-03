/**
 * scrape-cuyahoga-falls-library.js
 *
 * Cuyahoga Falls Library (Taylor Memorial) — a SEPARATE system from the
 * Akron-Summit County Public Library. Its Communico "Anywhere" calendar moved
 * from https://events.fallslibrary.org/events to a new host,
 * https://fallslibrary.libnet.info/events.
 *
 * The listing still renders client-side, but it is backed by a clean JSON feed
 * (the same endpoint the page's widget calls), so we no longer need Puppeteer:
 *   GET /eeventcaldata?event_type=0&req={"private":false,"date":"YYYY-MM-DD",
 *        "days":N,"locations":[],"ages":[],"types":[]}
 * It returns an array of event instances (recurring events pre-expanded), each
 * carrying title, sub_title, datestring ("Monday, June 29"), time_string
 * ("10:30am - 11:00am"), raw_start_time, location, ages, description, and the
 * /event/{id} detail url.
 *
 * The scraper runs twice daily so coverage rolls forward continuously. Price is
 * 0 (library programs are free). Category is inferred from the title (the feed
 * has no program-type field); is_family from the AGE GROUP field (authoritative
 * audience signal).
 *
 * Usage:  node scripts/scrape-cuyahoga-falls-library.js
 * Env:    VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, easternToIso,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'

export const SOURCE_KEY = 'cuyahoga_falls_library'
const ORIGIN = 'https://fallslibrary.libnet.info'
const BASE = `${ORIGIN}/events`             // public listing (fallback ticket url)
const API = `${ORIGIN}/eeventcaldata`       // JSON feed the widget reads
const DETAIL_BASE = `${ORIGIN}/event`
const DAYS_AHEAD = 60                        // one request covers ~2 months forward

const ORG_NAME = 'Cuyahoga Falls Library'
const MAIN_VENUE = {
  name: 'Cuyahoga Falls Library',
  details: {
    address: '2015 Third St', city: 'Cuyahoga Falls', state: 'OH', zip: '44221',
    lat: 41.1326, lng: -81.4836,
    website: 'https://www.fallslibrary.org',
    description: 'Taylor Memorial — the Cuyahoga Falls public library.',
    parking_type: 'lot', parking_notes: 'Free on-site parking.',
  },
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

// ── Pure parsers (unit-tested) ────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0')

/** "10:30am" → "10:30:00" (24h). */
export function to24h(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})\s*([ap])m$/i)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const pm = /p/i.test(m[3])
  if (h === 12) h = pm ? 12 : 0
  else if (pm) h += 12
  return `${pad(h)}:${m[2]}:00`
}

/**
 * Parse a Communico list date/time line — "Tuesday, June 16: 10:30am - 12:00pm"
 * (the year is NOT shown). Returns { dateYmd, start, end } clock times, or null.
 * `now` anchors the year: a month earlier than the current month rolls to next
 * year (covers loading "next month" in December).
 */
export function parseListDateTime(text, now = new Date()) {
  if (!text) return null
  let month = null, day = null
  for (const mm of String(text).matchAll(/([A-Za-z]{3,9})\s+(\d{1,2})\b/g)) {
    const mo = MONTHS[mm[1].toLowerCase()]
    if (mo) { month = mo; day = parseInt(mm[2], 10); break }
  }
  if (!month || !day) return null

  const todayYmd = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  const [ty, tm] = todayYmd.split('-').map(Number)
  const year = month < tm ? ty + 1 : ty
  const dateYmd = `${year}-${pad(month)}-${pad(day)}`

  const times = [...String(text).matchAll(/(\d{1,2}:\d{2}\s*[ap]m)/gi)].map((m) => to24h(m[1].replace(/\s+/g, '')))
  return { dateYmd, start: times[0] || null, end: times[1] || null }
}

// Communico Anywhere controlled EVENT TYPE vocabulary → v2 category.
// First match wins; specific phrases before generic keywords.
const TYPE_CATEGORY = [
  [/storytime|story time/i,                'learning'],
  [/arts?\s*\/?\s*crafts?|maker/i,         'visual-art'],
  [/literary|book|writing|author|poetry/i, 'learning'],
  [/continuing education|class|workshop|lecture|seminar|computer|technology|stem|career|job|tutor|language|esl|ged|finance|financial/i, 'learning'],
  [/concert|live performance|music|recital/i, 'music'],
  [/film|movie|cinema/i,                   'film'],
  [/exercise|fitness|yoga|wellness|tai chi/i, 'fitness'],
  [/nature|outdoor|garden/i,               'outdoors'],
  [/food|cooking|culinary/i,               'food'],
  [/book sale|sale|market/i,               'market'],
  [/board of trustees|meeting|civic|government|community discussion|town hall/i, 'civic'],
  [/theater|theatre|play|drama|performance/i, 'theater'],
]

/** Map the EVENT TYPE string (+ title fallback) to a v2 category, or null. */
export function mapCategory(eventType = '', title = '') {
  const s = `${eventType} ${title}`
  for (const [re, cat] of TYPE_CATEGORY) if (re.test(s)) return cat
  return null
}

/** AGE GROUP is the authoritative audience signal. Returns true or undefined. */
export function parseIsFamily(ageGroup = '') {
  return /\b(bab(y|ies)|toddler|preschool|kids?|child(ren)?|family|families|school-?age|grades?|tween|teen|youth|all ages)\b/i.test(ageGroup) || undefined
}

/**
 * Resolve a Communico location string to a venue. Main-library rooms (e.g.
 * "Cuyahoga Falls Library - Graefe Room") collapse to the one library venue;
 * external locations ("Silver Lake Village Hall (2961 Kent Rd, …) - Room",
 * "Lions Park") become their own venue, parsing a parenthetical address.
 * "In the Community"/"Online"/empty → null (no venue).
 */
export function venueFor(location = '') {
  const loc = String(location || '').replace(/\s+/g, ' ').trim()
  if (!loc) return null
  if (/^cuyahoga falls library/i.test(loc)) return MAIN_VENUE
  if (/^(in the community|online|virtual|tbd)$/i.test(loc)) return null

  // Strip a trailing " - <Room>" qualifier, and pull an address from parens.
  const addrMatch = loc.match(/\(([^)]*\d[^)]*)\)/)
  const name = loc.replace(/\s*\([^)]*\)\s*/, ' ').replace(/\s*-\s*[^-]*\broom\b.*$/i, '').replace(/\s+/g, ' ').trim()
  const details = { city: 'Cuyahoga Falls', state: 'OH' }
  if (addrMatch) {
    const a = addrMatch[1]
    const street = a.split(',')[0]?.trim()
    if (street) details.address = street
    const cityM = a.match(/,\s*([A-Za-z .'-]+?)\s*,\s*OH/i)
    if (cityM) details.city = cityM[1].trim()
    const zipM = a.match(/\b(\d{5})\b/)
    if (zipM) details.zip = zipM[1]
  }
  return { name: name || loc, details }
}

/** Build an event row from a parsed card. */
export function buildRow(card, now = new Date()) {
  const title = stripHtml(`${card.title || ''}${card.subtitle ? ' ' + card.subtitle : ''}`).trim()
  const when = parseListDateTime(card.datetimeText, now)
  if (!title || !when || !when.start) return null
  const startAt = easternToIso(`${when.dateYmd} ${when.start}`)
  if (!startAt) return null
  const endAt = when.end ? easternToIso(`${when.dateYmd} ${when.end}`) : null

  const tags = ['free', 'library', 'cuyahoga-falls']
  if (card.ageGroup) {
    for (const a of card.ageGroup.toLowerCase().split(/[,/]/).map((x) => x.trim())) {
      if (/toddler|preschool|baby/.test(a)) tags.push('kids')
      else if (/teen|tween/.test(a)) tags.push('teens')
      else if (/senior|older/.test(a)) tags.push('seniors')
      else if (/adult/.test(a)) tags.push('adults')
    }
  }
  return {
    row: {
      title,
      description: card.description ? stripHtml(card.description).slice(0, 5000) || null : null,
      start_at: startAt,
      end_at: endAt,
      category: mapCategory(card.eventType, title),
      is_family: parseIsFamily(card.ageGroup),
      tags: [...new Set(tags)],
      price_min: 0,
      price_max: null,
      age_restriction: 'not_specified',
      // The feed's `image`/`event_image` fields are consistently empty in
      // practice (verified 2026-07-02) — the platform has no per-event photo
      // for this library. Read defensively anyway in case that ever changes;
      // otherwise a source-level fallback applies (lib/fallback-images.js).
      image_url: card.imageUrl || null,
      ticket_url: card.detailUrl || BASE,
      source: SOURCE_KEY,
      source_id: card.eventId ? `cfl_${card.eventId}` : `cfl_${when.dateYmd}_${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`,
      status: 'published',
      featured: false,
    },
    venue: venueFor(card.location),
  }
}

// ── JSON feed ─────────────────────────────────────────────────────────────────

/** Today's date in Eastern time as YYYY-MM-DD — the feed's `date` anchor. */
function easternTodayYmd(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

/**
 * Map one feed event object to the "card" shape buildRow expects, so all the
 * pure parsers (parseListDateTime, mapCategory, parseIsFamily, venueFor) are
 * reused unchanged. `datetimeText` is rebuilt as "Weekday, Month Day: start -
 * end" from the feed's datestring + time_string, which parseListDateTime reads.
 */
export function eventToCard(e = {}) {
  const datestring = String(e.datestring || '').trim()
  const timeString = String(e.time_string || '').trim()
  // `image`/`event_image` are almost always "" in this feed, but on the rare
  // chance one is populated, only trust it if it's already an absolute URL —
  // we don't know this platform's asset base path, so a bare filename (like
  // akron_library's separate `services.akronlibrary.org` feed uses) is left
  // for the source-level fallback rather than guessed at.
  const rawImage = e.image || e.event_image || ''
  return {
    title:        e.title || '',
    subtitle:     e.sub_title || '',
    datetimeText: datestring && timeString ? `${datestring}: ${timeString}` : datestring,
    location:     e.location || e.library || '',
    ageGroup:     e.ages || '',
    eventType:    '',                                   // feed has no program-type field; title drives category
    description:  e.long_description || e.description || '',
    detailUrl:    e.url || (e.id != null ? `${DETAIL_BASE}/${e.id}` : null),
    imageUrl:     /^https?:\/\//i.test(rawImage) ? rawImage : null,
    // Per-instance id so recurring occurrences don't collide on source_id.
    eventId:      e.id != null ? `${e.id}_${String(e.raw_start_time || '').slice(0, 10)}` : null,
  }
}

/** Fetch the next DAYS_AHEAD days of events from the Communico JSON feed. */
async function fetchEvents(now = new Date()) {
  const req = { private: false, date: easternTodayYmd(now), days: DAYS_AHEAD, locations: [], ages: [], types: [] }
  const url = `${API}?event_type=0&req=${encodeURIComponent(JSON.stringify(req))}`
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching the Communico feed`)
  const data = await res.json()
  if (!Array.isArray(data)) throw new Error('Communico feed did not return a JSON array of events')
  return data
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('📚  Starting Cuyahoga Falls Library (Communico JSON feed) scrape…')
  const start = Date.now()

  try {
    const events = await fetchEvents()
    const cards = events.map(eventToCard).filter((c) => c.title)
    console.log(`\n📥  Processing ${cards.length} events (from ${events.length} feed rows)…`)
    if (!cards.length) {
      console.warn('  ⚠ Communico feed returned 0 upcoming events.')
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        durationMs: Date.now() - start, eventsFound: 0,
      })
      process.exit(0)
    }

    const organizerId = await ensureOrganization(ORG_NAME, {
      website: 'https://www.fallslibrary.org',
      description: 'The Cuyahoga Falls Library (Taylor Memorial) serves Cuyahoga Falls and Silver Lake with programs, classes, and events for all ages.',
    })

    const nowMs = Date.now()
    const cutoffPast = nowMs - 86_400_000
    const venueCache = new Map()
    let inserted = 0, skipped = 0

    for (const card of cards) {
      try {
        const built = buildRow(card)
        if (!built) { skipped++; continue }
        if (Date.parse(built.row.start_at) < cutoffPast) { skipped++; continue }

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
        console.warn(`  ⚠ Error on "${card.title}": ${err.message}`)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: cards.length, durationMs: Date.now() - start })
    console.log(`\n✅  Cuyahoga Falls Library: ${inserted} posted, ${skipped} skipped in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
