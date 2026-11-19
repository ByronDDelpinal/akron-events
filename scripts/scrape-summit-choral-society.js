/**
 * scrape-summit-choral-society.js — Summit Choral Society
 * (summitchoralsociety.org), Akron's children's choir program and
 * Metropolitan Chorus.
 *
 * The society's own season page is a collage: titles are partly in images
 * and public concerts sit beside private and invitation-only dates, so it
 * cannot be read reliably. What it does have is a "purchase tickets" link
 * for each public concert, to the society's ticket pages on Purplepass, and
 * each of those pages carries schema.org Event data: name, start and end
 * with their UTC offset, venue with street address, and price.
 *
 * So: the season page is used only to DISCOVER ticket links, and every fact
 * in a listing comes from the ticket page's structured data. A concert the
 * society does not sell through a ticket link is not listed. That is the
 * right way round: private and invitation-only dates have no ticket link.
 *
 * Checks: the organizer named in the data must be the society; a cancelled
 * or postponed event is skipped; a venue outside Summit County is skipped.
 *
 * Usage:
 *   node scripts/scrape-summit-choral-society.js
 *   node scripts/scrape-summit-choral-society.js --dry-run
 */
import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { decodeEntities, stripHtml, clampChars } from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'
import { runPlannedScraper, isDryRun } from './lib/planned-run.js'
import { classifySummitLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'summit_choral_society'
const ORIGIN = 'https://www.summitchoralsociety.org'
export const DISCOVERY_URLS = [`${ORIGIN}/season-events.html`, `${ORIGIN}/christmas-candlelights.html`]
const TICKET_RE = /https:\/\/www\.purplepass\.com\/events\/(\d+)-[a-z0-9-]+/gi
const MAX_DESCRIPTION = 3000
const PAGE_DELAY_MS = 300
const DAY_MS = 86_400_000

const ORG = {
  name: 'Summit Choral Society',
  details: { website: ORIGIN, description: "Akron choral organization with a children's choir program and the adult Metropolitan Chorus." },
}

/** Ticket links on a society page → [{ id, url }], de-duplicated, in page order. */
export function findTicketLinks(html = '') {
  const out = []
  const seen = new Set()
  for (const m of decodeEntities(String(html)).matchAll(TICKET_RE)) {
    if (seen.has(m[1])) continue
    seen.add(m[1])
    out.push({ id: m[1], url: m[0] })
  }
  return out
}

/**
 * The schema.org Event on a ticket page, or null. The site writes raw line
 * breaks inside JSON strings, which strict JSON forbids, so control
 * characters are replaced with spaces before parsing.
 */
export function readEvent(html = '') {
  for (const m of String(html).matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1].replace(/\p{Cc}+/gu, ' '))
      const found = (Array.isArray(data) ? data : [data]).find((d) => d?.['@type'] === 'Event')
      if (found) return found
    } catch { /* not this block */ }
  }
  return null
}

export function categoriesFor() { return ['music'] }

/** One ticket page's Event → { row, venue } or { skip }. */
export function buildRow(link, ev) {
  if (!link?.id || !ev?.name) return { skip: 'invalid' }
  if (!/summit choral/i.test(ev.organizer?.name ?? '')) return { skip: 'other_organizer' }
  if (/Cancelled|Postponed/i.test(ev.eventStatus ?? '')) return { skip: 'cancelled' }
  const start = Date.parse(ev.startDate ?? '')
  if (Number.isNaN(start)) return { skip: 'undatable' }
  const end = Date.parse(ev.endDate ?? '')
  const address = ev.location?.address ?? {}
  const city = address.addressLocality ?? null
  if (city && classifySummitLocation({ city }) === 'out') return { skip: 'out_of_county' }
  const prices = (Array.isArray(ev.offers) ? ev.offers : [ev.offers]).map((o) => Number(o?.price)).filter((n) => Number.isFinite(n))
  const performers = (Array.isArray(ev.performer) ? ev.performer : []).map((p) => p?.name).filter(Boolean)
  const about = clampChars(stripHtml(decodeEntities(String(ev.description ?? ''))).replace(/\s+/g, ' ').trim(), MAX_DESCRIPTION)
  const intro = `A Summit Choral Society concert${performers.length ? ` featuring ${performers.join(' and ')}` : ''}.`
  const venueName = ev.location?.name ? String(ev.location.name).trim() : null
  return {
    row: {
      title: String(ev.name).trim(),
      description: about ? `${intro}\n\n${about}` : intro,
      start_at: new Date(start).toISOString(),
      end_at: !Number.isNaN(end) && end > start ? new Date(end).toISOString() : null,
      categories: categoriesFor(),
      tags: ['choral', 'choir', 'concert', 'akron'],
      price_min: prices.length ? Math.min(...prices) : null,
      price_max: prices.length ? Math.max(...prices) : null,
      age_restriction: 'all_ages',
      image_url: typeof ev.image === 'string' ? ev.image : (Array.isArray(ev.image) ? ev.image[0] : null) ?? null,
      ticket_url: link.url,
      source: SOURCE_KEY,
      source_id: link.id,
      status: 'published',
      featured: false,
    },
    venue: venueName
      ? { name: venueName, details: { ...(address.streetAddress ? { address: String(address.streetAddress).trim() } : {}), ...(city ? { city } : {}), state: address.addressRegion ?? 'OH', ...(address.postalCode ? { zip: String(address.postalCode) } : {}) } }
      : null,
  }
}

const pause = (ms) => (ms ? new Promise((r) => setTimeout(r, ms)) : null)

export async function collect({ fetchImpl, now = Date.now, delayMs = PAGE_DELAY_MS } = {}) {
  const links = []
  const seen = new Set()
  let reached = 0
  for (const url of DISCOVERY_URLS) {
    try {
      const res = await fetchWithRetry(url, { headers: { Accept: 'text/html' }, fetchImpl })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      reached++
      for (const l of findTicketLinks(await res.text())) if (!seen.has(l.id)) { seen.add(l.id); links.push(l) }
    } catch (err) {
      console.warn(`  ⚠ ${url} failed: ${err.message}`)
    }
  }
  if (!reached) throw new Error('None of the Summit Choral Society pages could be read')
  const rows = []
  const skipped = {}
  const skip = (reason) => { skipped[reason] = (skipped[reason] ?? 0) + 1 }
  const earliest = now() - DAY_MS
  for (const link of links) {
    let ev
    try {
      await pause(delayMs)
      const res = await fetchWithRetry(link.url, { headers: { Accept: 'text/html' }, fetchImpl })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      ev = readEvent(await res.text())
    } catch (err) {
      console.warn(`  ⚠ Ticket page failed (${link.url}): ${err.message}`)
      skip('ticket_page_failed')
      continue
    }
    if (!ev) { skip('no_event_data'); continue }
    const built = buildRow(link, ev)
    if (built.skip) { skip(built.skip); continue }
    if (Date.parse(built.row.start_at) < earliest) { skip('past'); continue }
    rows.push(built)
  }
  return { found: links.length, rows, skipped }
}

export function run({ dryRun = false, fetchImpl, now, delayMs } = {}) {
  return runPlannedScraper({
    source: SOURCE_KEY, label: 'Summit Choral Society', emoji: '🎶', org: ORG, homeVenue: null,
    collect: () => collect({ fetchImpl, now, delayMs }), dryRun, emptyIsError: false,
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await run({ dryRun: isDryRun() })
  if (result.exitCode) process.exit(result.exitCode)
}
