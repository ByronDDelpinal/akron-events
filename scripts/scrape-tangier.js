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
  logUpsertResult, logScraperError, easternToIso, htmlToText, stripHtml, decodeEntities,
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

/**
 * Start time from an event's prose → "HH:MM" (24h), or '' if none stated.
 *
 * These events state the start only in the description ("…lounge at 6:00 pm",
 * "Open Bar from 7 pm", "Doors open at 6:30PM"), so we take the FIRST clock time
 * in the block — the opening/doors time. Returning '' (date-only) is correct
 * when no time is stated; we never fabricate one.
 */
export function parseStartTime(text) {
  const m = String(text || '').match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b/i)
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

/**
 * Parse the /events page into event objects.
 *
 * Anchored on each event's raw <h2> title tag, NOT on the flattened text — on
 * the live page the previous card's inline buttons ("Purchase Tickets",
 * "Reserve A Table", "View Menu") render onto the same text line as the next
 * title with no break, so a "line before the date" heuristic would prepend that
 * button noise to the title (it did: shipped a title of "Purchase Tickets…
 * Halloween Party with Roxxymoron"). Raw <h2> tags delimit titles cleanly.
 *
 * For each event, its block is the HTML between its <h2> and the next event's
 * <h2>; date/venue/price/time/description come from htmlToText(block); the real
 * Etix link (minus the boilerplate id) comes from the block's raw HTML; the
 * banner image is the last event image before this <h2>. Returns [] if nothing
 * parses.
 */
export function parseTangierEvents(html) {
  const raw = String(html || '')

  // Scope to the Upcoming Events region (raw HTML).
  const upIdx = raw.search(/Upcoming Events/i)
  const galIdx = raw.search(/Event Gallery/i)
  const region = upIdx === -1 ? raw : raw.slice(upIdx, galIdx > upIdx ? galIdx : undefined)

  // Event-title <h2>s (drop the section headers), with positions.
  const SECTION = /^(Upcoming Events|Entertainment Schedule|Event Gallery|Events)$/i
  const titles = []
  for (const m of region.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)) {
    const t = decodeEntities(stripHtml(m[1])).trim()
    if (!t || SECTION.test(t)) continue
    titles.push({ text: t, start: m.index, end: m.index + m[0].length })
  }

  // Event banner images (…website-files… "Banner"/"bkg"), positioned; parens
  // allowed (filename "…Banner (1).png") but URL kept percent-encoded.
  const banners = []
  for (const m of region.matchAll(/https?:\/\/[^\s"']*website-files\.com\/[^\s"']*?(?:banner|bkg)[^\s"']*\.(?:png|jpe?g|webp)/gi)) {
    banners.push({ url: m[0].split('?')[0], idx: m.index })
  }
  const imageBefore = (pos) => {
    let best = null
    for (const b of banners) { if (b.idx < pos) best = b.url; else break }
    return best
  }

  const out = []
  for (let i = 0; i < titles.length; i++) {
    const blockHtml = region.slice(titles[i].end, i + 1 < titles.length ? titles[i + 1].start : region.length)
    const blockText = htmlToText(blockHtml)

    const dateYmd = parseDate((blockText.match(/[A-Za-z]+\s+\d{1,2},\s*\d{4}/) || [])[0])
    if (!dateYmd) continue

    // Real Etix ticket link in this block (skip the boilerplate id).
    let ticket = null
    for (const lm of blockHtml.matchAll(/etix\.com\/ticket\/p\/(\d+)\/([a-z0-9-]+)/gi)) {
      if (lm[1] === BOILERPLATE_ETIX_ID) continue
      ticket = { id: lm[1], url: `https://www.etix.com/ticket/p/${lm[1]}/${lm[2]}` }
      break
    }
    if (!ticket) continue

    const venue = parseHeldAt(blockText) || { ...DEFAULT_VENUE }
    const { min, max } = parsePrices(blockText)
    const description = blockText
      .replace(/This EVENT WILL BE HELD AT[\s\S]*?\d{5}/i, '')
      .replace(/\$\d[\d,]*\.\d{2}[^\n]*/g, '')
      .replace(/\b(?:Purchase Tickets|Reserve A Table|View Menu)\b/gi, '')
      .replace(/[A-Za-z]+\s+\d{1,2},\s*\d{4}/, '')
      .replace(/\n{3,}/g, '\n\n').trim() || null

    out.push({
      title:      titles[i].text,
      dateYmd,
      time:       parseStartTime(blockText),
      venue,
      priceMin:   min,
      priceMax:   max,
      description,
      ticketUrl:  ticket.url,
      imageUrl:   imageBefore(titles[i].start),
      sourceId:   `${SOURCE_KEY}-${ticket.id}`,
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
