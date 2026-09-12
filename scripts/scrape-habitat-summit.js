/**
 * scrape-habitat-summit.js
 *
 * Habitat for Humanity of Summit County (hfhsummitcounty.org) — affordable-
 * housing nonprofit. Its events page carries two kinds of events:
 *
 *   1. "Annual Fundraising Events" — static cards for the marquee fundraisers
 *      (Build In Style, Home In One golf outing, Bourbon Build). Reliable
 *      title/date/location, but NO published start time (the landing pages are
 *      noisy/stale), so we infer a sensible time from the event type.
 *   2. ECWD (Events Calendar WD plugin) calendar — volunteer/community events
 *      (e.g. Neighborhood Reborn) rendered into a month grid with /event/<slug>
 *      links and machine-readable date ranges (YYYY.MM.DD) + times.
 *
 * Why HTML parsing: the ECWD plugin exposes no public REST/JSON (its /ecwd/v1/
 * routes are write-only and the post type isn't in WP REST), there's no Event
 * JSON-LD, and no all-events iCal feed. The events page is server-rendered, so
 * we parse it directly. These are charity fundraisers + volunteer drives, so
 * they're tagged for the Give Back facet.
 *
 * Retirement: after the upsert loop, published rows whose source_id no longer
 * appears on the page are set to status 'cancelled' (never deleted) — see
 * planHabitatRetirement for the decision rule and guards.
 *
 * Usage:   node scripts/scrape-habitat-summit.js [--dry-run]
 *          --dry-run: no DB writes at all; prints what would be upserted/retired.
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, htmlToText, decodeEntities, easternToIso,
  easternTodayIso, inferCategory, enrichWithImageDimensions, upsertEventSafe, linkEventVenue,
  linkEventOrganization, ensureVenue, ensureOrganization,
} from './lib/normalize.js'

export const SOURCE_KEY = 'habitat_summit'
const SITE = 'https://hfhsummitcounty.org'
const EVENTS_URL = `${SITE}/joinus/events/`
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'
const MAX_DAYS_AHEAD = 450
const DRY_RUN = process.argv.includes('--dry-run')

// Retirement guards — the sweep runs only on a healthy, complete parse.
const RETIREMENT_MIN_GRID_CELLS = 28   // a full month grid has 28–31 data-date cells
const RETIREMENT_MIN_CARDS      = 2    // fundraiser cards section parsed
const RETIREMENT_MIN_ECWD       = 1    // calendar section parsed
const RETIREMENT_MAX_ROWS       = 5
const RETIREMENT_MAX_FRACTION   = 0.5
const RETIREMENT_QUERY_LIMIT    = 500

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

const TAGS = ['fundraiser', 'charity', 'habitat-for-humanity', 'give-back']

// ── Pure parsers (exported for tests) ───────────────────────────────────────

const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

/** Parse "Tuesday, March 9th, 2027" → "YYYY-MM-DD". */
export function parseCardDate(text) {
  const m = String(text || '').match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})/i)
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  if (!month) return null
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`
}

/** Fundraisers publish no time — infer one from the event type. */
export function inferFundraiserTime(title, description) {
  const t = `${title || ''} ${description || ''}`.toLowerCase()
  if (/\bgolf\b|outing|tee\b|scramble/.test(t))            return '9:00 AM'   // morning shotgun
  if (/luncheon|lunch|build in style|fashion|brunch/.test(t)) return '11:00 AM' // midday luncheon
  return '6:00 PM'                                                              // evening gala/social
}

/** Parse the "Annual Fundraising Events" cards. */
export function parseFundraiserCards(html) {
  const s = String(html || '')
  const start = s.search(/Annual Fundraising Events/i)
  if (start < 0) return []
  const endIdx = s.search(/Support these Fundraising/i)
  const region = s.slice(start, endIdx > start ? endIdx : s.length)

  const re = /<h2[^>]*>([\s\S]*?)<\/h2>\s*<h4[^>]*>([\s\S]*?)<\/h4>\s*<h4[^>]*>([\s\S]*?)<\/h4>([\s\S]*?)(?=<h2[^>]*>|$)/gi
  const out = []
  for (const m of region.matchAll(re)) {
    const title = stripTags(m[1])
    const date = parseCardDate(stripTags(m[2]))
    const location = stripTags(m[3]) || null
    if (!title || !date) continue
    const rest = m[4]
    const descM = rest.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    const description = descM ? htmlToText(descM[1]).slice(0, 2000) || null : null
    const urlM = rest.match(/<a[^>]+href="([^"?#]+)"[^>]*>\s*More Here/i)
    out.push({ title, date, time: inferFundraiserTime(title, description), location, description, url: urlM ? urlM[1] : EVENTS_URL, kind: 'fundraiser' })
  }
  return out
}

/**
 * Best-effort parse of ECWD calendar events (volunteer/community). Deduped by
 * slug+date so a recurring event (same slug, two grid cells on different dates)
 * yields one entry per date — each becomes its own source_id downstream.
 */
export function parseEcwdEvents(html, origin = SITE) {
  const s = String(html || '')
  // Anchored to the site origin: card text can embed foreign /event/ links
  // (e.g. gofevo.com ticket pages) that would otherwise be read as event slugs.
  const esc = origin.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const re = new RegExp(`${esc}/event/([a-z0-9-]+)/?"[^>]*>\\s*(?:<span[^>]*>)?([\\s\\S]*?)</(?:span|a)>[\\s\\S]{0,600}?(\\d{1,2}:\\d{2}\\s*[ap]m)\\s*-\\s*(\\d{1,2}:\\d{2}\\s*[ap]m)[\\s\\S]{0,160}?(\\d{4})\\.(\\d{2})\\.(\\d{2})`, 'gi')
  const seen = new Map()
  for (const m of s.matchAll(re)) {
    const slug = m[1]
    const date = `${m[5]}-${m[6]}-${m[7]}`
    const key = `${slug}|${date}`
    if (seen.has(key)) continue
    const title = stripTags(m[2])
    if (!title) continue
    seen.set(key, {
      title,
      date,
      time: m[3].replace(/\s+/g, ' ').toUpperCase(),
      url: `${origin}/event/${slug}/`,
      kind: 'volunteer',
    })
  }
  return [...seen.values()]
}

/** Unique, sorted "YYYY-MM-DD" dates from the ECWD month grid's data-date="YYYY-M-D" cells. */
export function parseGridDates(html) {
  const out = new Set()
  for (const m of String(html || '').matchAll(/data-date="(\d{4})-(\d{1,2})-(\d{1,2})"/g)) {
    out.add(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`)
  }
  return [...out].sort()
}

/** Title → slug exactly as used in source_id (kept in one place so the sweep matches the upsert). */
const slugify = (title) => String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const sourceIdPrefix = (sourceId) => String(sourceId || '').replace(/-\d{4}-\d{2}-\d{2}$/, '')

/**
 * Resolve a parsed event to its source_id and decide whether it is inside the
 * upsert horizon. The source_id is added to `seenSourceIds` BEFORE the horizon
 * check, so far-future rows the page still lists are never retired as unseen.
 * Returns { skip: null | 'no-start' | 'outside-horizon', sourceId, startIso }.
 */
export function stageEvent(ev, { now = Date.now(), cutoff = now + MAX_DAYS_AHEAD * 86_400_000, seenSourceIds = new Set() } = {}) {
  const startIso = easternToIso(ev.date, ev.time)
  if (!startIso) return { skip: 'no-start', sourceId: null, startIso: null }
  const sourceId = `${slugify(ev.title)}-${startIso.slice(0, 10)}`
  seenSourceIds.add(sourceId)
  const ms = Date.parse(startIso)
  if (ms < now - 86_400_000 || ms > cutoff) return { skip: 'outside-horizon', sourceId, startIso }
  return { skip: null, sourceId, startIso }
}

// ── Retirement (pure planner, exported for tests) ──────────────────────────

/** True when a human (or a previous retirement) pinned `status` on this row. */
export function hasStatusOverride(row) {
  const ov = row?.manual_overrides
  return !!ov && typeof ov === 'object' && Object.prototype.hasOwnProperty.call(ov, 'status')
}

/**
 * Decide which rows to retire (status → 'cancelled'). Pure so the guards are testable.
 *
 * A row is retired when it is published, not status-pinned, and EITHER
 *   - dated inside [windowStart, windowEnd] (Eastern today → last grid cell) and
 *     its source_id was not seen on the page this run, OR
 *   - its source_id prefix is a fundraiser card slug and the card now carries a
 *     different date (the card moved; the old row is months out but still stale).
 * Rows outside the window with a non-card prefix are never touched.
 *
 * @param rows           rows for this source dated windowStart onward, all statuses
 * @param seenSourceIds  Set of source_ids parsed from the page this run
 * @param cardSlugs      Set of fundraiser card slugs parsed this run
 * @param health         { gridCells, cardCount, ecwdCount } — parse health guards
 */
export function planHabitatRetirement({
  rows = [], seenSourceIds = new Set(), cardSlugs = new Set(),
  windowStart = null, windowEnd = null, health = {},
} = {}) {
  const base = { retire: [], examined: rows.length, eligible: 0, protectedCount: 0, skipped: null, reason: null }
  const { gridCells = 0, cardCount = 0, ecwdCount = 0 } = health
  if (gridCells < RETIREMENT_MIN_GRID_CELLS || !windowStart || !windowEnd) {
    return { ...base, skipped: 'grid-incomplete', reason: `only ${gridCells} data-date cell(s) parsed (need ${RETIREMENT_MIN_GRID_CELLS}) — calendar grid not seen` }
  }
  if (cardCount < RETIREMENT_MIN_CARDS) {
    return { ...base, skipped: 'cards-missing', reason: `only ${cardCount} fundraiser card(s) parsed (need ${RETIREMENT_MIN_CARDS})` }
  }
  if (ecwdCount < RETIREMENT_MIN_ECWD) {
    return { ...base, skipped: 'ecwd-missing', reason: `only ${ecwdCount} calendar event(s) parsed (need ${RETIREMENT_MIN_ECWD})` }
  }

  const eligible = rows.filter((r) => r.status === 'published' && !hasStatusOverride(r))
  const pinned = rows.filter((r) => r.status === 'published' && hasStatusOverride(r))
  const candidates = eligible.filter((r) => {
    if (seenSourceIds.has(r.source_id)) return false
    const date = easternTodayIso(new Date(r.start_at))
    const inWindow = date >= windowStart && date <= windowEnd
    return inWindow || cardSlugs.has(sourceIdPrefix(r.source_id))
  })

  const fraction = eligible.length ? candidates.length / eligible.length : 0
  const out = { ...base, eligible: eligible.length, protectedCount: pinned.length, candidates: candidates.length, fraction }
  if (candidates.length > RETIREMENT_MAX_ROWS || fraction > RETIREMENT_MAX_FRACTION) {
    return { ...out, skipped: 'above-ceiling',
      reason: `${candidates.length}/${eligible.length} eligible row(s) (${(fraction * 100).toFixed(0)}%) would be retired — ` +
        `over the cap of ${RETIREMENT_MAX_ROWS} rows / ${(RETIREMENT_MAX_FRACTION * 100).toFixed(0)}%. Investigate before retiring.` }
  }
  return { ...out, retire: candidates }
}

/** Query rows from today onward, plan, and apply status-only UPDATEs (skipped under --dry-run). */
async function retireUnseen({ windowStart, windowEnd, seenSourceIds, cardSlugs, health }) {
  const { supabaseAdmin } = await import('./lib/supabase-admin.js')
  const { data: rows, error } = await supabaseAdmin
    .from('events')
    .select('id, title, source_id, status, start_at, manual_overrides')
    .eq('source', SOURCE_KEY)
    .gte('start_at', easternToIso(windowStart, '00:00:00'))
    .limit(RETIREMENT_QUERY_LIMIT)
  if (error) { console.warn(`  ⚠ Retirement query failed: ${error.message} — retiring nothing.`); return 0 }
  if ((rows?.length ?? 0) >= RETIREMENT_QUERY_LIMIT) {
    console.warn(`  ⚠ Retirement query hit the ${RETIREMENT_QUERY_LIMIT}-row bound — result may be truncated. Retiring nothing.`)
    return 0
  }

  const plan = planHabitatRetirement({ rows: rows ?? [], seenSourceIds, cardSlugs, windowStart, windowEnd, health })
  if (plan.skipped) { console.warn(`  ⏭  Retirement SKIPPED (${plan.skipped}): ${plan.reason}`); return 0 }
  if (plan.protectedCount) console.log(`  🛡  ${plan.protectedCount} row(s) skipped: manual_overrides.status is a human decision`)
  if (plan.retire.length === 0) { console.log(`  ✓ Nothing to retire (${plan.examined} row(s) examined)`); return 0 }

  let retired = 0   // rows updated (or, under --dry-run, rows that would be)
  for (const row of plan.retire) {
    if (DRY_RUN) { console.log(`     - [dry-run] would retire ${row.title} (${row.source_id})`); retired++; continue }
    // Status-only: no manual_overrides stamp, so a normal upsert re-publishes the row if the event returns.
    const { error: upErr } = await supabaseAdmin.from('events').update({ status: 'cancelled' }).eq('id', row.id)
    if (upErr) { console.warn(`  ⚠ Retirement failed for ${row.source_id}: ${upErr.message}`); continue }
    console.log(`     - ${row.title} (${row.source_id})`)
    retired++
  }
  return retired
}

// ── Fetch ─────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('🏠  Starting Habitat for Humanity of Summit County ingestion…')
  const start = Date.now()
  try {
    const html = await fetchHtml(EVENTS_URL)
    const cards = parseFundraiserCards(html)
    const ecwd = parseEcwdEvents(html)
    const gridDates = parseGridDates(html)
    const events = [...cards, ...ecwd]
    console.log(`  Parsed ${events.length} event(s) (${cards.length} card(s), ${ecwd.length} calendar, ${gridDates.length} grid cell(s))${DRY_RUN ? ' [DRY RUN — no DB writes]' : ''}`)

    const organizerId = DRY_RUN ? null : await ensureOrganization('Habitat for Humanity of Summit County', {
      website: SITE,
      description: 'Habitat for Humanity of Summit County builds and repairs affordable homes in Summit County, running annual fundraisers and community volunteer drives.',
    })

    const now = Date.now()
    const cutoff = now + MAX_DAYS_AHEAD * 86_400_000
    const venueCache = new Map()
    let inserted = 0, skipped = 0
    const seenSourceIds = new Set()   // every source_id the page yielded this run, upserted or not
    const cardSlugs = new Set(cards.map((c) => slugify(c.title)))

    for (const ev of events) {
      try {
        const { skip, sourceId, startIso } = stageEvent(ev, { now, cutoff, seenSourceIds })
        if (skip) { skipped++; continue }

        let venueId = null
        if (ev.location && !DRY_RUN) {
          if (venueCache.has(ev.location)) venueId = venueCache.get(ev.location)
          else {
            venueId = await ensureVenue(ev.location, { state: 'OH' })
            venueCache.set(ev.location, venueId)
          }
        }

        const category = inferCategory(ev.title, ev.description || '') || 'civic'
        const row = {
          title:           ev.title,
          description:     ev.description || null,
          start_at:        startIso,
          end_at:          null,
          category:        category === 'other' ? 'civic' : category,
          tags:            ev.kind === 'volunteer' ? [...TAGS, 'volunteer'] : TAGS,
          price_min:       ev.kind === 'volunteer' ? 0 : null,   // volunteer drives are free; fundraisers never assumed
          price_max:       null,
          age_restriction: 'all_ages',
          image_url:       null,
          ticket_url:      ev.url,
          source:          SOURCE_KEY,
          source_id:       sourceId,
          status:          'published',
          featured:        false,
        }
        if (DRY_RUN) { console.log(`     + [dry-run] would upsert ${row.title} (${row.source_id})`); inserted++; continue }
        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed "${row.title}":`, error.message); skipped++; continue }
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on "${ev.title}":`, err.message)
        skipped++
      }
    }

    // Retirement sweep: window = Eastern today → last grid cell on the page.
    const windowStart = easternTodayIso()
    const windowEnd = gridDates.length ? gridDates[gridDates.length - 1] : null
    console.log(`  Retirement window ${windowStart} → ${windowEnd ?? '(none)'}`)
    const retired = await retireUnseen({
      windowStart, windowEnd, seenSourceIds, cardSlugs,
      health: { gridCells: gridDates.length, cardCount: cards.length, ecwdCount: ecwd.length },
    })

    if (!DRY_RUN) {
      await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: events.length, durationMs: Date.now() - start, retired })
    }
    console.log(`  🗄  ${retired} row(s) ${DRY_RUN ? 'would be ' : ''}retired (status → cancelled)`)
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} ${DRY_RUN ? 'would be ' : ''}upserted, ${skipped} skipped`)
  } catch (err) {
    if (DRY_RUN) console.error(`\n❌  Fatal error [${SOURCE_KEY}] (dry-run, not logged to DB):`, err.message)
    else await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
