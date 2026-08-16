/**
 * scrape-city-of-cuyahoga-falls.js
 *
 * City of Cuyahoga Falls, Ohio (Summit County) — Drupal 10 site. Unlike the
 * Summit County CivicPlus municipalities, Cuyahoga Falls has no iCalendar
 * feed; events live in a Drupal calendar View.
 *
 * DATE AUTHORITY — read this before changing anything here.
 *
 * This module used to read the monthly calendar grid (/calendar/YYYYMM) and
 * described it as "the most reliable date source". That was exactly backwards
 * and it published a full calendar of wrong dates. The month grid renders EVERY
 * event one day early: the day cell's `date-date`, `data-day-of-month`,
 * `headers` and `id` all agree with each other and all four are wrong, so
 * nothing inside the grid can detect its own error. The grid is retired. Do not
 * reintroduce it, and do not fall back to it when the sources below fail — a
 * known-wrong source is worse than no data.
 *
 * The DAY view is the truth, corroborated five ways (the day view itself, the
 * detail page's recurrence prose, the incident report's description arbiter, a
 * June 2026 human verification, and weekday consistency). Worked example: the
 * month grid placed the Riverfront Cruise In on Sun 2026-08-16;
 * /calendar-field_cal_date/day/20260816 returns no events at all,
 * /calendar-field_cal_date/day/20260817 returns riverfront-cruise, and the
 * detail page says "Mondays, June - August".
 *
 * The YEAR view (/calendar-field_cal_date/year/YYYY) is the correctly-dated
 * index of which days have events, in one fetch: cells carry `has-events` and
 * link to /calendar-field_cal_date/day/YYYYMMDD. It is discovery only — the day
 * view supplies the events. /calendar-field_cal_date/month/… and /week/… are
 * 404 and /events is 403, so there is no third option.
 *
 * The detail page carries NO structured date — no <time>, no datetime=, no
 * JSON-LD, no meta. Only recurrence prose. Checked exhaustively; do not try.
 *
 * Strategy:
 *   1. Fetch the year view(s) covering the horizon (both years when the ~90-day
 *      window crosses Dec 31) → the set of days that actually have events.
 *   2. Filter that set to [today, today + HORIZON_DAYS], eastern-anchored.
 *   3. Fetch one day view per remaining day and read slug + title from its
 *      /events/{slug} anchors. Every day view is one date, so there is no
 *      column/weekday inference left to get wrong.
 *   4. Drop government/administrative entries (City Council, Planning
 *      Commission, Board of Zoning Appeal, etc.) with a meeting filter.
 *   5. Fetch each unique event node once (cached) for its <h1> title, og:
 *      description, og:image, and a best-effort start time parsed from the
 *      detail prose / meta description ("6 to 10 p.m.", "beginning at 7 p.m.").
 *   6. Retire published rows in the covered window that this run did not
 *      resolve (see planRetirement) — the date fix moves every occurrence by a
 *      day, so the old rows would otherwise stay published forever under
 *      source_ids the fixed scraper can never mint again.
 *
 * Public series surfaced: Falls Downtown Fridays, Front Street Live, Riverfront
 * Cruise In, Picnic In The Park, Community Band, Keyser Concerts, Flix on the
 * Falls, plus one-off festivals and Quirk Cultural Center programming.
 *
 * Usage:   node scripts/scrape-city-of-cuyahoga-falls.js
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import {
  clampChars,
  easternToIso,
  enrichWithImageDimensions,
  ensureOrganization,
  ensureVenue,
  inferCategory,
  linkEventOrganization,
  linkEventVenue,
  linkOrganizationVenue,
  logScraperError,
  logUpsertResult,
  stripHtml,
  upsertEventSafe,
  easternTodayIso,
} from './lib/normalize.js'
import { pathToFileURL } from 'node:url'

const SOURCE_KEY = 'city_of_cuyahoga_falls'
const BASE_URL = 'https://www.cityofcf.com'

// How far ahead we ingest, in days. ~90 preserves the intent of the retired
// MONTHS_AHEAD = 2 without its bug: MONTHS_AHEAD built month URLs from
// `new Date()` + getFullYear()/getMonth(), which are LOCAL, so on the last night
// of a month a UTC CI runner was already in the next month and silently skipped
// the current one entirely. Everything here is eastern-anchored instead. Sibling
// scrapers use the same day-count shape (scrape-akron-life.js 180,
// scrape-akron-ymca.js 200).
export const HORIZON_DAYS = 90

// Ceiling on day-view fetches in one run. The horizon can name at most ~91 days,
// so this is unreachable in normal operation; blowing past it means the year
// view changed shape and we are about to hammer the city's site. Truncating also
// makes the run partial, which blocks retirement (see planRetirement).
export const MAX_DAY_FETCHES = 120

// Administrative / governance event slugs+titles to drop. Cuyahoga Falls tags
// these as "Government Event" but the grid doesn't expose the category, so we
// gate on the title like the CivicPlus filter does.
const ADMIN_RE =
  /\b(city council|council\b|planning commission|board of zoning|zoning appeal|claims commission|public art board|tax incentive|review council|parks and recreation board|design & historic|historic review|public meeting|public hearing|committee|commission\b|board meeting|caucus|work session|trustees?)\b/i

function isPublicEvent(title) {
  const t = (title || '').trim().toLowerCase()
  if (!t) return false
  if (ADMIN_RE.test(t)) return false
  return true
}

// Category: infer from title + description.
function mapCategory(title = '', desc = '') {
  return inferCategory(title, desc)
}

function mapTags(title = '') {
  const t = title.toLowerCase()
  const tags = ['cuyahoga-falls', 'summit-county']
  if (/concert|music|band|live music/.test(t)) tags.push('music', 'outdoor')
  if (/flix|movie/.test(t))                    tags.push('family', 'outdoor', 'free')
  if (/downtown|front street|cruise/.test(t))  tags.push('downtown', 'outdoor')
  if (/picnic/.test(t))                        tags.push('family', 'free')
  return [...new Set(tags)]
}

// ── Time parsing from detail prose ──────────────────────────────────────────
// CF detail pages describe times in prose ("take place from 6 to 10 p.m.",
// "beginning at 7 p.m.", "11:30 a.m. – 1 p.m."). We want the event's START time.
//
// The previous version grabbed the first clock token that carried an am/pm
// marker. In a range like "7 - 8 p.m." only the END states the meridiem, so it
// matched "8 p.m." and stored the event an hour late; "4 – 7 p.m." likewise
// yielded 7 p.m. instead of the 4 p.m. start. So: detect a range first and take
// its start (inheriting the end's meridiem when the start omits one), and only
// fall back to a single clock time when there's no range.
// hour/minute/meridiem → "HH:MM:SS", or null when the numbers cannot be a
// clock time. Returning null (rather than clamping or wrapping) is what lets
// the scanners below REJECT a false match and keep looking.
//
// The old version computed `(hr % 12) + (isPm ? 12 : 0)` with no upper guard,
// so a two-digit non-hour swept out of surrounding prose came back as a
// plausible time: "26" → 26 % 12 = 2 → "02:00:00", returned with
// inferred: false, which suppressed the TIME_NOTE disclosure. Any hour a
// meridiem is attached to must be a real 12-hour-clock hour (1–12); anything
// else is not a time and must not be coerced into one.
//
// Modelled on to24h() in scrape-longwood-manor.js (the in-repo precedent for
// reject-and-rescan time parsing). Not imported: this contract differs (seconds
// in the string, and the caller owes a sanctioned default).
function timeStr(hr, min, isPm) {
  const hour = Number(hr)
  if (!Number.isInteger(hour)) return null
  if (hour < 1 || hour > 12) return null        // a meridiem forces a 12-hour clock
  const minute = String(min ?? '00')
  if (!/^\d{2}$/.test(minute) || Number(minute) > 59) return null
  const h = (hour % 12) + (isPm ? 12 : 0)
  return `${String(h).padStart(2, '0')}:${minute}:00`
}

// SANCTIONED-DEFAULT-TIME
// This source publishes no clock time for many events, so when the prose
// carries none we invent noon. That is deliberate, not an oversight: an event
// stored at midnight falls out of every feed on its own day under the
// no-grace-window rule, so a mid-day default is what keeps it visible to the
// people it is for. The default must never be silent, so the caller discloses
// it in the description (see TIME_NOTE below). Do not "fix" this to midnight
// or to null without reading the full record in
// docs/default-event-times-decision-2026-07-28.md (maintainer-local; docs/ is
// gitignored, so that file is a secondary reference, not the primary one).
//
// `inferred` is what tells the caller which path produced the time: comparing
// the returned string to '12:00:00' would false-positive on a genuine noon
// event.
export function parseTimeFromTextDetailed(text) {
  if (!text) return { time: '12:00:00', inferred: true }   // SANCTIONED-DEFAULT-TIME, see above

  // Range: "<start>[meridiem] (-|–|—|to) <end> meridiem".
  //
  // `\b` in front of each number and `(?!\d)` behind it are the digit-boundary
  // guards: without them the scanner reached INTO a four-digit year and matched
  // "26 - 9:00 AM" out of "…August 4-25, 2026 - 9:00 AM - 11:00 AM", storing
  // 02:00 for a 9 a.m. event with inferred:false so nothing disclosed it.
  //
  // Boundaries alone are not enough — "August 29 - 9:00 AM" still matches
  // "29 - 9:00 AM", because 29 IS a standalone number followed by a dash. That
  // is what timeStr()'s 1–12 hour check catches. And rejecting is only half the
  // job: the scan has to resume from match.index + 1, not from the end of the
  // rejected match, or the real "9:00 AM" inside it is skipped and the event
  // falls through to the noon default.
  const RANGE_RE =
    /\b(\d{1,2})(?::(\d{2}))?(?!\d)\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to)\s*\b(\d{1,2})(?::(\d{2}))?(?!\d)\s*(a\.?m\.?|p\.?m\.?)/gi
  RANGE_RE.lastIndex = 0
  let m
  while ((m = RANGE_RE.exec(text)) !== null) {
    const startHr  = parseInt(m[1], 10)
    const startMin = m[2] ?? '00'
    const endHr    = parseInt(m[4], 10)
    let startPm
    if (m[3]) {
      startPm = /p/i.test(m[3])                     // start states its own meridiem
    } else {
      const endPm = /p/i.test(m[6])
      const to24  = (h, pm) => (h % 12) + (pm ? 12 : 0)
      // Inherit the end's meridiem, unless inheriting PM would push the start
      // past the end across the noon line (e.g. "11 - 1 p.m." → 11 a.m.).
      startPm = endPm && to24(startHr, true) <= to24(endHr, true)
    }
    const time = timeStr(startHr, startMin, startPm)
    // Both ends have to be real clock hours: a valid-looking start paired with
    // an impossible end ("9 - 25 p.m.") is prose, not a range.
    if (time && timeStr(endHr, m[5] ?? '00', /p/i.test(m[6]))) {
      return { time, inferred: false }
    }
    RANGE_RE.lastIndex = m.index + 1                // rescan, don't skip the match
  }

  // Single time: "beginning at 7 p.m.", "10:30 a.m." Same guards, same rescan.
  const SINGLE_RE = /\b(\d{1,2})(?::(\d{2}))?(?!\d)\s*(a\.?m\.?|p\.?m\.?)/gi
  SINGLE_RE.lastIndex = 0
  let s
  while ((s = SINGLE_RE.exec(text)) !== null) {
    const time = timeStr(parseInt(s[1], 10), s[2] ?? '00', /p/i.test(s[3]))
    if (time) return { time, inferred: false }
    SINGLE_RE.lastIndex = s.index + 1
  }

  return { time: '12:00:00', inferred: true }   // SANCTIONED-DEFAULT-TIME, see above
}

/** Backwards-compatible wrapper: the parsed time only, same values as before. */
export function parseTimeFromText(text) {
  return parseTimeFromTextDetailed(text).time
}

// The description disclosure for the fallback path above. Worded for a listing
// page because that is what the reader clicks through to. It has to cover three
// different fallbacks (no time in the prose, a time we could not parse such as
// "at dusk", and a detail fetch that failed outright), so it claims only that we
// could not confirm a time, never that the source omitted one.
//
// Duplicated as a literal in supabase/functions/send-digest/select.ts, which
// subtracts it before scoring description length and cannot import from
// scripts/. Edit both; scripts/tests/test-digest-selection.js fails on drift.
export const TIME_NOTE =
  'We could not confirm a start time for this listing, so the time shown is a placeholder. Confirm with the organizer before you go.'

// Cap on the stored description, applied in fetchDetail and again in
// buildDescription so appending the note cannot push past it.
//
// `description` is a Postgres `text` column with no length limit, so this is a
// project convention, not a database constraint. It is still enforced rather
// than dropped: a cap that silently does not hold is worse than no cap, and an
// unbounded description is a real hazard downstream (the digest renders it into
// an email, and the site indexes it). scrape-ohio-erie-canalway.js applies the
// same reserve-then-append shape at its own, smaller cap.
export const MAX_DESCRIPTION = 5000

/**
 * The description we store for one occurrence. Appends TIME_NOTE only when the
 * time was invented, so a real 12:00 PM event is untouched. Exported so tests
 * exercise the real text.
 *
 * A null or empty base stays null: the note is a suffix to real prose, never a
 * description in its own right. A note-only description would read as a
 * complete listing to anything measuring description length (the digest's
 * `described` weight, for one) and would promote an event whose detail fetch
 * failed above events with real prose.
 *
 * `base` was already run through stripHtml in fetchDetail and must not be run
 * through it again: stripHtml strips tags and then decodes entities, so a
 * second pass turns a double-encoded source ("&amp;lt;script&amp;gt;") into
 * literal markup in the stored description. The includes() guard keeps a page
 * that quotes the sentence from doubling it.
 *
 * The note is reserved for, never truncated: room is MAX_DESCRIPTION minus the
 * note and its separating space, so the disclosure always lands whole. A half
 * sentence would be worse than none, and withoutTimeNote() in the digest
 * matches the note verbatim, so a clipped copy would survive subtraction and
 * score as prose.
 */
export function buildDescription(detail) {
  const base = detail?.description || null
  if (!base || !base.trim()) return base
  if (!detail?.timeInferred) return base
  if (base.includes(TIME_NOTE)) return base
  const room = MAX_DESCRIPTION - TIME_NOTE.length - 1
  return `${clampChars(base, room)} ${TIME_NOTE}`
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.text()
}

// ── Date authority: year view (discovery) → day view (dates) ────────────────

/**
 * The eastern-anchored ingestion window, as { start, end } "YYYY-MM-DD".
 *
 * `now` is injectable so tests can pin the window without mocking the clock.
 * easternTodayIso is used for BOTH ends deliberately: deriving the end from
 * `new Date().getFullYear()`-style local/UTC arithmetic is the exact shape that
 * made the retired monthUrls() skip a whole month on a UTC runner.
 */
export function horizonWindow(now = new Date()) {
  const from = now instanceof Date ? now : new Date(now)
  return {
    start: easternTodayIso(from),
    end:   easternTodayIso(new Date(from.getTime() + HORIZON_DAYS * 86400000)),
  }
}

/**
 * The calendar years a window touches, ascending.
 *
 * The year view covers ONE calendar year, so a ~90-day horizon starting around
 * October 2 or later runs off the end of it. Fetching both years is the whole
 * fix; skipping this silently truncates the horizon at Dec 31 and — worse —
 * would let the retirement pass sweep every January row the run never looked
 * for. (Both-ends bounding in planRetirement is the second line of defence.)
 */
export function yearsForWindow({ start, end }) {
  const first = Number(String(start).slice(0, 4))
  const last  = Number(String(end).slice(0, 4))
  const years = []
  for (let y = first; y <= last; y++) years.push(y)
  return years
}

/**
 * Every day the year view says has events, as sorted unique "YYYY-MM-DD".
 *
 * Only `has-events` cells carry a /calendar-field_cal_date/day/YYYYMMDD link, so
 * the links alone ARE the index — no class parsing needed. Adjacent mini-months
 * repeat a handful of spillover days (Aug 31 appears in both the August and the
 * September mini-grid) with identical dates, hence the dedupe.
 */
export function parseYearDays(html) {
  const days = new Set()
  const re = /calendar-field_cal_date\/day\/(\d{8})/g
  let m
  while ((m = re.exec(String(html || ''))) !== null) {
    const d = m[1]
    days.add(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`)
  }
  return [...days].sort()
}

/** The subset of `days` inside the window, inclusive at both ends, sorted. */
export function filterDaysToWindow(days, { start, end }) {
  return [...new Set(days)].filter(d => d >= start && d <= end).sort()
}

/**
 * The events listed on ONE day view: [{ slug, title }].
 *
 * A day view is a single date, so there is nothing to infer — every
 * /events/{slug} anchor on the page belongs to that day. Deduped by slug
 * because Drupal can render the same node twice (listing + "cutoff" block).
 */
export function parseDayView(html) {
  const out = []
  const seen = new Set()
  const re = /href="\/events\/([a-z0-9][a-z0-9-]*)"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(String(html || ''))) !== null) {
    const slug = m[1]
    const title = stripHtml(m[2])
    if (!title || seen.has(slug)) continue
    seen.add(slug)
    out.push({ slug, title })
  }
  return out
}

/** parseDayView + the date the page is for → occurrence rows. */
export function occurrencesForDay(dateStr, html) {
  return parseDayView(html).map(e => ({ ...e, dateStr }))
}

/** The day-view URL for a "YYYY-MM-DD". */
export function dayViewUrl(dateStr) {
  return `${BASE_URL}/calendar-field_cal_date/day/${dateStr.replace(/-/g, '')}`
}

/** The year-view URL for a calendar year. */
export function yearViewUrl(year) {
  return `${BASE_URL}/calendar-field_cal_date/year/${year}`
}

// ── Retirement of rows this run could not resolve ────────────────────────────

// Below this many resolved occurrences we assume the parse broke, not that the
// city cancelled its calendar, and retire nothing. CF's public calendar carries
// dozens of occurrences in any 90-day window (31 event days in the 2026-08-16 →
// 2026-10-31 sample alone), so 10 is far under the observed floor while still
// stopping a markup change that collapses the parse from sweeping the source.
// The ohio-festivals precedent uses 20 against a much larger single page.
export const RETIREMENT_MIN_RESOLVED = 10

// Retire at most this fraction of the source's in-window rows in one run.
// Steady state is near zero — the same recurring series resolve every night —
// so anything above a quarter means the run, not the city, changed.
//
// The FIRST run after the date-authority fix legitimately retires ~100% and
// WILL trip this. The ceiling stays at its steady-state value; the one-time
// bypass is the opt-in env flag below, never a looser default.
export const RETIREMENT_MAX_FRACTION = 0.25

// One-time operator escape hatch for the first run after the date-authority
// fix, when retiring ~100% of the window is the CORRECT outcome: every
// pre-existing row is dated one day early and carries a source_id this scraper
// can never mint again, so leaving them published doubles the source.
//
// Set CF_ALLOW_FULL_RETIREMENT=1 (or =true) for that single run. Absent the
// flag — which is every scheduled run — the ceiling is enforced exactly as
// before and the run aborts retirement loudly.
//
// SCOPE, and it is deliberately narrow: this flag relaxes THE CEILING AND
// NOTHING ELSE. It is not an "ignore safety" switch. Every other guard is still
// hard with the flag set — year view must have loaded, zero day views may have
// failed, the fetch cap must not have truncated the run, the resolved count must
// clear RETIREMENT_MIN_RESOLVED — and rows that are already cancelled or carry a
// manual_overrides.status pin are still skipped. Those guards mean "this run did
// not see the whole calendar"; no operator opt-in can make a partial run whole.
export const RETIREMENT_OVERRIDE_ENV = 'CF_ALLOW_FULL_RETIREMENT'

/** Whether the operator opted into a single over-ceiling retirement run. */
export function fullRetirementAllowed(env = process.env) {
  const raw = String(env?.[RETIREMENT_OVERRIDE_ENV] ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

// Explicit bound on the retirement query. PostgREST's implicit default is 1000
// rows; inheriting it would silently truncate the ceiling's DENOMINATOR, which
// is the one number that must never be understated (a short read makes an
// over-ceiling sweep look under-ceiling). CF carries ~100 in-window rows against
// a 90-day horizon, so this is an order of magnitude clear of reality, and the
// caller treats hitting it as a fault rather than paginating.
export const RETIREMENT_QUERY_LIMIT = 2000

// Stamped into manual_overrides.status so the retirement is auditable and so a
// later re-scrape cannot silently re-publish a row we retired.
export const RETIREMENT_STAMP_BY = 'scrape-city-of-cuyahoga-falls:retirement'
export const RETIREMENT_REASON =
  'not listed on the city day view for this date after the 2026-08 date-authority fix'

/** True when a human (or a previous retirement) pinned `status` on this row. */
export function hasStatusOverride(row) {
  const ov = row?.manual_overrides
  return !!ov && typeof ov === 'object' && Object.prototype.hasOwnProperty.call(ov, 'status')
}

/**
 * Decide which in-window rows to retire — pure, so the guards are testable.
 *
 * Shape borrowed from the stale-sweep in scrape-ohio-festivals.js:298-328, but
 * NOT its implementation, which has three flaws this must not inherit: it
 * DELETEs (destroying the audit trail and burning the nightly delete budget),
 * it bounds the window with a UTC-derived `new Date()`, and it has no upper
 * bound at all. Here: status-only mutation, eastern-anchored bounds applied by
 * the caller's query, and both ends bounded.
 *
 * @param rows  in-window rows for this source, ALL statuses. The ceiling is
 *              measured against the RETIRE-ELIGIBLE subset of these, not all of
 *              them — see the fraction below.
 * @param allowFullRetirement  operator opt-in (CF_ALLOW_FULL_RETIREMENT).
 *              Relaxes THE CEILING ONLY — it is checked in exactly one place,
 *              below the four health guards, and never above them. Read from the
 *              environment by the caller so this function stays pure.
 */
export function planRetirement({
  rows = [],
  resolvedSourceIds = new Set(),
  yearViewOk = false,
  dayViewFailures = 0,
  truncated = false,
  allowFullRetirement = false,
} = {}) {
  const resolvedCount = resolvedSourceIds.size ?? 0
  const base = { retire: [], examined: rows.length, resolvedCount, protectedCount: 0 }

  // Only a healthy run may retire. Each of these means "this run did not see
  // the whole calendar", and retiring on a partial view deletes real events
  // from the feed.
  if (!yearViewOk) {
    return { ...base, skipped: 'year-view-unavailable',
      reason: 'the year view (the date authority) did not load — this run never knew which days have events' }
  }
  if (dayViewFailures > 0) {
    return { ...base, skipped: 'day-view-failures',
      reason: `${dayViewFailures} day view(s) failed to load — every event on those days would look retired` }
  }
  if (truncated) {
    return { ...base, skipped: 'day-fetch-cap',
      reason: `the day-view fetch cap (${MAX_DAY_FETCHES}) truncated the run, so the tail of the window was never checked` }
  }
  if (resolvedCount < RETIREMENT_MIN_RESOLVED) {
    return { ...base, skipped: 'below-floor',
      reason: `only ${resolvedCount} occurrence(s) resolved (floor ${RETIREMENT_MIN_RESOLVED}) — the parse looks broken` }
  }

  // `manual_overrides.status` is a human decision. _stripOverriddenFields
  // protects the UPSERT path only; this is a separate UPDATE with no such
  // protection, so the skip has to be explicit here or we overwrite a row
  // somebody deliberately published.
  const eligible = rows.filter(r => r.status === 'published' && !hasStatusOverride(r))
  const pinned = rows.filter(r => r.status === 'published' && hasStatusOverride(r))
  const candidates = eligible.filter(r => !resolvedSourceIds.has(r.source_id))

  // The ceiling — and the ONLY guard the operator flag can relax. It is reached
  // only after all four health guards above have passed, so a bypassed ceiling
  // is still a complete, healthy view of the calendar.
  //
  // DENOMINATOR: retire-eligible rows (published, not status-pinned), NOT every
  // in-window row. The numerator can only ever be drawn from that subset, so a
  // wider denominator does not measure "how much of the retirable source is
  // about to go" — it dilutes it. Concretely: the first run leaves ~33 cancelled
  // rows inside a 90-day window, and against `rows.length` those would halve the
  // measured fraction for the next three months, waving through exactly the
  // 48%-of-the-live-source parse regression this ceiling exists to block —
  // during the months when the new year/day-view pipeline is least proven.
  const fraction = eligible.length ? candidates.length / eligible.length : 0
  const overCeiling = fraction > RETIREMENT_MAX_FRACTION
  if (overCeiling && !allowFullRetirement) {
    return {
      ...base,
      protectedCount: pinned.length,
      eligible: eligible.length,
      candidates: candidates.length,
      fraction,
      skipped: 'above-ceiling',
      reason: `${candidates.length}/${eligible.length} retire-eligible in-window rows (${(fraction * 100).toFixed(0)}%) would be retired, ` +
        `over the ${(RETIREMENT_MAX_FRACTION * 100).toFixed(0)}% ceiling. NOTE: the first run after a date-authority ` +
        `change legitimately retires ~100% and is EXPECTED to trip this; for that ONE run, re-run with ` +
        `${RETIREMENT_OVERRIDE_ENV}=1, which relaxes this ceiling and nothing else. ` +
        `Otherwise this means the run, not the city, changed — investigate before setting the flag.`,
    }
  }

  return {
    ...base,
    retire: candidates,
    // Only rows that were retirement CANDIDATES in the first place: a pinned row
    // that is already cancelled was never eligible, so reporting it as "skipped
    // because a human pinned it" overstates what the run protected on the one
    // line an operator reads to judge the run.
    protectedCount: pinned.length,
    eligible: eligible.length,
    fraction,
    ceilingBypassed: overCeiling,       // true only when the operator opted in
    skipped: null,
    reason: null,
  }
}

// ── Detail page enrichment ───────────────────────────────────────────────────

function metaContent(html, prop) {
  // Matches <meta name|property="prop" content="...">  (attribute order-agnostic)
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content=["']([^"']*)["']`,
    'i',
  )
  const m = html.match(re)
  if (m) return m[1]
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`,
    'i',
  )
  const m2 = html.match(re2)
  return m2 ? m2[1] : null
}

async function fetchDetail(slug, cache) {
  if (cache.has(slug)) return cache.get(slug)
  // A failed fetch leaves the noon default in place, so it counts as inferred.
  // SANCTIONED-DEFAULT-TIME, see parseTimeFromTextDetailed above. Description
  // stays null here, so buildDescription adds nothing and the event is not
  // scored as a complete listing on the strength of the disclosure alone.
  let detail = { title: null, description: null, imageUrl: null, timeStr: '12:00:00', timeInferred: true }
  try {
    const html = await fetchHtml(`${BASE_URL}/events/${slug}`)
    const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]
    const desc = metaContent(html, 'og:description') || metaContent(html, 'description')
    const parsedTime = parseTimeFromTextDetailed(desc || '')
    detail = {
      title:        h1 ? stripHtml(h1) : (metaContent(html, 'og:title') || null),
      description:  desc ? clampChars(stripHtml(desc), MAX_DESCRIPTION) : null,
      imageUrl:     metaContent(html, 'og:image') || null,
      timeStr:      parsedTime.time,
      timeInferred: parsedTime.inferred,
    }
  } catch (err) {
    console.warn(`  ⚠ detail fetch failed for ${slug}: ${err.message}`)
  }
  cache.set(slug, detail)
  return detail
}

// ── Retirement write ─────────────────────────────────────────────────────────

/**
 * Fetch the source's in-window rows, run planRetirement, and apply its verdict.
 * Returns the number of rows retired (0 whenever the plan says skip).
 *
 * NEVER deletes. The 9 hand-cancelled rows from the 2026-08 incident carry their
 * reasoning in manual_overrides, deleting would destroy that audit trail, and
 * the nightly budget only allows 20 deletes anyway. Status-only mutation with a
 * stamp is both reversible and legible after the fact.
 *
 * supabase-admin is lazily imported so importing this module in tests stays
 * side-effect free (scrape-ohio-festivals.js:305 is the shape, import-porchrokr.js
 * the lazy-load precedent); no new normalize.js export is needed.
 */
async function retireUnresolved({ win, resolvedSourceIds, health }) {
  const { supabaseAdmin } = await import('./lib/supabase-admin.js')

  // Both ends bounded, both eastern-anchored. The ohio-festivals precedent
  // bounds only the low end and does it from a UTC `new Date()`; unbounded above
  // would retire rows past the horizon that this run never looked for, and a UTC
  // low bound drops the rest of today's events for three hours every night.
  const from = easternToIso(win.start, '00:00:00')
  const to   = easternToIso(win.end,   '23:59:59')

  const { data: rows, error } = await supabaseAdmin
    .from('events')
    .select('id, title, source_id, status, start_at, manual_overrides')
    .eq('source', SOURCE_KEY)
    .gte('start_at', from)
    .lte('start_at', to)
    .limit(RETIREMENT_QUERY_LIMIT)
  if (error) {
    console.warn(`  ⚠ Retirement query failed: ${error.message} — retiring nothing.`)
    return 0
  }
  // A truncated result set would silently shrink the ceiling's denominator and
  // make an over-ceiling sweep look safe, so treat hitting the bound as a fault
  // rather than a page-one read.
  if ((rows?.length ?? 0) >= RETIREMENT_QUERY_LIMIT) {
    console.warn(`  ⚠ Retirement query returned ${rows.length} rows, at the ${RETIREMENT_QUERY_LIMIT} bound — ` +
      'the result may be truncated and the ceiling denominator wrong. Retiring nothing.')
    return 0
  }

  const allowFullRetirement = fullRetirementAllowed()
  const plan = planRetirement({
    rows: rows ?? [],
    resolvedSourceIds,
    yearViewOk:      health.yearViewOk,
    dayViewFailures: health.dayViewFailures,
    truncated:       health.truncated,
    allowFullRetirement,
  })
  if (plan.skipped) {
    console.warn(`  ⏭  Retirement SKIPPED (${plan.skipped}): ${plan.reason}`)
    return 0
  }
  if (plan.ceilingBypassed) {
    // Loud on purpose: the run's own output has to carry the evidence of what
    // it did and on whose say-so.
    console.warn(`  🚨 CEILING BYPASSED by explicit operator opt-in (${RETIREMENT_OVERRIDE_ENV}) — ` +
      `retiring ${plan.retire.length}/${plan.eligible} retire-eligible in-window rows ` +
      `(${(plan.fraction * 100).toFixed(0)}%, over the ${(RETIREMENT_MAX_FRACTION * 100).toFixed(0)}% ceiling). ` +
      'Every other guard still applied: year view OK, 0 day-view failures, no fetch-cap truncation, ' +
      `${plan.resolvedCount} occurrences resolved (floor ${RETIREMENT_MIN_RESOLVED}).`)
  }
  if (plan.retire.length === 0) {
    console.log(`  ✓ Nothing to retire (${plan.examined} in-window row(s) all resolved or protected)`)
    return 0
  }
  if (plan.protectedCount) {
    console.log(`  🛡  ${plan.protectedCount} row(s) skipped: manual_overrides.status is a human decision`)
  }

  const at = new Date().toISOString()
  let retired = 0
  for (const row of plan.retire) {
    const manual_overrides = {
      ...(row.manual_overrides ?? {}),
      status: { at, by: RETIREMENT_STAMP_BY, reason: RETIREMENT_REASON },
    }
    const { error: upErr } = await supabaseAdmin
      .from('events')
      .update({ status: 'cancelled', manual_overrides })
      .eq('id', row.id)
    if (upErr) {
      console.warn(`  ⚠ Retirement failed for ${row.source_id}: ${upErr.message}`)
      continue
    }
    console.log(`     - ${row.title} (${row.source_id})`)
    retired++
  }
  return retired
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🌊  Starting City of Cuyahoga Falls ingestion (Drupal calendar)…')
  const start = Date.now()

  // Run health, carried into planRetirement. Anything that makes this run a
  // PARTIAL view of the calendar must show up here, because retiring on a
  // partial view cancels events that are still happening.
  const health = { yearViewOk: false, dayViewFailures: 0, truncated: false }

  try {
    // 1. Year view(s) → the days that actually have events.
    const win = horizonWindow()
    const years = yearsForWindow(win)
    console.log(`  window ${win.start} → ${win.end} (${HORIZON_DAYS}d, Eastern) across ${years.join(', ')}`)

    const yearDays = new Set()
    let yearFailures = 0
    for (const year of years) {
      const url = yearViewUrl(year)
      console.log(`  → ${url}`)
      try {
        const html = await fetchHtml(url)
        const days = parseYearDays(html)
        for (const d of days) yearDays.add(d)
        console.log(`    ${days.length} event days in ${year}`)
      } catch (err) {
        yearFailures++
        console.warn(`    ⚠ ${err.message}`)
      }
      await new Promise(r => setTimeout(r, 400))
    }
    // Every year the window touches must load. A missing second year is not a
    // smaller run, it is a run that cannot tell "no events in January" from
    // "never looked at January".
    health.yearViewOk = yearFailures === 0

    // 2. Day views → the dates themselves. The year view is the index; the day
    //    view is the authority. Never fall back to /calendar/YYYYMM.
    let days = filterDaysToWindow([...yearDays], win)
    if (days.length > MAX_DAY_FETCHES) {
      console.warn(`  🚨 ${days.length} event days in a ${HORIZON_DAYS}-day window exceeds the ${MAX_DAY_FETCHES} fetch cap — ` +
        'the year view has probably changed shape. Truncating, and retirement is disabled for this run.')
      days = days.slice(0, MAX_DAY_FETCHES)
      health.truncated = true
    }
    console.log(`  ${days.length} event days to fetch`)

    const seen = new Set()
    const occurrences = []
    for (const day of days) {
      try {
        const html = await fetchHtml(dayViewUrl(day))
        const rows = occurrencesForDay(day, html)
        if (rows.length === 0) {
          // A real contradiction inside the new authority: the year view said
          // this day has events and the day view lists none. Costs nothing to
          // notice and is the first symptom we'd want if either view drifts.
          console.warn(`  ⚠ ${day}: year view listed this day as having events, day view returned none`)
        }
        for (const r of rows) {
          const key = `${r.slug}|${r.dateStr}`
          if (!seen.has(key)) { seen.add(key); occurrences.push(r) }
        }
      } catch (err) {
        health.dayViewFailures++
        console.warn(`  ⚠ day view failed for ${day}: ${err.message}`)
      }
      await new Promise(r => setTimeout(r, 400))
    }

    const today = win.start
    const publicFuture = occurrences.filter(o => isPublicEvent(o.title) && o.dateStr >= today)
    console.log(`  ${publicFuture.length} public upcoming occurrences (from ${occurrences.length} total)`)

    if (publicFuture.length === 0) {
      await logUpsertResult(SOURCE_KEY, 0, 0, 0, {
        status: occurrences.length === 0 ? 'error' : 'ok',
        errorMessage: occurrences.length === 0
          ? 'Year/day calendar views parsed 0 occurrences — Drupal markup may have changed (expected /calendar-field_cal_date/year/YYYY day links + /events/ links on the day view).'
          : undefined,
        durationMs:  Date.now() - start,
        eventsFound: occurrences.length,
      })
      // Deliberately no month-grid fallback: the grid is uniformly one day early,
      // and a known-wrong source is worse than no data. Retirement never runs on
      // this path either — nothing was resolved, so everything would look stale.
      console.warn('  ⚠ Nothing to ingest — exiting 0.')
      process.exit(0)
    }

    const organizerId = await ensureOrganization('City of Cuyahoga Falls', {
      website:     BASE_URL,
      description: 'City of Cuyahoga Falls (Summit County, OH) — municipal and Parks & Recreation programming including Falls Downtown Fridays, Front Street Live, the Riverfront Cruise In, Picnic In The Park, the Community Band and Keyser concert series, Flix on the Falls, and Quirk Cultural Center events.',
    })
    const defaultVenueId = await ensureVenue('Downtown Cuyahoga Falls', {
      city: 'Cuyahoga Falls', state: 'OH', zip: '44221',
      website: 'https://www.cityofcf.com/places/downtown',
    })
    if (organizerId && defaultVenueId) await linkOrganizationVenue(organizerId, defaultVenueId)

    // 3. Enrich + upsert.
    const detailCache = new Map()
    // Everything this run resolved FROM THE SOURCE, whether or not its upsert
    // then succeeded. A row whose upsert failed is still a real, listed event;
    // retiring it because of our own write error would be the worst kind of
    // false positive.
    const resolvedSourceIds = new Set(publicFuture.map(o => `${o.slug}-${o.dateStr}`))
    let inserted = 0, skipped = 0
    for (const occ of publicFuture) {
      try {
        const detail = await fetchDetail(occ.slug, detailCache)
        const title = detail.title || occ.title
        const startAt = easternToIso(`${occ.dateStr} ${detail.timeStr}`)
        if (!startAt) { skipped++; continue }

        const row = {
          title,
          description:     buildDescription(detail),
          start_at:        startAt,
          end_at:          null,
          category:        mapCategory(title, detail.description || ''),
          tags:            mapTags(title),
          // Never assume free: the city feed has no price field, so leave it
          // unknown (null) rather than asserting $0 for events that may charge.
          price_min:       null,
          price_max:       null,
          age_restriction: 'all_ages',
          image_url:       detail.imageUrl || null,
          ticket_url:      `${BASE_URL}/events/${occ.slug}`,
          source:          SOURCE_KEY,
          source_id:       `${occ.slug}-${occ.dateStr}`,
          status:          'published',
          featured:        false,
        }

        const enrichedRow = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enrichedRow)
        if (error) {
          console.warn(`  ⚠ Upsert failed for "${title}":`, error.message)
          skipped++
          continue
        }
        if (defaultVenueId) await linkEventVenue(upserted.id, defaultVenueId)
        if (organizerId)    await linkEventOrganization(upserted.id, organizerId)
        inserted++
      } catch (err) {
        console.warn(`  ⚠ Error processing "${occ.title}":`, err.message)
        skipped++
      }
      await new Promise(r => setTimeout(r, 250))   // polite to detail pages
    }

    // 4. Retire what this run could not resolve.
    //
    // Mandatory, not housekeeping: the date-authority fix moves every occurrence
    // by one day, so every already-published row in the window carries a
    // source_id this scraper will never mint again. Without this pass the first
    // run inserts a whole new correct calendar and leaves the whole old wrong one
    // published beside it.
    const retired = await retireUnresolved({ win, resolvedSourceIds, health })

    await logUpsertResult(SOURCE_KEY, inserted, 0, skipped, {
      eventsFound: occurrences.length,
      durationMs:  Date.now() - start,
    })
    // Its own line on purpose: logUpsertResult prefers its own internally
    // observed tallies, so folding retirements into inserted/updated/skipped
    // would either be dropped or corrupt those counters.
    console.log(`  🗄  ${retired} row(s) retired (status → cancelled)`)
    console.log(`\n✅  Done in ${((Date.now() - start) / 1000).toFixed(1)}s — ${inserted} inserted, ${skipped} skipped`)
  } catch (err) {
    await logScraperError(SOURCE_KEY, err, start)
    process.exit(1)
  }
}

// Run only when invoked directly; importing for tests exposes the parsers and
// planRetirement without triggering a live run or touching supabase-admin.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
