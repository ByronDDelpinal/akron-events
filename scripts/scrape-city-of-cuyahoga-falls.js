/**
 * scrape-city-of-cuyahoga-falls.js
 *
 * City of Cuyahoga Falls, Ohio (Summit County) — Drupal 10 site. Unlike the
 * Summit County CivicPlus municipalities, Cuyahoga Falls has no iCalendar
 * feed; events live in a Drupal calendar View. The monthly calendar grid
 * (/calendar/YYYYMM) is the most reliable date source because Drupal
 * materialises each occurrence of a recurring series into its own dated day
 * cell, e.g. "Picnic In The Park" every Tuesday or "Falls Downtown Fridays"
 * on first Fridays. Each cell links day numbers to
 * /calendar-field_cal_date/day/YYYYMMDD and events to /events/{slug}.
 *
 * Strategy:
 *   1. Fetch the calendar grid for the current month + 2 ahead.
 *   2. Walk the grid in document order, tracking the current day from each
 *      day-cell link, and attach every following /events/{slug} occurrence to
 *      that date (restricted to the page's own month so adjacent-month
 *      spillover cells don't double-count).
 *   3. Drop government/administrative entries (City Council, Planning
 *      Commission, Board of Zoning Appeal, etc.) with a meeting filter.
 *   4. Fetch each unique event node once (cached) for its <h1> title, og:
 *      description, og:image, and a best-effort start time parsed from the
 *      detail prose / meta description ("6 to 10 p.m.", "beginning at 7 p.m.").
 *
 * Public series surfaced: Falls Downtown Fridays, Front Street Live, Riverfront
 * Cruise In, Picnic In The Park, Community Band, Keyser Concerts, Flix on the
 * Falls, plus one-off festivals and Quirk Cultural Center programming.
 *
 * Usage:   node scripts/scrape-city-of-cuyahoga-falls.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import {
  easternToIso,
  enrichWithImageDimensions,
  ensureOrganization,
  ensureVenue,
  inferCategory,
  linkEventOrganization,
  linkEventVenue,
  linkOrganizationVenue,
  logScraperError,
  logUpsertResult,
  stripHtml,
  upsertEventSafe,
} from './lib/normalize.js'
import { pathToFileURL } from 'node:url'

const SOURCE_KEY = 'city_of_cuyahoga_falls'
const BASE_URL = 'https://www.cityofcf.com'
const MONTHS_AHEAD = 2

// Administrative / governance event slugs+titles to drop. Cuyahoga Falls tags
// these as "Government Event" but the grid doesn't expose the category, so we
// gate on the title like the CivicPlus filter does.
const ADMIN_RE =
  /\b(city council|council\b|planning commission|board of zoning|zoning appeal|claims commission|public art board|tax incentive|review council|parks and recreation board|design & historic|historic review|public meeting|public hearing|committee|commission\b|board meeting|caucus|work session|trustees?)\b/i

function isPublicEvent(title) {
  const t = (title || '').trim().toLowerCase()
  if (!t) return false
  if (ADMIN_RE.test(t)) return false
  return true
}

// Category: infer from title + description.
function mapCategory(title = '', desc = '') {
  return inferCategory(title, desc)
}

function mapTags(title = '') {
  const t = title.toLowerCase()
  const tags = ['cuyahoga-falls', 'summit-county']
  if (/concert|music|band|live music/.test(t)) tags.push('music', 'outdoor')
  if (/flix|movie/.test(t))                    tags.push('family', 'outdoor', 'free')
  if (/downtown|front street|cruise/.test(t))  tags.push('downtown', 'outdoor')
  if (/picnic/.test(t))                        tags.push('family', 'free')
  return [...new Set(tags)]
}

// ── Time parsing from detail prose ──────────────────────────────────────────
// CF detail pages describe times in prose ("take place from 6 to 10 p.m.",
// "beginning at 7 p.m.", "11:30 a.m. – 1 p.m."). We want the event's START time.
//
// The previous version grabbed the first clock token that carried an am/pm
// marker. In a range like "7 - 8 p.m." only the END states the meridiem, so it
// matched "8 p.m." and stored the event an hour late; "4 – 7 p.m." likewise
// yielded 7 p.m. instead of the 4 p.m. start. So: detect a range first and take
// its start (inheriting the end's meridiem when the start omits one), and only
// fall back to a single clock time when there's no range.
function timeStr(hr, min, isPm) {
  const h = (hr % 12) + (isPm ? 12 : 0)
  return `${String(h).padStart(2, '0')}:${min}:00`
}

export function parseTimeFromText(text) {
  if (!text) return '12:00:00'

  // Range: "<start>[meridiem] (-|–|—|to) <end> meridiem"
  const range = text.match(
    /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i,
  )
  if (range) {
    const startHr  = parseInt(range[1], 10)
    const startMin = range[2] ?? '00'
    const endHr    = parseInt(range[4], 10)
    let startPm
    if (range[3]) {
      startPm = /p/i.test(range[3])                 // start states its own meridiem
    } else {
      const endPm = /p/i.test(range[6])
      const to24  = (h, pm) => (h % 12) + (pm ? 12 : 0)
      // Inherit the end's meridiem, unless inheriting PM would push the start
      // past the end across the noon line (e.g. "11 - 1 p.m." → 11 a.m.).
      startPm = endPm && to24(startHr, true) <= to24(endHr, true)
    }
    return timeStr(startHr, startMin, startPm)
  }

  // Single time: "beginning at 7 p.m.", "10:30 a.m."
  const single = text.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i)
  if (single) return timeStr(parseInt(single[1], 10), single[2] ?? '00', /p/i.test(single[3]))

  return '12:00:00'
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Grid parsing ─────────────────────────────────────────────────────────────

/** Build the list of monthly calendar URLs (current + N ahead). */
function monthUrls() {
  const urls = []
  const now = new Date()
  for (let i = 0; i <= MONTHS_AHEAD; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`
    urls.push({ ym, url: `${BASE_URL}/calendar/${ym}?field_event_cat_target_id=All` })
  }
  return urls
}

/**
 * Map each event to its date using the calendar's week-block structure.
 *
 * Cuyahoga Falls' Drupal calendar renders every week as a `date-box` row whose
 * seven cells carry the day numbers (in-month days link to
 * /calendar-field_cal_date/day/YYYYMMDD), followed by `single-day` / `multi-day`
 * event rows whose cells reference the day only by a `headers="<Weekday>"`
 * attribute. An event's date is therefore the date-box date for the SAME weekday
 * column in the SAME week.
 *
 * The previous implementation tracked "the most recent day token in document
 * order" and attached events to it. Because the day links and the event rows
 * live in separate rows, that clustered an entire week's events onto a handful
 * of dates (e.g. 32 July events collapsed onto 5 days), producing wrong and
 * duplicated dates. We instead build the current week's weekday→date map from
 * each date-box row and resolve every event cell through it. `ym` keeps the page
 * to its own month so adjacent-month spillover cells (covered by their own page)
 * don't double-count.
 */
export function parseGrid(html, ym) {
  const out = []
  const weekDates = {}                          // weekday name → 'YYYY-MM-DD' | null
  const cellRe = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi
  const attrOf = (tag, name) =>
    (tag.match(new RegExp(`${name}="([^"]*)"`, 'i')) || [])[1] || ''

  let m
  while ((m = cellRe.exec(html)) !== null) {
    const tag = m[1]
    const inner = m[2]
    const cls = attrOf(tag, 'class')
    const weekday = attrOf(tag, 'headers')

    if (/\bdate-box\b/.test(cls)) {
      // Day cell. In-month days carry an 8-digit day link; spillover/empty days
      // don't — clear those so events can't inherit a stale prior-week date.
      const d = (inner.match(/calendar-field_cal_date\/day\/(\d{8})/) || [])[1]
      if (weekday) {
        weekDates[weekday] = d
          ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
          : null
      }
      continue
    }

    if (/\b(single-day|multi-day)\b/.test(cls)) {
      const dateStr = weekDates[weekday]
      if (!dateStr) continue                     // unknown / out-of-month column
      if (dateStr.slice(0, 4) + dateStr.slice(5, 7) !== ym) continue
      const linkRe = /href="\/events\/([a-z0-9][a-z0-9-]*)"[^>]*>([\s\S]*?)<\/a>/gi
      let e
      while ((e = linkRe.exec(inner)) !== null) {
        const title = stripHtml(e[2])
        if (title) out.push({ slug: e[1], title, dateStr })
      }
    }
  }
  return out
}

// ── Detail page enrichment ───────────────────────────────────────────────────

function metaContent(html, prop) {
  // Matches <meta name|property="prop" content="...">  (attribute order-agnostic)
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content=["']([^"']*)["']`,
    'i',
  )
  const m = html.match(re)
  if (m) return m[1]
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
    'i',
  )
  const m2 = html.match(re2)
  return m2 ? m2[1] : null
}

async function fetchDetail(slug, cache) {
  if (cache.has(slug)) return cache.get(slug)
  let detail = { title: null, description: null, imageUrl: null, timeStr: '12:00:00' }
  try {
    const html = await fetchHtml(`${BASE_URL}/events/${slug}`)
    const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]
    const desc = metaContent(html, 'og:description') || metaContent(html, 'description')
    detail = {
      title:       h1 ? stripHtml(h1) : (metaContent(html, 'og:title') || null),
      description: desc ? stripHtml(desc).slice(0, 5000) : null,
      imageUrl:    metaContent(html, 'og:image') || null,
      timeStr:     parseTimeFromText(desc || ''),
    }
  } catch (err) {
    console.warn(`  ⚠ detail fetch failed for ${slug}: ${err.message}`)
  }
  cache.set(slug, detail)
  return detail
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌊  Starting City of Cuyahoga Falls ingestion (Drupal calendar)…')
  const start = Date.now()

  try {
    // 1. Collect occurrences across months, dedupe by slug+date.
    const seen = new Set()
    const occurrences = []
    for (const { ym, url } of monthUrls()) {
      console.log(`  → ${url}`)
      try {
        const html = await fetchHtml(url)
        const rows = parseGrid(html, ym)
        for (const r of rows) {
          const key = `${r.slug}|${r.dateStr}`
          if (!seen.has(key)) { seen.add(key); occurrences.push(r) }
        }
        console.log(`    ${rows.length} occurrences`)
      } catch (err) {
        console.warn(`    ⚠ ${err.message}`)
      }
      await new Promise(r => setTimeout(r, 400))
    }

    const today = new Date().toISOString().split('T')[0]
    const publicFuture = occurrences.filter(o => isPublicEvent(o.title) && o.dateStr >= today)
    console.log(`  ${publicFuture.length} public upcoming occurrences (from ${occurrences.length} total)`)

    if (publicFuture.length === 0) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: occurrences.length === 0 ? 'error' : 'ok',
        errorMessage: occurrences.length === 0
          ? 'Calendar grid parsed 0 occurrences — Drupal markup may have changed (expected /calendar-field_cal_date/day/ + /events/ links).'
          : undefined,
        durationMs:  Date.now() - start,
        eventsFound: occurrences.length,
      })
      console.warn('  ⚠ Nothing to ingest — exiting 0.')
      process.exit(0)
    }

    const organizerId = await ensureOrganization('City of Cuyahoga Falls', {
      website:     BASE_URL,
      description: 'City of Cuyahoga Falls (Summit County, OH) — municipal and Parks & Recreation programming including Falls Downtown Fridays, Front Street Live, the Riverfront Cruise In, Picnic In The Park, the Community Band and Keyser concert series, Flix on the Falls, and Quirk Cultural Center events.',
    })
    const defaultVenueId = await ensureVenue('Downtown Cuyahoga Falls', {
      city: 'Cuyahoga Falls', state: 'OH', zip: '44221',
      website: 'https://www.cityofcf.com/places/downtown',
    })
    if (organizerId && defaultVenueId) await linkOrganizationVenue(organizerId, defaultVenueId)

    // 2. Enrich + upsert.
    const detailCache = new Map()
    let inserted = 0, skipped = 0
    for (const occ of publicFuture) {
      try {
        const detail = await fetchDetail(occ.slug, detailCache)
        const title = detail.title || occ.title
        const startAt = easternToIso(`${occ.dateStr} ${detail.timeStr}`)
        if (!startAt) { skipped++; continue }

        const row = {
          title,
          description:     detail.description,
          start_at:        startAt,
          end_at:          null,
          category:        mapCategory(title, detail.description || ''),
          tags:            mapTags(title),
          // Never assume free: the city feed has no price field, so leave it
          // unknown (null) rather than asserting $0 for events that may charge.
          price_min:       null,
          price_max:       null,
          age_restriction: 'all_ages',
          image_url:       detail.imageUrl || null,
          ticket_url:      `${BASE_URL}/events/${occ.slug}`,
          source:          SOURCE_KEY,
          source_id:       `${occ.slug}-${occ.dateStr}`,
          status:          'published',
          featured:        false,
        }

        const enrichedRow = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enrichedRow)
        if (error) {
          console.warn(`  ⚠ Upsert failed for "${title}":`, error.message)
          skipped++
          continue
        }
        if (defaultVenueId) await linkEventVenue(upserted.id, defaultVenueId)
        if (organizerId)    await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error processing "${occ.title}":`, err.message)
        skipped++
      }
      await new Promise(r => setTimeout(r, 250))   // polite to detail pages
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: occurrences.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly; importing for tests exposes parseGrid()
// without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
