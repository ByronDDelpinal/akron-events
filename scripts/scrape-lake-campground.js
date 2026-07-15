/**
 * scrape-lake_campground.js
 *
 * The Lake Campground (thelakepark.com) — a seasonal family campground in
 * Norton, OH (Summit County). Their events page is a single hand-formatted,
 * plain-text Weebly ("editmysite") page: one <div class="paragraph"> holding
 * the whole season's schedule as <br />-separated lines. There is NO events
 * plugin, feed, or per-event page — the date, time(s), and activity names all
 * live in prose the office types by hand each spring.
 *
 * Markup / prose quirks this parser defends against:
 *   • Date headers are bold: `<strong>Saturday, May 2 - </strong>` followed by
 *     that day's activities. The month name also appears alone on its own line
 *     ("May", "June", …) as a section divider — ignored (the header carries the
 *     full month itself).
 *   • A day's activities are one line of "/"-separated items, each usually
 *     prefixed OR suffixed with a time: "9 AM-12 PM Barnyard Brews",
 *     "Euchre Tournament 7 PM", "Eb's Soda Shop Truck 5:30 - 7:30 PM".
 *   • A single day's line sometimes WRAPS across several <br /> (e.g. Aug 1).
 *     We therefore treat every non-header, non-month line as a continuation of
 *     the current day and only split into activities AFTER re-joining the day.
 *   • The year is never printed next to a date — it lives once in the page
 *     title ("… 2026 Events Schedule"). We read it there and fall back to the
 *     current America/New_York year (never local Date + toISOString()).
 *
 * Modeling: ONE event per timed activity (real titles + real start times read
 * far better on a calendar than a single opaque "day at the campground" blob,
 * and inferCategory can then tag each). Activities with NO parseable clock time
 * (bare "Dusk", "Opening Day!!", "Theme TBD", a lone "10:15" with no meridiem)
 * are SKIPPED with a warning rather than guessing a time — we never synthesize a
 * default/midnight start (see the stan_hywet 09:00 lesson). The standing
 * "sand volleyball every Saturday at Noon" note is intentionally not expanded.
 *
 * Geography: a single fixed Summit County venue, so no per-event geo gate is
 * needed.
 *
 * Usage:
 *   node scripts/scrape-lake_campground.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  stripHtml,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  linkOrganizationVenue,
  ensureVenue,
  ensureOrganization,
  easternToIso,
} from './lib/normalize.js'

const SOURCE      = 'lake_campground'
const EVENTS_URL  = 'https://www.thelakepark.com/events.html'
const DAYS_AHEAD  = 180

// A cancelled/postponed activity names it in the token ("8 PM Karaoke CANCELED").
// Same title convention lib/civicplus.js uses — drop rather than publish.
const CANCELLED_RE = /\bcancell?ed\b|\bpostponed\b/i

// ── Static parsing tables ───────────────────────────────────────────────────

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
}
const WEEKDAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}
const MONTH_ALT = Object.keys(MONTHS).join('|')

// "Saturday, May 2 - <activities>" (the weekday is captured only to sanity-check
// the inferred year; the numeric date is authoritative).
const HEADER_RE = new RegExp(
  String.raw`^\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday),?\s+` +
  String.raw`(${MONTH_ALT})\s+(\d{1,2})\s*[-–—]\s*(.*)$`,
  'i',
)
// A line that is JUST a month name — a section divider, carries no event.
const MONTH_ONLY_RE = new RegExp(String.raw`^\s*(?:${MONTH_ALT})\s*$`, 'i')

// A single clock token: "9", "9:30", "9 AM", "9:30pm", "noon", "midnight".
const CLOCK = String.raw`\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|noon|midnight`
// "9 AM-12 PM", "5:30 - 7:30 PM", "2PM-4PM" — the start may omit its meridiem
// and inherit it from the end token.
const RANGE_RE  = new RegExp(String.raw`(${CLOCK})\s*[-–—]\s*(${CLOCK})`, 'i')
// A lone time that carries an explicit meridiem (or noon/midnight). We require
// the meridiem so a bare "10:15" is treated as unparseable rather than guessed.
const SINGLE_RE = new RegExp(
  String.raw`\b(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)|noon|midnight)\b`, 'i',
)

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/** The America/New_York calendar year right now — never local Date math. */
export function easternYearNow(dateNow = new Date()) {
  return Number(dateNow.toLocaleString('en-US', { timeZone: 'America/New_York', year: 'numeric' }))
}

/** Read the season year from the "… 2026 Events Schedule" heading. */
export function extractScheduleYear(html = '', fallback = easternYearNow()) {
  const m = html.match(/(\d{4})\s+Events?\s+Schedule/i)
  return m ? parseInt(m[1], 10) : fallback
}

/**
 * Isolate the schedule paragraph's inner HTML: the body <div class="paragraph">
 * that holds "… Events Schedule", trimmed at the trailing "Join us on Facebook"
 * footer so that boilerplate never leaks into the last day's activity line.
 */
export function extractScheduleParagraph(html = '') {
  const anchor = html.lastIndexOf('Events Schedule')
  if (anchor < 0) return ''
  const start = html.lastIndexOf('<div class="paragraph"', anchor)
  if (start < 0) return ''
  const close = html.indexOf('</div>', anchor)
  let seg = html.slice(start, close === -1 ? undefined : close)
  // Trim the trailing "Join us on Facebook: … for updated times" footer. Match
  // the colon form only — the intro line "Please join us on Facebook at:" near
  // the TOP must NOT trigger the cut (that would swallow the whole schedule).
  const footer = seg.search(/Join us on Facebook\s*:/i)
  if (footer !== -1) seg = seg.slice(0, footer)
  return seg
}

/** "6PM" / "10:30 am" / "noon" → "H:MM am|pm" (easternToIso-friendly) or null. */
export function normalizeClock(token, inheritMeridiem = null) {
  if (!token) return null
  const t = token.trim().toLowerCase()
  if (t === 'noon') return '12:00 pm'
  if (t === 'midnight') return '12:00 am'
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/)
  if (!m) return null
  const hour = parseInt(m[1], 10)
  const minute = m[2] ?? '00'
  const mer = m[3] ? (m[3].startsWith('p') ? 'pm' : 'am') : inheritMeridiem
  if (!mer || hour < 1 || hour > 12) return null
  return `${hour}:${minute} ${mer}`
}

/**
 * Parse one "/"-separated activity token into { title, startClock, endClock }.
 * Returns null when no explicit clock time is present (we skip rather than
 * fabricate a time). The time text — wherever it sits in the token — is removed
 * from the title.
 */
export function parseActivity(rawToken = '') {
  const raw = rawToken.trim()
  if (!raw) return null

  let matchStr = null
  let startClock = null
  let endClock = null

  const range = raw.match(RANGE_RE)
  if (range) {
    const end = normalizeClock(range[2])
    const start = normalizeClock(
      range[1], end?.endsWith('pm') ? 'pm' : end?.endsWith('am') ? 'am' : null,
    )
    if (start) {
      startClock = start
      endClock = end || null
      matchStr = range[0]
    }
  }
  if (!startClock) {
    const single = raw.match(SINGLE_RE)
    if (single) {
      const c = normalizeClock(single[1])
      if (c) { startClock = c; matchStr = single[0] }
    }
  }
  if (!startClock) return null

  let title = raw.replace(matchStr, ' ').replace(/\s+/g, ' ').trim()
  // Strip connective punctuation the removed time left behind ("- Kids Craft").
  title = title.replace(/^[\s\-–—,:/]+/, '').replace(/[\s\-–—,:/]+$/, '').trim()
  if (title.length < 3) return null

  return { title, startClock, endClock }
}

/** Kid/family-themed activity? Drives the is_family facet flag. */
export function isFamilyActivity(title = '') {
  return /\b(kids?|kid's|children|family|families|bike parade|coloring|trick or treat|scavenger hunt|bubble|fishing derby|olympics|reindeer|superhero|petting)\b/i
    .test(title)
}

/** Light content-category hint; inferCategory still runs and can add a second. */
export function categoryHint(title = '') {
  const t = title.toLowerCase()
  if (/\b(band|karaoke|dj|dance party|luau)\b/.test(t)) return 'music'
  if (/kids? paint|adult paint|paint n sip|\bpaint\b|coloring|\bcraft\b/.test(t)) return 'visual-art'
  if (/cornhole|euchre|bingo|poker run|scavenger hunt|trivia/.test(t)) return 'games'
  if (/volleyball|olympics|fishing derby|\btournament\b/.test(t)) return 'sports'
  if (/tasting|\bwine\b|\bbeer\b|bourbon|brews|ice cream|root ?beer|soda shop|kona ice|hot dog|chili|\bsoup\b|\bdinner\b|cook off|\bfloats?\b|breakfast|pancake/.test(t)) return 'food'
  if (/yard sale/.test(t)) return 'market'
  return null
}

function slugify(str = '') {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

/**
 * Split the season paragraph into day buckets. Each header opens a new day;
 * every following non-header, non-month line is appended (handles activity
 * lines that wrap across <br />). Returns [{ month, day, weekday, text }].
 */
export function splitDays(paragraphHtml = '') {
  const segments = paragraphHtml.split(/<br\s*\/?>/i)
  const days = []
  let current = null
  for (const rawSeg of segments) {
    const line = stripHtml(rawSeg)
    if (!line) continue
    const header = line.match(HEADER_RE)
    if (header) {
      if (current) days.push(current)
      current = {
        weekday: header[1].toLowerCase(),
        month: MONTHS[header[2].toLowerCase()],
        day: parseInt(header[3], 10),
        text: header[4] || '',
      }
      continue
    }
    if (MONTH_ONLY_RE.test(line)) continue
    if (current) current.text += ` ${line}`
  }
  if (current) days.push(current)
  return days
}

/**
 * Turn the raw page HTML into event rows (fully pure — easternToIso is
 * deterministic, so start/end ISO instants are computed here for the tests).
 * Window filtering is left to the caller.
 */
export function buildEvents(html = '', { year } = {}) {
  const scheduleYear = year ?? extractScheduleYear(html)
  const paragraph = extractScheduleParagraph(html)
  const days = splitDays(paragraph)
  const rows = []
  const warnings = []

  for (const d of days) {
    if (!d.month || !d.day) continue
    const dateStr = `${scheduleYear}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`

    // Sanity-check the inferred year against the printed weekday.
    const expected = new Date(Date.UTC(scheduleYear, d.month - 1, d.day)).getUTCDay()
    if (WEEKDAY_INDEX[d.weekday] !== expected) {
      warnings.push(`weekday mismatch for ${dateStr}: page says ${d.weekday}`)
    }

    const seenSlugs = new Map()
    for (const token of d.text.split('/')) {
      const raw = token.trim()
      if (!raw) continue
      // Drop a cancelled/postponed activity rather than publishing it.
      if (CANCELLED_RE.test(raw)) continue
      const parsed = parseActivity(raw)
      if (!parsed) {
        if (raw.length >= 3) warnings.push(`no time for "${raw}" on ${dateStr} — skipped`)
        continue
      }

      const startAt = easternToIso(dateStr, parsed.startClock)
      if (!startAt) { warnings.push(`bad start for "${raw}" on ${dateStr}`); continue }
      let endAt = parsed.endClock ? easternToIso(dateStr, parsed.endClock) : null
      // A range that reads earlier than its start crossed midnight — roll a day.
      if (endAt && endAt <= startAt) {
        endAt = new Date(new Date(endAt).getTime() + 86400_000).toISOString()
      }

      let slug = slugify(parsed.title) || 'event'
      if (seenSlugs.has(slug)) {
        const n = seenSlugs.get(slug) + 1
        seenSlugs.set(slug, n)
        slug = `${slug}-${n}`
      } else {
        seenSlugs.set(slug, 1)
      }

      const isFamily = isFamilyActivity(parsed.title)
      const tags = ['campground', 'the lake campground', 'norton']
      if (isFamily) tags.push('family')

      rows.push({
        title: parsed.title,
        description:
          `${raw} — Part of The Lake Campground's ${scheduleYear} seasonal event schedule ` +
          `in Norton, OH. Events are weather permitting and subject to change.`,
        start_at: startAt,
        end_at: endAt,
        category: categoryHint(parsed.title) ?? undefined,
        is_family: isFamily || undefined,
        tags,
        price_min: null,
        price_max: null,
        age_restriction: 'not_specified',
        image_url: null,
        source_url: EVENTS_URL,
        source: SOURCE,
        source_id: `${dateStr}-${slug}`,
        status: 'published',
        featured: false,
      })
    }
  }

  return { rows, warnings }
}

// ── Venue / Organizer ───────────────────────────────────────────────────────

async function ensureLakeVenue() {
  return ensureVenue('The Lake Campground', {
    address: '2678 S Hametown Rd',
    city: 'Norton',
    state: 'OH',
    zip: '44203',
    website: 'https://www.thelakepark.com',
    description:
      'Seasonal family campground and lake park in Norton, OH (Summit County), ' +
      'open roughly May through October with weekend activities for campers and guests.',
  })
}

async function ensureLakeOrganizer() {
  return ensureOrganization('The Lake Campground', {
    website: 'https://www.thelakepark.com',
    description: 'Family campground and lake park in Norton, OH.',
  })
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀  Starting The Lake Campground ingestion…')
  const start = Date.now()

  try {
    const res = await fetch(EVENTS_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0)' },
    })
    if (!res.ok) throw new Error(`Events page fetch failed: ${res.status}`)
    const html = await res.text()

    const { rows, warnings } = buildEvents(html)
    console.log(`  Parsed ${rows.length} timed activities across the schedule.`)
    warnings.forEach((w) => console.warn(`  ⚠ ${w}`))

    if (!rows.length) {
      await logUpsertResult(SOURCE, 0, 0, 0, {
        status: 'error',
        errorMessage: 'No timed activities parsed — page markup may have changed',
        durationMs: Date.now() - start,
        eventsFound: 0,
      })
      console.warn('\n⚠  No events parsed. Check thelakepark.com/events.html markup.')
      return
    }

    const [venueId, organizerId] = await Promise.all([
      ensureLakeVenue(),
      ensureLakeOrganizer(),
    ])
    if (venueId && organizerId) await linkOrganizationVenue(organizerId, venueId)

    const now = Date.now()
    const horizon = now + DAYS_AHEAD * 86400_000
    let inserted = 0
    let skipped = 0

    for (const row of rows) {
      const startMs = new Date(row.start_at).getTime()
      if (startMs < now - 86400_000 || startMs > horizon) { skipped++; continue }

      const { data, error } = await upsertEventSafe(row)
      if (error) {
        console.warn(`  ⚠ Upsert failed for "${row.title}" (${row.start_at}):`, error.message)
        skipped++
        continue
      }
      if (venueId) await linkEventVenue(data.id, venueId)
      if (organizerId) await linkEventOrganization(data.id, organizerId)
      inserted++
    }

    await logUpsertResult(SOURCE, inserted, 0, skipped, {
      eventsFound: rows.length,
      durationMs: Date.now() - start,
    })
    console.log(`\n✅  Done: ${inserted} upserted, ${skipped} skipped (out of window / failed) in ${((Date.now() - start) / 1000).toFixed(1)}s`)
  } catch (err) {
    await logScraperError(SOURCE, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly; importing for tests exposes the pure parsers
// without triggering a live run.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
