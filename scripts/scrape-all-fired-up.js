/**
 * scrape-all-fired-up.js
 *
 * All Fired Up Akron (allfiredupakron.com) — a paint-your-own-pottery, glass
 * fusing, stoneware & mosaic studio at 30 Rothrock Loop, Copley (the Montrose/
 * Fairlawn area, Summit County). Their public "Classes/Events" calendar is NOT
 * on the Wix marketing site; it lives on the Occasion booking platform.
 *
 * Platform: Occasion (getoccasion.com). Two tiers, both server-rendered (a plain
 * fetch() sees them — the only JS-loaded bit is the checkout slot picker):
 *
 *   1. STACK LIST  https://app.getoccasion.com/p/stacks/2668/13945
 *      One card per occurrence (a recurring class repeats as N cards). Each card
 *      is a <div class="… time-slot-list" data-id="YYYYMMDDhhmm…"> whose:
 *        • data-id starts with the Eastern calendar date (YYYYMMDD) then the UTC
 *          start (hhmm) — this is our authoritative, year-bearing date (the
 *          human-visible "Sun, September 13" label carries NO year).
 *        • .title-truncate = title, .text-sm.text-greythree = time range,
 *          .bg-announcement = availability, /p/n/<token> = detail link.
 *      Paginated via a "Load More" <a href="…?start_date=…"> in the raw HTML.
 *
 *   2. DETAIL PAGE  https://app.getoccasion.com/p/n/<token>
 *      Adds the full (untruncated) description, price, image and the <address>.
 *      Multiple date-cards share one token, so we fetch each token once.
 *
 * GEOGRAPHY: the studio is in Copley (Summit). Every event is still routed
 * through the strict Summit gate on its detail <address> city, so an "Off-Site
 * Event" outside the county would be dropped defensively. Non-event products on
 * the same stack (At-Home Kits, Party Pails to-go, gift cards, hiring
 * interviews, waitlists) are filtered by title.
 *
 * Usage:   node scripts/scrape-all-fired-up.js
 *          node scripts/scrape-all-fired-up.js --dry-run
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  stripHtml,
  htmlToText,
  decodeEntities,
  easternToIso,
  easternTodayIso,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  linkOrganizationVenue,
  ensureVenue,
  ensureOrganization,
} from './lib/normalize.js'
import { withBrowser, newConfiguredPage } from './lib/puppeteer.js'
import { classifySummitLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'all_fired_up'
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'

const APP_ORIGIN = 'https://app.getoccasion.com'
const STACK_URL = `${APP_ORIGIN}/p/stacks/2668/13945`
const SITE_URL = 'https://www.allfiredupakron.com'
const PAST_GRACE_MS = 86_400_000
const NAV_TIMEOUT_MS = 45_000

// The fixed studio venue. Every in-studio class pins here; the detail <address>
// is still parsed and gated so an off-site event can't silently inherit it.
const VENUE = {
  name: 'All Fired Up Akron',
  address: '30 Rothrock Loop',
  city: 'Copley',
  state: 'OH',
  zip: '44321',
}

// Titles that are NOT public, dated, in-person happenings — they ride the same
// Occasion stack but must never reach the calendar.
const NON_EVENT_TITLE_RE =
  /at[-\s]?home kit|party pail|parties to go|gift\s*card|\binterview/i

const pad2 = (n) => String(n).padStart(2, '0')

// ── List parsing ─────────────────────────────────────────────────────────────

const cardField = (block, clsToken) => {
  const m = block.match(
    new RegExp(`class="[^"]*${clsToken}[^"]*"[^>]*>([\\s\\S]*?)<\\/`, 'i'),
  )
  return m ? decodeEntities(stripHtml(m[1])).replace(/\s+/g, ' ').trim() : null
}

/**
 * Resolve a card's date to "YYYY-MM-DD". The authoritative source is the
 * data-id, whose first 8 digits are the Eastern calendar date (YYYYMMDD); the
 * visible label ("Sun, September 13") carries no year. Falls back to the label
 * text joined with an inferred year (current Eastern year, rolled forward when
 * the month is earlier than today's) only if the data-id is unusable.
 * Exported for tests.
 */
export function resolveCardDate(dataId, dateText, todayIso = easternTodayIso()) {
  const m = String(dataId || '').match(/^(\d{4})(\d{2})(\d{2})/)
  if (m) {
    const [, y, mo, d] = m
    if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) return `${y}-${mo}-${d}`
  }
  // Fallback: parse "Sun, September 13" and infer the year.
  const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 }
  const lm = String(dateText || '').match(/([A-Za-z]+)\s+(\d{1,2})/)
  if (!lm) return null
  const month = MONTHS[lm[1].toLowerCase()]
  if (!month) return null
  const day = parseInt(lm[2], 10)
  const [ty, tm] = todayIso.split('-').map(Number)
  const year = month < tm ? ty + 1 : ty  // month earlier than today → next year
  return `${year}-${pad2(month)}-${pad2(day)}`
}

/** Extract the START time from a "4:00 PM -  6:00 PM" range. Exported for tests. */
export function parseStartTime(timeText) {
  const m = String(timeText || '').match(/(\d{1,2}:\d{2}\s*[AP]M)/i)
  return m ? m[1].replace(/\s+/g, ' ').toUpperCase() : null
}

/** Extract the END time from a time range, or null. Exported for tests. */
export function parseEndTime(timeText) {
  const all = String(timeText || '').match(/(\d{1,2}:\d{2}\s*[AP]M)/gi)
  return all && all.length > 1 ? all[1].replace(/\s+/g, ' ').toUpperCase() : null
}

/** Parse one stack card block into a raw record, or null. Exported for tests. */
export function parseCard(block) {
  const dataId = (block.match(/data-id="(\d+)"/) || [])[1] || null
  const token = (block.match(/\/p\/n\/([A-Za-z0-9]+)/) || [])[1] || null
  const image = (block.match(/<img[^>]+src="([^"]+)"/i) || [])[1] || null
  const title = cardField(block, 'title-truncate')
  const dateText = cardField(block, 'capitalize')
  const timeM = block.match(/class="text-sm text-greythree"[^>]*>([\s\S]*?)<\/div>/i)
  const timeText = timeM ? decodeEntities(stripHtml(timeM[1])).replace(/\s+/g, ' ').trim() : null
  const badge = cardField(block, 'bg-announcement')
  if (!title || !token) return null
  return { dataId, token, image, title, dateText, timeText, badge }
}

/** Split the stack HTML into per-card blocks and parse each. Exported for tests. */
export function parseStackHtml(html) {
  const raw = String(html || '')
  const idxs = [...raw.matchAll(/class="[^"]*time-slot-list[^"]*"/gi)].map((m) => m.index)
  const cards = []
  for (let i = 0; i < idxs.length; i++) {
    const block = raw.slice(idxs[i], i + 1 < idxs.length ? idxs[i + 1] : raw.length)
    const card = parseCard(block)
    if (card) cards.push(card)
  }
  return cards
}

/** True when a card's title is a non-event product (kit / to-go / interview). */
export function isNonEvent(title) {
  return NON_EVENT_TITLE_RE.test(String(title || ''))
}

// ── Detail parsing ───────────────────────────────────────────────────────────

const meta = (html, prop) => {
  const m = String(html).match(
    new RegExp(`<meta property="${prop}" content="([^"]*)"`, 'i'),
  )
  return m ? decodeEntities(m[1]) : null
}

/**
 * Parse an Occasion detail page for the fields the list can't give us: full
 * description, price, image, canonical URL and the <address> (name/city/zip).
 * Exported for tests.
 */
export function parseDetail(html) {
  const raw = String(html || '')
  const title = meta(raw, 'og:title')
  const ogDesc = meta(raw, 'og:description')
  const description = ogDesc ? decodeEntities(htmlToText(ogDesc)).trim() : null
  const image = meta(raw, 'og:image')
  const url = meta(raw, 'og:url')

  const addrM = raw.match(/<address[^>]*>\s*([\s\S]*?)\s*<\/address>/i)
  let city = null, zip = null, addressLine = null
  if (addrM) {
    const parts = decodeEntities(stripHtml(addrM[1])).replace(/\s+/g, ' ').trim()
      .split(',').map((s) => s.trim()).filter(Boolean)
    // "30 Rothrock Loop, Copley, OH 44321"
    if (parts.length >= 3) {
      addressLine = parts[0]
      city = parts[parts.length - 2]
      const sz = parts[parts.length - 1].match(/([A-Z]{2})\s*(\d{5})?/)
      if (sz) zip = sz[2] || null
    }
  }

  const priceM = raw.match(/Price is\s+([\d.]+)\s*\$/i)
  const price = priceM ? Number(priceM[1]) : null

  return { title, description, image, url, addressLine, city, zip, price }
}

// ── Build row ────────────────────────────────────────────────────────────────

export function mapTags(title) {
  const tags = ['all-fired-up', 'pottery', 'art-class', 'copley', 'summit-county']
  const t = String(title || '').toLowerCase()
  if (/glass|stained glass|fus/.test(t)) tags.push('glass')
  if (/clay|hand.?build/.test(t)) tags.push('clay')
  if (/kid|family|scout/.test(t)) tags.push('family')
  return [...new Set(tags)]
}

/**
 * Build the DB row + venue spec for one card, using the (optional) detail data.
 * Pure. Exported for tests. Returns { skip } or { row, venueSpec }.
 *   skip: 'nonevent' | 'out' | 'nodata'
 */
export function buildRow(card, detail = null, todayIso = easternTodayIso()) {
  if (!card || !card.title || !card.token) return { skip: 'nodata' }
  if (isNonEvent(card.title)) return { skip: 'nonevent' }

  const dateIso = resolveCardDate(card.dataId, card.dateText, todayIso)
  if (!dateIso) return { skip: 'nodata' }

  const startTime = parseStartTime(card.timeText)
  const start_at = easternToIso(dateIso, startTime || '12:00 pm')
  if (!start_at) return { skip: 'nodata' }
  const endTime = parseEndTime(card.timeText)
  const end_at = endTime ? easternToIso(dateIso, endTime) : null

  // Summit gate on the detail address city (studio = Copley = in). With no
  // detail we trust the fixed studio venue (this source IS the studio).
  const city = detail?.city || VENUE.city
  if (classifySummitLocation({ city }) === 'out') return { skip: 'out' }

  const title = (detail?.title || card.title).replace(/\s*\.\s*$/, '').trim()
  const description = detail?.description || null
  const image_url = detail?.image || card.image || null
  const detailUrl = detail?.url || `${APP_ORIGIN}/p/n/${card.token}`
  const soldOut = /sold\s*out/i.test(card.badge || '')

  const venueSpec = detail?.addressLine
    ? { name: VENUE.name, address: detail.addressLine, city: detail.city || VENUE.city, state: 'OH', zip: detail.zip || VENUE.zip }
    : { ...VENUE }

  return {
    venueSpec,
    row: {
      title,
      description,
      start_at,
      end_at,
      category: 'visual-art',
      tags: [...mapTags(title), ...(soldOut ? ['sold-out'] : [])],
      price_min: detail?.price ?? null,
      price_max: null,
      age_restriction: 'not_specified',
      image_url,
      ticket_url: detailUrl,
      source_url: detailUrl,
      source: SOURCE_KEY,
      // One row per occurrence: token repeats across dates, so the date makes it unique.
      source_id: `${card.token}-${dateIso}`,
      status: 'published',
      featured: false,
    },
  }
}

// ── Fetch (headless browser) ─────────────────────────────────────────────────
//
// Occasion's edge hard-403s any plain HTTP client — a full browser header set on
// a residential IP is still rejected, i.e. it fingerprints below the header
// layer (TLS/HTTP2), which only a real browser engine clears. web_fetch and a
// live browser both load the stack fine, so we render it with Puppeteer (the
// repo's established path for bot-gated sources — see lib/puppeteer.js). One
// Chromium is reused for the stack list AND every detail page.

/**
 * Render the stack list, then each unique detail page, in a single browser.
 * Returns { cards, details }. When `withDetails` is false (dry-run) the detail
 * pages are skipped. Exported-shape data feeds the pure buildRow().
 */
async function collect({ withDetails = true } = {}) {
  return withBrowser(async (browser) => {
    const page = await newConfiguredPage(browser)

    await page.goto(STACK_URL, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS })
    // The cards render client-side; wait for at least one before reading.
    await page.waitForSelector('.time-slot-list', { timeout: NAV_TIMEOUT_MS })
    const cards = parseStackHtml(await page.content())

    const details = new Map()
    if (withDetails) {
      for (const token of new Set(cards.map((c) => c.token))) {
        try {
          await page.goto(`${APP_ORIGIN}/p/n/${token}`, {
            waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS,
          })
          details.set(token, parseDetail(await page.content()))
        } catch (err) {
          console.warn(`  ⚠ Detail render failed for ${token}: ${err.message}`)
          details.set(token, null)
        }
      }
    }
    return { cards, details }
  })
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🎨  Starting All Fired Up Akron ingestion…')
  if (DRY_RUN) console.log('   [dry-run mode — fetch + parse only, no DB writes]')
  const start = Date.now()

  try {
    console.log(`\n🔍  Rendering stack ${STACK_URL} (headless browser) …`)
    const { cards, details } = await collect({ withDetails: !DRY_RUN })
    console.log(`  Parsed ${cards.length} occurrence card(s) across ${new Set(cards.map((c) => c.token)).size} unique class(es).`)

    const now = Date.now()
    const built = cards.map((c) => ({ c, ...buildRow(c, details.get(c.token)) }))
    const publishable = built.filter(
      (b) => b.row && new Date(b.row.start_at).getTime() >= now - PAST_GRACE_MS,
    )
    const skippedNon = built.filter((b) => b.skip === 'nonevent').length
    const skippedOut = built.filter((b) => b.skip === 'out').length
    console.log(
      `  ${publishable.length} publishable; ${skippedNon} non-event product(s), ${skippedOut} out-of-county.`,
    )

    if (DRY_RUN) {
      for (const b of built) {
        const tag = b.row ? 'in ' : (b.skip || '???').toUpperCase().slice(0, 3)
        const date = resolveCardDate(b.c.dataId, b.c.dateText)
        console.log(`     [${tag}] ${b.c.title}  (${date} ${parseStartTime(b.c.timeText) || ''}) [${b.c.badge || ''}]`)
      }
      console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s [dry-run]`)
      return
    }

    const organizerId = await ensureOrganization(VENUE.name, {
      website: SITE_URL,
      description:
        'All Fired Up Akron is a paint-your-own-pottery, glass fusing, stoneware ' +
        'and mosaic studio in Copley (Montrose/Fairlawn), offering drop-in painting ' +
        'and a calendar of themed workshops and classes.',
    })
    const venueId = await ensureVenue(VENUE.name, {
      address: VENUE.address, city: VENUE.city, state: VENUE.state, zip: VENUE.zip,
      website: SITE_URL,
    })
    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    let inserted = 0, skipped = 0
    for (const b of publishable) {
      try {
        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(b.row))
        if (error) { console.warn(`  ⚠ Upsert failed "${b.row.title}": ${error.message}`); skipped++; continue }
        if (venueId) await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on "${b.row.title}": ${err.message}`)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skippedNon + skippedOut + skipped, {
      eventsFound: cards.length,
      durationMs: Date.now() - start,
    })
    console.log(
      `\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ` +
      `${inserted} upserted, ${skippedNon} non-event, ${skippedOut} out-of-county, ${skipped} errored`,
    )
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

export { STACK_URL, SITE_URL, VENUE }
