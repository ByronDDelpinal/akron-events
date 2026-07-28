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
 * <space>: <address>" block → description → prices → ticket buttons. Four
 * gotchas this parser handles:
 *   1. Every event card carries a BOILERPLATE "Purchase Tickets" button pointing
 *      at one recurring Etix product (id 51986841, the Disco Inferno NYE at The
 *      Bank). The event's REAL ticket link is a different etix.com/ticket/p/<id>
 *      — we drop id 51986841 and keep the rest, in document order.
 *   2. Times live only in prose ("Doors open at 6:30PM"); we look for a doors /
 *      showtime CUE first and only fall back to the first clock time on the
 *      card, so an UNCUED time (box-office hours, an on-sale date, a set time)
 *      can never outrank a cued one — see parseStartTime for what the cue does
 *      NOT buy us. With no time stated at all we publish date-only, never a
 *      fabricated one.
 *   3. The CTA buttons sit in sibling <div>s, and htmlToText does not newline
 *      </div>, so they flatten into one unseparated run at the end of the block
 *      ("Purchase TicketsReserve A TableView MenuPurchase Tickets") — see
 *      cleanDescription for why \b-anchored stripping can never match it.
 *   4. Webflow richtext spacer paragraphs (<p>&zwj;</p>) leave invisible
 *      zero-width joiners mid-description; cleanDescription removes them.
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

// A clock time: "6", "6:30", "6:00 pm", "6:30PM", "7 p.m.".
const CLOCK_SRC = String.raw`(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\b`
// Phrases that introduce the DOORS/START time, as opposed to an UNCUED clock
// time on the card (set times, box-office hours, on-sale dates). A cued buffet
// time is NOT excluded — see parseStartTime.
// The leading \b matters: without it "Concert restarts at 9 pm" matches the
// bare "starts at" alternative mid-word and beats a later, real doors cue.
const START_CUE_SRC = String.raw`\b(?:doors?\s+(?:will\s+)?opens?(?:\s+at)?|show(?:time)?\s+(?:starts?\s+)?at|(?:starts?|begins?)\s+at|open\s+bar\s+from|lounge\s+(?:opens?\s+)?at)`
const CUED_TIME = new RegExp(`${START_CUE_SRC}\\s*(?:promptly\\s+)?${CLOCK_SRC}`, 'i')
const ANY_TIME  = new RegExp(CLOCK_SRC, 'i')

/**
 * Start time from an event's prose → "HH:MM" (24h), or '' if none stated.
 *
 * These events state the start only in the description ("…lounge at 6:00 pm",
 * "Open Bar from 7 pm", "Doors open at 6:30PM"). Taking the first clock time
 * anywhere in the block is fragile: a card that opened with "box office opens
 * at 10 am" or listed an on-sale date first would publish that as the start.
 * So we look for a START CUE first — alternation makes JS pick the LEFTMOST
 * cue, which is the earliest stated opening (Frankie states "lounge at 6:00 pm"
 * before "dinner will start at 7:00 pm", and 6:00 pm is the right answer) — and
 * only fall back to the first clock time when no cue is present.
 *
 * The cue NARROWS the failure mode; it does not eliminate it. "starts at" /
 * "begins at" are themselves cues, so "The buffet starts at 5:30 pm. Doors open
 * at 7 pm." yields 17:30, not 19:00 — the leftmost cue wins and the phrase
 * ahead of it is not inspected. That is a deliberate trade: dropping the bare
 * "starts at" alternative would lose the only cue covering "the show begins at
 * 8 pm", and for these dinner-show cards the buffet time is in practice when
 * the doors are useful anyway. What the cue reliably buys us is that an UNCUED
 * time (a box-office hour, a set time, an on-sale date) can never outrank a
 * cued one.
 *
 * Returning '' (date-only) is correct when no time is stated; we never
 * fabricate one.
 */
export function parseStartTime(text) {
  const s = String(text || '')
  const m = s.match(CUED_TIME) || s.match(ANY_TIME)
  if (!m) return ''
  let hour = parseInt(m[1], 10)
  const min = m[2] || '00'
  const pm = /p/i.test(m[3])
  if (pm && hour !== 12) hour += 12
  if (!pm && hour === 12) hour = 0
  if (hour > 23) return ''
  return `${String(hour).padStart(2, '0')}:${min}`
}

// ── Description scrubbing ────────────────────────────────────────────────────
//
// Every card ends with the same inline CTA buttons. They live in sibling
// <div>s, and htmlToText does NOT newline </div>, so they flatten into ONE
// unbroken run with no separator at all:
//     "Purchase TicketsReserve A TableView MenuPurchase Tickets"
// The previous scrubber wrapped the alternation in \b, which can never match
// here: every boundary position sits between two word characters (s→R, e→V,
// u→P, and the leading one on the final "Purchase"), so the scrubber silently
// did nothing and the run shipped into every description.
//
// Dropping \b alone would be an over-match: "purchase tickets" is ordinary
// prose for a venue ("Purchase tickets at the box office"), and a global
// case-insensitive replace would gut a legitimate sentence mid-clause. So we
// only strip the two shapes that cannot be prose:
//   1. two or more labels glued together with no separator — a machine artifact;
//   2. a run of labels at the very END of the block, which is where the button
//      row always sits (the block ends at the next card's <h2>).
// A "purchase tickets" inside a real sentence is left alone.
const BUTTON_LABEL_SRC = String.raw`(?:Purchase Tickets|Reserve A Table|View Menu)`
const GLUED_BUTTONS    = new RegExp(`${BUTTON_LABEL_SRC}{2,}`, 'gi')
const TRAILING_BUTTONS = new RegExp(`(?:\\s*${BUTTON_LABEL_SRC})+\\s*$`, 'i')
// Webflow richtext emits spacer paragraphs holding a single zero-width joiner
// (<p>&zwj;</p>), which land as an invisible "\n\n\u200D\n\n" mid-description.
// They also turn up glued between the CTA buttons, where they are load-bearing
// for the scrubbers below — see cleanDescription for why this strip runs first.
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g

/**
 * Block text → a clean description, or null when nothing is left.
 *
 * ZERO_WIDTH runs FIRST, ahead of everything that pattern-matches. JS `\s` does
 * NOT include U+200B–U+200D or U+2060 (of the zero-width set only U+FEFF is
 * whitespace), so a joiner left in place defeats BOTH button scrubbers:
 * GLUED_BUTTONS needs literal adjacency, and TRAILING_BUTTONS's `\s*` cannot
 * step over one. A single ZWJ between two buttons — the same character Webflow
 * already emits elsewhere in this document — would otherwise ship a
 * half-stripped run ("Purchase TicketsReserve A Table"). Stripping invisible
 * characters is a normalization pass, so it belongs before the matchers, not
 * among them.
 *
 * The `\n{3,}` collapse stays LAST, which is what lets an emptied spacer
 * paragraph close to a single blank line instead of leaving "\n\n\n\n".
 */
export function cleanDescription(blockText) {
  return String(blockText || '')
    .replace(ZERO_WIDTH, '')
    .replace(/This EVENT WILL BE HELD AT[\s\S]*?\d{5}/i, '')
    .replace(/\$\d[\d,]*\.\d{2}[^\n]*/g, '')
    .replace(GLUED_BUTTONS, '')
    .replace(TRAILING_BUTTONS, '')
    .replace(/[A-Za-z]+\s+\d{1,2},\s*\d{4}/, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim() || null
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
    const description = cleanDescription(blockText)

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
