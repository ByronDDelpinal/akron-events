/**
 * scrape-western-reserve-playhouse.js
 *
 * Western Reserve Playhouse — community theater in Summit County (the "Barn"
 * on Everett Rd, straddling Bath/Richfield Township; the site markets it as
 * "of Bath Ohio" but lists 3326 Everett Rd, Richfield, OH 44286).
 *
 * Platform: Squarespace. TWO data sources are combined because WRP models its
 * season in two different places:
 *
 *   1. MAINSTAGE productions live in a real Squarespace Events collection at
 *      /mainstageseason (fetched via ?format=json). Each production is ONE
 *      event whose startDate = opening night (8pm) and endDate = closing
 *      matinee — exactly the "one event per production with a run range" shape
 *      we want, with proper times, a synopsis (excerpt), and a poster image.
 *      NOTE: the collection item `body` is Squarespace layout markup (empty
 *      after stripHtml), so the synopsis is taken from `excerpt`, not `body`.
 *
 *   2. Every OTHER series (Five Bucks staged readings, Cabaret / Broadway
 *      Bingo, Young Artists' Oz Series, Special Events like craft shows) is
 *      only exposed as a hand-maintained `FULL_EVENTS = [...]` JS array baked
 *      into the /nowplaying page's calendar code block. Those rows carry an
 *      explicit per-performance date + time + tag + url. Their linked url is a
 *      generic landing page (/fivebucks, /bingo, …), NOT a per-event page, so
 *      the array is the only structured source for them.
 *
 * Modeling: one event per production/run. Mainstage runs come pre-grouped from
 * the collection. Non-mainstage rows are grouped by (tag, title) into
 * contiguous runs — consecutive performances within GAP_DAYS collapse into a
 * single event (start = opening perf, end = closing perf); a title that
 * repeats months apart (e.g. monthly "Broadway Bingo") stays as separate
 * events. This mirrors scrape-weathervane.js / scrape-ohio-shakespeare.js
 * (one row per show, not per performance) and avoids recurring-instance bloat.
 *
 * Every Mainstage row already carries its time; every non-mainstage FULL_EVENTS
 * row carries an explicit time — so NO time is ever synthesized to midnight.
 *
 * Geography: single fixed Summit County venue → always published (no
 * classifySummitLocation needed).
 *
 * Usage:
 *   node scripts/scrape-western-reserve-playhouse.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  stripHtml,
  decodeEntities,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  linkOrganizationVenue,
  ensureVenue,
  ensureOrganization,
  easternToIso,
} from './lib/normalize.js'
import { fetchSquarespaceEvents } from './lib/squarespace.js'

const BASE_URL        = 'https://www.thewrp.org'
const NOW_PLAYING_URL = `${BASE_URL}/nowplaying`
const MAINSTAGE_URL   = `${BASE_URL}/mainstageseason`
const SOURCE          = 'western_reserve_playhouse'

// Consecutive performances within this many days collapse into one event.
// A weekend run (Fri/Sat/Sun) stays together; a monthly-repeating title
// (Broadway Bingo) splits into distinct events.
const GAP_DAYS = 4

// ── Small date/time helpers (pure) ──────────────────────────────────────────

/** Days between two "YYYY-MM-DD" strings (b - a), UTC-anchored. */
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

/** Today in America/New_York as "YYYY-MM-DD" (never local Date + toISOString). */
export function easternTodayIso(now = new Date()) {
  // en-CA gives ISO-ordered YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/** Slugify a title for a stable source_id. */
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** Epoch-ms → whole-second ISO (mirrors lib/squarespace's dedupe-safe flooring). */
function msToWholeSecondIso(v) {
  if (v == null) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return null
  d.setUTCMilliseconds(0)
  return d.toISOString()
}

// ── FULL_EVENTS array parsing (non-mainstage series) ────────────────────────

/**
 * Extract the `FULL_EVENTS = [ … ]` array baked into the /nowplaying calendar
 * code block. Each object is `{ date, title, time?, tag, url }` (Mainstage
 * rows omit `time`). Returns raw rows; caller filters/groups. Exported for
 * tests.
 */
export function parseFullEvents(html) {
  const start = html.indexOf('FULL_EVENTS')
  if (start === -1) return []
  const open = html.indexOf('[', start)
  const end  = html.indexOf('];', open)
  if (open === -1 || end === -1) return []
  const block = html.slice(open, end)

  const rows = []
  const re = /\{\s*date:\s*"([^"]+)"\s*,\s*title:\s*"([^"]+)"\s*,\s*(?:time:\s*"([^"]+)"\s*,\s*)?tag:\s*"([^"]+)"\s*,\s*url:\s*"([^"]+)"/g
  let m
  while ((m = re.exec(block))) {
    rows.push({
      date:  m[1].trim(),
      title: decodeEntities(m[2]).trim(),
      time:  m[3] ? m[3].trim() : null,
      tag:   m[4].trim(),
      url:   m[5].trim(),
    })
  }
  return rows
}

/**
 * Group non-mainstage rows into events. Rows sharing (tag, title) whose dates
 * are within `gapDays` of each other collapse into one run; larger gaps start
 * a new run. Returns arrays of rows (each = one event), sorted by opening date.
 * Exported for tests.
 */
export function groupRuns(rows, gapDays = GAP_DAYS) {
  const byKey = new Map()
  for (const r of rows) {
    const key = `${r.tag}||${r.title}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(r)
  }

  const runs = []
  for (const list of byKey.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date))
    let run = [list[0]]
    for (let i = 1; i < list.length; i++) {
      if (daysBetween(run[run.length - 1].date, list[i].date) <= gapDays) {
        run.push(list[i])
      } else {
        runs.push(run)
        run = [list[i]]
      }
    }
    runs.push(run)
  }

  runs.sort((a, b) => a[0].date.localeCompare(b[0].date))
  return runs
}

/**
 * Map a WRP series tag + title to a content category. Most events are theater;
 * bingo nights are games, craft/market shows are markets, and anything else
 * under "Special Event" (e.g. an awards ceremony) falls back to "other".
 * Exported for tests.
 */
export function resolveCategory(tag, title) {
  const t = title.toLowerCase()
  if (/\bbingo\b/.test(t)) return 'games'
  if (tag === 'Special Event') {
    if (/\b(craft|market|vintage|small business|fair|bazaar)\b/.test(t)) return 'market'
    return 'other'
  }
  return 'theater'
}

/** Series-specific descriptive tags (freeform strings). */
function tagsFor(tag, category) {
  const base = ['western-reserve-playhouse', 'summit-county']
  if (category === 'theater') base.push('theatre', 'community-theatre', 'live-performance')
  switch (tag) {
    case 'Mainstage':     base.push('mainstage'); break
    case 'Five Bucks':    base.push('staged-reading', 'five-bucks'); break
    case 'Young Artists': base.push('youth-theatre', 'young-artists'); break
    case 'Cabaret':       base.push('cabaret'); break
    default: break
  }
  return [...new Set(base)]
}

/**
 * Build an event row from a grouped non-mainstage run. start = opening
 * performance; a multi-performance run also records end = closing performance.
 * Exported for tests. Returns null if the opening datetime can't be built.
 */
export function buildNonMainstageRow(run) {
  const first = run[0]
  const last  = run[run.length - 1]

  const startAt = easternToIso(first.date, first.time)
  if (!startAt) return null
  const endAt = run.length > 1 ? easternToIso(last.date, last.time) : null

  const category = resolveCategory(first.tag, first.title)

  return {
    title:           first.title,
    description:     null,
    start_at:        startAt,
    end_at:          endAt,
    category,
    tags:            tagsFor(first.tag, category),
    price_min:       null,
    price_max:       null,
    age_restriction: 'all_ages',
    image_url:       null,
    ticket_url:      first.url || NOW_PLAYING_URL,
    source_url:      first.url || NOW_PLAYING_URL,
    source:          SOURCE,
    source_id:       `${slugify(first.title)}-${first.date}`,
    status:          'published',
    featured:        false,
  }
}

/**
 * Normalize a Mainstage Squarespace Events-collection item into an event row.
 * Description comes from `excerpt` (the item `body` is empty layout markup).
 * Exported for tests. Returns null if the item has no usable start time.
 */
export function normalizeMainstageItem(item) {
  const startAt = msToWholeSecondIso(item.startDate)
  if (!startAt) return null
  const endAt = msToWholeSecondIso(item.endDate)

  const description = item.excerpt ? stripHtml(item.excerpt) : null
  const ticketUrl   = item.fullUrl ? `${BASE_URL}${item.fullUrl}` : MAINSTAGE_URL

  return {
    title:           item.title ? decodeEntities(item.title.trim()) : null,
    description:     description || null,
    start_at:        startAt,
    end_at:          endAt,
    category:        'theater',
    tags:            tagsFor('Mainstage', 'theater'),
    price_min:       null,
    price_max:       null,
    age_restriction: 'all_ages',
    image_url:       item.assetUrl || null,
    ticket_url:      ticketUrl,
    source_url:      ticketUrl,
    source:          SOURCE,
    source_id:       item.id || item.urlId || null,
    status:          'published',
    featured:        item.starred ?? false,
  }
}

// ── Venue / Organizer ───────────────────────────────────────────────────────

async function ensureWrpVenue() {
  return ensureVenue('Western Reserve Playhouse', {
    address: '3326 Everett Rd',
    city:    'Richfield',
    state:   'OH',
    zip:     '44286',
    lat:     41.2022,
    lng:     -81.6583,
    website: BASE_URL,
  })
}

async function ensureWrpOrganizer() {
  return ensureOrganization('Western Reserve Playhouse', {
    website:     BASE_URL,
    description:
      'Western Reserve Playhouse is an award-winning community theater in ' +
      'Summit County, presenting Mainstage productions, the Five Bucks staged-' +
      'reading series, cabarets, and youth theater at "The Barn" on Everett Rd.',
  })
}

// ── HTML fetch ──────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronEventsBot/1.0)',
      Accept:       'text/html',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Upsert ──────────────────────────────────────────────────────────────────

async function upsertRows(rows, venueId, organizerId) {
  let inserted = 0, skipped = 0

  for (const row of rows) {
    if (!row || !row.title || !row.start_at) { skipped++; continue }
    try {
      const enriched = await enrichWithImageDimensions(row)
      const { data: upserted, error } = await upsertEventSafe(enriched)
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
        skipped++
        continue
      }
      await linkEventVenue(upserted.id, venueId)
      await linkEventOrganization(upserted.id, organizerId)
      inserted++
      console.log(`    ✓ ${row.title} — ${row.start_at}${row.end_at ? ` → ${row.end_at}` : ''}`)
    } catch (err) {
      console.warn(`  ⚠ Error upserting "${row.title}":`, err.message)
      skipped++
    }
  }

  return { inserted, skipped }
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting Western Reserve Playhouse ingestion…')
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([ensureWrpVenue(), ensureWrpOrganizer()])
    await linkOrganizationVenue(organizerId, venueId)

    const cutoff = easternTodayIso() // skip events whose last date is before "yesterday"
    const rows = []

    // 1. Mainstage — Squarespace Events collection (pre-grouped per production).
    console.log(`\n🔍  Fetching Mainstage collection: ${MAINSTAGE_URL}…`)
    try {
      const items = await fetchSquarespaceEvents(MAINSTAGE_URL)
      console.log(`  ${items.length} upcoming mainstage production(s)`)
      for (const item of items) {
        const row = normalizeMainstageItem(item)
        // Extra safety net: drop anything whose run already ended > 1 day ago.
        const endDate = (row?.end_at || row?.start_at || '').slice(0, 10)
        if (row && endDate && daysBetween(cutoff, endDate) >= -1) rows.push(row)
      }
    } catch (err) {
      console.warn('  ⚠ Mainstage collection fetch failed:', err.message)
    }

    // 2. All other series — FULL_EVENTS array on /nowplaying.
    console.log(`\n🔍  Fetching season calendar: ${NOW_PLAYING_URL}…`)
    const html   = await fetchHtml(NOW_PLAYING_URL)
    const parsed = parseFullEvents(html)
    console.log(`  Parsed ${parsed.length} FULL_EVENTS rows`)
    if (parsed.length === 0) {
      console.warn('  ⚠ FULL_EVENTS array not found — the calendar code block may have changed.')
    }

    const nonMainstage = parsed.filter((r) => r.tag !== 'Mainstage')
    const runs = groupRuns(nonMainstage)
    for (const run of runs) {
      const lastDate = run[run.length - 1].date
      if (daysBetween(cutoff, lastDate) < -1) continue // ended > 1 day ago
      const row = buildNonMainstageRow(run)
      if (row) rows.push(row)
    }
    console.log(`  ${runs.length} non-mainstage run(s) → ${rows.length} total event rows to upsert`)

    console.log(`\n📥  Upserting ${rows.length} events…`)
    const { inserted, skipped } = await upsertRows(rows, venueId, organizerId)

    await logUpsertResult(SOURCE, inserted, 0, skipped, {
      eventsFound: rows.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — inserted ${inserted}, skipped ${skipped}`)
  } catch (err) {
    await logScraperError(SOURCE, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly; importing for tests exposes the pure parsers
// without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
