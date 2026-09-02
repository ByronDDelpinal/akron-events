/**
 * seriesPicker.ts -- pure helpers behind the submit form's "Repeats" picker
 * (ADR-069 slice 3). No DOM, no React, no supabase, no Intl.
 *
 * The division of labour matters. This module derives an rrule from the
 * chosen repeat option and the series' EASTERN civil start date, expands it
 * to a date list, and writes the copy a submitter reads. It does not decide
 * whether a rule is legal: `validateOrganizerRule` (recurrence.js) is the
 * semantic gate the 069 CHECK is paired with, and a second copy of the
 * 52-occurrence / 366-day arithmetic here is exactly the drift
 * `recurrence.js` exists to prevent. Everything that touches instants
 * (`easternIsoAt`, `easternDateKey`, `easternTimeKey`) stays in the
 * component, so every input and output here is a plain string.
 *
 * Imports carry file extensions on purpose: `node --test` imports
 * `src/lib/*.ts` directly (Node 22 type stripping) and has no `@/` alias
 * resolver, so `scripts/tests/test-series-picker.js` can only reach this
 * module through relative, extension-bearing paths.
 */

import {
  WEEKDAY_CODE,
  MAX_SERIES_OCCURRENCES,
  MAX_SERIES_SPAN_DAYS,
  DEFAULT_HORIZON_DAYS,
  formatRrule,
  validateOrganizerRule,
  expandRuleDates,
  weekdayOfYmd,
  addDaysYmd,
} from './recurrence.js'

export type RepeatChoice = 'none' | 'weekly' | 'biweekly' | 'monthly'

export interface PickerState {
  repeat: RepeatChoice
  endMode: 'count' | 'date'
  /** Free text from a number input, validated here, not trusted. */
  count: string
  /** 'YYYY-MM-DD', or '' when the submitter has not picked one. */
  untilYmd: string
}

export type RruleParts = {
  FREQ?: string
  INTERVAL?: string
  BYDAY?: string
  COUNT?: string
  UNTIL?: string
}

export type BuildResult =
  | { ok: true; rrule: string; parts: RruleParts }
  | { ok: false; reason: string }

/** Reasons this module raises before `validateOrganizerRule` ever runs. */
const REASON_COUNT_RANGE = 'picker: count must be 1..52'
const REASON_UNTIL_MISSING = 'picker: until is required'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const ORDINAL_WORDS: Record<string, string> = { '1': '1st', '2': '2nd', '3': '3rd', '4': '4th', '-1': 'last' }

/**
 * Days in a civil month (month is 1..12). A three-line twin of the private
 * helper in recurrence.js, which does not export it; the alternative is
 * widening that module's public surface for one caller.
 */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function splitYmd(ymd: string): { y: number; m: number; d: number } {
  const [y, m, d] = ymd.split('-').map(Number)
  return { y, m, d }
}

/** RFC 5545 weekday code of a civil date, read back out of WEEKDAY_CODE. */
function weekdayCodeOf(ymd: string): string {
  const wd = weekdayOfYmd(ymd)
  const code = Object.keys(WEEKDAY_CODE).find((k) => WEEKDAY_CODE[k] === wd)
  return code ?? 'MO'
}

/**
 * Monthly BYDAY ordinal for a start date, matching validateOrganizerRule's
 * acceptance test (recurrence.js) exactly.
 *
 * The last-weekday branch comes FIRST and is not optional: for any day 29 or
 * later `ceil(d / 7)` is 5, which the validator's `^(-1|[1-4])([A-Z]{2})$`
 * refuses outright, and `d + 7 > daysInMonth` is true for every such date, so
 * the two branches are exhaustive. Where both would validate (2026-11-24 is
 * both the 4th and the last Tuesday of a 30-day month) we choose '-1' on
 * purpose: "the last Tuesday" is what an organizer who picked the 24th of
 * November means, and it keeps the series on the last Tuesday in a 31-day
 * month rather than sliding to the fourth.
 */
export function monthlyOrdinal(ymd: string): string {
  const { y, m, d } = splitYmd(ymd)
  return d + 7 > daysInMonth(y, m) ? '-1' : String(Math.ceil(d / 7))
}

/**
 * Derive the canonical rrule for a picker choice, then hand the whole
 * semantic decision to validateOrganizerRule. `formatRrule` is not optional:
 * the validator re-checks canonical key order and refuses anything
 * hand-assembled.
 */
export function buildSeriesRule(state: PickerState, dtstartYmd: string): BuildResult {
  const code = weekdayCodeOf(dtstartYmd)
  const parts: RruleParts =
    state.repeat === 'monthly'
      ? { FREQ: 'MONTHLY', BYDAY: monthlyOrdinal(dtstartYmd) + code }
      : state.repeat === 'biweekly'
        ? { FREQ: 'WEEKLY', INTERVAL: '2', BYDAY: code }
        : { FREQ: 'WEEKLY', BYDAY: code }

  if (state.endMode === 'count') {
    const n = Number(state.count)
    if (!/^\d+$/.test(state.count.trim()) || !Number.isInteger(n) || n < 1 || n > MAX_SERIES_OCCURRENCES) {
      return { ok: false, reason: REASON_COUNT_RANGE }
    }
    parts.COUNT = String(n)
  } else {
    if (!state.untilYmd) return { ok: false, reason: REASON_UNTIL_MISSING }
    parts.UNTIL = state.untilYmd.replaceAll('-', '')
  }

  const rrule = formatRrule(parts)
  const verdict = validateOrganizerRule(rrule, dtstartYmd)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  return { ok: true, rrule: verdict.rrule, parts: verdict.parts as RruleParts }
}

/**
 * Every date the rule produces, and the subset materialised at submit time.
 *
 * The horizon cap exists because the nightly extender mints the tail from the
 * newest PUBLISHED occurrence (scripts/lib/series.js): freezing a full year of
 * copies of an UNREVIEWED submission would make every correction the operator
 * makes in review apply to one row out of 52.
 *
 * The `toMint.length === 0` guard is not defensive padding. It fires when
 * dtstart itself is past the horizon, and without it a series would be created
 * with zero occurrence rows, could therefore never acquire a template, and the
 * extender would skip it forever: the submission would be silently lost.
 */
export function materialiseDates(
  parts: RruleParts,
  dtstartYmd: string,
  todayYmd: string,
  horizonDays: number = DEFAULT_HORIZON_DAYS,
): { all: string[]; toMint: string[] } {
  const u = parts.UNTIL
  const untilYmd = u ? `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}` : undefined
  const all = expandRuleDates(parts, dtstartYmd, { untilYmd, maxOccurrences: MAX_SERIES_OCCURRENCES })
  const horizonYmd = addDaysYmd(todayYmd, horizonDays)
  let toMint = all.filter((d) => d <= horizonYmd)
  if (toMint.length === 0 && all.length > 0) toMint = [all[0]]
  return { all, toMint }
}

/** Whole days from one civil date to another, DST-free (both are UTC noons). */
export function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const a = Date.parse(`${fromYmd}T00:00:00Z`)
  const b = Date.parse(`${toYmd}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

/**
 * Civil-day offset from an occurrence's start to its end, or null when the
 * end is not actually after the start.
 *
 * Both arguments are EASTERN civil pairs, so a 10 PM to 1 AM event returns 1
 * and every occurrence keeps its wall clock across a DST change instead of
 * drifting an hour. Null is the honest answer for an End earlier than or
 * equal to Start on the same day: the submit form's End field has no `min`
 * relative to Start beyond the native hint, and reapplying a negative offset
 * to all N occurrences would mint a whole series that ends before it begins.
 * The caller treats null as "no end supplied", a state the review queue
 * already annotates.
 *
 * 'HH:mm:ss' is zero-padded and fixed width, so a string compare is a clock
 * compare.
 */
export function occurrenceEndOffset(
  startYmd: string, startHms: string, endYmd: string, endHms: string,
): number | null {
  const offset = daysBetweenYmd(startYmd, endYmd)
  if (offset < 0) return null
  if (offset === 0 && endHms <= startHms) return null
  return offset
}

/** 'Oct 6' for a civil date. */
function monthDayLabel(ymd: string): string {
  const { m, d } = splitYmd(ymd)
  return `${MONTHS[m - 1]} ${d}`
}

/** 'Oct 6, 2027' for a civil date. Internal: the copy helpers below own it. */
function longDateLabel(ymd: string): string {
  return `${monthDayLabel(ymd)}, ${splitYmd(ymd).y}`
}

/** '7:00 PM' for an 'HH:mm:ss' Eastern clock time. */
function clockLabel(hms: string): string {
  const [h, mi] = hms.split(':').map(Number)
  const suffix = h < 12 ? 'AM' : 'PM'
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mi).padStart(2, '0')} ${suffix}`
}

/**
 * The one-sentence summary under the picker, plus a second sentence when the
 * horizon caps materialisation.
 *
 * `dates` is the REAL expansion, so a COUNT that UNTIL never reaches, or a
 * monthly rule whose fifth-week months are skipped, reports the truth rather
 * than the requested number.
 *
 * `showZone` is an option rather than a `resolvedOptions()` read inside the
 * helper: the module stays pure and both copy variants are testable. The time
 * shown is always the EASTERN wall clock, because that is what gets stored
 * (event_series.tz is CHECK-pinned to America/New_York) and what a submitter
 * outside Eastern would otherwise be told wrongly.
 */
export function describeSeries(
  state: PickerState,
  dtstartYmd: string,
  startHms: string,
  dates: string[],
  opts: { showZone?: boolean; mintedCount?: number } = {},
): string {
  if (dates.length === 0) return ''
  const weekday = WEEKDAY_NAMES[weekdayOfYmd(dtstartYmd)]
  const time = clockLabel(startHms) + (opts.showZone ? ' ET' : '')
  const pattern =
    state.repeat === 'monthly'
      ? `Monthly on the ${ORDINAL_WORDS[monthlyOrdinal(dtstartYmd)]} ${weekday} at ${time}`
      : state.repeat === 'biweekly'
        ? `Every other ${weekday} at ${time}`
        : `Every ${weekday} at ${time}`

  const last = dates[dates.length - 1]
  const lastLabel =
    splitYmd(last).y === splitYmd(dates[0]).y ? monthDayLabel(last) : longDateLabel(last)
  const n = dates.length
  let out = `${pattern}, ${n} ${n === 1 ? 'time' : 'times'}, ending ${lastLabel}.`

  const minted = opts.mintedCount
  if (minted != null && minted < n) {
    out += ` We will add the first ${minted === 1 ? 'date' : `${minted} dates`} now and the rest as each one gets closer.`
  }
  return out
}

/**
 * Public-facing copy for a rejection reason. The reason strings come from
 * validateOrganizerRule verbatim; the catch-all exists because the picker
 * cannot currently produce the other reasons (it derives BYDAY and FREQ
 * itself), and a developer string reaching a member of the public is worse
 * than a vague sentence. The caller logs the raw reason.
 *
 * Takes `dtstartYmd` as a second argument (the brief's signature had one):
 * the one-year copy names the last allowed date, which cannot be derived
 * from the reason string alone.
 */
export function pickerErrorCopy(reason: string, dtstartYmd = ''): string {
  if (reason === REASON_COUNT_RANGE || reason.startsWith('COUNT must be')) {
    return 'Pick between 1 and 52 dates.'
  }
  if (reason === REASON_UNTIL_MISSING) return 'Choose the date the series ends.'
  if (reason === 'UNTIL must be after dtstart') return 'The end date has to be after the first date.'
  if (reason.startsWith('UNTIL must be within') || reason.startsWith('series would run past')) {
    const lastAllowed = dtstartYmd ? longDateLabel(addDaysYmd(dtstartYmd, MAX_SERIES_SPAN_DAYS)) : ''
    return `A series can run at most one year from its first date.${lastAllowed ? ` Pick an end date on or before ${lastAllowed}.` : ''}`
  }
  if (reason.startsWith('series would exceed')) {
    return 'That comes to more than 52 dates. Shorten the run, or lower the number of dates.'
  }
  return 'We could not read that repeat pattern. Pick a different option, or email us the pattern and we will set it up.'
}
