/**
 * scrape-akron-roller-derby.js
 *
 * Akron Roller Derby (akronrollerderby.net/games-events) — the WFTDA-adjacent
 * flat-track roller derby league that plays its HOME bouts at the Summit County
 * Fairgrounds (229 E Howe Rd, Tallmadge, OH 44278).
 *
 * The schedule page is a Wix site, but the game listings ARE server-rendered
 * into the static HTML (they show up in the fetched markup, not just in a
 * client-side XHR), so we parse the served document directly. We run it through
 * htmlToText() to get a stable, tag-agnostic line stream and then split it on
 * the two section banners the page uses:
 *
 *     Season 2026
 *     Home Games         ← ~3 bouts at the Summit County Fairgrounds, Tallmadge
 *       APRIL 11
 *       All Stars vs. Black Rose B   AkRowdies vs. Black Rose C
 *       Summit County Fairgrounds
 *       Tallmadge, Ohio
 *       …
 *     Detailed Schedule  ← doors/first-whistle times per home date
 *     Away Games         ← ~11 games at out-of-state venues — DROPPED
 *
 * We ingest ONLY the Home Games (everything between the "Home Games" banner and
 * the "Away Games" banner). As a belt-and-suspenders geo gate we also require
 * each kept game's city to be inside Summit County (isSummitCountyLocation);
 * the away games are in Indiana / Michigan / Pennsylvania / New York / etc. and
 * fail both the section split and the gate. Start times come from the "Detailed
 * Schedule" paragraph (first whistle); price is left null unless stated.
 *
 * Why HTML parsing: Wix exposes no public events REST/JSON or iCal for this
 * site, there's no Event JSON-LD, and the schedule is a hand-built page — so we
 * parse the rendered text. Category sports.
 *
 * Usage:   node scripts/scrape-akron-roller-derby.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, htmlToText, easternToIso,
  enrichWithImageDimensions, upsertEventSafe, ensureVenue, ensureOrganization,
  linkEventVenue, linkEventOrganization, linkOrganizationVenue,
} from './lib/normalize.js'
import { isSummitCountyLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'akron_roller_derby'
const SITE = 'https://www.akronrollerderby.net'
const EVENTS_URL = `${SITE}/games-events`
const TICKETS_URL = `${SITE}/presale-tickets`
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'
const MAX_DAYS_AHEAD = 450

// Home bouts are ALL played here. The page never varies the home venue, so we
// pin it rather than trust a per-game parse that could pick up a stray line.
const HOME_VENUE = {
  name: 'Summit County Fairgrounds',
  address: '229 E Howe Rd',
  city: 'Tallmadge',
  state: 'OH',
  zip: '44278',
}
const DEFAULT_FIRST_WHISTLE = '6:00 PM'  // fallback when the detail block omits a date

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}

// ── Pure parsers (exported for tests) ───────────────────────────────────────

const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/**
 * Infer the year for a bare "MONTH DD" (the page lists none): a month earlier
 * than the current month rolls to next year (a spring schedule viewed in fall).
 */
export function inferYear(month, now = new Date()) {
  const cm = now.getMonth() + 1
  return month >= cm ? now.getFullYear() : now.getFullYear() + 1
}

/**
 * Parse a home-game date heading like "APRIL 11", "MAY 16 - Triple Header",
 * "JUNE 13th - Triple Header" → { month, day, ymd, tripleHeader } or null.
 */
export function parseDateHeading(line, now = new Date()) {
  const m = String(line || '').trim().match(
    /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\b(.*)$/,
  )
  if (!m) return null
  const month = MONTHS[m[1].toLowerCase()]
  if (!month) return null
  const day = Number(m[2])
  if (!day || day > 31) return null
  const year = inferYear(month, now)
  return {
    month,
    day,
    ymd: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    tripleHeader: /triple\s*header/i.test(m[3] || ''),
  }
}

/**
 * A city/state string is a HOME game iff it names a Summit County locality.
 * Away games carry out-of-state cities ("Danville, Indiana", "Detroit,
 * Michigan"), which fail the gate. Accepts "Tallmadge, Ohio" or "Tallmadge".
 */
export function isHomeGame(cityLine) {
  const city = String(cityLine || '').split(',')[0].trim()
  if (!city) return false
  return isSummitCountyLocation({ city })
}

/**
 * Parse the "Detailed Schedule" paragraph into { 'M/D': 'H:MM AM' } first-
 * whistle times, e.g. "4/11 … First whistle at 6PM." and "5/16 & 6/13 …
 * First whistle at 4PM.". Missing dates fall back to DEFAULT_FIRST_WHISTLE.
 */
export function parseDetailedTimes(text) {
  const out = {}
  const s = String(text || '')
  // Each sentence groups one or more "M/D" dates with a "First whistle at NPM".
  const re = /((?:\d{1,2}\/\d{1,2}(?:\s*&\s*\d{1,2}\/\d{1,2})*))[\s\S]*?first whistle at\s*(\d{1,2})(?::(\d{2}))?\s*([ap])m/gi
  for (const m of s.matchAll(re)) {
    const hour = Number(m[2])
    const minute = m[3] ? Number(m[3]) : 0
    const ampm = m[4].toUpperCase() === 'P' ? 'PM' : 'AM'
    const time = `${hour}:${String(minute).padStart(2, '0')} ${ampm}`
    for (const md of m[1].match(/\d{1,2}\/\d{1,2}/g) || []) out[md] = time
  }
  return out
}

/**
 * Parse the served HTML into HOME games only. Returns
 *   [{ date:'YYYY-MM-DD', title, matchups, city, time, tripleHeader }]
 *
 * Strategy: htmlToText → isolate the "Home Games" section (up to the "Away
 * Games" / "Detailed Schedule" banner) → walk its lines, treating each date
 * heading as the start of a block whose following lines carry the matchups and
 * city. The city is gated to Summit County so a mis-split can't leak an away
 * game. Times are joined in from the Detailed Schedule paragraph.
 */
export function parseEvents(html, now = new Date()) {
  const text = htmlToText(html)
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)

  const homeIdx = lines.findIndex((l) => /^home games$/i.test(l))
  if (homeIdx < 0) return []
  // The home section ends at the first of "Away Games" / "Detailed Schedule".
  let endIdx = lines.length
  for (let i = homeIdx + 1; i < lines.length; i++) {
    if (/^away games$/i.test(lines[i]) || /^detailed schedule$/i.test(lines[i])) { endIdx = i; break }
  }
  const section = lines.slice(homeIdx + 1, endIdx)

  const times = parseDetailedTimes(text)

  const games = []
  let cur = null
  const flush = () => {
    if (cur && cur.date && cur.matchups && isHomeGame(cur.city)) games.push(cur)
    cur = null
  }
  for (const line of section) {
    const heading = parseDateHeading(line, now)
    if (heading) {
      flush()
      cur = { date: heading.ymd, month: heading.month, day: heading.day, tripleHeader: heading.tripleHeader, matchups: null, city: null }
      continue
    }
    if (!cur) continue
    // The matchup line contains "vs." (one or more bouts). Take the first one
    // per block; ignore the "Summit County Fairgrounds" venue label and URLs.
    if (!cur.matchups && /\bvs\.?\b/i.test(line) && !/fairgrounds/i.test(line) && !/^https?:/i.test(line)) {
      cur.matchups = line
      continue
    }
    // City line: "Tallmadge, Ohio". Only set once, after we have matchups.
    if (cur.matchups && !cur.city && /,\s*ohio$/i.test(line)) {
      cur.city = line
    }
  }
  flush()

  return games.map((g) => {
    const md = `${g.month}/${g.day}`
    const time = times[md] || DEFAULT_FIRST_WHISTLE
    const title = g.tripleHeader
      ? `Akron Roller Derby Triple Header: ${g.matchups}`
      : `Akron Roller Derby: ${g.matchups}`
    return {
      date: g.date,
      time,
      title: title.replace(/\s+/g, ' ').trim(),
      matchups: g.matchups,
      city: g.city,
      tripleHeader: g.tripleHeader,
    }
  })
}

// ── Fetch ─────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('🛼  Starting Akron Roller Derby (home games) ingestion…')
  const start = Date.now()
  try {
    const html = await fetchHtml(EVENTS_URL)
    const games = parseEvents(html)
    console.log(`  Parsed ${games.length} home game(s)`)

    const organizerId = await ensureOrganization('Akron Roller Derby', {
      website: SITE,
      description: 'Akron Roller Derby is Akron\'s flat-track roller derby league, playing home bouts at the Summit County Fairgrounds in Tallmadge.',
    })
    const venueId = await ensureVenue(HOME_VENUE.name, {
      address: HOME_VENUE.address,
      city: HOME_VENUE.city,
      state: HOME_VENUE.state,
      zip: HOME_VENUE.zip,
    })
    if (organizerId && venueId) await linkOrganizationVenue(organizerId, venueId)

    const now = Date.now()
    const cutoff = now + MAX_DAYS_AHEAD * 86_400_000
    let inserted = 0, skipped = 0

    for (const g of games) {
      try {
        const startIso = easternToIso(g.date, g.time)
        if (!startIso) { skipped++; continue }
        const ms = Date.parse(startIso)
        if (ms < now - 86_400_000 || ms > cutoff) { skipped++; continue }

        const description =
          `${g.matchups}. Akron Roller Derby home bout at the Summit County ` +
          `Fairgrounds in Tallmadge, Ohio.` +
          (g.tripleHeader ? ' Triple header — three bouts.' : '')

        const row = {
          title:           g.title,
          description,
          start_at:        startIso,
          end_at:          null,
          category:        'sports',
          tags:            ['sports', 'roller-derby'],
          price_min:       null,   // presale tickets exist but no price on the page
          price_max:       null,
          age_restriction: 'all_ages',
          image_url:       null,
          ticket_url:      TICKETS_URL,
          source:          SOURCE_KEY,
          source_id:       `${slugify(g.matchups).slice(0, 60)}-${g.date}`,
          status:          'published',
          featured:        false,
        }
        const { data: upserted, error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed "${row.title}":`, error.message); skipped++; continue }
        if (venueId)     await linkEventVenue(upserted.id, venueId)
        if (organizerId) await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on "${g.title}":`, err.message)
        skipped++
      }
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: games.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
