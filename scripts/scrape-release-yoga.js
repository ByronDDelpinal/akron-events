/**
 * scrape-release-yoga.js
 *
 * Release Yoga — a yoga & wellness studio at 880 E Turkeyfoot Lake Rd in Green
 * (southern Summit County). We deliberately ingest only its ENROLLMENTS
 * (workshops, retreats, teacher trainings, sound baths, special events) — NOT
 * the daily drop-in class grid, which would flood an events calendar with
 * recurring classes. Enrollments are the genuine "events" worth surfacing.
 *
 * Platform: MINDBODY branded-web ("healcode") enrollments widget. The studio
 * rebuilt its site in 2026-08: the Shopify app proxy this scraper used to read
 * (/apps/mindbody/enrollments, server-rendered .enrollment_box markup) now
 * redirects to /workshops-and-events, a page that holds only an empty
 *   <healcode-widget data-type="enrollments" data-widget-id="…">
 * tag which the browser fills in by script. That is why every run since then
 * parsed 0 enrollments. The widget's own JSON endpoint serves the same markup
 * the script would inject, with no browser needed:
 *   https://widgets.mindbodyonline.com/widgets/enrollments/{id}.json
 *     → { "contents": "<…html…>" }
 * It returns a 30-day window; `options[start_date]=YYYY-MM-DD` moves it, and
 * each response names the next window's start in its "Next >" link. We walk
 * WINDOWS of them.
 *
 * Each `.enrollment` block carries the title + price (the
 * .healcode-enrollment-name link text, "Aerial UnWined - $18"), the
 * instructor (.trainer), a start date ("Nov 15 2026"), start and end times
 * (" 6:00 PM"), a description, and an image. The widget exposes no per-event
 * location, so every enrollment is pinned to the single studio venue.
 *
 * The widget id is read from the studio's page on every run and falls back to
 * the id captured 2026-11-10, so a regenerated widget does not need a deploy.
 *
 * ZERO EVENTS: a window whose markup has the widget's .filtered_collection
 * list but no enrollments in it is a quiet month, and a run where every
 * window is like that logs success with 0 found. A response without that list
 * is a markup change and logs an error.
 *
 * Category is left to text inference (yoga → fitness, workshops → learning,
 * etc.) with a 'fitness' default rescue (manifest) for the studio's wellness
 * programming. Price comes from the "$NN" in the title; null when absent.
 *
 * Usage:  node scripts/scrape-release-yoga.js
 *         node scripts/scrape-release-yoga.js --dry-run
 * Env:    VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, stripHtml, decodeEntities, easternToIso,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'

export const SOURCE_KEY = 'release_yoga'
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'

/** The public page a visitor books from; also where the widget id is read. */
const ENROLLMENTS_URL = 'https://releaseyoga.com/workshops-and-events'
const WIDGET_BASE = 'https://widgets.mindbodyonline.com/widgets/enrollments'
/** Widget id captured from the studio's page 2026-11-10; used if discovery fails. */
export const FALLBACK_WIDGET_ID = 'fe114957e7e9'
/** 30-day windows to walk (about four months ahead). */
const WINDOWS = 4
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

const ORG_NAME = 'Release Yoga'
const VENUE_NAME = 'Release Yoga'
const VENUE_DETAILS = {
  address: '880 E Turkeyfoot Lake Rd', city: 'Akron', state: 'OH', zip: '44312',
  website: 'https://releaseyoga.com',
  description: 'Yoga and wellness studio in Green (southern Summit County) offering classes, workshops, retreats, and teacher trainings.',
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

// ── Pure parsing helpers (unit-tested) ────────────────────────────────────────

const firstGroup = (s, re) => s.match(re)?.[1]?.trim() || null

/** "6:00" + "pm" → "18:00:00". */
function to24h(hm, ampm) {
  const m = String(hm || '').match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const min = m[2]
  const pm = /pm/i.test(ampm || '')
  if (h === 12) h = pm ? 12 : 0
  else if (pm) h += 12
  return `${String(h).padStart(2, '0')}:${min}:00`
}

/** "Nov 15 2026" (also "Nov 15, 2026") → "2026-11-15", or null. */
export function parseWidgetDate(text) {
  const m = String(text || '').match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/)
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  if (!month) return null
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`
}

/** " 6:00 PM" → "18:00:00", or null. */
export function parseWidgetTime(text) {
  const m = String(text || '').match(/(\d{1,2}:\d{2})\s*(am|pm)/i)
  return m ? to24h(m[1], m[2]) : null
}

/**
 * Resolve an enrollment's date fields into { dateYmd, start, end, multiDay }
 * (clock times, Eastern). Returns null without a start date AND a start time:
 * a time-less row would have to invent one. `multiDay` is true when the widget
 * lists an end date after the start date (a series or retreat), which this
 * scraper publishes at its first session and flags for review.
 */
export function parseEnrollmentWhen({ startDate, endDate, startTime, endTime } = {}) {
  const dateYmd = parseWidgetDate(startDate)
  const start = parseWidgetTime(startTime)
  if (!dateYmd || !start) return null
  const endYmd = parseWidgetDate(endDate)
  return {
    dateYmd,
    start,
    end: parseWidgetTime(endTime),
    multiDay: Boolean(endYmd && endYmd !== dateYmd),
  }
}

/** True when `html` is the enrollments widget's markup (has its list container). */
export function isWidgetMarkup(html) {
  return typeof html === 'string' && /class="[^"]*\bfiltered_collection\b/.test(html)
}

/** Split the widget markup into one entry per `.enrollment` block. */
export function parseEnrollments(html) {
  if (!html || typeof html !== 'string') return []
  // Split on the block wrapper only: `class="enrollment ` with a trailing space
  // is the block ("enrollment filterable …"); the child classes are all
  // healcode-* and never start that way.
  const chunks = html.split(/<div class="enrollment\s/).slice(1)
  const out = []
  for (const chunk of chunks) {
    // Title + price are the text of the name link.
    const titleRaw = firstGroup(chunk, /class="healcode-enrollment-name"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/)
    if (!titleRaw) continue
    const titlePrice = stripHtml(decodeEntities(titleRaw)).trim()
    const priceMatch = titlePrice.match(/\$\s*(\d+(?:\.\d{2})?)/)
    const price = priceMatch ? parseFloat(priceMatch[1]) : null
    const title = titlePrice.replace(/\s*[-–—]?\s*\$\s*\d+(?:\.\d{2})?\s*$/, '').trim()
    if (!title) continue

    const instructorRaw = firstGroup(chunk, /class="trainer"[^>]*>\s*(?:<a[^>]*>)?([^<]+)/)
    const descRaw = firstGroup(chunk, /class="healcode-description-area"[^>]*>([\s\S]*?)<\/div>\s*<div class="healcode-button"/)
      ?? firstGroup(chunk, /class="healcode-description-area"[^>]*>([\s\S]*?)<div class="clear">/)

    out.push({
      title,
      price,
      startDate: firstGroup(chunk, /class="healcode-start-date-value"[^>]*>([^<]+)</),
      endDate:   firstGroup(chunk, /class="healcode-end-date-value"[^>]*>([^<]+)</),
      startTime: firstGroup(chunk, /class="healcode-start-time-value"[^>]*>([^<]+)</),
      endTime:   firstGroup(chunk, /class="healcode-end-time-value"[^>]*>([^<]+)</),
      instructor: instructorRaw ? decodeEntities(instructorRaw).trim() || null : null,
      description: descRaw ? stripHtml(decodeEntities(descRaw)).slice(0, 5000) || null : null,
      imageUrl: firstGroup(chunk, /class="healcode-image-area"[^>]*>\s*<img[^>]+src="([^"]+)"/),
    })
  }
  return out
}

/** The next window's start date ("2026-12-10") from the widget's "Next >" link. */
export function nextWindowStart(html) {
  return firstGroup(String(html || ''), /class="healcode-next"[^>]*>\s*<a[^>]*data-hc-startdate="(\d{4}-\d{2}-\d{2})"/)
}

/** The enrollments widget id on the studio's page, or null. */
export function extractWidgetId(pageHtml) {
  const tag = String(pageHtml || '').match(/<healcode-widget\b[^>]*data-type="enrollments"[^>]*>/i)?.[0]
  return tag ? firstGroup(tag, /data-widget-id="([a-z0-9]+)"/i) : null
}

/** Stable slug for source_id. */
function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

/** Build an event row from a parsed enrollment, or null if undatable. */
export function buildRow(enr) {
  const when = parseEnrollmentWhen(enr)
  if (!enr.title || !when) return null
  const startAt = easternToIso(`${when.dateYmd} ${when.start}`)
  if (!startAt) return null
  const endAt = when.end ? easternToIso(`${when.dateYmd} ${when.end}`) : null

  const tags = ['release-yoga', 'yoga', 'wellness', 'green', 'akron']
  return {
    title: enr.title,
    description: enr.description,
    start_at: startAt,
    end_at: endAt,
    category: null,                 // defer to inference (manifest default 'fitness')
    tags,
    price_min: enr.price ?? null,   // never assume free
    price_max: enr.price ?? null,
    age_restriction: 'not_specified',
    image_url: enr.imageUrl || null,
    ticket_url: ENROLLMENTS_URL,
    source: SOURCE_KEY,
    // Same formula as the pre-2026-11 scraper, so rows ingested from the old
    // page keep their identity.
    source_id: `${SOURCE_KEY}-${slug(enr.title)}-${when.dateYmd}`,
    status: 'published',
    featured: false,
    ...(when.multiDay ? { needs_review: true } : {}),
  }
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchText(url, accept) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

/** Read the widget id off the studio's page; fall back to the captured one. */
async function resolveWidgetId(getText = fetchText) {
  try {
    const id = extractWidgetId(await getText(ENROLLMENTS_URL, 'text/html,application/xhtml+xml'))
    if (id) return id
    console.warn(`  ⚠ No enrollments widget tag on ${ENROLLMENTS_URL} — using the captured id`)
  } catch (err) {
    console.warn(`  ⚠ Could not read ${ENROLLMENTS_URL} (${err.message}) — using the captured id`)
  }
  return FALLBACK_WIDGET_ID
}

/**
 * Walk `windows` consecutive 30-day windows of the widget, following each
 * response's own "Next >" start date. Returns every enrollment (de-duplicated
 * on title + start date + start time, since a window boundary can repeat one)
 * and how many windows carried the widget's list markup. Exported for tests;
 * `getText` is injectable.
 */
export async function fetchAllEnrollments({ widgetId, windows = WINDOWS, getText = fetchText } = {}) {
  const seen = new Set()
  const enrollments = []
  let validWindows = 0
  let startDate = null
  for (let i = 0; i < windows; i++) {
    const url = `${WIDGET_BASE}/${widgetId}.json` +
      (startDate ? `?options%5Bstart_date%5D=${startDate}` : '')
    const body = await getText(url, 'application/json')
    let html
    try { html = JSON.parse(body)?.contents } catch { html = null }
    if (!isWidgetMarkup(html)) break
    validWindows++
    for (const enr of parseEnrollments(html)) {
      const key = `${enr.title}|${enr.startDate}|${enr.startTime}`
      if (seen.has(key)) continue
      seen.add(key)
      enrollments.push(enr)
    }
    startDate = nextWindowStart(html)
    if (!startDate) break
  }
  return { enrollments, validWindows }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🧘  Starting Release Yoga (MINDBODY enrollments widget) scrape…')
  if (DRY_RUN) console.log('   [dry-run mode — fetch + parse only, no DB writes]')
  const start = Date.now()

  try {
    const widgetId = await resolveWidgetId()
    const { enrollments, validWindows } = await fetchAllEnrollments({ widgetId })
    console.log(`  Parsed ${enrollments.length} enrollments from ${validWindows} window(s) of widget ${widgetId}`)

    if (DRY_RUN) {
      for (const enr of enrollments) {
        const row = buildRow(enr)
        console.log(`     • ${row ? row.start_at : 'UNDATABLE'}  ${enr.title}  ${enr.price != null ? `$${enr.price}` : ''}`)
      }
      console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s [dry-run]`)
      return
    }

    if (validWindows === 0) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: 'error',
        errorMessage: `Widget ${widgetId} answered without its enrollment list (.filtered_collection) — the MINDBODY widget markup or id may have changed`,
        durationMs: Date.now() - start,
        eventsFound: 0,
      })
      console.warn('  ⚠ No widget markup — logged as an error run.')
      process.exit(0)
    }

    const organizerId = await ensureOrganization(ORG_NAME, {
      website: 'https://releaseyoga.com',
      description: 'Release Yoga is a yoga and wellness studio in Green (southern Summit County) offering classes, workshops, retreats, and teacher trainings.',
    })
    const venueId = await ensureVenue(VENUE_NAME, VENUE_DETAILS)
    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    const nowMs = Date.now()
    const cutoffPast = nowMs - 86_400_000
    let inserted = 0, skipped = 0

    for (const enr of enrollments) {
      try {
        const row = buildRow(enr)
        if (!row) { skipped++; continue }
        if (Date.parse(row.start_at) < cutoffPast) { skipped++; continue }

        const enriched = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enriched)
        if (error) { console.warn(`  ⚠ Upsert failed for "${row.title}": ${error.message}`); skipped++; continue }
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error processing "${enr.title}": ${err.message}`)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: enrollments.length,
      durationMs:  Date.now() - start,
    })
    console.log(`✅  Release Yoga: ${inserted} posted, ${skipped} skipped in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
