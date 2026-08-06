/**
 * scrape-village-of-peninsula.js
 *
 * Village of Peninsula, Ohio (Summit County) — Modern Events Calendar (MEC)
 * WordPress plugin, server-rendered.
 *
 * The events archive at villageofpeninsula-oh.gov/events/ renders each event as
 * a server-side MEC card (`<div class="mec-topsec">`) — confirmed present in a
 * plain fetch() (no JavaScript needed), unlike the JS-injected Downtown CF list.
 * Each card carries:
 *   • title      — <h3 class="mec-event-title"><a href=".../events/<slug>/">…</a>
 *   • date label — <span class="mec-start-date-label">06 Aug</span>  (day + month
 *                  abbrev, NO year)
 *   • start time — <span class="mec-start-time">4:00 pm</span>
 *   • end time   — <span class="mec-end-time">6:00 pm</span>        (optional)
 * The YEAR comes from the `<h5>August 2026</h5>` month heading that precedes each
 * month's cards; we track the most recent heading in document order and stamp it
 * onto every card beneath it.
 *
 * This is a VILLAGE GOVERNMENT calendar, so — like the Richfield Township and
 * CivicPlus municipal scrapers — the feed is a mix of genuine community events
 * and governance rows (Planning Commission / Council / Zoning meetings, public
 * hearings). We drop the governance rows via MEETING_RE and keep the public
 * events. The list cards do not carry a per-event location, so every resolved
 * event is pinned to a village-wide "Village of Peninsula" venue (Peninsula is a
 * Summit County village) and routed through the strict Summit gate defensively.
 *
 * Usage:
 *   node scripts/scrape-village-of-peninsula.js
 *   node scripts/scrape-village-of-peninsula.js --dry-run   # fetch + parse only
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY  — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  stripHtml,
  decodeEntities,
  inferCategory,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'
import { classifySummitLocation } from './lib/summit-county.js'

// ── Constants ────────────────────────────────────────────────────────────────

export const SOURCE_KEY = 'village_of_peninsula'
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'

const ORIGIN = 'https://villageofpeninsula-oh.gov'
const EVENTS_URL = `${ORIGIN}/events/`

// 1 day of grace so same-day events stay visible until midnight ET.
const PAST_GRACE_MS = 86_400_000
// 365-day forward horizon — municipal calendars post a year out.
const HORIZON_DAYS = 365

// A village government calendar: drop board / commission / council meetings,
// public hearings, and work sessions the same way the Richfield Township and
// CivicPlus municipal scrapers do.
const MEETING_RE = new RegExp(
  [
    'planning commission', 'zoning commission', 'zoning appeals?',
    'board of zoning', 'village council', 'city council', '\\bcouncil\\b',
    '\\bcommission\\b', '\\bcommittee\\b', 'work session', 'public hearing',
    'executive session', '\\bcaucus\\b', 'board of trustees', '\\btrustees?\\b',
    '\\bmeeting\\b',
  ].join('|'),
  'i',
)

// Office-closure / cancellation markers left in place by the plugin.
const CLOSURE_RE = /offices?\s+closed/i
const CANCELLED_RE = /\bcancel?led\b|\bpostponed\b/i

// If a real future event ever ships without a start time, fall back to noon ET.
// A midnight default is unsafe: the digest/API filter is `.gte('start_at', now)`
// with no grace window, so a 00:00 start silently drops the event mid-day.
// SANCTIONED-DEFAULT-TIME.
const DEFAULT_START_TIME = '12:00 pm'

const MONTH_NUM = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

// ── Venue ────────────────────────────────────────────────────────────────────
//
// The list cards carry no per-event location, so every event resolves to the
// village-wide default venue, city pinned to the Summit-County village.
const VENUE = {
  name: 'Village of Peninsula',
  address: '1582 Main Street',
  city: 'Peninsula',
  state: 'OH',
  zip: '44264',
}

// ── Non-event filter ─────────────────────────────────────────────────────────

/**
 * True when a card title is a genuine public community event (not a governance
 * meeting, office closure, or cancellation). Exported for tests.
 */
export function isPublicEvent(title) {
  const t = stripHtml(String(title || '')).replace(/\s+/g, ' ').trim().toLowerCase()
  if (!t) return false
  if (CANCELLED_RE.test(t)) return false
  if (CLOSURE_RE.test(t)) return false
  if (MEETING_RE.test(t)) return false
  return true
}

// ── HTML parsing ─────────────────────────────────────────────────────────────

/**
 * Slugify a title into a stable id fragment (fallback when the card carries no
 * /events/<slug>/ href). Exported for tests.
 */
export function slugifyTitle(title) {
  return stripHtml(String(title || ''))
    .toLowerCase()
    .replace(/&[a-z]+;/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * Parse one MEC card block into a raw event object (no DB access, no time math).
 * Returns null when the block lacks a title or a date label. Exported for tests.
 */
export function parseCard(block, year) {
  const titleM = block.match(/mec-event-title[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i)
  if (!titleM) return null
  const title = decodeEntities(stripHtml(titleM[1])).replace(/\s+/g, ' ').trim()
  if (!title) return null

  const dateM = block.match(/mec-start-date-label[^>]*>\s*(\d{1,2})\s+([A-Za-z]{3,9})/i)
  if (!dateM) return null
  const day = parseInt(dateM[1], 10)
  const month = MONTH_NUM[dateM[2].toLowerCase().slice(0, 3)]
  if (!month || !day) return null

  const slugM = block.match(/\/events\/([a-z0-9][a-z0-9-]*)\/?/i)
  const slug = slugM ? slugM[1] : slugifyTitle(title)

  const startM = block.match(/mec-start-time[^>]*>\s*([\d:]+\s*[ap]\.?m\.?)/i)
  const endM = block.match(/mec-end-time[^>]*>\s*([\d:]+\s*[ap]\.?m\.?)/i)

  const descM = block.match(/mec-event-description[^>]*>([\s\S]*?)<\/div>/i)
  const description = descM
    ? (decodeEntities(stripHtml(descM[1])).replace(/\s+/g, ' ').trim() || null)
    : null

  return {
    title,
    slug,
    year,
    month,
    day,
    startTime: startM ? startM[1].trim() : null,
    endTime: endM ? endM[1].trim() : null,
    description,
  }
}

/**
 * Parse the events archive HTML into raw card objects. Establishes each card's
 * year from the most recent `<h5>Month YYYY</h5>` heading in document order,
 * then splits the body into per-card blocks on `class="mec-topsec"`.
 * `fallbackYear` stamps any card that appears before the first heading.
 * Exported for tests.
 */
export function parseEventsHtml(html, fallbackYear = new Date().getFullYear()) {
  if (!html || typeof html !== 'string') return []

  // Month/year headings, positioned so we can look up the year for any card.
  const HEAD_RE = new RegExp(
    '<h[1-6][^>]*>\\s*(January|February|March|April|May|June|July|' +
      'August|September|October|November|December)\\s+(20\\d\\d)\\s*</h[1-6]>',
    'gi',
  )
  const heads = []
  let hm
  while ((hm = HEAD_RE.exec(html))) heads.push({ year: parseInt(hm[2], 10), at: hm.index })

  const yearAt = (pos) => {
    let y = fallbackYear
    for (const h of heads) {
      if (h.at <= pos) y = h.year
      else break
    }
    return y
  }

  // Split the body into per-card blocks bounded by the next card, so a field
  // regex can never bleed from one card into the next.
  const starts = []
  const SPLIT_RE = /class="mec-topsec/gi
  let sm
  while ((sm = SPLIT_RE.exec(html))) starts.push(sm.index)

  const cards = []
  for (let i = 0; i < starts.length; i++) {
    const block = html.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : html.length)
    const card = parseCard(block, yearAt(starts[i]))
    if (card) cards.push(card)
  }
  return cards
}

// ── Row building ─────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0')

/** True when the event's window overlaps [now - grace, now + horizon]. */
export function isWithinWindow(startUtc, endUtc, nowMs = Date.now()) {
  if (!startUtc) return false
  const startMs = new Date(startUtc).getTime()
  const endMs = endUtc ? new Date(endUtc).getTime() : startMs
  if (Number.isNaN(startMs)) return false
  if (endMs < nowMs - PAST_GRACE_MS) return false
  if (startMs > nowMs + HORIZON_DAYS * 86_400_000) return false
  return true
}

/**
 * Pure transform: raw card → event row (no DB access). Returns null for
 * governance rows or unparseable dates. Exported for tests.
 */
export function buildRow(card) {
  if (!card || !card.title) return null
  if (!isPublicEvent(card.title)) return null
  if (!card.year || !card.month || !card.day) return null

  const dateStr = `${card.year}-${pad2(card.month)}-${pad2(card.day)}`
  const start_at = easternToIso(dateStr, card.startTime || DEFAULT_START_TIME)
  if (!start_at) return null

  let end_at = card.endTime ? easternToIso(dateStr, card.endTime) : null
  // Drop a nonsensical end (not strictly after start — e.g. an end earlier in
  // the day, which MEC occasionally renders for overnight/rollover events).
  if (!end_at || new Date(end_at) <= new Date(start_at)) end_at = null

  const description = card.description || null
  const category = inferCategory(card.title, description || '')
  const source_url = `${ORIGIN}/events/${card.slug}/`

  return {
    venueSpec: VENUE,
    row: {
      title: card.title,
      description,
      start_at,
      end_at,
      category,
      tags: ['peninsula', 'summit-county'],
      price_min: null,
      price_max: null,
      age_restriction: 'all_ages',
      image_url: null,
      ticket_url: null,
      source_url,
      source: SOURCE_KEY,
      source_id: `peninsula_${card.slug}`,
      status: 'published',
      featured: false,
    },
  }
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchEventsHtml() {
  const res = await fetch(EVENTS_URL, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronEventsBot/1.0)',
      Accept: 'text/html',
    },
  })
  if (!res.ok) throw new Error(`Events page HTTP ${res.status}`)
  return res.text()
}

// ── Venue / organizer ────────────────────────────────────────────────────────

async function ensureVillageVenue(organizerId) {
  const venueId = await ensureVenue(VENUE.name, {
    address: VENUE.address,
    city: VENUE.city,
    state: VENUE.state,
    zip: VENUE.zip,
    website: ORIGIN,
  })
  if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)
  return venueId
}

async function ensureVillageOrg() {
  return ensureOrganization('Village of Peninsula', {
    website: ORIGIN,
    description:
      'Village of Peninsula, Ohio (Summit County). Posts community events and ' +
      'public gatherings for the village and the surrounding Cuyahoga Valley.',
  })
}

// ── Upsert pipeline ──────────────────────────────────────────────────────────

async function processEvents(prepared, organizerId, venueId) {
  let inserted = 0
  let skipped = 0

  for (const { row, venueSpec } of prepared) {
    try {
      const geo = classifySummitLocation({ city: venueSpec.city })
      if (geo === 'out') {
        skipped++
        continue
      }
      if (geo === 'unknown') {
        row.status = 'pending_review'
        row.needs_review = true
      }

      const enrichedRow = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enrichedRow)
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
      } else {
        if (venueId) await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    } catch (err) {
      console.warn(`  ⚠ Error processing "${row.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Village of Peninsula ingestion…')
  if (DRY_RUN) console.log('   [dry-run mode — fetch + parse only, no DB writes]')
  const start = Date.now()

  try {
    console.log('\n🔍  Fetching Village of Peninsula events page…')
    const html = await fetchEventsHtml()

    const cards = parseEventsHtml(html)
    console.log(`  Parsed ${cards.length} card(s) from the events archive.`)

    const now = Date.now()
    const built = cards.map(buildRow).filter(Boolean)
    console.log(`  ${built.length} public event(s) after dropping meetings/notices.`)

    const prepared = built.filter(b => isWithinWindow(b.row.start_at, b.row.end_at, now))
    console.log(`  ${prepared.length} within the ${HORIZON_DAYS}-day window.`)

    // Defensive within-run dedup on source_id.
    const seen = new Set()
    const unique = prepared.filter(b => {
      if (seen.has(b.row.source_id)) return false
      seen.add(b.row.source_id)
      return true
    })

    if (DRY_RUN) {
      console.log(`\n🧪  Dry-run: ${unique.length} event(s) prepared — nothing written.`)
      for (const { row } of unique) {
        console.log(`     • ${row.title}  [${row.start_at}]  cat=${row.category}`)
      }
      console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s [dry-run]`)
      return
    }

    const organizerId = await ensureVillageOrg()
    const venueId = await ensureVillageVenue(organizerId)

    console.log(`\n📥  Processing ${unique.length} event(s)…`)
    const { inserted, skipped } = await processEvents(unique, organizerId, venueId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: unique.length,
      durationMs: Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — inserted ${inserted}, skipped ${skipped}`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly; importing for tests exposes the pure parsers
// without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
