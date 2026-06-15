/**
 * Shared iCalendar (RFC 5545) module.
 *
 * Parses `.ics` feeds into structured event objects and runs the shared
 * fetch → parse → normalise → upsert pipeline so per-source ICS scrapers
 * only need to supply configuration (feed URL, venue/org details, category
 * and tag logic).
 *
 * RFC 5545 features supported:
 *   • VCALENDAR / VEVENT block parsing
 *   • Line unfolding (continuation lines start with space/tab)
 *   • Property parameters (e.g. DTSTART;TZID=America/New_York:20260101T190000)
 *   • Date-time formats: floating local, UTC (suffixed "Z"), TZID, and all-day
 *   • TEXT escape sequences (\n \, \; \\)
 *
 * RRULE recurrence (opt-in): set config.expandRecurring to materialise
 *   recurring masters into per-occurrence events over a bounded future
 *   window (see expandRecurrence). Off by default so feeds that already emit
 *   each occurrence as its own VEVENT are unaffected.
 *
 * NOT supported (yet — keep scope tight):
 *   • VTIMEZONE definitions — we map common TZIDs (America/New_York etc.)
 *     via native Intl and fall back to treating TZID as Eastern.
 *
 * Usage:
 *   import { fetchIcsFeed, parseIcs, runIcsScraper } from './lib/ics.js'
 *
 *   await runIcsScraper({
 *     source: 'akron_symphony',
 *     feedUrl: 'https://akronsymphony.org/?ical=1',
 *     organizationName: 'Akron Symphony Orchestra',
 *     mapCategory: () => 'music',
 *     ...
 *   })
 */

import 'dotenv/config'
import {
  logUpsertResult,
  logScraperError,
  stripHtml,
  enrichWithImageDimensions,
  upsertEventSafe,
  linkEventVenue,
  linkEventOrganization,
  ensureVenue,
  ensureOrganization,
  linkOrganizationVenue,
} from './normalize.js'

// ════════════════════════════════════════════════════════════════════════════
// LOW-LEVEL PARSER
// ════════════════════════════════════════════════════════════════════════════

/**
 * Unfold ICS content lines per RFC 5545 §3.1:
 *   Long logical lines are split by CRLF followed by a single whitespace.
 *   We also accept LF-only line endings for forgiving input.
 */
function unfoldLines(text) {
  // Normalise line endings then unfold
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '')
}

/** Unescape text values per RFC 5545 §3.3.11. */
function unescapeText(value = '') {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g,  ',')
    .replace(/\\;/g,  ';')
    .replace(/\\\\/g, '\\')
}

/**
 * Split a content line into { name, params, value }.
 * Example: `DTSTART;TZID=America/New_York:20260101T190000`
 *       →  { name: 'DTSTART', params: { TZID: 'America/New_York' }, value: '20260101T190000' }
 */
function parseLine(line) {
  const colonIdx = findUnquoted(line, ':')
  if (colonIdx === -1) return null

  const left  = line.slice(0, colonIdx)
  const value = line.slice(colonIdx + 1)

  const parts = splitUnquoted(left, ';')
  const name  = parts[0].toUpperCase()
  const params = {}
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=')
    if (eq === -1) continue
    const pName  = parts[i].slice(0, eq).toUpperCase()
    const pValue = parts[i].slice(eq + 1).replace(/^"|"$/g, '')
    params[pName] = pValue
  }

  return { name, params, value }
}

/** Find the first unquoted occurrence of `char` in `str`. */
function findUnquoted(str, char) {
  let inQuote = false
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '"') { inQuote = !inQuote; continue }
    if (!inQuote && ch === char) return i
  }
  return -1
}

/** Split on `sep` ignoring occurrences inside double-quoted strings. */
function splitUnquoted(str, sep) {
  const out = []
  let buf = '', inQuote = false
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '"') { inQuote = !inQuote; buf += ch; continue }
    if (!inQuote && ch === sep) { out.push(buf); buf = ''; continue }
    buf += ch
  }
  if (buf.length) out.push(buf)
  return out
}

// ── Date/time conversion ───────────────────────────────────────────────────

/**
 * Convert an ICS date-time value to ISO 8601 UTC.
 *
 * Accepts:
 *   20260101T190000Z                 → UTC
 *   20260101T190000                  → floating — we treat as Eastern local
 *   20260101T190000  + TZID param    → convert from named TZ via Intl
 *   20260101                         → all-day — midnight Eastern
 */
export function icsDateToIso(rawValue, params = {}) {
  if (!rawValue) return null

  // All-day (VALUE=DATE or 8-char)
  if (rawValue.length === 8 && !rawValue.includes('T')) {
    const y = rawValue.slice(0, 4)
    const m = rawValue.slice(4, 6)
    const d = rawValue.slice(6, 8)
    return easternWallTimeToUtc(`${y}-${m}-${d}T00:00:00`)
  }

  const match = rawValue.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/)
  if (!match) return null
  const [, y, mo, d, h, mi, s, z] = match
  const wallClock = `${y}-${mo}-${d}T${h}:${mi}:${s}`

  if (z === 'Z') {
    return new Date(`${wallClock}Z`).toISOString()
  }

  const tzid = params.TZID
  if (tzid) {
    return namedTzWallTimeToUtc(wallClock, tzid)
  }

  // Floating — per RFC 5545 §3.3.5, floating times take on the local
  // timezone of the observer. For Akron, that's Eastern.
  return easternWallTimeToUtc(wallClock)
}

/**
 * Convert a wall-clock time in America/New_York (Eastern) to ISO 8601 UTC.
 * Delegates to the Intl-based converter so the EST↔EDT boundary is
 * resolved correctly at 2:00 AM local on DST transition days (which a
 * purely arithmetic "2nd Sunday of March" approximation mishandles when
 * the wall-clock evening of the preceding day rounds up to the boundary).
 */
function easternWallTimeToUtc(wallClock) {
  return namedTzWallTimeToUtc(wallClock, 'America/New_York')
}

/**
 * Convert a wall-clock time in a named IANA timezone to ISO 8601 UTC.
 * Uses Intl DateTimeFormat to compute the target-zone UTC offset.
 */
function namedTzWallTimeToUtc(wallClock, tzid) {
  try {
    const [datePart, timePart = '00:00:00'] = wallClock.split('T')
    const [year, month, day] = datePart.split('-').map(Number)
    const [hour, minute, second = 0] = timePart.split(':').map(Number)
    if (!year || !month || !day) return null

    // Convert wall time in tzid to UTC by asking Intl what that same moment
    // looks like if we assume it's UTC, then compute the offset difference.
    const asIfUtcMs = Date.UTC(year, month - 1, day, hour, minute, second)
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    })
    const parts = fmt.formatToParts(new Date(asIfUtcMs))
    const get = (t) => parts.find(p => p.type === t)?.value ?? '00'
    const asTzMs = Date.UTC(
      parseInt(get('year'), 10),
      parseInt(get('month'), 10) - 1,
      parseInt(get('day'), 10),
      parseInt(get('hour'), 10) % 24,
      parseInt(get('minute'), 10),
      parseInt(get('second'), 10),
    )
    const offsetMs = asIfUtcMs - asTzMs
    return new Date(asIfUtcMs + offsetMs).toISOString()
  } catch {
    // Unknown/unsupported TZID — Intl threw. Return null so the caller can
    // decide how to handle it (typically skip the event). Falling back to a
    // different timezone would silently corrupt data.
    return null
  }
}

// ════════════════════════════════════════════════════════════════════════════
// RRULE RECURRENCE EXPANSION
// ════════════════════════════════════════════════════════════════════════════
//
// Some publishers (notably Google Calendar) encode a venue's regular schedule
// as a single VEVENT carrying an RRULE recurrence rather than materialising
// every occurrence. The base parser ingests only the series start, so without
// expansion a weekly game night or monthly meetup is invisible from its second
// occurrence on. This expander turns one recurring master into concrete
// per-occurrence events, bounded to a future window so we never run away.
//
// Supported (matched to what real feeds emit — deliberately not a full RFC
// 5545 RRULE engine): FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, BYDAY (including
// monthly ordinals like 3SA / -1SU), UNTIL, COUNT, and EXDATE exclusions.
// Each occurrence is converted to UTC independently via icsDateToIso, so the
// EST↔EDT boundary is resolved per-occurrence (a series spanning a DST change
// keeps its wall-clock time correctly).

const WEEKDAY_CODE = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }
const DAY_MS = 86_400_000

/** Parse an `RRULE:` value string into a plain key→value object. */
export function parseRrule(rruleStr) {
  const out = {}
  if (!rruleStr || typeof rruleStr !== 'string') return out
  for (const part of rruleStr.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    out[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim()
  }
  return out
}

/** Parse a DTSTART value into civil date-time parts + form flags. */
function parseDtStartParts(value) {
  if (!value) return null
  if (value.length === 8 && !value.includes('T')) {
    return {
      y: +value.slice(0, 4), m: +value.slice(4, 6), d: +value.slice(6, 8),
      h: 0, mi: 0, s: 0, allDay: true, utc: false,
    }
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/)
  if (!m) return null
  return {
    y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6],
    allDay: false, utc: m[7] === 'Z',
  }
}

const pad = (n, len = 2) => String(n).padStart(len, '0')

/** Build a compact ICS value string for a civil date using a DTSTART template. */
function civilToIcsValue(y, m, d, dt) {
  if (dt.allDay) return `${pad(y, 4)}${pad(m)}${pad(d)}`
  return `${pad(y, 4)}${pad(m)}${pad(d)}T${pad(dt.h)}${pad(dt.mi)}${pad(dt.s)}${dt.utc ? 'Z' : ''}`
}

/** Compact UTC value (…Z) for an absolute instant — used for derived DTEND. */
function msToIcsUtcValue(ms) {
  const d = new Date(ms)
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

// A "civil cursor" is a Date pinned to UTC midnight used purely as a calendar
// counter — getUTCDay()/setUTCDate() give DST-free date arithmetic. The actual
// timezone conversion happens later, per occurrence, in icsDateToIso.
const civilOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d))
const mondayOf = (cur) => {
  const wd = cur.getUTCDay()             // 0=Sun … 6=Sat
  const back = (wd + 6) % 7              // days since Monday
  return new Date(cur.getTime() - back * DAY_MS)
}

/** nth weekday of a month (n<0 counts from the end). Returns a civil Date or null. */
function nthWeekdayOfMonth(year, month, weekday, n) {
  if (n > 0) {
    const first = civilOf(year, month, 1)
    const offset = (weekday - first.getUTCDay() + 7) % 7
    const day = 1 + offset + (n - 1) * 7
    const probe = civilOf(year, month, day)
    return probe.getUTCMonth() === month - 1 ? probe : null
  }
  // n < 0: count back from the last day of the month
  const last = new Date(Date.UTC(year, month, 0))   // day 0 of next month
  const offset = (last.getUTCDay() - weekday + 7) % 7
  const day = last.getUTCDate() - offset - (-n - 1) * 7
  return day >= 1 ? civilOf(year, month, day) : null
}

/**
 * Expand a single parsed VEVENT into concrete occurrences.
 *
 * Non-recurring events (no RRULE) pass straight through as `[ev]`. Recurring
 * masters return a sorted array of cloned VEVENTs, each with a materialised
 * DTSTART/DTEND, a per-occurrence UID (so source_id stays unique), and no
 * RRULE. Only occurrences whose start falls in [windowStartMs, windowEndMs]
 * and are not excluded by EXDATE survive.
 *
 * @param {object} ev   — raw VEVENT from parseIcs()
 * @param {object} opts
 *   @param {number} [opts.windowStartMs=Date.now()] — earliest occurrence kept
 *   @param {number} [opts.windowDays=120]           — window length forward
 *   @param {number} [opts.maxOccurrences=200]       — hard safety cap per series
 */
export function expandRecurrence(ev, opts = {}) {
  if (!ev || !ev.RRULE || !ev.DTSTART) return ev ? [ev] : []

  const {
    windowStartMs  = Date.now(),
    windowDays     = 120,
    maxOccurrences = 200,
  } = opts
  const windowEndMs = windowStartMs + windowDays * DAY_MS

  const rule = parseRrule(ev.RRULE)
  const freq = (rule.FREQ || '').toUpperCase()
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) return [ev]

  const dt = parseDtStartParts(ev.DTSTART.value)
  if (!dt) return [ev]
  const startParams = dt.utc ? {} : (ev.DTSTART.params || {})

  // Convert a civil (y,m,d) occurrence to its UTC instant using the DTSTART
  // template (preserves time-of-day + timezone semantics per occurrence).
  const occToMs = (y, m, d) => {
    const iso = icsDateToIso(civilToIcsValue(y, m, d, dt), startParams)
    return iso ? Date.parse(iso) : null
  }

  const interval = Math.max(1, parseInt(rule.INTERVAL || '1', 10) || 1)
  const countCap = rule.COUNT ? parseInt(rule.COUNT, 10) : null
  // UNTIL is UTC (…Z) or a date per RFC 5545; icsDateToIso handles both forms.
  const untilIso = rule.UNTIL ? icsDateToIso(rule.UNTIL, {}) : null
  const untilMs  = untilIso ? Date.parse(untilIso) : null

  // EXDATE exclusion set keyed by ISO-UTC instant.
  const exSet = new Set()
  for (const ex of (ev.EXDATE || [])) {
    for (const v of (ex.value || '').split(',')) {
      const iso = icsDateToIso(v.trim(), ex.params || {})
      if (iso) exSet.add(iso)
    }
  }

  // Duration carried from DTSTART→DTEND, reapplied to each occurrence.
  let durationMs = null
  if (ev.DTEND) {
    const sIso = icsDateToIso(ev.DTSTART.value, ev.DTSTART.params || {})
    const eIso = icsDateToIso(ev.DTEND.value, ev.DTEND.params || {})
    if (sIso && eIso) durationMs = Date.parse(eIso) - Date.parse(sIso)
  }

  const startCivil = civilOf(dt.y, dt.m, dt.d)
  const occurrences = []   // { y, m, d, ms }
  let seen = 0             // counts toward COUNT (every generated occurrence)

  const pushOcc = (y, m, d) => {
    const ms = occToMs(y, m, d)
    if (ms == null) return true
    if (untilMs != null && ms > untilMs) return false       // series ended
    seen++
    if (ms >= windowStartMs && ms <= windowEndMs) {
      const iso = new Date(ms).toISOString()
      if (!exSet.has(iso)) occurrences.push({ y, m, d, ms })
    }
    return true   // keep going
  }

  if (freq === 'DAILY') {
    let cur = startCivil
    for (let i = 0; i < 4000; i++) {
      if (countCap != null && seen >= countCap) break
      const cont = pushOcc(cur.getUTCFullYear(), cur.getUTCMonth() + 1, cur.getUTCDate())
      if (!cont) break
      if (cur.getTime() > windowEndMs) break
      cur = new Date(cur.getTime() + interval * DAY_MS)
    }
  } else if (freq === 'WEEKLY') {
    const days = (rule.BYDAY || '')
      .split(',').map(s => WEEKDAY_CODE[s.trim().replace(/^[+-]?\d+/, '')]).filter(n => n != null)
    const targetDows = days.length ? days : [startCivil.getUTCDay()]
    const anchorMonday = mondayOf(startCivil).getTime()
    let cur = startCivil
    for (let i = 0; i < 4000; i++) {
      if (countCap != null && seen >= countCap) break
      if (cur.getTime() > windowEndMs && cur.getTime() > startCivil.getTime()) break
      if (targetDows.includes(cur.getUTCDay())) {
        const weekIdx = Math.round((mondayOf(cur).getTime() - anchorMonday) / (7 * DAY_MS))
        if (weekIdx >= 0 && weekIdx % interval === 0) {
          const cont = pushOcc(cur.getUTCFullYear(), cur.getUTCMonth() + 1, cur.getUTCDate())
          if (!cont) break
        }
      }
      cur = new Date(cur.getTime() + DAY_MS)
    }
  } else if (freq === 'MONTHLY') {
    const byday = (rule.BYDAY || '').split(',').map(s => s.trim()).filter(Boolean)
    let y = dt.y, m = dt.m
    for (let step = 0; step < 120; step++) {           // up to 10 years of months
      if (countCap != null && seen >= countCap) break
      const firstOfMonthMs = occToMs(y, m, 1)
      if (firstOfMonthMs != null && firstOfMonthMs > windowEndMs && (y > dt.y || (y === dt.y && m > dt.m))) break
      if ((step % interval) === 0) {
        const tokens = byday.length ? byday : null
        if (tokens) {
          let ended = false
          for (const tok of tokens) {
            const mt = tok.match(/^([+-]?\d+)?([A-Z]{2})$/)
            if (!mt) continue
            const ord = mt[1] ? parseInt(mt[1], 10) : 1
            const wd = WEEKDAY_CODE[mt[2]]
            if (wd == null) continue
            const date = nthWeekdayOfMonth(y, m, wd, ord)
            if (date) {
              const cont = pushOcc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
              if (!cont) { ended = true; break }
            }
          }
          if (ended) break
        } else {
          const cont = pushOcc(y, m, dt.d)             // BYMONTHDAY-less: same day each month
          if (!cont) break
        }
      }
      m++; if (m > 12) { m = 1; y++ }
    }
  }

  occurrences.sort((a, b) => a.ms - b.ms)
  const baseUid = (ev.UID || '').trim()
  return occurrences.slice(0, maxOccurrences).map(({ y, m, d, ms }) => {
    const clone = { ...ev }
    delete clone.RRULE
    delete clone.EXDATE
    delete clone.RDATE
    clone.DTSTART = { value: civilToIcsValue(y, m, d, dt), params: startParams }
    clone.DTEND = durationMs != null
      ? { value: msToIcsUtcValue(ms + durationMs), params: {} }
      : undefined
    clone.UID = baseUid ? `${baseUid}_${pad(y, 4)}${pad(m)}${pad(d)}` : baseUid
    return clone
  })
}

// ── VEVENT extraction ──────────────────────────────────────────────────────

/**
 * Parse an ICS feed body into an array of raw event objects.
 * Each event is an object keyed by RFC 5545 property names (upper case).
 *
 * Example returned event:
 *   {
 *     UID: '123@example.com',
 *     SUMMARY: 'Concert',
 *     DTSTART: { value: '20260101T190000', params: { TZID: 'America/New_York' } },
 *     DTEND:   { value: '20260101T210000', params: { TZID: 'America/New_York' } },
 *     LOCATION: 'E.J. Thomas Hall',
 *     DESCRIPTION: 'An evening with…',
 *     URL: 'https://akronsymphony.org/event/123',
 *   }
 */
export function parseIcs(icsText) {
  if (!icsText || typeof icsText !== 'string') return []
  if (!icsText.includes('BEGIN:VCALENDAR')) return []

  const unfolded = unfoldLines(icsText)
  const lines = unfolded.split('\n')

  const events = []
  let current = null
  let depth = 0   // track nested blocks (VALARM inside VEVENT)

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    // Only treat BEGIN/END with known block names as block boundaries
    if (line.startsWith('BEGIN:VEVENT')) {
      current = {}
      depth = 0
      continue
    }
    if (line.startsWith('END:VEVENT')) {
      if (current) events.push(current)
      current = null
      continue
    }
    if (!current) continue

    // Ignore nested alarm/audio blocks
    if (line.startsWith('BEGIN:')) { depth++; continue }
    if (line.startsWith('END:'))   { depth = Math.max(0, depth - 1); continue }
    if (depth > 0) continue

    const parsed = parseLine(line)
    if (!parsed) continue

    const { name, params, value } = parsed
    // EXDATE/RDATE may appear on multiple lines (or carry a comma-separated
    // value list), so accumulate them into an array rather than overwriting.
    const isMultiDateProp = name === 'EXDATE' || name === 'RDATE'
    const isDateProp = ['DTSTART', 'DTEND', 'DTSTAMP', 'LAST-MODIFIED', 'CREATED'].includes(name)

    if (isMultiDateProp) {
      ;(current[name] ||= []).push({ value, params })
    } else if (isDateProp) {
      current[name] = { value, params }
    } else {
      current[name] = unescapeText(value)
    }
  }

  return events
}

// ── Normalisation ──────────────────────────────────────────────────────────

/**
 * Convert a raw parsed VEVENT into the common event row shape.
 *
 * @param {object} ev      — Raw VEVENT from parseIcs()
 * @param {object} config  — Per-source configuration:
 *   @param {string}   config.source             — scraper source key (e.g. 'akron_symphony')
 *   @param {Function} [config.mapCategory]      — (ev) → v2 category or null (default null → inference)
 *   @param {Function} [config.mapTags]          — (ev) → string[] (default [])
 *   @param {number|null} [config.defaultPriceMin] — default price_min (default null — never assume free)
 *   @param {number|null} [config.defaultPriceMax] — default price_max (default null)
 *   @param {string}   [config.ageRestriction]   — default age_restriction (default 'not_specified')
 *   @param {string}   [config.defaultImageUrl]  — fallback image if feed omits one
 * @returns {object|null}  — Event row ready for upsertEventSafe(); null if invalid
 */
/**
 * Resolve an ICS URL field to an absolute http(s) URL.
 *
 * Some feeds (notably CivicPlus municipal calendars) emit a root-relative
 * path like "/common/modules/iCalendar/iCalendar.aspx?..." in the VEVENT
 * URL. Stored verbatim, that becomes a same-origin link that resolves to
 * akronpulse.com and 404s (and, inside the white-label embed, breaks the
 * iframe out to a not-found page). Absolutising against the feed's own
 * origin fixes it at the source.
 *
 * Returns null for an empty value or a relative URL we can't resolve
 * (no linkBaseUrl) — a broken relative link is worse than no link.
 */
export function absolutiseIcsUrl(url, linkBaseUrl) {
  const raw = (url || '').trim()
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) return raw
  if (!linkBaseUrl) return null
  try {
    return new URL(raw, linkBaseUrl).toString()
  } catch {
    return null
  }
}

export function normaliseIcsEvent(ev, config = {}) {
  const {
    source,
    mapCategory      = () => null,   // no hint by default — inference decides
    mapTags          = () => [],
    defaultPriceMin  = null,
    defaultPriceMax  = null,
    ageRestriction   = 'not_specified',
    defaultImageUrl  = null,
    // Origin used to absolutise a root-relative VEVENT URL (e.g. the
    // feed's own site). Optional; absolute URLs pass through untouched.
    linkBaseUrl      = null,
  } = config

  const title = stripHtml((ev.SUMMARY ?? '').trim())
  if (!title) return null

  const startAt = ev.DTSTART ? icsDateToIso(ev.DTSTART.value, ev.DTSTART.params) : null
  const endAt   = ev.DTEND   ? icsDateToIso(ev.DTEND.value,   ev.DTEND.params)   : null
  if (!startAt) return null

  const rawDesc = ev.DESCRIPTION ?? ''
  const description = rawDesc ? stripHtml(rawDesc).slice(0, 5000) || null : null

  // Some feeds embed the image in a custom X-… property or an ATTACH.
  // Prefer X-ALT-IMAGE, then X-IMAGE. X-APPLE-STRUCTURED-LOCATION is a geo
  // payload (not an image), so it is deliberately never used as a fallback.
  const imageUrl = ev['X-ALT-IMAGE'] ?? ev['X-IMAGE'] ?? null

  const attachImage = typeof ev.ATTACH === 'string' && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(ev.ATTACH)
    ? ev.ATTACH
    : null

  const image_url = imageUrl || attachImage || defaultImageUrl || null

  return {
    title,
    description,
    start_at:        startAt,
    end_at:          endAt,
    category:        mapCategory(ev),
    tags:            mapTags(ev),
    price_min:       defaultPriceMin,
    price_max:       defaultPriceMax,
    age_restriction: ageRestriction,
    image_url,
    ticket_url:      absolutiseIcsUrl(ev.URL, linkBaseUrl),
    source,
    source_id:       (ev.UID || '').trim() || null,
    status:          'published',
    featured:        false,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// FEED FETCH + DISCOVERY
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; AkronPulse-bot/1.0; +https://akronpulse.com)'

/**
 * Fetch an ICS feed URL. Throws on HTTP error or obviously wrong content.
 */
export async function fetchIcsFeed(url, opts = {}) {
  const { userAgent = DEFAULT_USER_AGENT, timeoutMs = 20_000 } = opts

  const controller = new AbortController()
  const tid = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: {
        Accept:       'text/calendar, text/plain, */*',
        'User-Agent': userAgent,
      },
      redirect: 'follow',
      signal:   controller.signal,
    })
    if (!res.ok) throw new Error(`ICS feed HTTP ${res.status} at ${url}`)

    const body = await res.text()
    if (!body.includes('BEGIN:VCALENDAR')) {
      throw new Error(
        `Feed at ${url} did not return iCalendar content (no BEGIN:VCALENDAR marker). ` +
        `The URL may serve HTML instead of .ics — verify in a browser and update the scraper config.`
      )
    }
    return body
  } finally {
    clearTimeout(tid)
  }
}

/**
 * Auto-discover an ICS feed from a page URL.
 *
 * Strategy:
 *   1. Fetch the page HTML
 *   2. Look for <link rel="alternate" type="text/calendar" href="…">
 *   3. Also try common patterns: ?ical=1, /events.ics, /feed.ics,
 *      /events/feed/?ical=1 (WordPress Tribe Events pattern)
 *
 * Returns the first URL that responds with a valid ICS body, or null.
 */
export async function discoverIcsFeed(pageUrl, opts = {}) {
  const { userAgent = DEFAULT_USER_AGENT } = opts
  const tryUrl = async (u) => {
    try {
      await fetchIcsFeed(u, { userAgent, timeoutMs: 10_000 })
      return u
    } catch { return null }
  }

  // 1. Parse the page HTML for <link rel=alternate>
  try {
    const res = await fetch(pageUrl, {
      headers: { Accept: 'text/html', 'User-Agent': userAgent },
      redirect: 'follow',
    })
    if (res.ok) {
      const html = await res.text()
      const re = /<link[^>]+rel=["']alternate["'][^>]*type=["']text\/(calendar|ics)["'][^>]*>/gi
      let m
      while ((m = re.exec(html)) !== null) {
        const hrefMatch = m[0].match(/href=["']([^"']+)["']/i)
        if (hrefMatch?.[1]) {
          const resolved = new URL(hrefMatch[1], pageUrl).toString()
          const found = await tryUrl(resolved)
          if (found) return found
        }
      }
    }
  } catch { /* ignore — fall through to URL pattern probing */ }

  // 2. Probe common feed URL patterns
  const origin = new URL(pageUrl).origin
  const pagePath = new URL(pageUrl).pathname.replace(/\/$/, '')
  const CANDIDATES = [
    `${pageUrl.replace(/\/$/, '')}?ical=1`,                // WordPress Tribe Events
    `${pageUrl.replace(/\/$/, '')}/?ical=1`,
    `${pageUrl.replace(/\/$/, '')}/feed.ics`,
    `${origin}${pagePath}.ics`,
    `${origin}/events.ics`,
    `${origin}/events/feed/?ical=1`,
    `${origin}/calendar.ics`,
    `${origin}/?ical=1`,
  ]
  for (const candidate of CANDIDATES) {
    const found = await tryUrl(candidate)
    if (found) return found
  }
  return null
}

// ════════════════════════════════════════════════════════════════════════════
// FULL PIPELINE RUNNER
// ════════════════════════════════════════════════════════════════════════════

/**
 * End-to-end pipeline for an ICS-sourced scraper.
 *
 * Fetches the feed, parses + normalises events, ensures venue + organization,
 * upserts each event, and logs a scraper_runs row. Returns a summary.
 *
 * @param {object} config
 *   @param {string}   config.source            — scraper source key (required)
 *   @param {string}   [config.feedUrl]         — direct ICS feed URL
 *   @param {string}   [config.discoveryUrl]    — page URL to auto-discover a feed
 *   @param {string}   [config.organizationName]— default organization for all events
 *   @param {object}   [config.organizationDetails] — passed to ensureOrganization
 *   @param {string}   [config.defaultVenueName]— fallback venue if VEVENT has no LOCATION
 *   @param {object}   [config.defaultVenueDetails] — passed to ensureVenue
 *   @param {Function} [config.mapCategory]     — (ev) → category
 *   @param {Function} [config.mapTags]         — (ev) → string[]
 *   @param {number}   [config.defaultPriceMin]
 *   @param {number|null} [config.defaultPriceMax]
 *   @param {string}   [config.ageRestriction]
 *   @param {string}   [config.defaultImageUrl]
 */
export async function runIcsScraper(config) {
  const { source } = config
  if (!source) throw new Error('runIcsScraper: config.source is required')

  console.log(`🚀  Starting ICS scrape: ${source}`)
  const start = Date.now()

  try {
    // Resolve ICS text. Custom scrapers can supply `getIcsText` to inject their
    // own fetch/fallback logic (e.g. snapshot files for bot-protected sites).
    // Default path: discover/fetch a feed URL over HTTP.
    let icsText
    if (typeof config.getIcsText === 'function') {
      console.log(`\n🔍  Fetching ICS text via custom getIcsText()…`)
      icsText = await config.getIcsText()
    } else {
      let feedUrl = config.feedUrl
      if (!feedUrl && config.discoveryUrl) {
        console.log(`  🔎  Discovering ICS feed from ${config.discoveryUrl}…`)
        feedUrl = await discoverIcsFeed(config.discoveryUrl)
        if (!feedUrl) {
          throw new Error(
            `No ICS feed found on ${config.discoveryUrl}. ` +
            `Open the page in a browser, find the calendar subscription link, and set config.feedUrl explicitly.`
          )
        }
        console.log(`  ✓ Discovered feed: ${feedUrl}`)
      }
      if (!feedUrl) throw new Error('runIcsScraper: either feedUrl, discoveryUrl, or getIcsText must be provided')

      // Fetch + parse
      console.log(`\n🔍  Fetching ICS feed: ${feedUrl}`)
      icsText = await fetchIcsFeed(feedUrl)
    }
    const rawEvents = parseIcs(icsText)
    console.log(`  Parsed ${rawEvents.length} VEVENT blocks`)

    // Optionally materialise recurring masters into concrete occurrences.
    let workEvents = rawEvents
    if (config.expandRecurring) {
      workEvents = rawEvents.flatMap(ev =>
        expandRecurrence(ev, { windowDays: config.recurrenceWindowDays ?? 120 }))
      const recurring = rawEvents.filter(e => e.RRULE).length
      console.log(`  Expanded ${recurring} recurring master(s) → ${workEvents.length} occurrences total`)
    }

    if (rawEvents.length === 0) {
      await logUpsertResult(source, 0, 0, 0, {
        status: 'error',
        errorMessage: 'Feed parsed but contained 0 VEVENTs',
        durationMs: Date.now() - start,
        eventsFound: 0,
      })
      process.exit(0)
    }

    // Ensure organization + default venue (once, outside the loop)
    let organizationId = null
    if (config.organizationName) {
      organizationId = await ensureOrganization(config.organizationName, config.organizationDetails || {})
    }

    let defaultVenueId = null
    if (config.defaultVenueName) {
      defaultVenueId = await ensureVenue(config.defaultVenueName, config.defaultVenueDetails || {})
      if (organizationId && defaultVenueId) {
        await linkOrganizationVenue(organizationId, defaultVenueId)
      }
    }

    // Process each event
    console.log(`\n📥  Processing ${workEvents.length} events…`)
    let inserted = 0, skipped = 0
    const venueCache = new Map()

    // Opt-in past cutoff. Feeds that emit only upcoming events (Tribe, etc.)
    // don't need this, but full-history feeds (e.g. Google Calendar) carry
    // years of dead events — skipPast drops anything older than maxPastDays
    // (default 1) so we never insert expired rows.
    const nowMs = Date.now()
    const pastCutoffMs = nowMs - (config.maxPastDays ?? 1) * DAY_MS

    for (const ev of workEvents) {
      try {
        const row = normaliseIcsEvent(ev, {
          source,
          mapCategory:      config.mapCategory,
          mapTags:          config.mapTags,
          defaultPriceMin:  config.defaultPriceMin,
          defaultPriceMax:  config.defaultPriceMax,
          ageRestriction:   config.ageRestriction,
          defaultImageUrl:  config.defaultImageUrl,
        })
        if (!row || !row.start_at || !row.source_id) { skipped++; continue }

        if (config.skipPast) {
          const sMs = Date.parse(row.start_at)
          if (Number.isFinite(sMs) && sMs < pastCutoffMs) { skipped++; continue }
        }

        // Per-event venue: prefer VEVENT LOCATION, fall back to default
        let venueId = defaultVenueId
        const locName = (ev.LOCATION || '').trim()
        if (locName) {
          if (venueCache.has(locName)) {
            venueId = venueCache.get(locName)
          } else {
            venueId = await ensureVenue(locName, { city: 'Akron', state: 'OH' })
            venueCache.set(locName, venueId)
          }
        }

        const enrichedRow = await enrichWithImageDimensions(row)
        const { data: upserted, error } = await upsertEventSafe(enrichedRow)

        if (error) {
          console.warn(`  ⚠ Upsert failed for "${row.title}":`, error.message)
          skipped++
        } else {
          if (venueId)        await linkEventVenue(upserted.id, venueId)
          if (organizationId) await linkEventOrganization(upserted.id, organizationId)
          inserted++
        }
      } catch (err) {
        console.warn(`  ⚠ Error processing event "${ev.SUMMARY}":`, err.message)
        skipped++
      }
    }

    const durationMs = Date.now() - start
    await logUpsertResult(source, inserted, 0, skipped, {
      eventsFound: workEvents.length,
      durationMs,
    })
    console.log(`\n✅  ${source} done in ${(durationMs / 1000).toFixed(1)}s`)
    return { inserted, skipped, eventsFound: workEvents.length }

  } catch (err) {
    await logScraperError(source, err, start)
    process.exit(1)
  }
}
