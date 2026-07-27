/**
 * scrape-tangier.js
 *
 * Tangier (thetangier.com) — a 65-year-old Akron-area restaurant, banquet, and
 * entertainment institution now anchored at "Tangier West," 3150 W Market St,
 * Fairlawn, OH 44333. Fairlawn is in SUMMIT COUNTY, and Tangier's event spaces
 * (Tangier West, Our Lady of the Cedars Ballroom, The Bank at East End, The
 * Trailhead at Cascade Lofts, the Greek Community Center) are all in the
 * Fairlawn/Akron area — all Summit — so events publish directly with no geo gate.
 *
 * Platform: a Webflow marketing site. /events renders an "Upcoming Events"
 * section as a flat sequence of banner image → <h2> title → date → a "HELD AT
 * <space>: <address>" block → description → prices → ticket buttons. Two gotchas
 * this parser handles:
 *   1. Every event card carries a BOILERPLATE "Purchase Tickets" button pointing
 *      at one recurring Etix product (id 51986841, the Disco Inferno NYE at The
 *      Bank). The event's REAL ticket link is a different etix.com/ticket/p/<id>
 *      — we drop id 51986841 and keep the rest, in document order.
 *   2. Times live only in prose ("Doors open at 6:30PM"); we extract a doors time
 *      when one is clearly stated and otherwise publish the event date-only
 *      rather than fabricate a start time.
 *
 * Ticketing is Etix; ticket_url is the per-event Etix product page. The stable
 * Etix product id is the source_id, so the twice-daily run is idempotent.
 * Prices are parsed from the "$NN.NN" lines (min/max across ticket tiers).
 *
 * Usage:   node scripts/scrape-tangier.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, easternToIso, htmlToText, decodeEntities,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'

export const SOURCE_KEY = 'tangier'
const BASE_URL   = 'https://www.thetangier.com'
const EVENTS_URL = `${BASE_URL}/events`
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'
const ORG_NAME   = 'Tangier'
// The recurring boilerplate "Purchase Tickets" button that appears in EVERY card.
const BOILERPLATE_ETIX_ID = '51986841'
// Fallback venue (Tangier's main box-office address) when an event states no space.
const DEFAULT_VENUE = { name: 'Tangier', address: '507 S Cleveland Massillon Rd', city: 'Fairlawn', state: 'OH', zip: '44333' }

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
}

/** Title-case a lowercased venue name ("tangier west" → "Tangier West"). */
export function titleCase(s) {
  return String(s || '').trim().toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
}

/** "August 19, 2026" → "2026-08-19", or null. */
export function parseDate(str) {
  const m = String(str || '').match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/)
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  if (month === undefined) return null
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`
}

/** Extract a doors/start time from prose → "HH:MM" (24h), or '' if none stated. */
export function parseDoorsTime(text) {
  const m = String(text || '').match(/doors?\s+open(?:s)?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m/i)
  if (!m) return ''
  let hour = parseInt(m[1], 10)
  const min = m[2] || '00'
  const pm = /p/i.test(m[3])
  if (pm && hour !== 12) hour += 12
  if (!pm && hour === 12) hour = 0
  if (hour > 23) return ''
  return `${String(hour).padStart(2, '0')}:${min}`
}

/**
 * Parse a "…HELD AT <space>: <street> <city>, OH <zip>…" block into a venue.
 * Returns null when no such block is present (caller falls back to DEFAULT_VENUE).
 */
export function parseHeldAt(text) {
  const flat = String(text || '').replace(/\s+/g, ' ')
  const m = flat.match(/HELD AT\s+([A-Za-z][A-Za-z .'&]*?)\s*:?\s+(\d+\s+[^,]+?)\s+([A-Za-z]+),?\s+(?:OH|Ohio)\s+(\d{5})/i)
  if (!m) return null
  return {
    name:    titleCase(m[1]),
    address: titleCase(m[2].replace(/\s+/g, ' ').trim()),
    city:    titleCase(m[3]),
    state:   'OH',
    zip:     m[4],
  }
}

/** All "$NN.NN" amounts in the block → { min, max } (null when none). */
export function parsePrices(text) {
  const nums = [...String(text || '').matchAll(/\$(\d[\d,]*\.\d{2})/g)]
    .map((m) => parseFloat(m[1].replace(/,/g, '')))
    .filter((n) => Number.isFinite(n))
  if (!nums.length) return { min: null, max: null }
  return { min: Math.min(...nums), max: Math.max(...nums) }
}

const lastNonEmpty = (s) => String(s).split('\n').map((l) => l.trim()).filter(Boolean).pop() || null

/**
 * Parse the /events page into event objects.
 *
 * Three independently-extracted, document-ordered lists are zipped by index:
 *   • real Etix ticket links (etix.com/ticket/p/<id>, minus the boilerplate id),
 *   • banner images (…website-files… "Banner"/"bkg" .png), best-effort,
 *   • text blocks from htmlToText, segmented by each "Month DD, YYYY" date line
 *     (title = the line before the date; body = through the next event's title).
 * The ticket links are the authoritative event count; images only attach when
 * their count matches (never mis-associated). Returns [] if nothing parses.
 */
export function parseTangierEvents(html) {
  const raw = String(html || '')

  // 1. Real ticket links (drop the boilerplate), in order, deduped by product id.
  const links = []
  const seenLink = new Set()
  for (const m of raw.matchAll(/etix\.com\/ticket\/p\/(\d+)\/([a-z0-9-]+)/gi)) {
    const id = m[1]
    if (id === BOILERPLATE_ETIX_ID || seenLink.has(id)) continue
    seenLink.add(id)
    links.push({ id, url: `https://www.etix.com/ticket/p/${id}/${m[2]}` })
  }

  // 2. Banner images (best-effort), in order, deduped.
  const images = []
  const seenImg = new Set()
  // Allow parens (a banner filename is "…Banner (1).png") but stop at whitespace/
  // quotes. Keep the URL percent-encoded — a literal space would break <img src>.
  for (const m of raw.matchAll(/https?:\/\/[^\s"']*website-files\.com\/[^\s"']*?(?:banner|bkg)[^\s"']*\.(?:png|jpe?g|webp)/gi)) {
    const u = m[0].split('?')[0]
    if (seenImg.has(u)) continue
    seenImg.add(u)
    images.push(u)
  }

  // 3. Text blocks from the "Upcoming Events" region.
  const text = htmlToText(raw)
  const up = text.search(/Upcoming Events/i)
  const gal = text.search(/Event Gallery/i)
  const region = up === -1 ? text : text.slice(up, gal > up ? gal : undefined)

  const DATE_RE = /[A-Za-z]+\s+\d{1,2},\s*\d{4}/g
  const dates = [...region.matchAll(DATE_RE)]
  const blocks = dates.map((d, i) => {
    const title = lastNonEmpty(region.slice(i === 0 ? 0 : dates[i - 1].index + dates[i - 1][0].length, d.index))
    // body runs from after this date to just before the NEXT event's title line
    let bodyEnd = region.length
    if (i + 1 < dates.length) {
      const nextTitle = lastNonEmpty(region.slice(d.index + d[0].length, dates[i + 1].index))
      const idx = nextTitle ? region.indexOf(nextTitle, d.index) : -1
      bodyEnd = idx === -1 ? dates[i + 1].index : idx
    }
    return { title, date: d[0], body: region.slice(d.index + d[0].length, bodyEnd) }
  })

  // Zip. Ticket links are authoritative; require a title+date to publish.
  const n = Math.min(blocks.length, links.length)
  const imagesAligned = images.length === blocks.length
  const out = []
  for (let i = 0; i < n; i++) {
    const b = blocks[i]
    const dateYmd = parseDate(b.date)
    const title = b.title && decodeEntities(b.title.trim())
    if (!dateYmd || !title) continue
    const venue = parseHeldAt(b.body) || { ...DEFAULT_VENUE }
    const { min, max } = parsePrices(b.body)
    // Description: the body minus the HELD-AT line and the price lines.
    const description = b.body
      .replace(/This EVENT WILL BE HELD AT[\s\S]*?\d{5}/i, '')
      .replace(/\$\d[\d,]*\.\d{2}[^\n]*/g, '')
      .replace(/\n{3,}/g, '\n\n').trim() || null

    out.push({
      title,
      dateYmd,
      time: parseDoorsTime(b.body),
      venue,
      priceMin: min,
      priceMax: max,
      description,
      ticketUrl: links[i].url,
      imageUrl: imagesAligned ? images[i] : null,
      sourceId: `${SOURCE_KEY}-${links[i].id}`,
    })
  }
  return out
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🎭  Starting Tangier ingestion…')
  const start = Date.now()
  try {
    const html = await fetchPage(EVENTS_URL)
    const events = parseTangierEvents(html)
    console.log(`  Parsed ${events.length} event(s)`)
    if (!events.length) throw new Error('No events parsed from thetangier.com/events — page format may have changed')

    const organizerId = await ensureOrganization(ORG_NAME, {
      website: BASE_URL,
      description: 'Akron-area restaurant, banquet, and live-entertainment venue (est. 1960) anchored at Tangier West in Fairlawn.',
    })

    let inserted = 0, skipped = 0
    for (const ev of events) {
      const startIso = easternToIso(ev.dateYmd, ev.time)
      if (!startIso) { skipped++; continue }

      const venueId = await ensureVenue(ev.venue.name, {
        address: ev.venue.address, city: ev.venue.city, state: ev.venue.state, zip: ev.venue.zip,
        website: BASE_URL,
      })
      if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

      const row = {
        title:           ev.title,
        description:     ev.description,
        start_at:        startIso,
        end_at:          null,
        category:        'music',
        tags:            ['tangier', 'music', 'concert', 'nightlife', ev.venue.city.toLowerCase()],
        price_min:       ev.priceMin,
        price_max:       ev.priceMax,
        age_restriction: 'not_specified',
        image_url:       ev.imageUrl,
        ticket_url:      ev.ticketUrl,
        source:          SOURCE_KEY,
        source_id:       ev.sourceId,
        status:          'published',
        featured:        false,
      }

      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) { console.warn(`  ⚠ Upsert failed "${ev.title}": ${error.message}`); skipped++; continue }
      if (venueId)     await linkEventVenue(upserted.id, venueId)
      if (organizerId) await linkEventOrganization(upserted.id, organizerId)
      inserted++
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: events.length, durationMs: Date.now() - start,
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
