/**
 * scrape-community-legal-aid.js
 *
 * Community Legal Aid (communitylegalaid.org) — a nonprofit law firm serving
 * central northeast Ohio with free legal clinics and community events.
 *
 * Platform: Drupal 10. The /events list is server-rendered (plain fetch() sees
 * it) and paginated (?page=0,1,2,…). Each event is a clean, per-field block:
 *   <div class="item"><a class="wrap" href="/events/<slug>">
 *     <h4 class="title">…</h4>
 *     <div class="date">Aug 25, 2026</div>
 *     <div class="time">9 a.m. to noon</div>
 *     <div class="location">Venue, Street, City</div>
 *   </a></div>
 *
 * GEOGRAPHY (this source is mostly OUT of scope): Community Legal Aid covers
 * Summit, Portage, Stark, Medina, Wayne, Columbiana and more. Most clinics are
 * in Canton/Alliance (Stark), Medina, Ravenna (Portage), or are "Online". Only
 * the events physically in Summit County (Akron, Stow, Twinsburg, …) publish —
 * every event is gated on its parsed city via classifySummitLocation; out-of-
 * county and location-less "Online" clinics are dropped.
 *
 * All clinics are free (price 0). One event per occurrence: recurring clinics
 * reuse the same detail URL across dates, so the source_id carries the date.
 *
 * Usage:   node scripts/scrape-community-legal-aid.js
 *          node scripts/scrape-community-legal-aid.js --dry-run
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  stripHtml,
  decodeEntities,
  easternToIso,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
} from './lib/normalize.js'
import { fetchWithRetry } from './lib/http.js'
import { classifySummitLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'community_legal_aid'
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'

const ORIGIN = 'https://www.communitylegalaid.org'
const EVENTS_URL = `${ORIGIN}/events`
const MAX_PAGES = 6                 // safety cap on pagination
const PAST_GRACE_MS = 86_400_000

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}
const pad2 = (n) => String(n).padStart(2, '0')

const field = (block, cls) => {
  const m = block.match(new RegExp(`class="${cls}"[^>]*>([\\s\\S]*?)<\\/`, 'i'))
  return m ? decodeEntities(stripHtml(m[1])).replace(/\s+/g, ' ').trim() : null
}

/** Parse "Aug 25, 2026" → "YYYY-MM-DD" or null. Exported for tests. */
export function parseDate(raw) {
  const m = String(raw || '').match(/([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(20\d\d)/)
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase().slice(0, 3)]
  if (!month) return null
  return `${m[3]}-${pad2(month)}-${pad2(parseInt(m[2], 10))}`
}

/**
 * Parse a messy time string to a normalized "h:mm am|pm" START time.
 *   "9 a.m. to noon"      → "9:00 am"
 *   "1:00 - 4:00 PM"      → "1:00 pm"   (start inherits the end meridiem)
 *   "9:00 AM - 12:00 PM"  → "9:00 am"
 *   "7:45 to 9 a.m."      → "7:45 am"
 * Exported for tests. Returns null when no time is present.
 */
export function parseStartTime(raw) {
  const s = String(raw || '').toLowerCase()
    .replace(/\bnoon\b/g, '12:00 pm')
    .replace(/\bmidnight\b/g, '12:00 am')
    .replace(/a\.m\./g, 'am')
    .replace(/p\.m\./g, 'pm')

  const TOKEN = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/g
  const toks = []
  let m
  while ((m = TOKEN.exec(s)) && toks.length < 4) {
    toks.push({ h: parseInt(m[1], 10), min: m[2] ? parseInt(m[2], 10) : 0, mer: m[3] || null })
  }
  if (!toks.length) return null

  const start = toks[0]
  let mer = start.mer
  if (!mer) {
    const later = toks.slice(1).find((t) => t.mer)
    if (later) {
      mer = later.mer
      // Inheriting PM can flip a morning start past the end (e.g. "11 to 1 pm"
      // is 11am–1pm, not 11pm–1pm) — if so, the start is AM.
      if (mer === 'pm' && start.h !== 12) {
        const start24 = start.h + 12
        const end24 = later.mer === 'pm' ? (later.h === 12 ? 12 : later.h + 12) : (later.h === 12 ? 0 : later.h)
        if (start24 > end24) mer = 'am'
      }
    } else {
      mer = 'am'
    }
  }
  return `${start.h}:${pad2(start.min)} ${mer}`
}

/**
 * Parse a "Venue, Street, City[, Ohio ZIP]" location string. Returns
 * { online } for virtual events, else { name, address, city, state, zip }.
 * Exported for tests.
 */
export function parseLocation(raw) {
  const s = stripHtml(String(raw || '')).replace(/\s+/g, ' ').trim().replace(/,\s*$/, '')
  if (!s) return null
  if (/^online\b/i.test(s)) return { online: true }

  const segs = s.split(',').map((t) => t.trim()).filter(Boolean)
  // Capture then drop a trailing "Ohio 44224" / "OH 44224" / bare zip segment.
  const lastSeg = segs[segs.length - 1] || ''
  const zip = (lastSeg.match(/\b(\d{5})\b/) || [])[1] || null
  if (/^(ohio|oh)\b/i.test(lastSeg) || /^\d{5}/.test(lastSeg)) segs.pop()

  const city = segs[segs.length - 1] || null
  const name = segs[0] || null
  const address = segs.slice(1, -1).find((p) => /^\d/.test(p)) || null
  return { online: false, name, address, city, state: 'OH', zip }
}

/**
 * Parse one `class="item"` block into a raw event, or null. Exported for tests.
 */
export function parseItem(block) {
  const title = field(block, 'title')
  const dateStr = parseDate(field(block, 'date'))
  if (!title || !dateStr) return null
  const startTime = parseStartTime(field(block, 'time'))
  const location = parseLocation(field(block, 'location'))
  const hrefM = block.match(/<a[^>]+class="wrap"[^>]*href="([^"]+)"/i) || block.match(/href="([^"]+)"/i)
  const href = hrefM ? hrefM[1] : null
  const slug = href ? href.replace(/^https?:\/\/[^/]+/, '').replace(/^\/+|\/+$/g, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase() : null
  return { title, dateStr, startTime, location, href, slug }
}

/** Split the list HTML into per-item blocks and parse each. Exported for tests. */
export function parseEventsHtml(html) {
  const raw = String(html || '')
  const idxs = [...raw.matchAll(/class="item"/gi)].map((m) => m.index)
  const items = []
  for (let i = 0; i < idxs.length; i++) {
    const block = raw.slice(idxs[i], i + 1 < idxs.length ? idxs[i + 1] : raw.length)
    const item = parseItem(block)
    if (item) items.push(item)
  }
  return items
}

/**
 * Build the DB row + venue spec, or a skip reason. Pure. Exported for tests.
 * Returns { skip: 'out'|'online'|'nodata' } or { row, venueSpec }.
 */
export function buildRow(item) {
  if (!item || !item.title || !item.dateStr) return { skip: 'nodata' }
  const loc = item.location
  if (!loc || loc.online) return { skip: 'online' }

  const geo = classifySummitLocation({ city: loc.city })
  if (geo !== 'in') return { skip: 'out' }   // strict: regional org, only Summit publishes

  const start_at = easternToIso(item.dateStr, item.startTime || '9:00 am')
  if (!start_at) return { skip: 'nodata' }

  const citySlug = (loc.city || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

  return {
    venueSpec: { name: loc.name, address: loc.address, city: loc.city, state: 'OH', zip: loc.zip || null },
    row: {
      title: item.title,
      description: 'Free legal clinic hosted by Community Legal Aid. Open to eligible ' +
        'low-income residents; walk-ins welcome unless noted.',
      start_at,
      end_at: null,
      category: 'civic',
      tags: ['legal-aid', 'legal', 'clinic', 'free', citySlug, 'summit-county'].filter(Boolean),
      price_min: 0,
      price_max: 0,
      age_restriction: 'all_ages',
      image_url: null,
      ticket_url: item.href ? (item.href.startsWith('http') ? item.href : `${ORIGIN}${item.href}`) : EVENTS_URL,
      source_url: item.href ? (item.href.startsWith('http') ? item.href : `${ORIGIN}${item.href}`) : EVENTS_URL,
      source: SOURCE_KEY,
      source_id: `${item.slug || 'cla'}-${item.dateStr}`,
      status: 'published',
      featured: false,
    },
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchAllPages() {
  const all = []
  const seen = new Set()
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = page === 0 ? EVENTS_URL : `${EVENTS_URL}?page=${page}`
    const res = await fetchWithRetry(url, { headers: { Accept: 'text/html' } })
    if (!res.ok) throw new Error(`Events page ${page} HTTP ${res.status}`)
    const html = await res.text()
    const items = parseEventsHtml(html)
    if (!items.length) break
    let added = 0
    for (const it of items) {
      const key = `${it.slug}-${it.dateStr}`
      if (seen.has(key)) continue
      seen.add(key)
      all.push(it)
      added++
    }
    // Stop when a page adds nothing new (last page repeats or pagination ended).
    if (added === 0) break
    await new Promise((r) => setTimeout(r, 200))
  }
  return all
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('⚖️  Starting Community Legal Aid ingestion…')
  if (DRY_RUN) console.log('   [dry-run mode — fetch + parse only, no DB writes]')
  const start = Date.now()

  try {
    console.log(`\n🔍  Fetching ${EVENTS_URL} (paginated)…`)
    const items = await fetchAllPages()
    console.log(`  Parsed ${items.length} event(s) across pages.`)

    const now = Date.now()
    const built = items.map((it) => ({ it, ...buildRow(it) }))
    const publishable = built.filter((b) => b.row && new Date(b.row.start_at).getTime() >= now - PAST_GRACE_MS)
    const droppedOut = built.filter((b) => b.skip === 'out' || b.skip === 'online').length
    console.log(`  ${publishable.length} in-Summit event(s); ${droppedOut} out-of-county/online dropped.`)

    if (DRY_RUN) {
      for (const b of built) {
        const tag = b.row ? 'in ' : (b.skip === 'out' ? 'OUT' : b.skip === 'online' ? 'ONL' : '???')
        console.log(`     [${tag}] ${b.it.title}  (${b.it.dateStr} ${b.it.startTime || ''}) @ ${b.it.location?.city || b.it.location?.online && 'Online' || '?'}`)
      }
      console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s [dry-run]`)
      return
    }

    const organizerId = await ensureOrganization('Community Legal Aid', {
      website: ORIGIN,
      description:
        'Community Legal Aid is a nonprofit law firm serving the legal needs of ' +
        'low-income individuals and families in central northeast Ohio, offering ' +
        'free legal clinics and community education.',
    })

    const venueCache = new Map()
    let inserted = 0, skipped = 0
    for (const { row, venueSpec } of publishable) {
      try {
        let venueId = null
        if (venueSpec?.name) {
          if (venueCache.has(venueSpec.name)) venueId = venueCache.get(venueSpec.name)
          else {
            // allowGenericName: these are real institutions (Municipal Court,
            // Library, Church, Foodbank) that arrive WITH a street address, but
            // the junk-name guard false-positives on names ending in a street
            // suffix ("…Court"). This is a curated first-party source, so opt out.
            venueId = await ensureVenue(venueSpec.name, {
              address: venueSpec.address || undefined,
              city: venueSpec.city,
              state: venueSpec.state,
              zip: venueSpec.zip || undefined,
            }, { allowGenericName: true })
            venueCache.set(venueSpec.name, venueId)
            if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)
          }
        }
        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed "${row.title}": ${error.message}`); skipped++; continue }
        if (venueId) await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on "${row.title}": ${err.message}`)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: publishable.length,
      durationMs: Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — inserted ${inserted}, skipped ${skipped}`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
