/**
 * scrape-release-yoga.js
 *
 * Release Yoga — a yoga & wellness studio at 880 E Turkeyfoot Lake Rd in Green
 * (southern Summit County). We deliberately ingest only its ENROLLMENTS page
 * (workshops, retreats, teacher trainings, sound baths, special events) — NOT
 * the daily drop-in class grid, which would flood an events calendar with
 * recurring classes. Enrollments are the genuine "events" worth surfacing.
 *
 * Platform: MINDBODY, surfaced through a Shopify app proxy at
 *   https://releaseyoga.com/apps/mindbody/enrollments
 * The proxy server-renders the enrollment list as HTML (no JS needed), so we
 * fetch + parse it directly. Each `.enrollment_box` carries the title + price
 * (`.not_entire`), instructor (`.mb_le_staff_*`), a date/time line
 * (`.bold_date`, e.g. "Fri, Jun 19, 2026 at 6:00 pm - 7:00 pm"), a description,
 * and an image. The page exposes no per-event location, so every enrollment is
 * pinned to the single studio venue.
 *
 * Category is left to text inference (yoga → fitness, workshops → learning,
 * etc.) with a 'fitness' default rescue (manifest) for the studio's wellness
 * programming. Price comes from the "$NN" in the title; null when absent.
 *
 * Usage:  node scripts/scrape-release-yoga.js
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
const ENROLLMENTS_URL = 'https://releaseyoga.com/apps/mindbody/enrollments'
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

/**
 * Parse a MINDBODY enrollment date line into { dateYmd, start, end } (clock
 * times, Eastern). Handles the single-day form "Fri, Jun 19, 2026 at 6:00 pm
 * - 7:00 pm". Returns null when it can't extract a date + start time (e.g.
 * multi-day retreat ranges we don't yet model).
 */
export function parseEnrollmentDate(text) {
  if (!text) return null
  const m = String(text).match(
    /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})\s+at\s+(\d{1,2}:\d{2})\s*(am|pm)(?:\s*[-–—]\s*(\d{1,2}:\d{2})\s*(am|pm))?/i,
  )
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  if (!month) return null
  const dateYmd = `${m[3]}-${String(month).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`
  const start = to24h(m[4], m[5])
  const end   = m[6] ? to24h(m[6], m[7]) : null
  return start ? { dateYmd, start, end } : null
}

/** Split the enrollments HTML into one entry per `.enrollment_box`. */
export function parseEnrollments(html) {
  if (!html || typeof html !== 'string') return []
  // Split on the box wrapper only — `[\s"]` after "enrollment_box" avoids
  // matching the nested enrollment_box_image / _text children.
  const chunks = html.split(/class="enrollment_box[\s"]/).slice(1)
  const out = []
  for (const chunk of chunks) {
    // Title + price live as the own-text of .not_entire, before the instructor span.
    const titleRaw = firstGroup(chunk, /class="[^"]*not_entire[^"]*"[^>]*>\s*([^<]+)/)
    if (!titleRaw) continue
    const titlePrice = decodeEntities(titleRaw)
    const priceMatch = titlePrice.match(/\$\s*(\d+(?:\.\d{2})?)/)
    const price = priceMatch ? parseFloat(priceMatch[1]) : null
    const title = titlePrice.replace(/\s*[-–—]?\s*\$\s*\d+(?:\.\d{2})?\s*$/, '').trim()
    if (!title) continue

    const dateText = firstGroup(chunk, /class="[^"]*bold_date[^"]*"[^>]*>\s*([^<]+?)\s*</)
    const first = firstGroup(chunk, /mb_le_staff_firstname[^>]*>\s*([^<]+?)\s*</)
    const last  = firstGroup(chunk, /mb_le_staff_lastname[^>]*>\s*([^<]+?)\s*</)
    const instructor = [first, last].filter(Boolean).join(' ').trim() || null
    const descRaw = firstGroup(chunk, /class="description"[^>]*>([\s\S]*?)<\/span>/)
    const description = descRaw ? stripHtml(decodeEntities(descRaw)).slice(0, 5000) || null : null
    const imageUrl = firstGroup(chunk, /<img[^>]+src="([^"]+)"/)

    out.push({ title, price, dateText, instructor, description, imageUrl })
  }
  return out
}

/** Stable slug for source_id. */
function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

/** Build an event row from a parsed enrollment, or null if undatable. */
export function buildRow(enr) {
  const when = parseEnrollmentDate(enr.dateText)
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
    source_id: `${SOURCE_KEY}-${slug(enr.title)}-${when.dateYmd}`,
    status: 'published',
    featured: false,
  }
}

// ── Fetch ──────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('🧘  Starting Release Yoga (MINDBODY enrollments) scrape…')
  const start = Date.now()

  try {
    const html = await fetchHtml(ENROLLMENTS_URL)
    const enrollments = parseEnrollments(html)
    console.log(`  Parsed ${enrollments.length} enrollments`)

    if (!enrollments.length) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: 'error',
        errorMessage: 'Page fetched but 0 enrollments parsed — the MINDBODY widget markup may have changed (expected .enrollment_box with .not_entire / .bold_date).',
        durationMs: Date.now() - start,
        eventsFound: 0,
      })
      console.warn('  ⚠ No enrollments parsed — exiting 0.')
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
