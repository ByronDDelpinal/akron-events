/**
 * scrape-magic-city-drivein.js
 *
 * Magic City Drive-In Theater — Barberton's two-screen drive-in (opened 1953,
 * 5602 S Cleveland-Massillon Rd), showing nightly double features during the
 * fair-weather season. A marquee Summit County experience, same content class
 * as the Nightlight's film calendar.
 *
 * Platform: hand-built static HTML (Drive-In Webs template, table/div layout,
 * no feed of any kind). Two pages share one layout:
 *   • /            — "Now Showing"  (current Thu–Sun window)
 *   • /features2.html — "Next Week" (following window)
 *
 * Page shape (verified 2026-07-08): a "Showing:" block with a weekday list and
 * a date list ("THURSDAY, Friday, Saturday, Sunday" / "July 9, 10, 11, 12"),
 * "Box office opens: 8:25", then per-screen sections ("Screen 1", "Screen 2")
 * each listing two features as title + "Rated: PG | Starts: 9:30" lines. The
 * layout is divs/spans with NO <br>/<p> separation, so htmlToText would run
 * lines together — we tag-split on closing div/span/td instead (the
 * stripHtml-contract lesson: never flatten line-based sources).
 *
 * Event model: ONE event per night per screen — "Drive-In Double Feature:
 * Moana & Toy Story 5" — starting at the first feature's showtime (times are
 * evening PM by nature). The second feature rides in the description. Nights
 * roll Thu–Sun, so a full week is ≤8 events; the twice-daily scrape plus
 * date-keyed source_ids (`screen{N}-{YYYY-MM-DD}`) keep re-runs idempotent and
 * let "Features Subject To Change" swaps update in place. Posters are not
 * extracted (third-party lakehosting URLs, inconsistent markup) — the shared
 * fallback-image mechanism covers display. Off-season the pages carry no date
 * block and the run simply yields zero events.
 *
 * Usage:   node scripts/scrape-magic-city-drivein.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, easternToIso,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'

export const SOURCE_KEY = 'magic_city_drivein'
const PAGES = [
  'https://www.magiccitydrive-in.com/',
  'https://www.magiccitydrive-in.com/features2.html',
]
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

const ORG_NAME   = 'Magic City Drive-In Theater'
const VENUE_NAME = 'Magic City Drive-In Theater'
const VENUE_DETAILS = {
  address: '5602 S Cleveland-Massillon Rd',
  city: 'Barberton', state: 'OH', zip: '44203',
  website: 'https://www.magiccitydrive-in.com',
  parking_type: 'lot',
  parking_notes: 'Drive-in: you watch from your parking spot. Arrive early for a good row.',
  description: 'Two-screen drive-in theater open since 1953, showing double features on both screens during the fair-weather months.',
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

// ── Pure parsers (exported for tests) ───────────────────────────────────────

/**
 * Line-split raw HTML on the tags that actually delimit content on this site
 * (closing div/span/td/p/h*, plus <br>), then strip the rest. htmlToText is
 * NOT suitable here — the layout has no <br>/<p> between logical lines.
 */
export function htmlToLines(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|span|td|tr|p|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "'").replace(/&#8211;|&ndash;/g, '–').replace(/&nbsp;/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * The showing window: month name + a list of day numbers, e.g.
 * "July 9, 10, 11, 12" (usually on/after the weekday list line).
 * Year inference: current year, rolling forward if that lands >45 days in the
 * past (a late-December listing scraped in January).
 */
export function parseShowDates(lines, now = new Date()) {
  const re = new RegExp(`\\b(${Object.keys(MONTHS).join('|')})\\b\\s+((?:\\d{1,2}\\s*,?\\s*)+)`, 'i')
  for (const line of lines) {
    const m = line.match(re)
    if (!m) continue
    const month = MONTHS[m[1].toLowerCase()]
    const days = (m[2].match(/\d{1,2}/g) ?? []).map(Number).filter((d) => d >= 1 && d <= 31)
    if (!days.length) continue
    const nowMs = now.getTime()
    return days.map((day) => {
      let year = now.getFullYear()
      if (Date.UTC(year, month - 1, day) < nowMs - 45 * 86400_000) year += 1
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    })
  }
  return []
}

/** "Box office opens: 8:25" → "8:25 pm" (evening by nature), else null. */
export function parseBoxOffice(lines) {
  for (const line of lines) {
    const m = line.match(/box office opens:?\s*(\d{1,2}:\d{2})/i)
    if (m) return `${m[1]} pm`
  }
  return null
}

/**
 * Per-screen features: sections start at "Screen N"; within a section each
 * feature is title / "Rated: PG | Movie Info" / "Starts: 9:30" on THREE
 * consecutive lines in the raw markup (verified against the live source
 * 2026-07-08 — the rendered DOM merges the last two, which is what the first
 * fixture wrongly copied). Both split and merged forms are handled.
 */
export function parseScreens(lines) {
  const screens = []
  let current = null
  let pendingTitle = null
  let pendingRating = null
  const complete = (starts) => {
    current.features.push({ title: pendingTitle, rating: pendingRating, starts: `${starts} pm` })
    pendingTitle = null
    pendingRating = null
  }
  for (const line of lines) {
    const screenM = line.match(/^screen\s+(\d)\b/i)
    if (screenM) {
      current = { screen: Number(screenM[1]), features: [] }
      screens.push(current)
      pendingTitle = null
      pendingRating = null
      continue
    }
    if (!current) continue
    const ratedM  = line.match(/^rated:?\s*([A-Za-z0-9-]+)/i)
    const startsM = line.match(/\bstarts:?\s*(\d{1,2}:\d{2})/i)
    if (ratedM && pendingTitle) {
      pendingRating = ratedM[1]
      if (startsM) complete(startsM[1])            // merged form: "Rated: PG | … Starts: 9:30"
      continue
    }
    if (startsM && pendingTitle) {                 // split form: "Starts: 9:30" on its own line
      complete(startsM[1])
      continue
    }
    // A candidate movie title: short line, not boilerplate
    if (!/rated:|starts:|box office|we recommend|we also accept|features subject|showing:|welcome to/i.test(line) && line.length <= 60) {
      pendingTitle = line
      pendingRating = null
    }
  }
  return screens.filter((s) => s.features.length)
}

/** Assemble night×screen events from parsed pieces. */
export function buildEvents(lines, pageUrl, now = new Date()) {
  const dates = parseShowDates(lines, now)
  if (!dates.length) return []
  const boxOffice = parseBoxOffice(lines)
  const screens = parseScreens(lines)
  const events = []
  for (const { screen, features } of screens) {
    const names = features.map((f) => f.title)
    // ' + ' joiner, not ' & ' — titles themselves contain ampersands
    // ("Minions & Monsters").
    const title = names.length > 1
      ? `Drive-In Double Feature: ${names.join(' + ')}`
      : `Drive-In Movie Night: ${names[0]}`
    const featureLines = features.map((f) =>
      `${f.title}${f.rating ? ` (Rated ${f.rating})` : ''} — starts ${f.starts.replace(' pm', ' PM')}`)
    const description =
      `Screen ${screen} at the Magic City Drive-In: ${featureLines.join('; ')}.` +
      (boxOffice ? ` Box office opens ${boxOffice.replace(' pm', ' PM')}.` : '') +
      ' Features subject to change without notice.'
    for (const ymd of dates) {
      events.push({
        title,
        description,
        startIso: easternToIso(ymd, features[0].starts),
        screen,
        ymd,
        ticketUrl: pageUrl,
      })
    }
  }
  return events
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🎬  Starting Magic City Drive-In ingestion…')
  const start = Date.now()
  try {
    const [organizerId, venueId] = await Promise.all([
      ensureOrganization(ORG_NAME, {
        website: VENUE_DETAILS.website,
        description: VENUE_DETAILS.description,
      }),
      ensureVenue(VENUE_NAME, VENUE_DETAILS),
    ])
    await linkOrganizationVenue(organizerId, venueId)

    const now = new Date()
    const allEvents = new Map() // source_id → event (features2 can overlap index on rollover)
    for (const url of PAGES) {
      try {
        const lines = htmlToLines(await fetchPage(url))
        const events = buildEvents(lines, url, now)
        console.log(`  ${url} → ${events.length} night-screen events`)
        for (const ev of events) allEvents.set(`screen${ev.screen}-${ev.ymd}`, ev)
      } catch (err) {
        console.warn(`  ⚠ Page failed ${url}:`, err.message)
      }
    }

    let inserted = 0, skipped = 0
    for (const [sourceId, ev] of allEvents) {
      if (!ev.startIso || Date.parse(ev.startIso) < Date.now() - 3 * 3600_000) { skipped++; continue }
      const row = {
        title:           ev.title,
        description:     ev.description,
        start_at:        ev.startIso,
        end_at:          null,
        category:        'film',
        tags:            ['film', 'drive-in', 'movies', 'magic-city-drive-in'],
        price_min:       null,          // admission charged, amount not published on the schedule page
        price_max:       null,
        age_restriction: 'all_ages',
        image_url:       null,          // posters are third-party; shared fallback image covers display
        ticket_url:      ev.ticketUrl,
        source:          SOURCE_KEY,
        source_id:       sourceId,
        status:          'published',
        featured:        false,
      }
      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) {
        console.warn(`  ⚠ Upsert failed "${row.title}":`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: allEvents.size, durationMs: Date.now() - start,
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
