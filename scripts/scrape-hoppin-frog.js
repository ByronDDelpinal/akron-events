/**
 * scrape-hoppin-frog.js
 *
 * Hoppin' Frog Brewery — an award-winning craft brewery and taproom in Akron
 * (1680 E Waterloo Rd, Summit County). Its taproom hosts trivia nights, live
 * "Patio Music" days, beer releases, car shows, and other special events.
 *
 * Platform: custom WordPress (Craftpeak/Arryved "cooler" theme). NOT The Events
 * Calendar (Tribe) — /wp-json/tribe/... 404s and there is no iCal feed. Events
 * live as a server-rendered archive (list) at /events/ plus one detail page per
 * event at /event/<slug>/. Both are plain HTML, so this scraper:
 *
 *   1. Fetches the /events/ archive and extracts one card per upcoming event
 *      (url, slug, event-type, title, image) — see parseArchiveCards().
 *   2. Fetches each event's detail page and reads the canonical date/time from
 *      the `<span class='ui-label color--dark' title='...'>` element, a clean
 *      JSON-LD WebPage `description`, and the og:image — see parseDetail().
 *   3. Combines them: the slug carries the authoritative start date incl. YEAR
 *      (e.g. car-show-2026-07-16); the ui-label carries the time(s) and, for
 *      multi-day events, the end date (e.g. "July 20 3:00 pm - July 26 5:00 pm").
 *
 * Markup quirks:
 *   • The archive card date ("Jul 16 @ Tasting Room") has NO time and NO year —
 *     both come from the slug + detail ui-label, never synthesized.
 *   • Every page carries a site-wide "Are you 21 or older?" age gate; that is a
 *     website modal, NOT a per-event restriction, so it is ignored. Age is only
 *     set from explicit event copy (21+) or "family-friendly" → all_ages.
 *   • Single fixed venue in Akron (Summit County) → status always 'published'.
 *
 * Overlap: visit_akron_cvb already lists some Hoppin' Frog programming (e.g.
 * "Can Night Every Thursday"); this becomes the canonical first-party source and
 * cross-source dedupe / aggregator suppression handle the overlap downstream.
 *
 * Usage:  node scripts/scrape-hoppin-frog.js
 * Env:    VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
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
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
  easternToIso,
} from './lib/normalize.js'

const ARCHIVE_URL = 'https://hoppinfrog.com/events/'
const SITE_BASE   = 'https://hoppinfrog.com'
const SOURCE_KEY  = 'hoppin_frog'

const VENUE_NAME     = "Hoppin' Frog Brewery"
const VENUE_FALLBACK = {
  address: '1680 E Waterloo Rd',
  city:    'Akron',
  state:   'OH',
  zip:     '44306',
  website: SITE_BASE,
  description:
    "Hoppin' Frog Brewery is an award-winning craft brewery and taproom in " +
    'Akron, serving big, flavorful beers alongside food, trivia, live music, ' +
    'and community events.',
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
}

// Cancelled/postponed events are left in the archive with a title marker rather
// than removed. Title-scoped (never description) per the shared convention.
const CANCELLED_RE = /\bcancel?led\b|\bpostponed\b/i

// ── Category / tag hints ────────────────────────────────────────────────────
const MUSIC_RE = /\b(live music|patio music|concert|acoustic|\bband\b|\bdj\b|singer|songwriter|open mic|karaoke)\b/i
const GAMES_RE = /\b(trivia|bingo|game night|euchre|quizzo|pub quiz|quiz night)\b/i
const ARTS_RE  = /\b(paint|craft|make.?and.?take|\bdiy\b|succulent)\b/i
const DRINK_RE = /\b(beer release|tasting|\brelease\b|shandy|\bale\b|\blager\b|\bstout\b|\bipa\b|on draft|beer box|christmas in july|tower tuesday|pint night|brunch|cocktail)\b/i

/**
 * Content-category hint (upsertEventSafe still runs text inference and may
 * enrich toward a second category). Order matters: music → games → arts →
 * food, else null so inference decides.
 * @returns {string|null}
 */
export function mapCategory({ title = '', description = '', eventTypeSlug = '' }) {
  const text = `${title} ${description}`
  if (MUSIC_RE.test(text)) return 'music'
  if (GAMES_RE.test(text)) return 'games'
  if (ARTS_RE.test(text))  return 'visual-art'
  if (eventTypeSlug === 'beer-release' || DRINK_RE.test(text)) return 'food'
  return null
}

export function mapTags({ title = '', description = '', eventTypeSlug = '' }) {
  const text = `${title} ${description}`
  const tags = ['brewery', 'hoppin-frog', 'akron']
  if (MUSIC_RE.test(text)) tags.push('live-music')
  if (GAMES_RE.test(text)) tags.push('trivia')
  if (eventTypeSlug === 'beer-release' || /\brelease\b/i.test(text)) tags.push('beer-release')
  return [...new Set(tags)]
}

/**
 * Age restriction from event copy only — never from the site-wide 21+ gate.
 * @returns {'21_plus'|'all_ages'|'not_specified'}
 */
export function mapAgeRestriction(description = '') {
  if (/\b21\s*\+|\b21 and (over|older|up)\b|must be 21|ages 21/i.test(description)) return '21_plus'
  if (/family[- ]friendly|all ages/i.test(description)) return 'all_ages'
  return 'not_specified'
}

// ── Archive (list) parsing ──────────────────────────────────────────────────

/**
 * Extract event cards from the /events/ archive HTML. Each card is an anchor
 * `<a href=".../event/<slug>/" class="excerpt-box ...">`. Returns one object
 * per card: { url, slug, sourceId, eventTypeSlug, title, imageUrl }.
 * Pure — exported for tests.
 */
export function parseArchiveCards(html = '') {
  const cards = []
  const anchorRe = /<a\s+href="(https:\/\/hoppinfrog\.com\/event\/([^"/]+)\/)"\s+class="excerpt-box\b[\s\S]*?<\/a>/g
  let m
  while ((m = anchorRe.exec(html)) !== null) {
    const chunk = m[0]
    const url   = m[1]
    const slug  = m[2]

    const typeMatch  = chunk.match(/event_type-([a-z0-9-]+)/)
    const titleMatch = chunk.match(/<h2 class="excerpt-box-title[^"]*">([\s\S]*?)<\/h2>/i)
    const imgMatch   = chunk.match(/<img class="image"\s+src="([^"]+)"/i)

    const title = titleMatch ? stripHtml(titleMatch[1]).trim() : null
    if (!title) continue

    cards.push({
      url,
      slug,
      sourceId:      slug,
      eventTypeSlug: typeMatch ? typeMatch[1] : null,
      title,
      imageUrl:      imgMatch ? decodeEntities(imgMatch[1]) : null,
    })
  }
  return cards
}

// ── Detail-page parsing ─────────────────────────────────────────────────────

/**
 * Read the fields the archive card lacks from a detail page:
 *   • timeLabel   — the `ui-label color--dark` title text (date + time[s])
 *   • description — the JSON-LD WebPage `description` (clean, entity-decoded)
 *   • imageUrl    — og:image (entity-decoded)
 * Pure — exported for tests.
 */
export function parseDetail(html = '') {
  const labelMatch = html.match(/<span class=['"]ui-label color--dark['"][^>]*\btitle=['"]([^'"]+)['"]/i)
  const timeLabel  = labelMatch ? decodeEntities(labelMatch[1]).trim() : null

  const ogMatch  = html.match(/<meta property="og:image" content="([^"]+)"/i)
  const imageUrl = ogMatch ? decodeEntities(ogMatch[1]) : null

  let description = null
  const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i)
  if (ldMatch) {
    try {
      const data  = JSON.parse(ldMatch[1])
      const nodes = Array.isArray(data['@graph']) ? data['@graph'] : [data]
      const page  = nodes.find((n) => {
        const t = n && n['@type']
        return t === 'WebPage' || (Array.isArray(t) && t.includes('WebPage'))
      })
      if (page && typeof page.description === 'string' && page.description.trim()) {
        description = page.description.trim()
      }
    } catch { /* malformed JSON-LD — leave description null */ }
  }

  return { timeLabel, description, imageUrl }
}

// ── Date/time parsing ───────────────────────────────────────────────────────

/** First time token in a string as a normalized "H:MMam/pm", or null. */
function firstTime(s = '') {
  const m = s.match(/(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/i)
  return m ? `${m[1]}:${m[2]}${m[3].toLowerCase()}m` : null
}

/** "YYYY-MM-DD" start date embedded in the event slug, or null. */
export function dateFromSlug(slug = '') {
  const m = slug.match(/-(\d{4})-(\d{2})-(\d{2})$/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/**
 * Resolve start/end ISO timestamps from the ui-label + slug date.
 *   • slugDate  — authoritative start date (has the year).
 *   • timeLabel — e.g. "July 16 5:00 pm - 8:00 pm"          (same-day range)
 *                      "August 1 11:00 am"                   (single time)
 *                      "July 20 3:00 pm - July 26 5:00 pm"   (multi-day range)
 * The start time comes from the label's first time token; the end date, when a
 * second month/day appears after the dash, is parsed with the year inferred
 * from slugDate (rolling to the next year only if the end month wraps). If the
 * label carries no time at all, start falls back to a timeless (midnight) date
 * — documented, and rare enough to surface via the contract advisory.
 * Pure — exported for tests.
 * @returns {{ start_at: string|null, end_at: string|null }}
 */
export function parseUiLabelDateTime(timeLabel, slugDate) {
  if (!slugDate) return { start_at: null, end_at: null }

  const label = timeLabel || ''
  const [leftPart, rightPart] = label.split(/\s+-\s+/, 2)

  const startTime = firstTime(leftPart || '')
  const start_at  = easternToIso(slugDate, startTime || '')

  let end_at = null
  if (rightPart) {
    const endTime = firstTime(rightPart)
    const endDateMatch = rightPart.match(/([A-Za-z]+)\s+(\d{1,2})\b/)
    let endDate = slugDate
    if (endDateMatch) {
      const endMonth = MONTHS[endDateMatch[1].toLowerCase()]
      const endDay   = parseInt(endDateMatch[2], 10)
      if (endMonth) {
        const [sY, sM] = slugDate.split('-').map(Number)
        const endYear  = endMonth < sM ? sY + 1 : sY
        endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`
      }
    }
    if (endTime) {
      const candidate = easternToIso(endDate, endTime)
      // Guard against a garbled label producing end <= start.
      if (candidate && start_at && Date.parse(candidate) > Date.parse(start_at)) {
        end_at = candidate
      }
    }
  }

  return { start_at, end_at }
}

// ── Row assembly ────────────────────────────────────────────────────────────

/**
 * Combine an archive card + its parsed detail into an upsert-ready row, or null
 * when the event is unparseable or already ended (> ~1 day ago).
 * Pure — exported for tests. `now` is injectable for deterministic testing.
 */
export function buildRow(card, detail, now = Date.now()) {
  if (CANCELLED_RE.test(card.title || '')) return null   // scratched — drop
  const slugDate = dateFromSlug(card.slug)
  const { start_at, end_at } = parseUiLabelDateTime(detail.timeLabel, slugDate)
  if (!start_at) return null

  // Skip anything that ended more than ~1 day ago (archive is upcoming-only,
  // but a lingering multi-day tail could slip through).
  const endedAt = Date.parse(end_at || start_at)
  if (Number.isFinite(endedAt) && endedAt < now - 24 * 3_600_000) return null

  const description = detail.description || null
  const ctx = { title: card.title, description: description || '', eventTypeSlug: card.eventTypeSlug || '' }

  return {
    title:           card.title,
    description,
    start_at,
    end_at,
    category:        mapCategory(ctx),
    tags:            mapTags(ctx),
    price_min:       null,
    price_max:       null,
    age_restriction: mapAgeRestriction(description || ''),
    image_url:       detail.imageUrl || card.imageUrl || null,
    ticket_url:      card.url,
    source_url:      card.url,
    source:          SOURCE_KEY,
    source_id:       card.sourceId,
    status:          'published',
    featured:        false,
  }
}

// ── Fetch helpers ───────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.org)' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🐸  Starting Hoppin' Frog Brewery ingestion…")
  const start = Date.now()

  try {
    const [venueId, organizerId] = await Promise.all([
      ensureVenue(VENUE_NAME, VENUE_FALLBACK),
      ensureOrganization(VENUE_NAME, { website: SITE_BASE, description: VENUE_FALLBACK.description }),
    ])
    if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)

    console.log(`\n🔍  Fetching archive ${ARCHIVE_URL}…`)
    const archiveHtml = await fetchHtml(ARCHIVE_URL)
    const cards = parseArchiveCards(archiveHtml)
    console.log(`  Found ${cards.length} event cards`)

    let inserted = 0, skipped = 0
    for (const card of cards) {
      try {
        const detailHtml = await fetchHtml(card.url)
        const detail = parseDetail(detailHtml)
        const row = buildRow(card, detail)
        if (!row) { console.log(`  – skip (past/undated): ${card.title}`); skipped++; continue }

        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) {
          console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
          skipped++
          continue
        }
        if (venueId) await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
        console.log(`  ✓ ${row.start_at.slice(0, 10)}  ${row.title}`)
      } catch (err) {
        console.warn(`  ⚠ Error processing "${card.title}":`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: cards.length,
      durationMs:  Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

export { ARCHIVE_URL, SITE_BASE, SOURCE_KEY, VENUE_NAME }
