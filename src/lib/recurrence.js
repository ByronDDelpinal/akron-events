// @ts-check
/**
 * recurrence.js -- RRULE parsing, formatting, civil expansion and the
 * organizer-subset validator (PURE, no I/O).
 *
 * SINGLE SOURCE OF TRUTH. Lives in src/lib (not scripts/lib) for the same
 * reason src/lib/sourceTiers.js does: both the browser bundle (the submit
 * form and the admin series editor) and the Node side (scripts/lib/ics.js
 * feed expansion, the nightly series extender) need the same expansion, and
 * two copies of "which dates does this rule produce" would drift. ics.js
 * imports from here and re-exports parseRrule so its existing callers keep
 * their import path.
 *
 * This module must stay PURE: no I/O, no supabase, no env, no Intl, and no
 * local-time Date getters. Every piece of calendar arithmetic is done on a
 * "civil cursor": a Date pinned to UTC midnight and used purely as a calendar
 * counter, so getUTCDay()/Date.UTC() give DST-free date math (the same
 * technique scripts/lib/ics.js and scripts/lib/weekly-occurrences.js use).
 * The output is calendar dates as 'YYYY-MM-DD' strings; converting a date to
 * an America/New_York instant happens per occurrence in the caller, which is
 * what keeps a series that spans a DST change on its wall-clock time.
 *
 * Supported (matched to what real feeds emit plus the organizer subset, on
 * purpose not a full RFC 5545 engine): FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL,
 * BYDAY (including monthly ordinals like 3SA / -1SU), UNTIL, COUNT, plus a
 * caller-supplied exdate list. Invalid civil dates (Feb 30, Apr 31) are
 * skipped, never rolled into the next month.
 */

/** RFC 5545 weekday codes to JS getUTCDay() numbering. */
export const WEEKDAY_CODE = /** @type {{ readonly [code: string]: number }} */ (
  { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }
)

/** Organizer series never mint more than a year of weekly occurrences. */
export const MAX_SERIES_OCCURRENCES = 52
/** UNTIL may be at most this far past DTSTART for an organizer series. */
export const MAX_SERIES_SPAN_DAYS = 366
/** How far ahead the nightly extender materialises occurrences. */
export const DEFAULT_HORIZON_DAYS = 91

/**
 * @typedef {{ FREQ?: string, INTERVAL?: string, BYDAY?: string, UNTIL?: string, COUNT?: string, [k: string]: string|undefined }} RruleParts
 */

/**
 * @typedef {object} ExpandOptions
 * @property {string} [fromYmd]        inclusive lower bound on RETURNED dates;
 *   earlier occurrences still count toward COUNT (ics.js semantics)
 * @property {string} [toYmd]          inclusive upper bound; expansion stops past it
 * @property {string} [untilYmd]       inclusive civil UNTIL; the series ends past it
 * @property {string[]} [exdates]      cancelled dates, removed AFTER COUNT accounting
 * @property {number} [maxOccurrences] hard cap on returned dates
 */

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS
// Loop guards, identical to the caps ics.js carried before the engine moved
// here: 4000 day-steps for DAILY/WEEKLY, 120 month-steps for MONTHLY.
const MAX_DAY_STEPS = 4000
const MAX_MONTH_STEPS = 120

const CANONICAL_KEY_ORDER = ['FREQ', 'INTERVAL', 'BYDAY', 'COUNT', 'UNTIL']
const UUID_RE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const SOURCE_ID_RE = new RegExp(`^series:(${UUID_RE}):(\\d{4}-\\d{2}-\\d{2})$`)

/** @param {number} n @param {number} [len] */
const pad = (n, len = 2) => String(n).padStart(len, '0')

/** Days in a civil month (month is 1..12). Day 0 of the next month. */
const daysInMonth = (/** @type {number} */ y, /** @type {number} */ m) =>
  new Date(Date.UTC(y, m, 0)).getUTCDate()

/**
 * Split a 'YYYY-MM-DD' string into numeric parts, or null when it is not a
 * real civil date (shape or range).
 * @param {string} ymd
 * @returns {{ y: number, m: number, d: number } | null}
 */
function parseYmd(ymd) {
  const mt = typeof ymd === 'string' ? ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null
  if (!mt) return null
  const y = +mt[1], m = +mt[2], d = +mt[3]
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null
  return { y, m, d }
}

/** @param {number} y @param {number} m @param {number} d */
const toYmd = (y, m, d) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`

/** UTC-midnight civil cursor for a 'YYYY-MM-DD' string (caller validated). */
const cursorOf = (/** @type {string} */ ymd) => {
  const p = parseYmd(ymd)
  if (!p) throw new RangeError(`not a civil date: ${ymd}`)
  return new Date(Date.UTC(p.y, p.m - 1, p.d))
}

/** 'YYYY-MM-DD' for a civil cursor. */
const ymdOfCursor = (/** @type {Date} */ cur) =>
  toYmd(cur.getUTCFullYear(), cur.getUTCMonth() + 1, cur.getUTCDate())

/** Monday-based week anchor of a civil cursor (ics.js INTERVAL semantics). */
const mondayOf = (/** @type {Date} */ cur) => {
  const wd = cur.getUTCDay()             // 0=Sun ... 6=Sat
  const back = (wd + 6) % 7              // days since Monday
  return new Date(cur.getTime() - back * DAY_MS)
}

/**
 * Parse an `RRULE:` value string into a plain key to value object.
 * @param {string | null | undefined} rruleStr
 * @returns {RruleParts}
 */
export function parseRrule(rruleStr) {
  /** @type {RruleParts} */
  const out = {}
  if (!rruleStr || typeof rruleStr !== 'string') return out
  for (const part of rruleStr.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    out[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim()
  }
  return out
}

/**
 * Canonical RRULE text: FREQ, INTERVAL, BYDAY, COUNT, UNTIL in that order,
 * uppercase, no trailing ';'. Any other keys follow, sorted, so nothing is
 * silently dropped. parseRrule(formatRrule(p)) deep-equals p for valid
 * (already uppercase) input.
 * @param {RruleParts} parts
 * @returns {string}
 */
export function formatRrule(parts) {
  const extras = Object.keys(parts)
    .map(k => k.toUpperCase())
    .filter(k => !CANONICAL_KEY_ORDER.includes(k))
    .sort()
  const out = []
  for (const key of [...CANONICAL_KEY_ORDER, ...extras]) {
    const raw = parts[key] ?? parts[key.toLowerCase()]
    if (raw == null || raw === '') continue
    out.push(`${key}=${String(raw).trim().toUpperCase()}`)
  }
  return out.join(';')
}

/**
 * JS weekday (0=Sunday ... 6=Saturday) of a 'YYYY-MM-DD' civil date.
 * @param {string} ymd
 * @returns {number}
 */
export function weekdayOfYmd(ymd) {
  return cursorOf(ymd).getUTCDay()
}

/**
 * Add whole days to a 'YYYY-MM-DD' civil date (negative to subtract).
 * @param {string} ymd
 * @param {number} days
 * @returns {string}
 */
export function addDaysYmd(ymd, days) {
  return ymdOfCursor(new Date(cursorOf(ymd).getTime() + days * DAY_MS))
}

/**
 * nth weekday of a month (n<0 counts from the end). Returns 'YYYY-MM-DD' or
 * null when the month has no such day (a 5th Friday, say).
 * @param {number} year
 * @param {number} month   1..12
 * @param {number} weekday 0=Sunday ... 6=Saturday
 * @param {number} n       1..5 or -1..-5
 * @returns {string | null}
 */
export function nthWeekdayOfMonth(year, month, weekday, n) {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1))
    const offset = (weekday - first.getUTCDay() + 7) % 7
    const day = 1 + offset + (n - 1) * 7
    return day <= daysInMonth(year, month) ? toYmd(year, month, day) : null
  }
  if (n === 0) return null
  // n < 0: count back from the last day of the month
  const last = new Date(Date.UTC(year, month, 0))   // day 0 of next month
  const offset = (last.getUTCDay() - weekday + 7) % 7
  const day = last.getUTCDate() - offset - (-n - 1) * 7
  return day >= 1 ? toYmd(year, month, day) : null
}

/**
 * Civil expansion of a parsed rule from its DTSTART date.
 *
 * dtstartYmd is the first candidate and is always evaluated against the
 * rule. Dates before opts.fromYmd are not returned but still consume COUNT
 * (ics.js semantics, and what lets a later re-expansion agree with an
 * earlier one). opts.exdates are removed AFTER COUNT accounting so a
 * cancelled date never shifts the rest of the series. Invalid civil dates
 * are skipped and do not consume COUNT.
 *
 * DAILY is supported here because ICS feeds emit it; validateOrganizerRule
 * rejects it for organizer-authored series.
 *
 * @param {RruleParts} parts
 * @param {string} dtstartYmd
 * @param {ExpandOptions} [opts]
 * @returns {string[]} ascending 'YYYY-MM-DD' strings
 */
export function expandRuleDates(parts, dtstartYmd, opts = {}) {
  const {
    fromYmd = null,
    toYmd: toBound = null,
    untilYmd = null,
    exdates = [],
    maxOccurrences = MAX_SERIES_OCCURRENCES,
  } = opts

  const start = parseYmd(dtstartYmd)
  if (!start) return []
  const freq = String(parts.FREQ || '').toUpperCase()
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(freq)) return []

  const interval = Math.max(1, parseInt(parts.INTERVAL || '1', 10) || 1)
  const parsedCount = parts.COUNT ? parseInt(parts.COUNT, 10) : NaN
  const countCap = Number.isFinite(parsedCount) ? parsedCount : null

  const startCursor = new Date(Date.UTC(start.y, start.m - 1, start.d))
  const startYmd = ymdOfCursor(startCursor)

  /** @type {string[]} */
  const out = []
  let seen = 0   // counts toward COUNT (every produced occurrence)

  // Record one candidate. Returns false when the series has ended (UNTIL).
  const consider = (/** @type {string} */ ymd) => {
    if (untilYmd != null && ymd > untilYmd) return false
    seen++
    if ((fromYmd == null || ymd >= fromYmd) && (toBound == null || ymd <= toBound)) out.push(ymd)
    return true
  }
  const capped = () => (countCap != null && seen >= countCap) || out.length >= maxOccurrences

  if (freq === 'DAILY') {
    let cur = startCursor
    for (let i = 0; i < MAX_DAY_STEPS; i++) {
      if (capped()) break
      const ymd = ymdOfCursor(cur)
      if (!consider(ymd)) break
      if (toBound != null && ymd > toBound) break
      cur = new Date(cur.getTime() + interval * DAY_MS)
    }
  } else if (freq === 'WEEKLY') {
    const days = (parts.BYDAY || '')
      .split(',').map(s => WEEKDAY_CODE[s.trim().replace(/^[+-]?\d+/, '')]).filter(n => n != null)
    const targetDows = days.length ? days : [startCursor.getUTCDay()]
    const anchorMonday = mondayOf(startCursor).getTime()
    let cur = startCursor
    for (let i = 0; i < MAX_DAY_STEPS; i++) {
      if (capped()) break
      const ymd = ymdOfCursor(cur)
      if (toBound != null && ymd > toBound && ymd > startYmd) break
      if (targetDows.includes(cur.getUTCDay())) {
        const weekIdx = Math.round((mondayOf(cur).getTime() - anchorMonday) / WEEK_MS)
        if (weekIdx >= 0 && weekIdx % interval === 0) {
          if (!consider(ymd)) break
        }
      }
      cur = new Date(cur.getTime() + DAY_MS)
    }
  } else {
    const byday = (parts.BYDAY || '').split(',').map(s => s.trim()).filter(Boolean)
    let y = start.y, m = start.m
    for (let step = 0; step < MAX_MONTH_STEPS; step++) {
      if (capped()) break
      const afterStartMonth = y > start.y || (y === start.y && m > start.m)
      if (toBound != null && toYmd(y, m, 1) > toBound && afterStartMonth) break
      if ((step % interval) === 0) {
        if (byday.length) {
          // Resolve every token for this month first and walk the dates in
          // calendar order, so COUNT and UNTIL are applied per date rather
          // than per month (BYDAY=3SA,1MO must not let an UNTIL hit on the
          // Saturday hide the earlier Monday, or a COUNT overrun by a token).
          /** @type {string[]} */
          const monthDates = []
          for (const tok of byday) {
            const mt = tok.match(/^([+-]?\d+)?([A-Z]{2})$/)
            if (!mt) continue
            const ord = mt[1] ? parseInt(mt[1], 10) : 1
            const wd = WEEKDAY_CODE[mt[2]]
            if (wd == null) continue
            const date = nthWeekdayOfMonth(y, m, wd, ord)
            if (date) monthDates.push(date)
          }
          monthDates.sort()
          let ended = false
          for (const date of monthDates) {
            if (capped() || !consider(date)) { ended = true; break }
          }
          if (ended) break
        } else {
          // BYDAY-less: same day-of-month as DTSTART. Months too short for
          // it are SKIPPED (Jan 31 recurs Mar 31, not "Feb 31" = Mar 3).
          if (start.d <= daysInMonth(y, m)) {
            if (!consider(toYmd(y, m, start.d))) break
          }
        }
      }
      m++; if (m > 12) { m = 1; y++ }
    }
  }

  const exSet = new Set(exdates)
  return out
    .filter(d => !exSet.has(d))
    .sort()
    .slice(0, maxOccurrences)
}

/**
 * source_id for one materialised occurrence of a series.
 * @param {string} seriesId
 * @param {string} ymd
 * @returns {string}
 */
export function occurrenceSourceId(seriesId, ymd) {
  return `series:${seriesId}:${ymd}`
}

/**
 * Inverse of occurrenceSourceId. Null for anything that is not a series
 * occurrence id (scraper source_ids never carry the 'series:' prefix).
 * @param {string | null | undefined} sourceId
 * @returns {{ seriesId: string, ymd: string } | null}
 */
export function parseOccurrenceSourceId(sourceId) {
  const mt = typeof sourceId === 'string' ? sourceId.match(SOURCE_ID_RE) : null
  return mt ? { seriesId: mt[1], ymd: mt[2] } : null
}

/**
 * Validate an organizer-authored rule against the subset the submit form
 * and the series extender support (ADR-069): FREQ WEEKLY or MONTHLY,
 * INTERVAL 1..4, a single BYDAY token that agrees with DTSTART (weekday for
 * WEEKLY; ordinal weekday for MONTHLY, 1..4 or -1), exactly one of COUNT
 * (1..52) or UNTIL (YYYYMMDD, after DTSTART, within 366 days), nothing
 * else, canonical text only, and the expanded series itself must stay
 * within 52 occurrences and 366 days. The database CHECK on
 * event_series.rrule guards the shape only; this is the semantic gate and
 * must run before any insert. On success `rrule` is the canonical string to
 * store.
 *
 * @param {string} rruleStr
 * @param {string} dtstartYmd
 * @returns {{ ok: true, parts: RruleParts, rrule: string } | { ok: false, reason: string }}
 */
export function validateOrganizerRule(rruleStr, dtstartYmd) {
  const start = parseYmd(dtstartYmd)
  if (!start) return { ok: false, reason: `dtstart is not a civil date: ${dtstartYmd}` }
  if (typeof rruleStr !== 'string' || !rruleStr.trim()) return { ok: false, reason: 'rrule is empty' }

  const parts = parseRrule(rruleStr)
  const allowed = new Set(CANONICAL_KEY_ORDER)
  for (const key of Object.keys(parts)) {
    if (!allowed.has(key)) return { ok: false, reason: `unsupported rule key ${key}` }
  }

  const freq = parts.FREQ
  if (freq !== 'WEEKLY' && freq !== 'MONTHLY') {
    return { ok: false, reason: `FREQ must be WEEKLY or MONTHLY, got ${freq ?? '(none)'}` }
  }

  if (parts.INTERVAL != null) {
    if (!/^\d+$/.test(parts.INTERVAL) || +parts.INTERVAL < 1 || +parts.INTERVAL > 4) {
      return { ok: false, reason: `INTERVAL must be 1..4, got ${parts.INTERVAL}` }
    }
  }

  const startWd = weekdayOfYmd(dtstartYmd)
  if (parts.BYDAY == null) return { ok: false, reason: 'BYDAY is required' }
  if (freq === 'WEEKLY') {
    const wd = WEEKDAY_CODE[parts.BYDAY]
    if (wd == null) return { ok: false, reason: `WEEKLY BYDAY must be a single weekday code, got ${parts.BYDAY}` }
    if (wd !== startWd) return { ok: false, reason: `BYDAY ${parts.BYDAY} does not match the dtstart weekday` }
  } else {
    const mt = parts.BYDAY.match(/^(-1|[1-4])([A-Z]{2})$/)
    const wd = mt ? WEEKDAY_CODE[mt[2]] : undefined
    if (!mt || wd == null) {
      return { ok: false, reason: `MONTHLY BYDAY must be one ordinal weekday (1..4 or -1), got ${parts.BYDAY}` }
    }
    if (wd !== startWd) return { ok: false, reason: `BYDAY ${parts.BYDAY} does not match the dtstart weekday` }
    const ord = +mt[1]
    const matches = ord > 0
      ? Math.ceil(start.d / 7) === ord
      : start.d + 7 > daysInMonth(start.y, start.m)
    if (!matches) return { ok: false, reason: `BYDAY ${parts.BYDAY} does not match the dtstart position in its month` }
  }

  const hasCount = parts.COUNT != null
  const hasUntil = parts.UNTIL != null
  if (hasCount === hasUntil) return { ok: false, reason: 'exactly one of COUNT or UNTIL is required' }
  if (hasCount) {
    const c = parts.COUNT ?? ''
    if (!/^\d+$/.test(c) || +c < 1 || +c > MAX_SERIES_OCCURRENCES) {
      return { ok: false, reason: `COUNT must be 1..${MAX_SERIES_OCCURRENCES}, got ${c}` }
    }
  } else {
    const u = parts.UNTIL ?? ''
    const um = u.match(/^(\d{4})(\d{2})(\d{2})$/)
    const untilYmd = um ? `${um[1]}-${um[2]}-${um[3]}` : null
    if (!untilYmd || !parseYmd(untilYmd)) return { ok: false, reason: `UNTIL must be a YYYYMMDD date, got ${u}` }
    if (untilYmd <= dtstartYmd) return { ok: false, reason: 'UNTIL must be after dtstart' }
    if (untilYmd > addDaysYmd(dtstartYmd, MAX_SERIES_SPAN_DAYS)) {
      return { ok: false, reason: `UNTIL must be within ${MAX_SERIES_SPAN_DAYS} days of dtstart` }
    }
  }

  // Shape parity with the 069 CHECK: the database accepts only the
  // canonical text (uppercase, canonical key order, no spaces), so the
  // validator refuses anything else instead of letting a rule pass here and
  // fail on insert. Callers insert the returned `rrule`, never their input.
  const rrule = formatRrule(parts)
  if (rruleStr !== rrule) return { ok: false, reason: 'rrule is not canonical' }

  // The static checks above bound COUNT and UNTIL separately; only a real
  // expansion bounds the series as a whole (MONTHLY COUNT=52 is four years,
  // and a weekly UNTIL a year out can produce 53 dates). Expand with one
  // spare slot so an overrun is detected rather than silently capped.
  const untilYmd = parts.UNTIL
    ? `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`
    : undefined
  const dates = expandRuleDates(parts, dtstartYmd, { untilYmd, maxOccurrences: MAX_SERIES_OCCURRENCES + 1 })
  if (dates.length > MAX_SERIES_OCCURRENCES) {
    return { ok: false, reason: `series would exceed ${MAX_SERIES_OCCURRENCES} occurrences` }
  }
  const lastAllowed = addDaysYmd(dtstartYmd, MAX_SERIES_SPAN_DAYS)
  if (dates.length && dates[dates.length - 1] > lastAllowed) {
    return { ok: false, reason: `series would run past ${MAX_SERIES_SPAN_DAYS} days from dtstart` }
  }

  return { ok: true, parts, rrule }
}
