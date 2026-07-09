/**
 * scrape-old-stone-jail.js
 *
 * Old Stone Jail Bar and Grill — Norton's local bar & grill in the historic
 * Norton Jailhouse (5640 Wooster Rd W, Norton, OH 44203). Burgers, wings,
 * full bar, and one standing weekly event.
 *
 * Platform: hand-built static single-page site (theoldstonejail.com) with no
 * feed, no per-date listings, and no events page. The page states ONE standing
 * schedule (verified 2026-07-09): a "Weekly Event" block reading
 * "Trivia Night" / "Every Thursday at 8 PM" / "Bring your crew and put your
 * smarts to the test. Prizes, cold drinks, and bragging rights on the line."
 * No dated events (live music, specials) are published anywhere on the page.
 *
 * Event model: parse the schedule STATEMENT from the page (weekday + time are
 * never hardcoded — if the bar moves trivia to Wednesdays at 7, the next
 * scrape follows), then GENERATE the next 8 weekly occurrences via
 * lib/weekly-occurrences.js (Eastern-anchored calendar math, immune to the
 * UTC-rollover footgun) and easternToIso(ymd, time). Date-keyed source_ids
 * ('trivia-YYYY-MM-DD') keep the twice-daily run idempotent; the standing
 * 8-week window slides forward one occurrence per week. If the trivia block
 * disappears from the page the run yields zero events (existing future rows
 * age out via the stale sweep).
 *
 * The markup is div/span-heavy with logical lines delimited by closing tags,
 * so we tag-split the RAW HTML (htmlToLines) rather than use htmlToText —
 * the stripHtml-contract lesson. Fixture captured from the live raw source
 * (fetch().text(), not the rendered DOM) on 2026-07-09.
 *
 * Usage:   node scripts/scrape-old-stone-jail.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, easternToIso,
  enrichWithImageDimensions, upsertEventSafe, linkEventVenue, linkEventOrganization,
  ensureVenue, ensureOrganization, linkOrganizationVenue,
} from './lib/normalize.js'
import { WEEKDAY, nextWeeklyOccurrences } from './lib/weekly-occurrences.js'

export const SOURCE_KEY = 'old_stone_jail'
const PAGE_URL = 'https://theoldstonejail.com/'
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

const ORG_NAME   = 'Old Stone Jail Bar and Grill'
const VENUE_NAME = 'Old Stone Jail Bar and Grill'
const VENUE_DETAILS = {
  address: '5640 Wooster Rd W',
  city: 'Norton', state: 'OH', zip: '44203',
  website: 'https://theoldstonejail.com',
  description: 'Local bar & grill in the historic Norton Jailhouse: made-to-order burgers, wings with 16 sauces, loaded starters, and a full bar.',
}

const OCCURRENCE_COUNT = 8

// ── Pure parsers (exported for tests) ───────────────────────────────────────

/**
 * Line-split raw HTML on the tags that actually delimit content on this site
 * (closing div/span/a/heading/etc., plus <br>), then strip the rest.
 * htmlToText is NOT suitable here — logical lines are separated only by
 * element boundaries, never <br>/<p> pairs.
 */
export function htmlToLines(html = '') {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|span|td|tr|p|h[1-6]|li|a|section|header|footer|title)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;|&#x27;|&#39;/g, "'").replace(/&#8211;|&ndash;/g, '–').replace(/&nbsp;/g, ' ')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * Find the standing weekly schedule statement, e.g. "Every Thursday at 8 PM".
 * Returns { weekday, weekdayName, time, statement, title, description } or
 * null when no such statement exists (trivia dropped from the page).
 *
 * title = the nearest preceding line mentioning "trivia" ("Trivia Night");
 * description = the line right after the statement when it reads like prose.
 */
export function parseTriviaSchedule(lines = []) {
  const re = /\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\b/i
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re)
    if (!m) continue
    const weekdayName = m[1].toLowerCase()
    const time = `${m[2]}:${m[3] ?? '00'} ${m[4].toLowerCase()}m`
    let title = null
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      if (/trivia/i.test(lines[j])) { title = lines[j]; break }
    }
    let description = null
    const next = lines[i + 1]
    if (next && next.length > 40 && !/find us|menu|hours/i.test(next)) description = next
    return { weekday: WEEKDAY[weekdayName], weekdayName, time, statement: lines[i], title, description }
  }
  return null
}

/**
 * The venue's street address as stated on the page — a drift guard, not the
 * source of truth (VENUE_DETAILS is verified by hand). main() warns when the
 * page no longer matches.
 */
export function parseAddress(lines = []) {
  const re = /^(\d+[^,]+),\s*([A-Za-z .']+),\s*OH\s+(\d{5})$/
  for (const line of lines) {
    const m = line.match(re)
    if (m) return { address: m[1].trim(), city: m[2].trim(), state: 'OH', zip: m[3] }
  }
  return null
}

/**
 * Assemble the next OCCURRENCE_COUNT weekly trivia events from the parsed
 * schedule. Returns [] when the page carries no schedule statement.
 */
export function buildTriviaEvents(lines, now = new Date()) {
  const schedule = parseTriviaSchedule(lines)
  if (!schedule) return []
  const title = schedule.title ?? 'Trivia Night'
  const statement = schedule.statement.charAt(0).toLowerCase() + schedule.statement.slice(1)
  const description =
    `${title} at the Old Stone Jail Bar and Grill in Norton — ${statement}.` +
    (schedule.description ? ` ${schedule.description}` : '')
  return nextWeeklyOccurrences(schedule.weekday, { count: OCCURRENCE_COUNT, now }).map((ymd) => ({
    title: `${title} at the Old Stone Jail`,
    description,
    startIso: easternToIso(ymd, schedule.time),
    ymd,
    sourceId: `trivia-${ymd}`,
  }))
}

// ── Fetch ────────────────────────────────────────────────────────────────────

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  console.log('🍺  Starting Old Stone Jail ingestion…')
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

    const lines = htmlToLines(await fetchPage(PAGE_URL))

    const stated = parseAddress(lines)
    if (!stated || stated.address !== VENUE_DETAILS.address || stated.city !== VENUE_DETAILS.city) {
      console.warn('  ⚠ Page address drifted from VENUE_DETAILS:', JSON.stringify(stated))
    }

    const events = buildTriviaEvents(lines)
    console.log(`  ${PAGE_URL} → ${events.length} weekly trivia occurrences`)

    let inserted = 0, skipped = 0
    for (const ev of events) {
      if (!ev.startIso || Date.parse(ev.startIso) < Date.now() - 3 * 3600_000) { skipped++; continue }
      const row = {
        title:           ev.title,
        description:     ev.description,
        start_at:        ev.startIso,
        end_at:          null,
        category:        'games',
        tags:            ['trivia', 'bar', 'games', 'old-stone-jail'],
        price_min:       null,           // page states no entry fee either way
        price_max:       null,
        age_restriction: 'not_specified', // bar & grill; page states no age policy
        image_url:       null,            // shared fallback image covers display
        ticket_url:      PAGE_URL,
        source:          SOURCE_KEY,
        source_id:       ev.sourceId,
        status:          'published',
        featured:        false,
      }
      const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
      if (error) {
        console.warn(`  ⚠ Upsert failed "${row.title}" (${ev.ymd}):`, error.message)
        skipped++
      } else {
        await linkEventVenue(upserted.id, venueId)
        await linkEventOrganization(upserted.id, organizerId)
        inserted++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: events.length, durationMs: Date.now() - start,
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
