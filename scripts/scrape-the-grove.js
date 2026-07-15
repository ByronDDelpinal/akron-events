/**
 * scrape-the-grove.js
 *
 * The Grove — a wellness studio at 4434 Wadsworth Rd, Norton, OH 44203 (Summit
 * County; verified against the site's JSON-LD PostalAddress and geocoded to
 * "Norton, Summit County, Ohio"). It offers massage therapy plus standing
 * weekly yoga and spin classes. Only the class pages carry a schedule; the
 * massage and studio pages are appointment/rental info with no dated events.
 *
 * Platform: GoDaddy Websites+Marketing static site (thegrove.info). There is no
 * feed and no per-date listings — instead each class page (/spin-classes,
 * /yoga-classes) renders a GoDaddy "Calendar" widget whose cards carry stable
 * data-aid hooks:
 *   data-aid="CALENDAR_EVENT_DATE"  → the weekday, e.g. "Tuesdays" / "Monday"
 *   data-aid="CALENDAR_EVENT_TITLE" → the class title, e.g. "Spin with Hayley"
 *   data-aid="CALENDAR_EVENT_TIME"  → one or more <h4>s making a single time
 *                                     ("5:30pm") or a range ("7 am - 8am")
 *   data-aid="CALENDAR_DESC_TEXT"   → the class description
 * The widget renders every card TWICE (a large-screen grid and a
 * CALENDAR_SMALLER_SCREEN_CONTAINER); the large-screen copy leaves the
 * description empty while the small-screen copy fills it. We parse all cards in
 * document order and dedupe by (weekday + title + start time), preferring the
 * copy that actually carries a description.
 *
 * Event model: each card states a standing weekly slot (weekday + time never
 * hardcoded — if a class moves the next scrape follows). We expand it into the
 * next WEEKS_AHEAD weekly occurrences via lib/weekly-occurrences.js
 * (Eastern-anchored calendar math, immune to the UTC-rollover footgun) paired
 * with easternToIso(ymd, 'HH:MM'). Date-keyed source_ids keep the twice-daily
 * run idempotent. Cards whose title is a "Coming Soon!" placeholder, or that
 * carry no parseable time, are skipped — we only publish what we can date.
 *
 * The venue is fixed and in Summit County, so events publish directly (no
 * classifySummitLocation needed). Price is left NULL — the pages advertise a
 * separate "Pricing & Packages" page but state no per-class price, and we never
 * assume free.
 *
 * Usage:   node scripts/scrape-the-grove.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, easternToIso, stripHtml,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'
import { nextWeeklyOccurrences } from './lib/weekly-occurrences.js'

export const SOURCE_KEY = 'the_grove'
const BASE_URL   = 'https://thegrove.info'
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'
const WEEKS_AHEAD = 8

/** Class pages to ingest. Each has its own GoDaddy calendar widget. */
export const CLASS_PAGES = [
  { key: 'spin', path: '/spin-classes',  discipline: 'spin' },
  { key: 'yoga', path: '/yoga-classes',  discipline: 'yoga' },
]

const ORG_NAME   = 'The Grove'
const VENUE_NAME = 'The Grove'
const VENUE_DETAILS = {
  address: '4434 Wadsworth Rd',
  city: 'Norton', state: 'OH', zip: '44203',
  lat: 41.0468287, lng: -81.6875556,
  website: BASE_URL,
  description: 'Wellness studio in Norton offering massage therapy plus weekly yoga and spin classes for all levels.',
}

// ── Day parsing ──────────────────────────────────────────────────────────────

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/** "Tuesdays"/"Monday" → { index, name } (0=Sunday). null when unrecognized. */
export function dayNameToWeekday(text) {
  const lower = String(text || '').trim().toLowerCase().replace(/s$/, '')
  const index = DAY_NAMES.indexOf(lower)
  return index === -1 ? null : { index, name: lower }
}

// ── Time parsing ─────────────────────────────────────────────────────────────

/** "7", "07", min "30", meridiem "am"/"pm"/null → "HH:MM" (24-hour). */
export function to24h(hourStr, minStr, ampm) {
  let hour = parseInt(hourStr, 10)
  if (Number.isNaN(hour) || hour > 23) return null
  const minute = minStr != null ? minStr : '00'
  if (ampm) {
    const isPm = /^p/i.test(ampm)
    if (isPm && hour !== 12) hour += 12
    if (!isPm && hour === 12) hour = 0
  }
  if (hour > 23) return null
  return `${String(hour).padStart(2, '0')}:${minute}`
}

const TIME_TOKEN = '(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?'
const TIME_RANGE_RE = new RegExp(
  `${TIME_TOKEN}(?:\\s*[-–—to]+\\s*${TIME_TOKEN})?`, 'i',
)

/**
 * Parse a GoDaddy time cell into { start, end } as 24-hour "HH:MM" strings.
 * Handles a single time ("5:30pm" → start only, end null) and a range
 * ("7 am - 8am", "8:30am - 9:30am", "7pm - 8pm"). Meridiem is inherited across
 * the range in both directions so "7 - 8pm" and "7am - 8" both resolve. Returns
 * null when no clock time is present.
 */
export function parseTimeRange(text) {
  const m = String(text || '').match(TIME_RANGE_RE)
  if (!m) return null

  const [, sH, sMin, sAmPmRaw, eH, eMin, eAmPmRaw] = m
  const hasEnd = eH != null
  // Inherit a missing meridiem from the other end of the range.
  const startAmPm = sAmPmRaw || (hasEnd ? eAmPmRaw : null) || null
  const endAmPm   = eAmPmRaw || sAmPmRaw || null

  const start = to24h(sH, sMin, startAmPm)
  if (!start) return null
  const end = hasEnd ? to24h(eH, eMin, endAmPm) : null
  return { start, end }
}

// ── Card parsing ─────────────────────────────────────────────────────────────

const RE_DATE  = /data-aid="CALENDAR_EVENT_DATE"[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>/g
const RE_TITLE = /data-aid="CALENDAR_EVENT_TITLE"[^>]*>([\s\S]*?)<\/h4>/g
const RE_TIME  = /data-aid="CALENDAR_EVENT_TIME"[^>]*>([\s\S]*?)(?:<div[^>]*data-aid="CALENDAR_DESC"|<p data-ux="Text")/g
const RE_DESC  = /data-aid="CALENDAR_DESC_TEXT"[^>]*>([\s\S]*?)<\/div>\s*<span[^>]*data-aid="CALENDAR_DESC_EXPAND"/g

/** Slug fragment: lowercase alphanumerics, hyphen-joined. */
export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Parse a class page's calendar widget into standing weekly slots.
 *
 * Every card is rendered twice (large + small screen); the parallel data-aid
 * arrays stay index-aligned, so we zip DATE/TITLE/TIME/DESC and dedupe by
 * (weekday + title + start), keeping the copy that carries a description.
 * "Coming Soon!" placeholder titles and cards with no parseable weekday/time
 * are dropped. Returns [{ programSlug, weekday, weekdayName, title, start, end,
 * description }] in weekday order.
 */
export function parseClassCards(html, pageKey = '') {
  const dates  = [...String(html).matchAll(RE_DATE)].map((m) => stripHtml(m[1]))
  const titles = [...String(html).matchAll(RE_TITLE)].map((m) => stripHtml(m[1]))
  const times  = [...String(html).matchAll(RE_TIME)].map((m) => stripHtml(m[1]))
  const descs  = [...String(html).matchAll(RE_DESC)].map((m) => stripHtml(m[1]))

  const n = Math.min(dates.length, titles.length, times.length)
  const byKey = new Map()

  for (let i = 0; i < n; i++) {
    const title = titles[i]
    // Skip "Coming Soon!" placeholders and any cancelled/postponed slot (a
    // scratched class is left on the widget with a title marker). Title-scoped
    // per the shared convention.
    if (!title || /coming soon/i.test(title) || /\bcancel?led\b|\bpostponed\b/i.test(title)) continue

    const day = dayNameToWeekday(dates[i])
    const time = parseTimeRange(times[i])
    if (!day || !time) continue

    const description = (descs[i] || '').trim()
    const key = `${day.index}|${title.toLowerCase()}|${time.start}`

    const existing = byKey.get(key)
    if (existing && existing.description) continue // keep the described copy

    byKey.set(key, {
      programSlug: `${pageKey}-${day.name}-${slugify(title)}-${time.start.replace(':', '')}`,
      weekday: day.index,
      weekdayName: day.name,
      title,
      start: time.start,
      end: time.end,
      description,
    })
  }

  return [...byKey.values()].sort(
    (a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start),
  )
}

/** Read a <meta property|name="…" content="…"> value (og:image et al.). */
export function getMeta(html, key) {
  const tag = String(html || '').match(
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, 'i'),
  )
  const content = tag?.[0].match(/content=["']([\s\S]*?)["']\s*\/?>/i)?.[1]
  return content ? content.trim() : null
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🌿  Starting The Grove ingestion…')
  const start = Date.now()
  try {
    const [organizerId, venueId] = await Promise.all([
      ensureOrganization(ORG_NAME, { website: VENUE_DETAILS.website, description: VENUE_DETAILS.description }),
      ensureVenue(VENUE_NAME, VENUE_DETAILS),
    ])
    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    let found = 0, inserted = 0, skipped = 0

    for (const page of CLASS_PAGES) {
      const url = `${BASE_URL}${page.path}`
      let html
      try { html = await fetchPage(url) }
      catch (err) { console.warn(`  ⚠ Failed to fetch ${url}: ${err.message}`); continue }

      const imageUrl = getMeta(html, 'og:image')
      const cards = parseClassCards(html, page.key)
      console.log(`  ${url} → ${cards.length} weekly class slot(s)`)

      for (const card of cards) {
        const occurrences = nextWeeklyOccurrences(card.weekday, { count: WEEKS_AHEAD })
        for (const ymd of occurrences) {
          found++
          const startIso = easternToIso(ymd, card.start)
          if (!startIso || Date.parse(startIso) < Date.now() - 3 * 3600_000) { skipped++; continue }
          const endIso = card.end ? easternToIso(ymd, card.end) : null

          const tags = ['the-grove', 'norton', 'fitness', 'wellness', page.discipline, card.weekdayName]

          const row = {
            title:           card.title,
            description:     card.description || null,
            start_at:        startIso,
            end_at:          endIso,
            category:        'fitness',
            tags,
            price_min:       null,          // pricing is on a separate page; never assume free
            price_max:       null,
            age_restriction: 'not_specified',
            image_url:       imageUrl || null,
            ticket_url:      url,
            source:          SOURCE_KEY,
            source_id:       `${SOURCE_KEY}-${card.programSlug}-${ymd}`,
            status:          'published',
            featured:        false,
          }

          const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
          if (error) {
            console.warn(`  ⚠ Upsert failed "${row.title}" (${ymd}): ${error.message}`)
            skipped++
            continue
          }
          if (venueId)     await linkEventVenue(upserted.id, venueId)
          if (organizerId) await linkEventOrganization(upserted.id, organizerId)
          inserted++
        }
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: found, durationMs: Date.now() - start,
    })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
