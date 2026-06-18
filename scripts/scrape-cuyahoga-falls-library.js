/**
 * scrape-cuyahoga-falls-library.js
 *
 * Cuyahoga Falls Library (Taylor Memorial) — a SEPARATE system from the
 * Akron-Summit County Public Library. Its events live on a Communico "Anywhere"
 * hosted calendar at https://events.fallslibrary.org/events.
 *
 * Unlike the Akron library (which exposes a clean JSON endpoint), this Communico
 * tenant renders events client-side via the `amEvents` jQuery widget, and its
 * internal API (api.communico.co/v1/fallslibrary/events) is undocumented and
 * param-fragile (returns empty / SQL errors). There is no public ICS/RSS feed.
 * So we render the listing with Puppeteer and parse the event cards from the DOM
 * — each `[class*="event-"]` card carries:
 *   .eelisttitle  (title <a> + optional subtitle <span>, and the /event/{id} link)
 *   .eelisttime   ("Tuesday, June 16: 10:30am - 12:00pm")
 *   .eelocation   ("Cuyahoga Falls Library - Graefe Room" or an external venue)
 *   .eelisttags   ("Age group: Toddler Preschool")
 *   .eelistgroup  ("event type: Storytime, Arts/Crafts")
 *   .eelistdesc   (description)
 *
 * We page through the widget's named ranges (this month + next month); the
 * scraper runs twice daily so coverage rolls forward continuously. Price is 0
 * (library programs are free). Category comes from the EVENT TYPE field;
 * is_family from the AGE GROUP field (authoritative audience signal).
 *
 * Usage:  node scripts/scrape-cuyahoga-falls-library.js
 * Env:    VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { withBrowser, newConfiguredPage } from './lib/puppeteer.js'
import {
  logUpsertResult, logScraperError, stripHtml, easternToIso,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'

export const SOURCE_KEY = 'cuyahoga_falls_library'
const BASE = 'https://events.fallslibrary.org/events'
const RANGES = ['thismonth', 'nextmonth']  // named widget ranges; ~2 months forward

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
      image_url: null,
      ticket_url: card.detailUrl || BASE,
      source: SOURCE_KEY,
      source_id: card.eventId ? `cfl_${card.eventId}` : `cfl_${when.dateYmd}_${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`,
      status: 'published',
      featured: false,
    },
    venue: venueFor(card.location),
  }
}

// ── Browser extraction ────────────────────────────────────────────────────────

/** Runs in the page: pull raw fields from each rendered event card. */
/* c8 ignore start */
function extractCards() {
  const txt = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '')
  const stripLabel = (s, label) => s.replace(new RegExp(`^\\s*${label}\\s*:?\\s*`, 'i'), '').replace(new RegExp(`\\s*${label}\\s*:?\\s*$`, 'i'), '').trim()
  return [...document.querySelectorAll('[class*="event-"]')].map((card) => {
    const titleA = card.querySelector('.eelisttitle a')
    const sub = card.querySelector('.eelisttitle span')
    const link = card.querySelector('a[href*="/event/"]')
    const idM = link ? (link.getAttribute('href') || '').match(/\/event\/(\d+)/) : null
    return {
      title: txt(titleA),
      subtitle: txt(sub),
      datetimeText: txt(card.querySelector('.eelisttime')),
      location: txt(card.querySelector('.eelocation')),
      ageGroup: stripLabel(txt(card.querySelector('.eelisttags')), 'age group'),
      eventType: stripLabel(txt(card.querySelector('.eelistgroup')), 'event type'),
      description: txt(card.querySelector('.eelistdesc')),
      detailUrl: link ? link.href : null,
      eventId: idM ? idM[1] : null,
    }
  }).filter((c) => c.title)
}
/* c8 ignore stop */

async function collectCards() {
  return withBrowser(async (browser) => {
    const page = await newConfiguredPage(browser)
    const byId = new Map()
    for (const range of RANGES) {
      try {
        await page.goto(`${BASE}?r=${range}`, { waitUntil: 'networkidle2', timeout: 30_000 })
        try { await page.waitForSelector('.eelisttitle', { timeout: 8_000 }) } catch { /* empty range */ }
        const cards = await page.evaluate(extractCards)
        for (const c of cards) {
          const key = c.eventId ? `id:${c.eventId}` : `${c.title}|${c.datetimeText}`
          if (!byId.has(key)) byId.set(key, c)
        }
        console.log(`  ${range}: ${cards.length} cards (total unique: ${byId.size})`)
      } catch (err) {
        console.warn(`  ⚠ ${range} load failed: ${err.message}`)
      }
    }
    return [...byId.values()]
  })
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('📚  Starting Cuyahoga Falls Library (Communico) scrape…')
  const start = Date.now()

  try {
    const cards = await collectCards()
    console.log(`\n📥  Processing ${cards.length} events…`)
    if (!cards.length) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: 'error',
        errorMessage: 'Rendered the Communico listing but found 0 event cards — the .eelist* markup may have changed.',
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
