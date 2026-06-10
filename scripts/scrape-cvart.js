/**
 * scrape-cvart.js
 *
 * Fetches upcoming Artist Receptions and public exhibit-opening events
 * from the Cuyahoga Valley Art Center (CVAC) — a community art center
 * and gallery at 2131 Front St in downtown Cuyahoga Falls. CVAC runs
 * juried members' exhibitions on a rotating schedule, each closing
 * with a public Artist Reception (free admission, ~90 minutes).
 *
 * Platform: cvart.org is WordPress (AIOSEO, no Tribe Events plugin)
 * with a server-rendered /events/ index. Each /events/<slug>/ detail
 * page emits the reception's date+time as two structured lines:
 *   "Fri, August 28, 2026 @ 5:30 pm"
 *   "Fri, August 28, 2026 @ 7:00 pm"
 * Plus the exhibit-run window as:
 *   "ON VIEW: JULY 28 – SEPTEMBER 10, 2026"
 * The page has no Schema.org Event JSON-LD; we extract everything by
 * regex over the rendered body text.
 *
 * Slug filtering: CVAC's /events/ listing mixes two slug families —
 *   call-<name>-NN  (Call For Entries; artist submission deadlines)
 *   <name>-ar-NN    (Artist Receptions; public attendance events)
 * Only AR slugs are ingested. Call-for-entries pages are internal
 * artist deadlines, not events users attend.
 *
 * Why this avoids Akron Life: CVAC is priority #3 in the Akron Life
 * dwindle plan (~7 events / 30 days). Direct ingestion lets the
 * dedup guard drop those Evvnt rows via COVERED_BY_DIRECT_SCRAPER.
 *
 * Usage:
 *   node scripts/scrape-cvart.js
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
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'

// ── Constants ──────────────────────────────────────────────────────────────

const SOURCE_KEY  = 'cvart'
const BASE_URL    = 'https://www.cvart.org'
const LISTING_URL = `${BASE_URL}/events/`
const USER_AGENT  = 'Mozilla/5.0 (compatible; AkronPulseBot/1.0; +https://akronpulse.com)'

const VENUE_INFO = {
  name:    'Cuyahoga Valley Art Center',
  address: '2131 Front St',
  city:    'Cuyahoga Falls',
  state:   'OH',
  zip:     '44221',
  lat:     41.1339,
  lng:     -81.4849,
  website: BASE_URL,
  description:
    "Community art center and gallery in downtown Cuyahoga Falls, ~7 miles north of Akron. " +
    "Hosts juried members' exhibitions on a rotating schedule plus art classes, workshops, " +
    "and public-art programming.",
  parking_type:  'street',
  parking_notes: 'Free on-street parking on Front St plus the public lot at Front & Broad.',
}

const ORG_INFO = {
  name: 'Cuyahoga Valley Art Center',
  details: {
    website: BASE_URL,
    description:
      'Nonprofit community art center founded 1934 (originally The Arts and Crafts Club). ' +
      'Offers classes, workshops, juried exhibitions, and public-art programming.',
  },
}

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

// ── Fetch + listing parse ─────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

/**
 * Pull every /events/<slug>/ URL from the listing HTML, drop the
 * `call-` artist-submission-deadline slugs.
 */
function parseEventUrls(html) {
  const seen = new Set()
  const re = /href="([^"]*\/events\/([A-Za-z0-9_-]+)\/?)"/gi
  for (const m of html.matchAll(re)) {
    const url = m[1]
    const slug = m[2]
    if (!slug || slug === 'events') continue
    if (/^call-/i.test(slug)) continue  // artist submission deadline, not an event
    const abs = url.startsWith('http') ? url : `${BASE_URL}${url}`
    seen.add(abs.replace(/\/?$/, '/'))
  }
  return [...seen]
}

// ── Detail page extraction ───────────────────────────────────────────────

/**
 * Find the pair of reception start/end lines. Two formats observed
 * on cvart.org:
 *
 *   Fri, August 28, 2026 @ 5:30 pm
 *   Fri, August 28, 2026 @ 7:00 pm
 *
 * These render as separate elements (the event-template-shortcode the
 * theme emits). When both are present we use them as start/end. When
 * only one is present we fall back to parsing the
 *   "ARTIST RECEPTION: FRIDAY, AUGUST 28, 2026 | 5:30–7:00 PM"
 * fallback line.
 */
function parseReceptionTimes(text) {
  const pairRe = /([A-Za-z]+),?\s+([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\s*@\s*(\d{1,2}):(\d{2})\s*(am|pm)/gi
  const matches = [...text.matchAll(pairRe)]
  if (matches.length >= 2) {
    return {
      start: toIsoFromParts(matches[0]),
      end:   toIsoFromParts(matches[1]),
    }
  }
  if (matches.length === 1) {
    return { start: toIsoFromParts(matches[0]), end: null }
  }

  // Fallback: "ARTIST RECEPTION: FRIDAY, AUGUST 28, 2026 | 5:30–7:00 PM"
  const fallback = text.match(
    /ARTIST RECEPTION:\s*[A-Z]+,\s*([A-Z]+)\s+(\d{1,2}),\s+(\d{4})\s*\|\s*(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i,
  )
  if (fallback) {
    const [, mon, day, year, sH, sM, eH, eM, mer] = fallback
    const m = MONTH_MAP[mon.toLowerCase()]
    if (!m) return { start: null, end: null }
    // The single AM/PM suffix at the end applies to the END time. Reception
    // pages always start in the afternoon, so if end is "7:00 PM" and start
    // is "5:30", start is also PM. Mirror end's meridiem onto start unless
    // the resulting start would be after end (then flip it).
    let startH = (parseInt(sH, 10) % 12) + (mer.toUpperCase() === 'PM' ? 12 : 0)
    let endH   = (parseInt(eH, 10) % 12) + (mer.toUpperCase() === 'PM' ? 12 : 0)
    if (startH > endH) startH -= 12
    const dateStr = `${year}-${String(m).padStart(2,'0')}-${String(parseInt(day,10)).padStart(2,'0')}`
    return {
      start: easternToIso(`${dateStr} ${String(startH).padStart(2,'0')}:${sM}:00`),
      end:   easternToIso(`${dateStr} ${String(endH).padStart(2,'0')}:${eM}:00`),
    }
  }
  return { start: null, end: null }
}

function toIsoFromParts(match) {
  // match groups: [_, weekday, month, day, year, hr, min, meridiem]
  const [, , mon, day, year, hr, min, mer] = match
  const m = MONTH_MAP[mon.toLowerCase()]
  if (!m) return null
  let h = parseInt(hr, 10) % 12
  if (mer.toLowerCase() === 'pm') h += 12
  const iso = `${year}-${String(m).padStart(2,'0')}-${String(parseInt(day,10)).padStart(2,'0')} ${String(h).padStart(2,'0')}:${min}:00`
  return easternToIso(iso)
}

/**
 * Find the "ON DISPLAY:" / "ON VIEW:" line and return the exhibit
 * window as "Jun 9 – Jul 23, 2026" (informational, surfaced in the
 * description so attendees know the exhibit is up beyond reception
 * night).
 */
function parseExhibitWindow(text) {
  const m = text.match(/\bON (DISPLAY|VIEW):\s*([A-Za-z]+\s+\d{1,2}\s*[–—-]\s*[A-Za-z]+\s+\d{1,2},\s*\d{4})/i)
  return m ? m[2].replace(/\s+/g, ' ').trim() : null
}

/**
 * Best-effort description: pull substantial <p> tags from the main
 * content area. Skips short specifier lines and boilerplate footer.
 */
function parseDescription(html) {
  const main = html.match(/<main\b[\s\S]*?<\/main>/i)?.[0]
    ?? html.match(/<article\b[\s\S]*?<\/article>/i)?.[0]
    ?? html
  const cleaned = main
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<header\b[\s\S]*?<\/header>/gi, '')
    .replace(/<footer\b[\s\S]*?<\/footer>/gi, '')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, '')

  const paras = []
  for (const m of cleaned.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    const txt = stripHtml(m[1]).trim()
    if (txt.length < 80) continue
    if (/^\s*©|\b(privacy policy|all rights reserved|class policies)\b/i.test(txt)) continue
    paras.push(txt)
    if (paras.join(' ').length > 1500) break
  }
  return paras.length === 0 ? null : paras.join('\n\n').slice(0, 1800)
}

/** Page title pulled from the og:title or document title; strip site suffix. */
function parseTitle(html) {
  const og = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i)?.[1]
    ?? html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?? null
  if (!og) return null
  return decodeHtmlEntities(og.split('|')[0]).trim()
}

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
}

// ── Category / tag mapping ───────────────────────────────────────────────

// Category is always 'visual-art' — CVAC is a gallery venue.

function mapTags(title = '') {
  const t = title.toLowerCase()
  const tags = ['cvart', 'cvac', 'art-gallery', 'artist-reception', 'cuyahoga-falls']
  if (/floral|landscape/i.test(t)) tags.push('floral', 'landscape')
  if (/juried/i.test(t))           tags.push('juried-exhibition')
  if (/wpa\b/i.test(t))            tags.push('works-on-paper')
  if (/members/i.test(t))          tags.push('members-show')
  return [...new Set(tags)]
}

// ── Process + upsert ─────────────────────────────────────────────────────

async function processEvents(detailPages, venueId, organizerId) {
  let inserted = 0, skipped = 0
  for (const { url, html } of detailPages) {
    try {
      const title = parseTitle(html)
      if (!title) { skipped++; continue }

      const bodyText = stripHtml(html)
      const { start, end } = parseReceptionTimes(bodyText)
      if (!start) {
        // Page exists but reception date isn't yet posted — common for
        // future exhibits with TBD reception dates. Skip without raising.
        skipped++
        continue
      }

      // Past-event guard
      if (new Date(start).getTime() < Date.now() - 86_400_000) {
        skipped++
        continue
      }

      const onView = parseExhibitWindow(bodyText)
      let description = parseDescription(html)
      // If we know the exhibit window and the description doesn't already
      // mention it, prepend a one-line note so attendees see both dates.
      if (onView && description && !new RegExp(onView, 'i').test(description)) {
        description = `Exhibit on view: ${onView}.\n\n${description}`
      } else if (onView && !description) {
        description = `Exhibit on view: ${onView}.`
      }

      const slugMatch = url.match(/\/events\/([^/]+)/)
      const sourceId  = slugMatch ? slugMatch[1] : url

      const row = {
        title,
        description,
        start_at:        start,
        end_at:          end,
        category:        'visual-art',
        tags:            mapTags(title),
        price_min:       null,
        price_max:       null,
        age_restriction: 'all_ages',
        image_url:       null,    // detail pages reuse the org logo; not useful
        ticket_url:      url,
        source:          SOURCE_KEY,
        source_id:       sourceId,
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
      console.warn(`  ⚠ Error processing ${url}:`, err.message)
      skipped++
    }
  }
  return { inserted, skipped }
}

// ── Entry point ──────────────────────────────────────────────────────────

async function main() {
  console.log('🎨  Starting Cuyahoga Valley Art Center ingestion…')
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

    console.log(`\n🔍  Fetching ${LISTING_URL}…`)
    const listingHtml = await fetchHtml(LISTING_URL)
    const eventUrls = parseEventUrls(listingHtml)
    console.log(`  Found ${eventUrls.length} candidate event URLs (call-* slugs dropped)`)

    const detailPages = []
    for (const url of eventUrls) {
      try {
        const html = await fetchHtml(url)
        detailPages.push({ url, html })
      } catch (err) {
        console.warn(`  ⚠ Failed to fetch ${url}: ${err.message}`)
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

// Run only when invoked directly (`node scripts/scrape-cvart.js`); importing the module
// for tests exposes the pure parsers without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
