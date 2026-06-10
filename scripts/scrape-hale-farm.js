/**
 * scrape-hale-farm.js
 *
 * Fetches upcoming events from Hale Farm & Village — a 90-acre living-history
 * museum in Bath Township (Summit County) operated by the Western Reserve
 * Historical Society. Hale Farm runs ~30 events / 6 months including
 * glassblowing and natural-dyeing workshops, family farm days, the Made in
 * Ohio Art & Craft Festival, murder-mystery dinners, and seasonal heritage
 * programming.
 *
 * Platform: WRHS runs a server-rendered Lucy CMS calendar at
 *   https://www.wrhs.org/do-see/events/{YYYY}/{MM}
 * The calendar renders as an HTML table of `<td>` cells, each with `.title`,
 * `.location`, and a `/do-see/events/YYYY/MM/DD/<slug>` link. WRHS also runs
 * the Cleveland History Center (~30 mi north — outside our 25-mile Akron
 * radius), so we filter on the `.location` text to keep only `Hale Farm &
 * Village` and drop Cleveland History Center / Crawford Auto Aviation Museum
 * events at parse time.
 *
 * Per-event detail page exposes a tidy `og:title` of the form
 *   "<Title> | <Day, Mon DD, YYYY HH:MM am – HH:MM pm> | WRHS"
 * which is the cleanest source for title + time range. The date comes from
 * the URL slug; the description is scraped from the main body content; the
 * banner image is `og:image`.
 *
 * Why this avoids Akron Life: Hale Farm is the single highest-volume
 * organiser in the Akron Life Evvnt feed (~32 events / 30 days). Direct
 * ingestion lets us drop those rows from akron_life via
 * COVERED_BY_DIRECT_SCRAPER so we stop relying on Evvnt's flaky category
 * tagging for them.
 *
 * Usage:
 *   node scripts/scrape-hale-farm.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
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

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_KEY     = 'hale_farm'
const BASE_URL       = 'https://www.wrhs.org'
const MONTHS_AHEAD   = 6                       // calendar pages to walk forward from today
const DEFAULT_TIME   = '09:00:00'              // when og:title omits a start time
const USER_AGENT     = 'Mozilla/5.0 (compatible; AkronPulseBot/1.0; +https://akronpulse.com)'

const VENUE_INFO = {
  name:    'Hale Farm & Village',
  address: '2686 Oak Hill Rd',
  city:    'Bath',
  state:   'OH',
  zip:     '44210',
  lat:     41.2017,
  lng:     -81.6486,
  website: 'https://www.wrhs.org/halefarm',
  description:
    "Living-history museum and 90-acre 19th-century farm in Bath Township operated by the " +
    "Western Reserve Historical Society. Programming includes craft workshops (glassblowing, " +
    "natural dyeing), family farm days, the Made in Ohio Art & Craft Festival, and seasonal " +
    "heritage events.",
  parking_type:  'lot',
  parking_notes: 'Free on-site parking lot.',
}

const ORG_INFO = {
  name: 'Western Reserve Historical Society',
  details: {
    website:     'https://www.wrhs.org',
    description:
      'Northeast Ohio\'s oldest cultural institution. Operates Hale Farm & Village in Bath ' +
      'Township and the Cleveland History Center in University Circle.',
  },
}

// ── Listing fetch + parse ─────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

/**
 * Months to walk: current month plus MONTHS_AHEAD forward months. The Lucy
 * calendar URL is /do-see/events/YYYY/MM (no DD). Returns an array of
 * { year, month } pairs.
 */
function monthsToWalk() {
  const out = []
  const today = new Date()
  for (let i = 0; i < MONTHS_AHEAD; i++) {
    const d = new Date(today.getFullYear(), today.getMonth() + i, 1)
    out.push({ year: d.getFullYear(), month: d.getMonth() + 1 })
  }
  return out
}

/**
 * Pull every Hale Farm event URL out of a single month's listing HTML.
 *
 * The calendar is a table; each `<td class="filled …">` cell holds one
 * event with `.title`, `.location`, and an anchor to the detail page.
 * Cells can repeat the same event across multiple days (multi-day shows),
 * so we Set-dedupe by href before returning.
 */
function parseHaleFarmHrefs(html) {
  const seen = new Set()
  // Walk every <td> that contains a /do-see/events/YYYY/MM/DD/ link.
  const tdRe = /<td\b[^>]*class="([^"]*)"[^>]*>([\s\S]*?)<\/td>/gi
  for (const m of html.matchAll(tdRe)) {
    const inner = m[2]
    const hrefMatch = inner.match(/href="(\/do-see\/events\/\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9_-]+)"/)
    if (!hrefMatch) continue
    const locMatch = inner.match(/<[^>]*class="[^"]*\blocation\b[^"]*"[^>]*>([\s\S]*?)<\//i)
    const location = locMatch ? stripHtml(locMatch[1]).trim() : ''
    // Skip Cleveland History Center, Crawford Auto Aviation Museum, and
    // anything else that isn't the Bath Township farm — those are 30+ mi
    // outside our 25-mile Akron radius.
    if (!/^Hale Farm/i.test(location)) continue
    seen.add(hrefMatch[1])
  }
  return [...seen]
}

// ── Detail page parse ─────────────────────────────────────────────────────

/** Pull a meta tag's content attribute by property/name. */
function readMeta(html, key) {
  const re = new RegExp(`<meta\\s+(?:property|name)="${key}"\\s+content="([^"]*)"`, 'i')
  return html.match(re)?.[1] ?? null
}

/**
 * Parse the og:title into { title, startTime, endTime } where times are
 * "HH:MM:SS" 24h or null.
 *
 * Format:
 *   "Glassblowing Workshop | Thursday, June 04, 2026 11:00 am – 12:30 pm | WRHS"
 *
 * Falls back gracefully — a missing time range just returns null times,
 * and the caller uses DEFAULT_TIME.
 */
function parseOgTitle(raw) {
  if (!raw) return { title: null, startTime: null, endTime: null }
  const parts = raw.split('|').map(s => s.trim()).filter(Boolean)
  if (parts.length === 0) return { title: null, startTime: null, endTime: null }
  const title = parts[0] || null
  // Time range usually in part[1]; en-dash, em-dash, or hyphen between.
  const dateLine = parts.slice(1, parts.length - 1).join(' ')
  const timeRange = dateLine.match(
    /(\d{1,2}):(\d{2})\s*(am|pm)\s*[–—-]\s*(\d{1,2}):(\d{2})\s*(am|pm)/i,
  )
  const timeSingle = dateLine.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i)
  let startTime = null, endTime = null
  if (timeRange) {
    startTime = to24h(timeRange[1], timeRange[2], timeRange[3])
    endTime   = to24h(timeRange[4], timeRange[5], timeRange[6])
  } else if (timeSingle) {
    startTime = to24h(timeSingle[1], timeSingle[2], timeSingle[3])
  }
  return { title, startTime, endTime }
}

function to24h(hr, min, mer) {
  let h = parseInt(hr, 10) % 12
  if (mer.toLowerCase() === 'pm') h += 12
  return `${String(h).padStart(2, '0')}:${min.padStart(2, '0')}:00`
}

/**
 * Parse YYYY/MM/DD off the event slug. Listing-confirmed format:
 *   /do-see/events/2026/06/04/glassblowing-workshop
 */
function parseDateFromHref(href) {
  const m = href.match(/\/do-see\/events\/(\d{4})\/(\d{2})\/(\d{2})\//)
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

/**
 * Best-effort description from the page body. Strategy:
 *   1. Strip script/style/nav blocks
 *   2. Grab the first run of <p> tags inside the page
 *   3. Filter to substantive text (>=60 chars) so we skip "Ages:" /
 *      "Capacity:" / "Fee:" specifier lines that aren't the bio
 *
 * Returns the joined paragraphs (max ~1200 chars) or null.
 */
function parseDescription(html) {
  // Get text inside the main content. Strip nav + footer to avoid grabbing
  // WRHS's site-wide programs list.
  const main = html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html
  const cleaned = main
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<header\b[\s\S]*?<\/header>/gi, '')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, '')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, '')

  const paras = []
  const pRe = /<p\b[^>]*>([\s\S]*?)<\/p>/gi
  for (const m of cleaned.matchAll(pRe)) {
    const txt = stripHtml(m[1]).trim()
    if (txt.length < 60) continue          // skip "Ages:", "Capacity:" specifier lines
    if (/^\s*©|\b(privacy policy|all rights reserved)\b/i.test(txt)) continue
    paras.push(txt)
    if (paras.join(' ').length > 1200) break
  }
  if (paras.length === 0) return null
  return paras.join('\n\n').slice(0, 1500)
}

/** First dollar amount in the page body (e.g. "$75 General Public"). */
function parsePrice(html) {
  const main = html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ?? html
  const text = stripHtml(main)
  const range = text.match(/\$([\d.,]+)\s*[-–—]\s*\$([\d.,]+)/)
  if (range) {
    return {
      min: parseFloat(range[1].replace(/,/g, '')),
      max: parseFloat(range[2].replace(/,/g, '')),
    }
  }
  const single = text.match(/\$([\d.,]+)/)
  if (single) return { min: parseFloat(single[1].replace(/,/g, '')), max: null }
  return { min: null, max: null }
}

// ── Category / tag mapping ───────────────────────────────────────────────

// Category: infer from title + description.
function mapCategory(title = '', description = '') {
  return inferCategory(title, description)
}

function mapTags(title = '') {
  const t = title.toLowerCase()
  const tags = ['hale-farm', 'historical', 'wrhs', 'bath-township']
  if (/glassblow/i.test(t))      tags.push('glassblowing', 'craft')
  if (/dyeing|indigo/i.test(t))  tags.push('natural-dyeing', 'craft')
  if (/blacksmith/i.test(t))     tags.push('blacksmithing', 'craft')
  if (/fun on the farm/i.test(t)) tags.push('family', 'kids')
  if (/made in ohio/i.test(t))   tags.push('art-fair', 'ohio-artisans')
  if (/murder mystery/i.test(t)) tags.push('immersive', 'mystery')
  return [...new Set(tags)]
}

// ── Process ──────────────────────────────────────────────────────────────

async function processEvents(detailPages, venueId, organizerId) {
  let inserted = 0, skipped = 0
  for (const { href, html } of detailPages) {
    try {
      const ogTitle = readMeta(html, 'og:title')
      const ogImage = readMeta(html, 'og:image')
      const { title, startTime, endTime } = parseOgTitle(ogTitle)
      if (!title) { skipped++; continue }

      const dateStr = parseDateFromHref(href)
      if (!dateStr) { skipped++; continue }

      const startAt = easternToIso(`${dateStr} ${startTime ?? DEFAULT_TIME}`)
      const endAt   = endTime ? easternToIso(`${dateStr} ${endTime}`) : null
      if (!startAt) { skipped++; continue }

      // Skip events more than a day in the past — WRHS occasionally leaves
      // wrap-up info on past detail pages.
      if (new Date(startAt).getTime() < Date.now() - 86_400_000) {
        skipped++
        continue
      }

      const description = parseDescription(html)
      const { min: priceMin, max: priceMax } = parsePrice(html)

      const row = {
        title,
        description,
        start_at:        startAt,
        end_at:          endAt,
        category:        mapCategory(title, description ?? ''),
        tags:            mapTags(title),
        price_min:       priceMin,
        price_max:       priceMax,
        age_restriction: 'all_ages',
        image_url:       ogImage,
        ticket_url:      `${BASE_URL}${href}`,
        source:          SOURCE_KEY,
        // Source ID = URL slug (already unique per event-date). Strip the
        // /do-see/events/ prefix so we don't store path noise.
        source_id:       href.replace(/^\/do-see\/events\//, ''),
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
      if (venueId)     await linkEventVenue(upserted.id, venueId)
      if (organizerId) await linkEventOrganization(upserted.id, organizerId)
      inserted++
    } catch (err) {
      console.warn(`  ⚠ Error processing ${href}:`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Entry point ──────────────────────────────────────────────────────────

async function main() {
  console.log('🚜  Starting Hale Farm & Village ingestion…')
  const start = Date.now()

  try {
    const venueId = await ensureVenue(VENUE_INFO.name, {
      address:       VENUE_INFO.address,
      city:          VENUE_INFO.city,
      state:         VENUE_INFO.state,
      zip:           VENUE_INFO.zip,
      lat:           VENUE_INFO.lat,
      lng:           VENUE_INFO.lng,
      website:       VENUE_INFO.website,
      description:   VENUE_INFO.description,
      parking_type:  VENUE_INFO.parking_type,
      parking_notes: VENUE_INFO.parking_notes,
    })
    const organizerId = await ensureOrganization(ORG_INFO.name, ORG_INFO.details)
    if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)

    // ── Listing pass: walk N months ahead, collect Hale Farm hrefs ──────
    const months = monthsToWalk()
    const allHrefs = new Set()
    for (const { year, month } of months) {
      const mm  = String(month).padStart(2, '0')
      const url = `${BASE_URL}/do-see/events/${year}/${mm}`
      console.log(`\n🔍  Fetching ${url}…`)
      const html = await fetchHtml(url)
      const hrefs = parseHaleFarmHrefs(html)
      console.log(`  Found ${hrefs.length} Hale Farm event hrefs`)
      hrefs.forEach(h => allHrefs.add(h))
    }
    console.log(`\n  Unique events across ${months.length} months: ${allHrefs.size}`)

    // ── Detail pass: fetch each event page ─────────────────────────────
    const detailPages = []
    for (const href of allHrefs) {
      try {
        const html = await fetchHtml(`${BASE_URL}${href}`)
        detailPages.push({ href, html })
      } catch (err) {
        console.warn(`  ⚠ Failed to fetch ${href}: ${err.message}`)
      }
    }

    console.log(`\n📥  Processing ${detailPages.length} events…`)
    const { inserted, skipped } = await processEvents(detailPages, venueId, organizerId)

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: detailPages.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly (`node scripts/scrape-hale-farm.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
