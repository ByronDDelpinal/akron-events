/**
 * scrape-better-kenmore.js
 *
 * Better Kenmore CDC — community development corporation for Akron's Kenmore
 * neighborhood and the historic Kenmore Boulevard business district.
 *   https://www.betterkenmore.org/upcoming-events/
 *
 * The site is WordPress running the Events Manager plugin. The
 * /upcoming-events/ list renders one structured item per event:
 *
 *   <div class="em-event em-item">
 *     … a /events/{slug}/ permalink (the title link AND a "More Info" link) …
 *     <div class="em-item-meta-line em-event-date">Friday June 5, 2026</div>
 *     <div class="em-item-meta-line em-event-time">7:00 pm - 10:00 pm</div>
 *     <div class="em-item-meta-line em-event-location">…</div>
 *   </div>
 *
 * IMPORTANT: the list markup is unreliable for the *title* — the only link
 * text Events Manager exposes per item can be the literal "More Info" button,
 * and the list carries no event description at all. So we use the list only to
 * harvest each event's permalink + date/time/location, then fetch the event's
 * own detail page and read its Open Graph tags (og:title / og:description /
 * og:image) for the real title, the full description, and the hero image.
 *
 * `source_id` is the permalink's final path segment, which Events Manager keeps
 * stable and unique (recurring occurrences carry the date in the slug), so
 * re-runs update in place rather than duplicating.
 *
 * Usage:   node scripts/scrape-better-kenmore.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import {
  decodeEntities,
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
  easternTodayIso,
} from './lib/normalize.js'
import { pathToFileURL } from 'node:url'

const SOURCE_KEY = 'better_kenmore'
const EVENTS_URL = 'https://www.betterkenmore.org/upcoming-events/'
const ORIGIN = 'https://www.betterkenmore.org'

const MONTH_MAP = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
}

// ── Field helpers ────────────────────────────────────────────────────────────

/** "Friday June 5, 2026" → "2026-06-05" (weekday ignored). */
export function parseDate(text) {
  if (!text) return null
  const m = stripHtml(text).match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (!m) return null
  const month = MONTH_MAP[m[1].toLowerCase()]
  if (!month) return null
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`
}

/** "9:30 am - 10:30 am" → "09:30:00" (start time). "All Day"/empty → 00:00:00. */
export function parseTime(text) {
  if (!text) return '00:00:00'
  const m = stripHtml(text).match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i)
  if (!m) return '00:00:00'
  let hr = parseInt(m[1], 10)
  const min = m[2] ?? '00'
  const isPm = /pm/i.test(m[3])
  if (isPm && hr !== 12) hr += 12
  if (!isPm && hr === 12) hr = 0
  return `${String(hr).padStart(2, '0')}:${min}:00`
}

function firstMatch(html, re) {
  const m = html.match(re)
  return m ? m[1] : null
}

function metaLine(chunk, cls) {
  return stripHtml(
    firstMatch(chunk, new RegExp(`class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`, 'i')) || '',
  ) || null
}

/** Last path segment of an /events/{slug}/ permalink — our stable source_id. */
export function permalinkSlug(href) {
  try {
    const segs = new URL(href, ORIGIN).pathname.split('/').filter(Boolean)
    return segs.length ? segs[segs.length - 1] : null
  } catch {
    return null
  }
}

/**
 * Human-readable title derived from a permalink slug. Fallback only — used when
 * the detail page can't be fetched. Strips trailing recurrence date chains
 * (…-2026-06-07) and a trailing numeric occurrence suffix (…-2) before
 * title-casing.
 */
export function deSlugTitle(slug) {
  if (!slug) return 'Better Kenmore Event'
  const cleaned = String(slug)
    .replace(/(?:-\d{4}-\d{2}-\d{2})+$/i, '')
    .replace(/-\d+$/i, '')
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
  return cleaned || 'Better Kenmore Event'
}

// Category: infer from title (location text adds noise, not signal).
function mapCategory(title = '') {
  return inferCategory(title, '')
}

// ── Venue aliasing ───────────────────────────────────────────────────────────
// The CDC's location strings are free text and often a bare street address.
// That minted a junk venue literally NAMED "1000 Kenmore Blvd" (no address),
// and since dedupe buckets by location, a Rialto show the CDC republished
// could never group with the rialto scraper's copy — it showed twice on the
// site (2026-06-11). This alias maps the Rialto's known name/address strings to
// the canonical venue record (with correct address details).
//
// Defense in depth: even when a Boulevard address ISN'T aliased here, the
// shared ingest layer now refuses to mint a venue whose NAME is a bare street
// address — ensureVenue routes it to an existing venue by matching the
// normalized `address` column, or skips creation. See normalizeStreetAddress /
// resolveVenueByAddress in lib/normalize.js. So this list only needs entries
// for informal NAMES that address-matching can't catch ("The Rialto").
//
// We alias rather than SKIP, because the CDC also runs unique events AT these
// addresses (the Kenmore Cowbell 7K starts at the Rialto's address) — dedupe
// deletes the true duplicates and the unique events survive with a correct venue.
const VENUE_ALIASES = [
  {
    re: /\brialto\b|^1000 kenmore blvd\.?$/i,
    name: 'The Rialto Theatre',
    details: { address: '1000 Kenmore Blvd', city: 'Akron', state: 'OH' },
  },
]

/** Resolve a CDC location string to a canonical venue, or null when the
 *  location is not a known alias. Exported for tests. */
export function resolveVenueAlias(location = '') {
  const loc = (location || '').trim()
  if (!loc) return null
  for (const alias of VENUE_ALIASES) {
    if (alias.re.test(loc)) return { name: alias.name, details: alias.details }
  }
  return null
}

// ── Direct-source suppression ─────────────────────────────────────────────────
// Some venues the CDC re-lists are ones we already scrape DIRECTLY from the
// venue's own site, which is the higher-fidelity source of truth. When a CDC
// item is at such a venue we SKIP it entirely and let the direct scraper be
// canonical.
//
// Why skip rather than alias+dedupe (the Rialto approach above)? Dedupe groups
// by venue + date, so it only collapses copies that agree on the date. First
// Glance is a case where the CDC's republished schedule DISAGREES with the
// venue's own (e.g. the CDC lists Rec Night on Fridays while firstglance.org
// lists it on Thursdays) and even republishes programs the venue has since
// PAUSED (Hip Hop Night). Those never align, so dedupe can't catch them and
// they surface as conflicting, sometimes-stale duplicates. Suppressing at the
// source keeps First Glance's own site authoritative for its programming.
//
// Matched against the CDC location free text by name or street address.
const DIRECTLY_SCRAPED_VENUES = [
  { source: 'first_glance', re: /first\s*glance|\b943\s+kenmore\s+blvd/i },
]

/** If the CDC location is a venue we scrape directly, return that source key
 *  (so the caller can skip it); otherwise null. Exported for tests. */
export function directlyScrapedVenue(location = '') {
  const loc = (location || '').trim()
  if (!loc) return null
  for (const v of DIRECTLY_SCRAPED_VENUES) {
    if (v.re.test(loc)) return v.source
  }
  return null
}

// ── List parse ────────────────────────────────────────────────────────────────

export function parseEvents(html) {
  const events = []
  // Split into Events Manager items.
  const chunks = html.split(/<div[^>]*class="[^"]*\bem-event\b[^"]*\bem-item\b[^"]*"/i)
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]

    // Permalink: first /events/ link in the item. Both the title link and the
    // "More Info" button point at the same permalink, so the href is reliable
    // even though the link *text* is not.
    const linkMatch = chunk.match(/<a[^>]+href="([^"]*\/events\/[^"#?]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
    if (!linkMatch) continue
    let href = linkMatch[1]
    if (href.startsWith('/')) href = ORIGIN + href

    const sourceId = permalinkSlug(href)
    if (!sourceId || sourceId === 'events') continue

    const dateStr = parseDate(metaLine(chunk, 'em-event-date'))
    if (!dateStr) continue
    const timeStr = parseTime(metaLine(chunk, 'em-event-time'))
    const location = metaLine(chunk, 'em-event-location')
    const imageUrl = firstMatch(chunk, /<img[^>]+(?:data-src|src)="([^"]+\.(?:jpe?g|png|webp)[^"]*)"/i)

    // Tentative title from the list — usually unreliable ("More Info"); the
    // detail-page Open Graph title overrides it in main().
    const listTitle = stripHtml(linkMatch[2])

    events.push({ listTitle, dateStr, timeStr, location, ticketUrl: href, imageUrl, sourceId })
  }
  return events
}

// ── Detail-page parse (Open Graph) ─────────────────────────────────────────────

/** Read a <meta property="og:*"> content value, tolerant of attribute order. */
function metaContent(html, prop) {
  const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const a = html.match(new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([\\s\\S]*?)["']`, 'i'))
  if (a) return a[1]
  const b = html.match(new RegExp(`<meta[^>]+content=["']([\\s\\S]*?)["'][^>]+property=["']${escaped}["']`, 'i'))
  return b ? b[1] : null
}

/**
 * Extract { title, description, image } from an event detail page. Prefers the
 * Open Graph tags Events Manager (Yoast) emits; falls back to the <h1> for the
 * title. The og:description is prefixed with a "Friday June 5, 2026 @ 7:00 pm -
 * 10:00 pm - " date/time string and sometimes ends with a bare share URL — both
 * are stripped so we store clean copy.
 */
export function extractDetail(html) {
  const rawTitle = metaContent(html, 'og:title') || firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) || ''
  const title = decodeEntities(stripHtml(rawTitle))
    .replace(/\s*[|–-]\s*Better Kenmore\s*$/i, '')
    .trim()

  let description = decodeEntities(metaContent(html, 'og:description') || '')
  description = description
    // Leading "Weekday Month D, YYYY @ H:MM am - H:MM pm - " date/time prefix.
    .replace(/^[A-Za-z]+\s+[A-Za-z]+\s+\d{1,2},\s*\d{4}\s*@\s*[\d:]+\s*[ap]m\s*(?:-\s*[\d:]+\s*[ap]m\s*)?-\s*/i, '')
    // Trailing bare share URL (Facebook event link, etc.).
    .replace(/\s*https?:\/\/\S+\s*$/i, '')
    .trim()

  const image = metaContent(html, 'og:image')

  return { title: title || null, description: description || null, image: image || null }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎸  Starting Better Kenmore ingestion (Events Manager list + OG detail)…')
  const start = Date.now()

  try {
    const html = await fetchHtml(EVENTS_URL)
    const parsed = parseEvents(html)
    console.log(`  Parsed ${parsed.length} events`)

    const today = easternTodayIso()
    const future = parsed.filter(e => e.dateStr >= today)
    console.log(`  ${future.length} upcoming (dropped ${parsed.length - future.length} past)`)

    if (future.length === 0) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: parsed.length === 0 ? 'error' : 'ok',
        errorMessage: parsed.length === 0
          ? 'Page fetched but 0 events parsed — the Events Manager markup may have changed (expected .em-event.em-item with .em-event-date and a /events/ permalink).'
          : undefined,
        durationMs:  Date.now() - start,
        eventsFound: parsed.length,
      })
      console.warn('  ⚠ No upcoming events — exiting 0.')
      process.exit(0)
    }

    const organizerId = await ensureOrganization('Better Kenmore CDC', {
      website:     'https://www.betterkenmore.org',
      description: "Better Kenmore CDC works to improve quality of life in Akron's Kenmore neighborhood — its second-largest — through cultural, artistic, recreational, and business revitalization along the historic Kenmore Boulevard. Hosts the BLVD Block Party, Kenmore First Friday Festival, the Rialto Living Room concert series, and recurring Kenmore Senior Community Center programming.",
    })

    let inserted = 0, skipped = 0, suppressed = 0
    const venueCache = new Map()

    for (const ev of future) {
      try {
        // Skip events at venues we scrape directly — the venue's own site is
        // canonical (see DIRECTLY_SCRAPED_VENUES).
        const directSource = directlyScrapedVenue(ev.location)
        if (directSource) {
          console.log(`  ⤿ Skipping "${ev.sourceId}" — "${ev.location}" is scraped directly via ${directSource}`)
          suppressed++
          continue
        }

        const startAt = easternToIso(`${ev.dateStr} ${ev.timeStr}`)
        if (!startAt) { skipped++; continue }

        // Fetch the detail page for the real title, description, and image.
        // Failures fall back to a slug-derived title so we never store the
        // "More Info" button text or a blank record.
        let detail = { title: null, description: null, image: null }
        try {
          detail = extractDetail(await fetchHtml(ev.ticketUrl))
        } catch (e) {
          console.warn(`  ⚠ Detail fetch failed for ${ev.ticketUrl}: ${e.message}`)
        }
        await sleep(250) // be polite between detail-page requests

        const title =
          detail.title ||
          (ev.listTitle && !/^more\s*info$/i.test(ev.listTitle) ? ev.listTitle : deSlugTitle(ev.sourceId))
        const description = detail.description || null
        const imageUrl = ev.imageUrl || detail.image || null

        let venueId = null
        const alias = resolveVenueAlias(ev.location)
        const venueName = alias?.name ?? (ev.location || 'Kenmore Boulevard')
        if (alias) {
          console.log(`  ⇒ Venue alias: "${ev.location}" → ${alias.name}`)
        }
        if (venueCache.has(venueName)) {
          venueId = venueCache.get(venueName)
        } else {
          venueId = await ensureVenue(venueName, alias?.details ?? { city: 'Akron', state: 'OH' })
          venueCache.set(venueName, venueId)
        }
        if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

        const row = {
          title,
          description,
          start_at:        startAt,
          end_at:          null,
          category:        mapCategory(title),
          tags:            ['better-kenmore', 'kenmore', 'akron'],
          price_min:       null,
          price_max:       null,
          age_restriction: 'all_ages',
          image_url:       imageUrl,
          ticket_url:      ev.ticketUrl,
          source:          SOURCE_KEY,
          source_id:       ev.sourceId,
          status:          'published',
          featured:        false,
        }

        const enrichedRow = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enrichedRow)
        if (error) {
          console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
          skipped++
          continue
        }
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error processing "${ev.sourceId}":`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped + suppressed, {
      eventsFound: parsed.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped, ${suppressed} suppressed (direct-source venues)`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
