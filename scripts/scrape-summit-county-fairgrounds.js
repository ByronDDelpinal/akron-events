/**
 * scrape-summit-county-fairgrounds.js
 *
 * Summit County Fairgrounds (summitfair.com) — the year-round events calendar
 * for the Summit County Agricultural Society's grounds in Tallmadge. The
 * /schedule-of-events/ page is a single server-rendered WordPress page holding
 * ~20 events per year: the county fair, plus a long tail of shows and markets
 * (dog shows, gun shows, motocross, gymnastics meets, home shows, roller derby,
 * craft/vintage markets, etc.). MANY are run by OUTSIDE PROMOTERS — the page
 * itself warns of this — so titles/dates are the fairgrounds' own listing while
 * the "More Info" link usually points off-site to the promoter.
 *
 * Structure: the page is organized into year sections ("2026 Schedule of
 * Events", "2027 Schedule of Events"). Under each, every event is an <h3> date
 * heading (e.g. "JULY 28-AUGUST 2", "September 5") followed by an <h4> name
 * heading and some free-text body (hours, admission, a "More Info" link) up to
 * the next <h3>. There is no JSON-LD, no iCal feed, and no public REST for this
 * post type, so we parse the rendered HTML directly.
 *
 * All events are at ONE venue — 229 E Howe Rd, Tallmadge, OH 44278 — entirely
 * inside Summit County, so no geo gate is needed. Dates are frequently ranges
 * (we use the START date). Many rows publish no start time, in which case we
 * leave the time empty (easternToIso(date, '')). Price is only set when the
 * body states one; never assumed free.
 *
 * Usage:   node scripts/scrape-summit-county-fairgrounds.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, htmlToText, decodeEntities,
  easternToIso, inferCategory, enrichWithImageDimensions, upsertEventSafe,
  ensureVenue, ensureOrganization, linkEventVenue, linkEventOrganization,
  linkOrganizationVenue,
} from './lib/normalize.js'

export const SOURCE_KEY = 'summit_county_fairgrounds'
const SITE = 'https://summitfair.com'
const EVENTS_URL = `${SITE}/schedule-of-events/`
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'
const MAX_DAYS_AHEAD = 500

// The single, fixed venue for every event on the grounds.
const VENUE_NAME = 'Summit County Fairgrounds'
const VENUE_DETAILS = {
  address: '229 E Howe Rd',
  city: 'Tallmadge',
  state: 'OH',
  zip: '44278',
  website: SITE,
}

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9,
  sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
}

const TAGS = ['fairgrounds', 'summit-county-fairgrounds']

// ── Pure parsers (exported for tests) ───────────────────────────────────────

const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

const monthNum = (name) => MONTHS[String(name || '').trim().toLowerCase().replace(/\.$/, '')] || null

/**
 * Parse a fairgrounds date heading into a start date "YYYY-MM-DD".
 * Handles single days ("JUNE 13", "September 5"), same-month ranges
 * ("October 2-4", "November 28-29"), and cross-month ranges
 * ("JULY 28-AUGUST 2", "January 30-Feb 1", "February 28- March 1").
 * Always returns the START date; year is supplied by the section context.
 *
 * @param {string} text  — the raw <h3> heading text
 * @param {number} year  — the year of the surrounding schedule section
 */
export function parseFairDate(text, year) {
  const s = stripTags(text)
  if (!s || !year) return null
  // First "<Month> <day>" token = the start of the range.
  const m = s.match(/\b([A-Za-z]+)\.?\s+(\d{1,2})/)
  if (!m) return null
  const month = monthNum(m[1])
  if (!month) return null
  const day = Number(m[2])
  if (!day || day > 31) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Best-effort start time from the body text. The fairgrounds rarely publishes a
 * clean single start time; when it does it's usually a "Doors Open at 3pm" line
 * or a "11am – 4pm" / "10am to 4pm" range (we take the opening bound). Returns
 * '' when nothing usable is present, so easternToIso leaves the time empty.
 */
export function parseFairTime(text) {
  const s = stripTags(text)
  if (!s) return ''
  // "Doors Open at 3pm" / "Doors open at 8am"
  let m = s.match(/doors?\s+open(?:s)?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)/i)
  if (!m) {
    // A leading time in a range like "11am – 4pm" or "10am to 4pm" or "8AM".
    m = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)\b/i)
  }
  if (!m) return ''
  const hour = Number(m[1])
  if (!hour || hour > 12) return ''
  const min = m[2] ? m[2] : '00'
  const ap = m[3].replace(/\./g, '').toUpperCase()
  return `${hour}:${min} ${ap}`
}

/** Parse a stated admission price into { price_min, price_max }. Never assumes free. */
export function parseFairPrice(text) {
  const s = stripTags(text)
  if (!s) return { price_min: null, price_max: null }
  if (/free\s+admission|admission\s+free|free\s+to\s+the\s+public/i.test(s)) {
    return { price_min: 0, price_max: null }
  }
  // Collect dollar amounts that look like admission (e.g. "$8", "$10.00", "$20").
  const nums = [...s.matchAll(/\$\s?(\d{1,3}(?:\.\d{2})?)/g)].map((x) => Number(x[1]))
  if (!nums.length) return { price_min: null, price_max: null }
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  return { price_min: min, price_max: max > min ? max : null }
}

/**
 * Parse the schedule page HTML into event objects.
 * Splits into year sections, then reads each <h3> date / <h4> title pair with
 * its trailing body (up to the next <h3>).
 *
 * @returns {Array<{title,date,time,description,url,priceMin,priceMax}>}
 */
export function parseEvents(html) {
  const s = String(html || '')

  // Locate each "YYYY Schedule of Events" marker to attribute a year to the
  // events that follow it. Fall back to a single implicit section if absent.
  const yearMarkers = [...s.matchAll(/(\d{4})\s+Schedule of Events/gi)]
    .map((m) => ({ year: Number(m[1]), index: m.index }))
    .sort((a, b) => a.index - b.index)

  const yearForIndex = (idx) => {
    let year = null
    for (const mk of yearMarkers) {
      if (mk.index <= idx) year = mk.year
      else break
    }
    return year
  }

  // Each event = an <h3> date heading, then the next <h4> title, then body
  // text up to the following <h3> (or end).
  const re = /<h3[^>]*>([\s\S]*?)<\/h3>\s*<h4[^>]*>([\s\S]*?)<\/h4>([\s\S]*?)(?=<h3[^>]*>|$)/gi
  const out = []
  const seen = new Set()

  for (const m of s.matchAll(re)) {
    const year = yearForIndex(m.index)
    if (!year) continue
    const date = parseFairDate(m[1], year)
    const title = stripTags(m[2])
    if (!date || !title) continue

    const body = m[3]
    // Body text minus the "More Info" boilerplate for a usable description.
    const bodyText = htmlToText(body).replace(/\bMore Info\b/gi, '').trim()
    const description = bodyText ? bodyText.slice(0, 2000) : null

    // Prefer the event's "More Info" link (usually the outside promoter); fall
    // back to the schedule page itself.
    let url = EVENTS_URL
    const linkM = body.match(/<a[^>]+href="([^"?#]+)[^"]*"[^>]*>\s*More Info/i)
    if (linkM) url = linkM[1]
    else {
      const anyLink = body.match(/<a[^>]+href="(https?:\/\/[^"?#]+)[^"]*"/i)
      if (anyLink) url = anyLink[1]
    }

    const { price_min, price_max } = parseFairPrice(body)

    const key = `${title.toLowerCase()}|${date}`
    if (seen.has(key)) continue
    seen.add(key)

    out.push({
      title,
      date,
      time: parseFairTime(body),
      description,
      url,
      priceMin: price_min,
      priceMax: price_max,
    })
  }
  return out
}

// ── Fetch ─────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎡  Starting Summit County Fairgrounds ingestion…')
  const start = Date.now()
  try {
    const html = await fetchHtml(EVENTS_URL)
    const events = parseEvents(html)
    console.log(`  Parsed ${events.length} event(s)`)

    const venueId = await ensureVenue(VENUE_NAME, VENUE_DETAILS)
    const organizerId = await ensureOrganization('Summit County Agricultural Society', {
      website: SITE,
      description: 'The Summit County Agricultural Society runs the Summit County Fairgrounds in Tallmadge, hosting the annual county fair plus year-round shows, markets, and events.',
    })
    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    const now = Date.now()
    const cutoff = now + MAX_DAYS_AHEAD * 86_400_000
    let inserted = 0, skipped = 0

    for (const ev of events) {
      try {
        const startIso = easternToIso(ev.date, ev.time)
        if (!startIso) { skipped++; continue }
        const ms = Date.parse(startIso)
        if (ms < now - 86_400_000 || ms > cutoff) { skipped++; continue }

        const category = inferCategory(ev.title, ev.description || '') || 'other'
        const slug = `${ev.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${ev.date}`
        const row = {
          title:           ev.title,
          description:     ev.description,
          start_at:        startIso,
          end_at:          null,
          category,
          tags:            TAGS,
          price_min:       ev.priceMin,
          price_max:       ev.priceMax,
          age_restriction: 'all_ages',
          image_url:       null,
          ticket_url:      ev.url,
          source:          SOURCE_KEY,
          source_id:       slug,
          status:          'published',
          featured:        false,
        }
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

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: events.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
