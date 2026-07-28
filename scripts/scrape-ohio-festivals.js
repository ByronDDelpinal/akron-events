/**
 * scrape-ohio-festivals.js
 *
 * Ohio Festivals (ohiofestivals.net) — a statewide, hand-curated festival
 * directory (WordPress). Its 2,600+ listings are a single chronological guide;
 * each festival is one line:
 *
 *     7/10-7/11 – Summit County Italian American Festival – Akron – My Review
 *     7/18*     – Halfway to Christmas – Akron
 *
 * Format: {M/D[-M/D]}{*?} – {Festival Name} – {City} [– My Review]. The trailing
 * "*" marks an unconfirmed date; "My Review" is a link to the site's own review.
 *
 * This is an AGGREGATOR, so we gate every entry to Summit County by city
 * (lib/summit-county.js) — that yields ~100 local festivals. The data is thin
 * (date + name + city only — no time, venue, or description), so we set a
 * midday default start, leave the venue null (the city goes in the description),
 * and rank `ohio_festivals` below richer sources in the dedupe priority.
 * Category festival; price never assumed.
 *
 * YEAR HANDLING (2026-07 fix): the guide is a rolling ~14-month document with
 * month section headers — JULY … DECEMBER, then "JANUARY (2027)" … AUGUST. The
 * old month-vs-current-month inference mapped the second year's JUL-DEC
 * tentative entries into the CURRENT year, creating phantom near-duplicates at
 * wrong dates (~26% of upcoming rows). We now track the year from the section
 * headers ("(YYYY)" markers, plus month rollover) and only fall back to month
 * inference if a page redesign removes the headers.
 *
 * STALENESS (same fix): source_id embeds the start date, so a hand-edited date
 * change orphaned the old row forever. Each run now deletes future rows whose
 * source_id was not produced by the current guide. Starred (unconfirmed)
 * entries more than 180 days out are skipped — they are prior-year guesses the
 * guide firms up closer in.
 *
 * DIRECT-SOURCE SUPPRESSION (Better Kenmore pattern, title-keyed): guide rows
 * carry NO venue, so the venue+second dedupe pass can never merge them with
 * the richer copies our first-party scrapers produce — the site showed both.
 * SUPPRESSED_DIRECT skips guide entries owned by a direct scraper (suppress,
 * don't dedupe). Only DB-verified coverage is listed: before adding an entry,
 * confirm the owning scraper actually ingests that festival — e.g. Tallmadge's
 * Circle Festival and Akron CityFest are NOT suppressed because no direct
 * source currently carries them.
 *
 * Usage:   node scripts/scrape-ohio-festivals.js
 * Env:     VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult, logScraperError, htmlToText, easternToIso,
  enrichWithImageDimensions, upsertEventSafe,
} from './lib/normalize.js'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { isSummitCountyLocation } from './lib/summit-county.js'

export const SOURCE_KEY = 'ohio_festivals'
const GUIDE_URL = 'https://ohiofestivals.net/ohio-festivals/'
const USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'
// SANCTIONED-DEFAULT-TIME
// The guide publishes date, name and city only, so both clock times below are
// invented for every row. That is deliberate, not an oversight: an event stored
// at midnight falls out of every feed on its own day under the no-grace-window
// rule, so a midday start and an evening end are what keep a festival visible to
// the people it is for. The defaults must never be silent, so every description
// discloses them (see TIME_NOTE below). Do not "fix" these to midnight or to
// null without reading the full record in
// docs/default-event-times-decision-2026-07-28.md (maintainer-local; docs/ is
// gitignored, so that file is a secondary reference, not the primary one).
const DEFAULT_TIME = '12:00 PM'   // festivals list no time; midday default
const END_TIME     = '8:00 PM'    // SANCTIONED-DEFAULT-TIME, same decision as above
const MAX_DAYS_AHEAD = 400
const TENTATIVE_MAX_DAYS_AHEAD = 180  // starred (unconfirmed) dates only publish within ~6 months

const DASH = '–'  // en-dash field separator

// The disclosure for the defaults above. Accurate as worded because this source
// genuinely never publishes a time.
//
// Duplicated as a literal in supabase/functions/send-digest/select.ts, which
// subtracts it before scoring description length and cannot import from
// scripts/. Edit both; scripts/tests/test-digest-selection.js fails on drift.
export const TIME_NOTE =
  'The guide does not list a start time, so the time shown is a placeholder. Confirm with the organizer before you go.'

// ── Pure parsers (exported for tests) ───────────────────────────────────────

/** Build YYYY-MM-DD, inferring the year: a month earlier than the current month
 *  belongs to next year (the guide spans into next year). */
export function buildYmd(month, day, now = new Date()) {
  const cm = now.getMonth() + 1
  const year = month >= cm ? now.getFullYear() : now.getFullYear() + 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Parse one festival line → { name, city, startYmd, endYmd, unconfirmed } or null.
 * When `sectionYear` is provided (from the guide's month headers) it is
 * authoritative; a range whose end month precedes its start month crosses into
 * the next year (12/28-1/2). Without it, fall back to month inference.
 */
export function parseFestivalLine(line, now = new Date(), sectionYear = null) {
  const re = new RegExp(`^(\\d{1,2})\\/(\\d{1,2})(?:-(\\d{1,2})\\/(\\d{1,2}))?(\\*?)\\s*${DASH}\\s*(.+)$`)
  const m = String(line || '').trim().match(re)
  if (!m) return null
  const [, sm, sd, em, ed, star, rest] = m
  const parts = rest.split(new RegExp(`\\s*${DASH}\\s*`)).map((s) => s.trim()).filter((p) => p && !/^my review$/i.test(p))
  if (parts.length < 2) return null
  const city = parts[parts.length - 1]
  const name = parts.slice(0, -1).join(` ${DASH} `).trim()
  if (!name || !city) return null
  const ymd = (mo, d, yr) => `${yr}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  let startYmd, endYmd
  if (sectionYear != null) {
    startYmd = ymd(+sm, +sd, sectionYear)
    endYmd   = em ? ymd(+em, +ed, +em < +sm ? sectionYear + 1 : sectionYear) : null
  } else {
    startYmd = buildYmd(+sm, +sd, now)
    endYmd   = em ? buildYmd(+em, +ed, now) : null
  }
  return { name, city, startYmd, endYmd, unconfirmed: !!star }
}

const MONTH_INDEX = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}
// A section header line: just a month name, optionally "(YYYY)" at the year
// boundary — e.g. "JULY", "JANUARY (2027)".
const MONTH_HEADER_RE = /^(january|february|march|april|may|june|july|august|september|october|november|december)(?:\s*\((\d{4})\))?$/i

/**
 * Parse the whole guide text into festival entries (not yet gated).
 * Tracks the year across month section headers: an explicit "(YYYY)" sets it,
 * and a month that moves backwards (DECEMBER → JANUARY without a marker) rolls
 * it forward. The first header anchors to the current year — the guide's first
 * section is always the current month. If no headers are found at all (page
 * redesign), every line falls back to the old month-vs-now inference.
 */
export function parseFestivals(text, now = new Date()) {
  // Insert a break before each "M/D –" start, so we parse whether the source
  // rendered one festival per line or ran them together. The preceding char
  // must not be a hyphen: "7/25-7/26 – Akron Arts Expo" is ONE range — the old
  // pattern split it into a dropped "7/25-" fragment plus a single-day 7/26
  // event, which is why every multi-day festival lost its start date.
  const normalized = String(text || '').replace(
    new RegExp(`([^\\n\\d-])\\s*(?=\\d{1,2}\\/\\d{1,2}(?:-\\d{1,2}\\/\\d{1,2})?\\*?\\s*${DASH})`, 'g'),
    '$1\n',
  )
  const out = []
  let sectionYear = null
  let lastMonth = null
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trim()
    const h = line.match(MONTH_HEADER_RE)
    if (h) {
      const mo = MONTH_INDEX[h[1].toLowerCase()]
      if (h[2]) sectionYear = +h[2]
      else if (sectionYear == null) sectionYear = now.getFullYear()
      else if (lastMonth != null && mo < lastMonth) sectionYear++
      lastMonth = mo
      continue
    }
    const f = parseFestivalLine(line, now, sectionYear)
    if (f) out.push(f)
  }
  return out
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// ── Direct-source suppression ───────────────────────────────────────────────
// Festivals a first-party scraper already covers with richer data (venue,
// times, images). Guide copies are suppressed at ingest — no venue means the
// dedupe pass can't merge them downstream. `city` (lowercase) narrows generic
// titles ("Harvest Festival") to the right venue's town. DB-verified 2026-07-08.
export const SUPPRESSED_DIRECT = [
  { pattern: /porchrokr/i,                 source: 'highland_square' },
  { pattern: /akron pride festival/i,      source: 'akron_pride' },
  { pattern: /civil war/i,                 city: 'bath', source: 'hale_farm' },
  { pattern: /music in the valley/i,       city: 'bath', source: 'hale_farm' },
  { pattern: /made in ohio/i,              city: 'bath', source: 'hale_farm' },
  { pattern: /harvest festival/i,          city: 'bath', source: 'hale_farm' },
  { pattern: /summer sunset blast/i,       city: 'stow', source: 'city_of_stow' },
  { pattern: /wild lights/i,               city: 'akron', source: 'akron_zoo' },
]

/** Returns the owning direct source key when a guide entry should be suppressed, else null. */
export function directSourceFor(f) {
  const city = String(f?.city ?? '').toLowerCase().trim()
  for (const rule of SUPPRESSED_DIRECT) {
    if (!rule.pattern.test(f?.name ?? '')) continue
    if (rule.city && rule.city !== city) continue
    return rule.source
  }
  return null
}

// ── Row construction ──────────────────────────────────────────────────────

/**
 * Build the event row for one parsed festival, or null when the date cannot be
 * resolved to an instant. Pure and exported so tests exercise the real start
 * time and the real description text instead of a copy of them.
 *
 * The description is rebuilt from the parsed fields on every run and is never
 * read back from the database, so appending TIME_NOTE is idempotent by
 * construction. It fires unconditionally because this source never publishes a
 * time.
 */
export function buildEventRow(f) {
  const startIso = easternToIso(f.startYmd, DEFAULT_TIME)
  if (!startIso) return null

  const description =
    `${f.name} is a festival in ${f.city}, Summit County, Ohio.` +
    (f.unconfirmed ? ' Dates are tentative; confirm before attending.' : '') +
    ' Listed in the Ohio Festivals guide.' +
    ` ${TIME_NOTE}`

  return {
    title:           f.name,
    description,
    start_at:        startIso,
    end_at:          f.endYmd ? easternToIso(f.endYmd, END_TIME) : null,
    category:        'festival',
    tags:            ['festival', 'ohio-festivals', slugify(f.city)],
    price_min:       null,            // never assume free
    price_max:       null,
    age_restriction: 'all_ages',
    image_url:       null,
    ticket_url:      GUIDE_URL,
    source:          SOURCE_KEY,
    source_id:       `${slugify(f.name)}-${f.startYmd}`,
    status:          'published',
    featured:        false,
  }
}

// ── Fetch ─────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('🎪  Starting Ohio Festivals (Summit County) ingestion…')
  const start = Date.now()
  try {
    const html = await fetchHtml(GUIDE_URL)
    const all = parseFestivals(htmlToText(html))
    // Deliberately strict allowlist-drop rather than review-queue (2026-07-14
    // strict mandate): this is a STATEWIDE guide where every row carries a
    // real city name, so an off-allowlist city means genuinely out-of-county
    // — routing ~400 Columbus/Dayton/etc. rows to review would bury the queue.
    const summit = all.filter((f) => isSummitCountyLocation({ city: f.city }))
    console.log(`  Parsed ${all.length} festivals; ${summit.length} in Summit County`)

    const now = Date.now()
    const cutoff = now + MAX_DAYS_AHEAD * 86_400_000
    const tentativeCutoff = now + TENTATIVE_MAX_DAYS_AHEAD * 86_400_000
    let inserted = 0, skipped = 0
    const seenSourceIds = new Set()

    for (const f of summit) {
      try {
        const row = buildEventRow(f)
        if (!row) { skipped++; continue }
        const ms = Date.parse(row.start_at)
        if (ms < now - 86_400_000 || ms > cutoff) { skipped++; continue }
        // Starred entries far out are the guide's prior-year guesses — wait
        // for it to firm them up before publishing.
        if (f.unconfirmed && ms > tentativeCutoff) { skipped++; continue }

        // A first-party scraper owns this festival with richer data — the
        // venue-less guide copy would surface as an unmergeable duplicate.
        const directOwner = directSourceFor(f)
        if (directOwner) {
          console.log(`  ⛔ Suppressing "${f.name}" — covered by direct scraper ${directOwner}`)
          skipped++
          continue
        }

        const { error } = await upsertEventSafe(await enrichWithImageDimensions(row))
        if (error) { console.warn(`  ⚠ Upsert failed "${row.title}":`, error.message); skipped++; continue }
        seenSourceIds.add(row.source_id)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error on "${f.name}":`, err.message)
        skipped++
      }
    }

    // ── Stale-row cleanup ────────────────────────────────────────────────
    // source_id embeds the start date, so when the hand-edited guide moves a
    // date the upsert creates a NEW row; anything future-dated that this run
    // did not produce is an orphan from an older guide revision — remove it.
    // Guard: never run the sweep after a suspiciously small parse (a page
    // redesign shrinking the list must not delete the whole source).
    if (seenSourceIds.size >= 20) {
      const { data: staleRows, error: staleErr } = await supabaseAdmin
        .from('events')
        .select('id, source_id, title')
        .eq('source', SOURCE_KEY)
        .gte('start_at', new Date(now).toISOString())
      if (staleErr) {
        console.warn('  ⚠ Stale sweep query failed:', staleErr.message)
      } else {
        const stale = (staleRows ?? []).filter((r) => !seenSourceIds.has(r.source_id))
        if (stale.length) {
          const { error: delErr } = await supabaseAdmin
            .from('events')
            .delete()
            .in('id', stale.map((r) => r.id))
          if (delErr) console.warn('  ⚠ Stale delete failed:', delErr.message)
          else {
            console.log(`  🧹 Removed ${stale.length} stale rows no longer in the guide:`)
            stale.forEach((r) => console.log(`     - ${r.title} (${r.source_id})`))
          }
        }
      }
    } else {
      console.warn(`  ⚠ Only ${seenSourceIds.size} rows parsed — skipping stale sweep (guide layout may have changed).`)
    }

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, { eventsFound: summit.length, durationMs: Date.now() - start })
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} upserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
