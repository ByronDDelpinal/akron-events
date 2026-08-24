/**
 * intent.ts: the deterministic matcher, plus the pure primitives it needs.
 *
 * Phase 1 of Tier 3 has NO LLM (ADR section 3: "Where does the LLM sit in
 * Phase 1? Nowhere"). Routing is a short ORDERED list of rules over normalised
 * text. First match wins. Every function in this file is pure: no I/O, no
 * `Deno.env`, no `new Date()` without an injected `now`, no imports from
 * anything that touches a database. That is what makes intent.test.ts able to
 * assert real behaviour instead of a mock's return value.
 *
 * The file owns three things, in this order:
 *
 *   1. EASTERN TIME    the date semantics every windowed handler depends on
 *   2. TEXT + SLOTS    normalisation, the one window parser, the slots
 *   3. THE RULE TABLE  ordered, first match wins, with the order justified
 *
 * It also owns SCRAPER_REGISTRY, because the registry's job here is to
 * VALIDATE a user-supplied slot before it ever reaches a query, which is a
 * matcher concern. handlers.ts imports it from this file. The dependency runs
 * one way only (handlers -> intent), so there is no import cycle.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THERE IS NO `toISOString()` ANYWHERE IN THIS PROJECT'S DATE LOGIC
 * ══════════════════════════════════════════════════════════════════════════
 * Akron Pulse is an Eastern-time product. `new Date().toISOString().slice(0,10)`
 * is the UTC calendar date, which between 20:00 and 23:59 ET is TOMORROW. A
 * bot that answers "how many events today" with tomorrow's count between
 * 8pm and midnight is worse than a bot that refuses, and this project has
 * already been bitten by exactly this class of bug (see the timezone rule in
 * .claude/agents/developer.md and `easternTodayIso` in scripts/lib/normalize.js).
 *
 * `easternTodayIso` below is a deliberate reimplementation of that helper with
 * identical semantics: same `Intl.DateTimeFormat('en-CA', { timeZone:
 * 'America/New_York' })` construction, same `YYYY-MM-DD` output. It is
 * duplicated rather than imported because Deno edge functions cannot import
 * from `scripts/` (different runtime, different module graph, no bundler
 * step). The duplication is the lesser evil; a drifting copy would be caught
 * by intent.test.ts, which pins the semantics rather than the implementation.
 *
 * `easternToUtc` is the piece `scripts/lib` does not export in a form usable
 * here: it turns an Eastern WALL-CLOCK moment into a real UTC instant, which
 * is what a `start_at >= ... and start_at < ...` filter actually needs. It
 * resolves the offset from the zone database via `Intl` rather than assuming
 * -5 or -4, so a window that straddles a DST transition is genuinely 23 or 25
 * hours long. Both are unit-tested around the March and November boundaries
 * and around midnight ET.
 */

import type { HandlerId, HandlerParams, IntentMatch, TimeWindow, WindowKind } from './types.ts'

// ══════════════════════════════════════════════════════════════════════════
// 1. EASTERN TIME
// ══════════════════════════════════════════════════════════════════════════

const EASTERN = 'America/New_York'

/**
 * en-CA formats as `YYYY-MM-DD` natively, which is why the repo's original
 * helper picked that locale. Do not "simplify" this to en-US.
 */
const ET_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: EASTERN,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * `hourCycle: 'h23'` (not `hour12: false`) because `hour12: false` is
 * specified to produce hour "24" for midnight in some engines, which would
 * silently shift a day when fed back into `Date.UTC`.
 */
const ET_WALL = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** The Eastern calendar date of an instant, `YYYY-MM-DD`. Never UTC. */
export function easternTodayIso(now: Date = new Date()): string {
  return ET_DATE.format(now)
}

interface WallParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

function easternWallParts(instant: Date): WallParts {
  const parts = ET_WALL.formatToParts(instant)
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type)
    if (!found) throw new Error(`easternWallParts: Intl did not emit a "${type}" part`)
    const n = Number(found.value)
    if (!Number.isFinite(n)) throw new Error(`easternWallParts: non-numeric "${type}" part "${found.value}"`)
    return n
  }
  // The `% 24` is belt-and-braces against an engine emitting "24" despite
  // hourCycle h23. Cheap, and the failure it prevents is a silent day shift.
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  }
}

/**
 * Eastern UTC offset at a given instant, in milliseconds (negative: ET is
 * behind UTC). Derived from the zone database through Intl, never hardcoded.
 */
function easternOffsetMs(instant: Date): number {
  const p = easternWallParts(instant)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  const flooredToSecond = Math.floor(instant.getTime() / 1000) * 1000
  return asIfUtc - flooredToSecond
}

/**
 * An Eastern wall-clock moment -> the UTC instant it names.
 *
 * Two passes, on purpose. The first guesses the offset using the offset that
 * applies at the same wall-clock reading interpreted as UTC; on a DST
 * transition day that guess can be an hour wrong, so the second pass
 * re-resolves the offset at the instant the first pass produced. Two passes
 * are provably enough for a one-hour transition.
 *
 * The two pathological wall-clock readings behave sanely:
 *  - A time that does not exist (02:30 on spring-forward day) resolves to the
 *    same instant as 03:30 EDT. It never throws and never silently lands on
 *    the previous day.
 *  - A time that happens twice (01:30 on fall-back day) resolves to the first
 *    occurrence (EDT). Window boundaries here are 00:00 and 17:00, neither of
 *    which is ever ambiguous, so this only matters to a future caller.
 */
export function easternToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  const firstPass = asIfUtc - easternOffsetMs(new Date(asIfUtc))
  const secondPass = asIfUtc - easternOffsetMs(new Date(firstPass))

  // Verify the answer actually reads back as the wall clock that was asked
  // for. It always does for a real time. It cannot for a time inside the
  // spring-forward gap, and there the two passes oscillate between the hour
  // before and the hour after; preferring the FIRST pass makes the result
  // 03:30 EDT rather than 01:30 EST, which is what `new Date(y, m, d, 2, 30)`
  // does on an Eastern machine and what every date library does. Matching the
  // conventional answer beats inventing a novel one.
  const check = easternWallParts(new Date(secondPass))
  const roundTrips = check.year === year && check.month === month && check.day === day &&
    check.hour === hour && check.minute === minute && check.second === second
  return new Date(roundTrips ? secondPass : firstPass)
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** Split a `YYYY-MM-DD` into numbers, throwing rather than producing NaN. */
export function parseEtDate(dateIso: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso)
  if (!m) throw new Error(`parseEtDate: "${dateIso}" is not YYYY-MM-DD`)
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }
}

/**
 * Calendar-date arithmetic, done in UTC on purpose. These are civil dates with
 * no time component, so UTC is just a stable integer calendar here: adding a
 * day can never cross a DST seam because there is no clock involved.
 */
export function etDateAdd(dateIso: string, days: number): string {
  const { year, month, day } = parseEtDate(dateIso)
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000)
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`
}

/** Day of week for an Eastern calendar date. 0 = Sunday, 6 = Saturday. */
export function etWeekday(dateIso: string): number {
  const { year, month, day } = parseEtDate(dateIso)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/**
 * Build a window from Eastern calendar boundaries.
 *
 * `endDateExclusiveEt` is the first Eastern date NOT in the window, always at
 * 00:00 ET. Half-open, so adjacent windows tile exactly and nothing hinges on
 * a 23:59:59.999 sentinel.
 */
/**
 * `Aug 28-30`, or `Aug 28-Sep 2` when the span crosses a month.
 *
 * Appended to the label of every window whose name is ambiguous on its own.
 * "this week" and "this weekend" are the two people argue about, and a reply
 * that says which dates it used is a reply nobody has to re-ask. The line
 * budget is 600 characters and a typical answer spends about 40, so this is
 * free.
 */
function rangeSuffix(startDateEt: string, endDateEt: string): string {
  const s = parseEtDate(startDateEt)
  const e = parseEtDate(endDateEt)
  const left = `${MONTH_ABBR[s.month - 1]} ${s.day}`
  const right = s.month === e.month ? String(e.day) : `${MONTH_ABBR[e.month - 1]} ${e.day}`
  return left === `${MONTH_ABBR[e.month - 1]} ${e.day}` ? ` (${left})` : ` (${left}-${right})`
}

export function buildEtWindow(
  kind: WindowKind,
  label: string,
  startDateEt: string,
  startHourEt: number,
  endDateExclusiveEt: string,
  withRange = false,
): TimeWindow {
  const s = parseEtDate(startDateEt)
  const e = parseEtDate(endDateExclusiveEt)
  const endDateEt = etDateAdd(endDateExclusiveEt, -1)
  return {
    kind,
    label: withRange ? `${label}${rangeSuffix(startDateEt, endDateEt)}` : label,
    startUtc: easternToUtc(s.year, s.month, s.day, startHourEt).toISOString(),
    endUtc: easternToUtc(e.year, e.month, e.day, 0).toISOString(),
    startDateEt,
    endDateEt,
  }
}

/**
 * A window bounded by real instants rather than Eastern midnight boundaries.
 *
 * Only "last N hours" needs this. Collapsing "last 24 hours" onto calendar
 * days means that asked at 9am it covers nine hours, which is not what
 * anybody means by "the last 24 hours". Everything else in this file is
 * genuinely calendar-shaped and stays that way.
 */
function rollingWindow(kind: WindowKind, label: string, endInstant: Date, hours: number): TimeWindow {
  const start = new Date(endInstant.getTime() - hours * 3_600_000)
  return {
    kind,
    label,
    startUtc: start.toISOString(),
    endUtc: endInstant.toISOString(),
    startDateEt: easternTodayIso(start),
    endDateEt: easternTodayIso(endInstant),
  }
}

/** The Friday of the weekend "this weekend" means, relative to an ET date. */
function weekendFriday(todayEt: string): string {
  const wd = etWeekday(todayEt)
  // Mon(1)..Thu(4) look FORWARD to the coming Friday. Fri(5)/Sat(6)/Sun(0) are
  // already inside a weekend, so they look BACK to the Friday that started it.
  // Without that second half, asking "how many events this weekend" on a
  // Saturday would answer about the weekend six days away.
  const offset = wd === 0 ? -2 : wd === 6 ? -1 : wd === 5 ? 0 : 5 - wd
  return etDateAdd(todayEt, offset)
}

/** The Monday of the ISO week containing an ET date. */
function weekMonday(todayEt: string): string {
  const wd = etWeekday(todayEt)
  return etDateAdd(todayEt, wd === 0 ? -6 : 1 - wd)
}

// ══════════════════════════════════════════════════════════════════════════
// 2. TEXT AND SLOTS
// ══════════════════════════════════════════════════════════════════════════

/**
 * Strip the bot mention and everything else Slack's wire format adds, then
 * flatten to a comparable form.
 *
 * Order matters and is not arbitrary:
 *  1. Slack entities go first (`<@U…>`, `<#C…>`, `<!here>`, `<url|label>`),
 *     because their angle brackets and pipes would be destroyed by the
 *     punctuation strip and leave id fragments behind as fake words.
 *  2. Slack's own HTML escaping is UNDONE next. Slack sends `&amp;` on the
 *     wire, so a question about "Barnes &amp; Noble" must become "barnes &
 *     noble" before matching, or nothing lines up with the database.
 *  3. Apostrophes are KEPT (curly ones folded to straight). Dropping them
 *     would make the venue slot unable to match "Jilly's Music Room" with an
 *     ILIKE, and every rule that wants "how's" simply writes `how'?s`.
 *  4. `/` and `-` are kept so `9/5` and `2026-09-05` survive to the date slot.
 */
export function normalizeQuestion(raw: string): string {
  return raw
    .replace(/<@[A-Z0-9]+(\|[^>]*)?>/gi, ' ')
    .replace(/<#[A-Z0-9]+(\|[^>]*)?>/gi, ' ')
    .replace(/<!(here|channel|everyone)(\|[^>]*)?>/gi, ' ')
    .replace(/<([^|>]*)\|([^>]*)>/g, ' $2 ')
    .replace(/<([^>]*)>/g, ' $1 ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/[^a-z0-9'/\-\s&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, twenty: 20, thirty: 30, sixty: 60, ninety: 90,
})

const NUM = `(\\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`

function toNumber(token: string): number | null {
  if (/^\d{1,3}$/.test(token)) return Number(token)
  const word = NUMBER_WORDS[token]
  return word ?? null
}

const MONTH_NAMES: Readonly<Record<string, number>> = Object.freeze({
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9,
  sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
})

const MONTH_ALT = Object.keys(MONTH_NAMES).sort((a, b) => b.length - a.length).join('|')

/**
 * THE window parser. One implementation, used by every windowed handler, so
 * "this weekend" can never mean two different things in two answers.
 *
 * Returns null when the text names no window at all; the caller supplies its
 * own documented default rather than this function inventing one.
 *
 * Semantics, all in Eastern time, all documented because they are judgement
 * calls a reader will want to check:
 *  - `today`      the ET calendar day containing `now`
 *  - `tonight`    17:00 ET today through midnight. Late-night shows that cross
 *                 midnight are stored on their own start date and belong to
 *                 tomorrow, which is what a reader asking at 9pm expects.
 *  - `weekend`    Friday 00:00 through Monday 00:00. Fri-Sun, matching the
 *                 ADR's own worked example ("47 events Fri-Sun").
 *  - `week`       ISO week, Monday through Sunday. Chosen over a Sunday start
 *                 because "this week" on a Sunday should not mean "the seven
 *                 days beginning today", which is what a Sunday-start week
 *                 does and which nobody means.
 *  - `last N days`  N calendar days ENDING WITH TODAY inclusive. "in the last
 *                 7 days" that excluded today would be wrong every morning.
 *  - `next N days`  today 00:00 through today+N 00:00.
 *  - `last night`  yesterday 17:00 ET through midnight, the mirror of tonight.
 *  - `last N hours` a TRUE rolling window from now, not N calendar days.
 *  - a named month resolves to the NEXT occurrence: this year if the month has
 *                 not finished, otherwise next year. Asking about "march" in
 *                 August means next March.
 *
 * FIRST PHRASE IN THIS FUNCTION'S ORDER WINS, not first in the sentence.
 * "events today and tomorrow" is answered about tomorrow only, because the
 * tomorrow branch is checked before the today branch. A multi-window question
 * is out of scope for Phase 1; the alternative (silently answering about half
 * of it with no indication) would be worse, and the reply always names the
 * window it used so the reader can see which half they got.
 */
export function parseWindow(text: string, now: Date): TimeWindow | null {
  const today = easternTodayIso(now)

  // Before `tonight`, so the shared word cannot cross-match, and before the
  // "last N" branches so "last night" is never read as "last 1 night".
  if (/\b(last night|lastnight|last nights)\b/.test(text)) {
    const yesterday = etDateAdd(today, -1)
    return buildEtWindow('last_night', 'last night', yesterday, 17, today)
  }
  if (/\b(tonight|tonite|this evening)\b/.test(text)) {
    return buildEtWindow('tonight', 'tonight', today, 17, etDateAdd(today, 1))
  }
  if (/\b(tomorrow|tomorow|tmrw|tmr)\b/.test(text)) {
    const d = etDateAdd(today, 1)
    return buildEtWindow('tomorrow', 'tomorrow', d, 0, etDateAdd(d, 1))
  }
  if (/\byesterday\b/.test(text)) {
    const d = etDateAdd(today, -1)
    return buildEtWindow('yesterday', 'yesterday', d, 0, today)
  }

  // Weekend before week: "weekend" contains "week".
  if (/\bweekends?\b/.test(text)) {
    const base = weekendFriday(today)
    const shift = /\bnext\b/.test(text) ? 7 : /\b(last|past|previous)\b/.test(text) ? -7 : 0
    const fri = etDateAdd(base, shift)
    const label = shift > 0 ? 'next Fri-Sun' : shift < 0 ? 'last Fri-Sun' : 'Fri-Sun'
    return buildEtWindow('weekend', label, fri, 0, etDateAdd(fri, 3), true)
  }

  if (/\bweeks?\b/.test(text) && !/\b\d+\s*weeks?\b/.test(text)) {
    const base = weekMonday(today)
    const shift = /\bnext\b/.test(text) ? 7 : /\b(last|past|previous)\b/.test(text) ? -7 : 0
    const mon = etDateAdd(base, shift)
    const label = shift > 0 ? 'next week' : shift < 0 ? 'last week' : 'this week'
    return buildEtWindow('week', label, mon, 0, etDateAdd(mon, 7), true)
  }

  // "last 24 hours" is a ROLLING window from now, not a calendar day. Checked
  // before the calendar-day branch so the hour unit is never rounded away.
  const lastHours = new RegExp(`\\b(?:last|past|previous)\\s+${NUM}\\s*(?:hours?|hrs?|h)\\b`).exec(text)
  if (lastHours) {
    const raw = toNumber(lastHours[1])
    if (raw !== null) {
      const hours = Math.min(90 * 24, Math.max(1, Math.trunc(raw)))
      return rollingWindow('last_hours', `last ${hours}h`, now, hours)
    }
  }

  // "last N days" / "past 3 days".
  const lastDays = new RegExp(`\\b(?:last|past|previous)\\s+${NUM}\\s*(?:days?|d)\\b`).exec(text)
  if (lastDays) {
    const raw = toNumber(lastDays[1])
    if (raw !== null) {
      const clamped = clampDays(raw)
      const start = etDateAdd(today, -(clamped - 1))
      return buildEtWindow('last_days', `last ${clamped}d`, start, 0, etDateAdd(today, 1), true)
    }
  }

  const nextDays = new RegExp(`\\b(?:next|coming|upcoming|in the next|in)\\s+${NUM}\\s*(days?|d)\\b`).exec(text)
  if (nextDays) {
    const raw = toNumber(nextDays[1])
    if (raw !== null) {
      const clamped = clampDays(raw)
      return buildEtWindow('next_days', `next ${clamped}d`, today, 0, etDateAdd(today, clamped), true)
    }
  }

  if (/\bmonths?\b/.test(text)) {
    const { year, month } = parseEtDate(today)
    const shift = /\bnext\b/.test(text) ? 1 : /\b(last|past|previous)\b/.test(text) ? -1 : 0
    return monthWindow(year, month + shift)
  }

  // A named month, optionally with a year: "in september", "sept 2027".
  const named = new RegExp(`\\b(${MONTH_ALT})\\b(?:\\s+(\\d{4}))?`).exec(text)
  if (named && monthNameIsAMonth(text, named[1], named.index)) {
    const month = MONTH_NAMES[named[1]]
    const explicitYear = named[2] ? Number(named[2]) : null
    // A day number next to the month means a DATE, not a whole month.
    const withDay = new RegExp(`\\b${named[1]}\\s+(\\d{1,2})\\b(?!\\d)`).exec(text)
    if (withDay) {
      const day = Number(withDay[1])
      const { year: nowYear, month: nowMonth, day: nowDay } = parseEtDate(today)
      const year = explicitYear ??
        (month > nowMonth || (month === nowMonth && day >= nowDay) ? nowYear : nowYear + 1)
      const dated = dateWindow(year, month, day)
      if (dated) return dated
      // An impossible day ("feb 30") falls through to the whole-month reading
      // rather than silently relocating to March 2nd.
    }
    const { year: nowYear, month: nowMonth } = parseEtDate(today)
    const year = explicitYear ?? (month >= nowMonth ? nowYear : nowYear + 1)
    return monthWindow(year, month)
  }

  const isoDate = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(text)
  if (isoDate) {
    const dated = dateWindow(Number(isoDate[1]), Number(isoDate[2]), Number(isoDate[3]))
    if (dated) return dated
  }

  const slashDate = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(text)
  if (slashDate) {
    const { year: nowYear } = parseEtDate(today)
    const rawYear = slashDate[3] ? Number(slashDate[3]) : nowYear
    const dated = dateWindow(
      rawYear < 100 ? 2000 + rawYear : rawYear,
      Number(slashDate[1]),
      Number(slashDate[2]),
    )
    if (dated) return dated
  }

  if (/\btoday\b/.test(text)) {
    return buildEtWindow('today', 'today', today, 0, etDateAdd(today, 1))
  }

  return null
}

/**
 * Two month names are also ordinary English words: "may" (the modal verb) and
 * "march" (the verb). "you may want to check the scrapers" must not be read as
 * a question about May.
 *
 * Those two are accepted only when a preposition puts them in date position, a
 * number follows them, or they are the entire message. Every other month name
 * ("september", "aug", "oct") has no other meaning and needs no gate.
 */
const AMBIGUOUS_MONTHS = new Set(['may', 'march'])

function monthNameIsAMonth(text: string, name: string, index: number): boolean {
  if (!AMBIGUOUS_MONTHS.has(name)) return true
  if (text.trim() === name) return true
  if (new RegExp(`\\b${name}\\s+\\d`).test(text)) return true
  const before = text.slice(0, index).trimEnd()
  return /\b(in|for|during|on|through|about|around|throughout|of)$/.test(before)
}

/** Days in an Eastern calendar month, leap-aware. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Reject a date that does not exist rather than letting `Date.UTC` roll it
 * over. Without this, "events on 2026-13-45" silently becomes a window six
 * months out with a label of `undefined`, which is a confidently wrong answer
 * to a typo. Returning null makes the caller fall through to its documented
 * default instead.
 */
function isValidYmd(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false
  if (year < 1970 || year > 2100) return false
  if (month < 1 || month > 12) return false
  return day >= 1 && day <= daysInMonth(year, month)
}

function monthWindow(year: number, month: number): TimeWindow {
  // Normalise a month of 0 or 13 (produced by the this/next/last shift).
  const y = year + Math.floor((month - 1) / 12)
  const m = ((month - 1) % 12 + 12) % 12 + 1
  const start = `${y}-${pad2(m)}-01`
  const endYear = m === 12 ? y + 1 : y
  const endMonth = m === 12 ? 1 : m + 1
  const end = `${endYear}-${pad2(endMonth)}-01`
  return buildEtWindow('month', MONTH_ABBR[m - 1], start, 0, end)
}

function dateWindow(year: number, month: number, day: number): TimeWindow | null {
  if (!isValidYmd(year, month, day)) return null
  const start = `${year}-${pad2(month)}-${pad2(day)}`
  // Round-trip check: parseEtDate must read back exactly what was asked for,
  // so nothing can reach a query through a formatting slip.
  const back = parseEtDate(start)
  if (back.year !== year || back.month !== month || back.day !== day) return null
  return buildEtWindow('date', `${MONTH_ABBR[month - 1]} ${day}`, start, 0, etDateAdd(start, 1))
}

/**
 * "Today 00:00 ET through today+N 00:00 ET", the default window for every
 * handler whose question named no window. Exported because handlers must be
 * able to rebuild their own default rather than trusting the matcher's
 * (rule 8: a handler validates its own params before querying).
 */
export function upcomingWindow(now: Date, days: number): TimeWindow {
  const clamped = clampDays(days)
  const today = easternTodayIso(now)
  return buildEtWindow('next_days', `next ${clamped}d`, today, 0, etDateAdd(today, clamped))
}

/** Whole days from one ET calendar date to another. `b - a`. */
export function etDaysBetween(a: string, b: string): number {
  const pa = parseEtDate(a)
  const pb = parseEtDate(b)
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / 86_400_000)
}

/** The project-wide day clamp. Exported so handlers re-apply it (rule 8). */
export function clampDays(n: number, min = 1, max = 90): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** A bare day count anywhere in the text: "last 14 days", "in 30 days", "7d". */
export function parseDays(text: string): number | null {
  const hours = new RegExp(`\\b${NUM}\\s*(?:hours?|hrs?|h)\\b`).exec(text)
  if (hours) {
    const n = toNumber(hours[1])
    if (n !== null) return clampDays(Math.max(1, Math.ceil(n / 24)))
  }
  const days = new RegExp(`\\b${NUM}\\s*(?:days?|d)\\b`).exec(text)
  if (days) {
    const n = toNumber(days[1])
    if (n !== null) return clampDays(n)
  }
  return null
}

// ── The scraper registry ──────────────────────────────────────────────────

/**
 * Mirror of `scripts/manifest.js`'s SCRAPERS, key + label + active, frozen.
 *
 * WHY A COPY. Deno edge functions cannot import from `scripts/` (Node module
 * graph, no bundler in the deploy path), and the brief is explicit that a
 * `scraper_name` slot must be validated against the canonical registry rather
 * than passed through raw. A copy that can drift is still strictly safer than
 * interpolating whatever the user typed into a query.
 *
 * DRIFT IS A KNOWN LIABILITY AND SHOULD BE MADE INTO A TEST. The repo already
 * solves this exact problem twice: `scripts/tests/test-slack-agent-identities.js`
 * fails CI when `AGENT_IDENTITIES` drifts from `.claude/agents/*.md`, and the
 * dataSources sync test fails CI when `manifest.js` drifts from
 * `src/lib/dataSources.ts`. A third test in the same shape belongs here. It is
 * NOT written in this run because this run is forbidden from touching the
 * repo; see README.md, "Not implemented".
 *
 * Generated from manifest.js on 2026-08-23: 156 entries, 150 active.
 */
export interface ScraperEntry {
  readonly label: string
  readonly active: boolean
}

export const SCRAPER_REGISTRY: ReadonlyMap<string, ScraperEntry> = new Map<string, ScraperEntry>([
  ['summit_artspace',            { label: 'Summit Artspace',                  active: true  }],
  ['summit_metro_parks',         { label: 'Summit Metro Parks',               active: true  }],
  ['cvnp_conservancy',           { label: 'CVNP Conservancy',                 active: true  }],
  ['players_guild',              { label: 'Players Guild Theatre',            active: false }],
  ['uakron_calendar',            { label: 'University of Akron',              active: true  }],
  ['rubberducks',                { label: 'Akron RubberDucks',                active: true  }],
  ['nightlight_cinema',          { label: 'The Nightlight Cinema',            active: true  }],
  ['akron_library',              { label: 'Akron Library',                    active: true  }],
  ['cuyahoga_falls_library',     { label: 'Cuyahoga Falls Library',           active: true  }],
  ['jillys_music_room',          { label: "Jilly's Music Room",               active: true  }],
  ['blu_jazz',                   { label: 'BLU Jazz+',                        active: true  }],
  ['missing_falls',              { label: 'Missing Falls Brewery',            active: true  }],
  ['akronym_brewing',            { label: 'Akronym Brewing',                  active: true  }],
  ['rialto',                     { label: 'The Rialto Theatre',               active: true  }],
  ['kent_stage',                 { label: 'The Kent Stage',                   active: false }],
  ['highland_square_theatre',    { label: 'Highland Square Theatre',          active: true  }],
  ['killbox_comedy',             { label: 'KillBox Comedy Club',              active: true  }],
  ['workz',                      { label: 'The Workz',                        active: true  }],
  ['akron_art_museum',           { label: 'Akron Art Museum',                 active: true  }],
  ['akron_civic',                { label: 'Akron Civic Theatre',              active: true  }],
  ['downtown_akron',             { label: 'Downtown Akron Partnership',       active: true  }],
  ['ohio_shakespeare',           { label: 'Ohio Shakespeare Festival',        active: true  }],
  ['weathervane',                { label: 'Weathervane Playhouse',            active: true  }],
  ['painting_twist',             { label: 'Painting with a Twist',            active: true  }],
  ['cvart',                      { label: 'CV Art Center',                    active: true  }],
  ['akron_symphony',             { label: 'Akron Symphony',                   active: true  }],
  ['stan_hywet',                 { label: 'Stan Hywet',                       active: true  }],
  ['get_away_with_murder',       { label: 'Get Away With Murder',             active: true  }],
  ['akron_zips',                 { label: 'University of Akron Athletics (Zips)', active: true }],
  ['akron_zoo',                  { label: 'Akron Zoo',                        active: true  }],
  ['hale_farm',                  { label: 'Hale Farm & Village',              active: true  }],
  ['cascade_locks',              { label: 'Cascade Locks',                    active: true  }],
  ['hiho_brewing',               { label: 'HiHO Brewing Co.',                 active: true  }],
  ['crown_point_ecology',        { label: 'Crown Point Ecology Center',       active: true  }],
  ['highland_square',            { label: 'Highland Square (PorchROKR)',      active: true  }],
  ['akron_childrens_museum',     { label: "Akron Children's Museum",          active: true  }],
  ['akron_makerspace',           { label: 'Akron Makerspace',                 active: true  }],
  ['akron_soul_train',           { label: 'Akron Soul Train',                 active: true  }],
  ['southgate_farm',             { label: 'Southgate Farm',                   active: false }],
  ['helens_studio',              { label: "Helen's Ceramic and Art Studio",   active: true  }],
  ['north_hill_cdc',             { label: 'North Hill CDC',                   active: false }],
  ['akron_pride',                { label: 'Akron Pride Festival',             active: true  }],
  ['city_of_barberton',          { label: 'City of Barberton',                active: true  }],
  ['united_way_summit',          { label: 'United Way of Summit & Medina',    active: true  }],
  ['pegs_foundation',            { label: "Peg's Foundation",                 active: true  }],
  ['village_of_mogadore',        { label: 'Village of Mogadore',              active: true  }],
  ['village_of_peninsula',       { label: 'Village of Peninsula',             active: true  }],
  ['music_western_reserve',      { label: 'Music from The Western Reserve',   active: true  }],
  ['fair_housing_akron',         { label: 'Fair Housing Contact Service',     active: true  }],
  ['habitat_summit',             { label: 'Habitat for Humanity Summit',      active: true  }],
  ['ohio_festivals',             { label: 'Ohio Festivals',                   active: true  }],
  ['summit_county_fairgrounds',  { label: 'Summit County Fairgrounds',        active: true  }],
  ['ohio_erie_canalway',         { label: 'Ohio & Erie Canalway',             active: true  }],
  ['akron_roller_derby',         { label: 'Akron Roller Derby',               active: true  }],
  ['cvfm',                       { label: 'Cuyahoga Valley Farmers Market',   active: true  }],
  ['tangier',                    { label: 'Tangier',                          active: true  }],
  ['downtown_cf',                { label: 'Downtown Cuyahoga Falls',          active: true  }],
  ['magic_city_drivein',         { label: 'Magic City Drive-In',              active: true  }],
  ['dilly_ds',                   { label: "Dilly D's Sports Grill",           active: true  }],
  ['old_stone_jail',             { label: 'Old Stone Jail',                   active: true  }],
  ['leadership_akron',           { label: 'Leadership Akron',                 active: true  }],
  ['artisan_coffee',             { label: 'Artisan Coffee',                   active: true  }],
  ['russos',                     { label: "Russo's Restaurant",               active: true  }],
  ['musica',                     { label: 'Musica',                           active: true  }],
  ['akron_urban_league',         { label: 'Akron Urban League',               active: true  }],
  ['the_well_cdc',               { label: 'The Well CDC',                     active: true  }],
  ['better_kenmore',             { label: 'Better Kenmore CDC',               active: true  }],
  ['first_glance',               { label: 'First Glance Student Center',      active: true  }],
  ['jadfa_house',                { label: 'The JADFA House',                  active: true  }],
  ['full_grip_games',            { label: 'Full Grip Games',                  active: true  }],
  ['better_plays_gaming',        { label: 'Better Plays Gaming',              active: true  }],
  ['mustard_seed',               { label: 'Mustard Seed Market & Cafe',       active: true  }],
  ['royal_palace',               { label: 'Royal Palace Akron',               active: true  }],
  ['northfield_park',            { label: 'Northfield Park Racino',           active: true  }],
  ['summit_humane',              { label: 'Humane Society of Summit County',  active: true  }],
  ['stewarts_caring_place',      { label: "Stewart's Caring Place",           active: true  }],
  ['stewarts_partner_events',    { label: "Stewart's Caring Place Partner Events", active: true }],
  ['woven_words',                { label: 'Woven Words Bookshop',             active: true  }],
  ['main_street_barberton',      { label: 'Main Street Barberton',            active: true  }],
  ['wine_mill',                  { label: 'The Wine Mill',                    active: true  }],
  ['portage_lakes_kiwanis',      { label: 'Portage Lakes Kiwanis',            active: true  }],
  ['release_yoga',               { label: 'Release Yoga',                     active: true  }],
  ['life_gurukula',              { label: 'Life Gurukula',                    active: true  }],
  ['torchbearers',               { label: 'Torchbearers',                     active: false }],
  ['indivisible_akron',          { label: 'Indivisible Akron',                active: true  }],
  ['house_three_thirty',         { label: 'House Three Thirty',               active: true  }],
  ['akron_public_schools',       { label: 'Akron Public Schools',             active: true  }],
  ['akron_community_foundation', { label: 'Akron Community Foundation',       active: true  }],
  ['akron_life',                 { label: 'Akron Life',                       active: true  }],
  ['eventbrite',                 { label: 'Eventbrite',                       active: true  }],
  ['ticketmaster',               { label: 'Ticketmaster',                     active: true  }],
  ['visit_akron_cvb',            { label: 'Visit Akron CVB',                  active: true  }],
  ['meetup',                     { label: 'Meetup',                           active: true  }],
  ['akron_rec_parks',            { label: 'Akron Recreation & Parks',         active: true  }],
  ['city_of_akron_lock3',        { label: 'City of Akron (Lock 3)',           active: true  }],
  ['city_of_green',              { label: 'City of Green',                    active: true  }],
  ['city_of_stow',               { label: 'City of Stow',                     active: true  }],
  ['city_of_hudson',             { label: 'City of Hudson',                   active: true  }],
  ['city_of_tallmadge',          { label: 'City of Tallmadge',                active: true  }],
  ['city_of_new_franklin',       { label: 'City of New Franklin',             active: true  }],
  ['city_of_norton',             { label: 'City of Norton',                   active: true  }],
  ['copley_township',            { label: 'Copley Township',                  active: true  }],
  ['springfield_township',       { label: 'Springfield Township',             active: true  }],
  ['village_of_richfield',       { label: 'Village of Richfield',             active: true  }],
  ['city_of_fairlawn',           { label: 'City of Fairlawn',                 active: true  }],
  ['city_of_cuyahoga_falls',     { label: 'City of Cuyahoga Falls',           active: true  }],
  ['akron_marathon',             { label: 'Akron Marathon',                   active: true  }],
  ['akron_promise',              { label: 'Akron Promise',                    active: true  }],
  ['runsignup',                  { label: 'RunSignup',                        active: true  }],
  ['akron_dance_festival',       { label: 'Heinz Poll Dance Festival',        active: true  }],
  ['gather_round_games',         { label: 'Gather Round Games',               active: true  }],
  ['bath_business_assoc',        { label: 'Bath Business Association',        active: true  }],
  ['cvsr',                       { label: 'Cuyahoga Valley Scenic Railroad',  active: true  }],
  ['stow_library',               { label: 'Stow-Munroe Falls Library',        active: true  }],
  ['christ_community_chapel',    { label: 'Christ Community Chapel',          active: true  }],
  ['bath_township',              { label: 'Bath Township',                    active: true  }],
  ['richfield_township',         { label: 'Richfield Township',               active: true  }],
  ['wolf_creek_winery',          { label: 'The Winery at Wolf Creek',         active: true  }],
  ['danos_lakeside',             { label: "Dano's Lakeside Pub",              active: true  }],
  ['hudson_library',             { label: 'Hudson Library & Historical Society', active: true }],
  ['the_grove',                  { label: 'The Grove',                        active: true  }],
  ['barnes_noble_akron',         { label: 'Barnes & Noble Akron',             active: true  }],
  ['city_of_twinsburg',          { label: 'City of Twinsburg',                active: true  }],
  ['lake_campground',            { label: 'The Lake Campground',              active: true  }],
  ['hoppin_frog',                { label: "Hoppin' Frog Brewery",             active: true  }],
  ['peninsula_art_academy',      { label: 'Peninsula Art Academy',            active: true  }],
  ['clutch_lanes',               { label: 'Clutch Lanes',                     active: true  }],
  ['slovene_center',             { label: 'Slovene Performance & Events Center', active: true }],
  ['explore_hudson',             { label: 'Explore Hudson (Chamber)',         active: true  }],
  ['leos_italian_social',        { label: "Leo's Italian Social",             active: true  }],
  ['peninsula_library',          { label: 'Peninsula Library',                active: true  }],
  ['lalas_in_the_lakes',         { label: "Lala's in the Lakes",              active: true  }],
  ['city_of_macedonia',          { label: 'City of Macedonia',                active: true  }],
  ['peninsula_foundation',       { label: 'Peninsula Foundation (G.A.R. Hall)', active: true }],
  ['islamic_society_akron',      { label: 'Islamic Society of Akron & Kent',  active: true  }],
  ['peninsula_coffee_house',     { label: 'Peninsula Coffee House',           active: true  }],
  ['akron_fossils',              { label: 'Akron Fossils & Science Center',   active: true  }],
  ['western_reserve_playhouse',  { label: 'Western Reserve Playhouse',        active: true  }],
  ['tiki_underground',           { label: 'Tiki Underground',                 active: true  }],
  ['hudson_bandstand',           { label: 'Hudson Bandstand',                 active: true  }],
  ['learned_owl',                { label: 'The Learned Owl Book Shop',        active: true  }],
  ['rock_mill',                  { label: 'Rock Mill Climbing',               active: true  }],
  ['beaus_on_the_river',         { label: "Beau's on the River",              active: true  }],
  ['raintree_golf',              { label: 'Raintree Golf & Event Center',     active: true  }],
  ['village_of_reminderville',   { label: 'Village of Reminderville',         active: true  }],
  ['bath_richfield_kiwanis',     { label: 'Bath Richfield Kiwanis',           active: false }],
  ['village_of_northfield',      { label: 'Village of Northfield',            active: true  }],
  ['750ml_wines',                { label: '750ml Wines',                      active: true  }],
  ['akron_power_squadron',       { label: 'Akron Sail & Power Squadron',      active: true  }],
  ['village_of_clinton',         { label: 'Village of Clinton',               active: true  }],
  ['akron_ymca',                 { label: 'Akron Area YMCA',                  active: true  }],
  ['cfalls_natatorium',          { label: 'The Natatorium (Cuyahoga Falls)',  active: true  }],
  ['heritage_farms',             { label: 'Heritage Farms',                   active: true  }],
  ['jewish_akron',               { label: 'Jewish Akron',                     active: true  }],
  ['longwood_manor',             { label: 'Longwood Manor Historical Society', active: true }],
  ['west_side_gymnastics',       { label: 'West Side Gymnastics',             active: true  }],
])

/** The single validation gate for the `scraper_name` slot. */
export function isKnownScraper(name: string): boolean {
  return SCRAPER_REGISTRY.has(name)
}

/** Display label for a key, falling back to the key so a caller cannot get `undefined`. */
export function scraperLabel(name: string): string {
  return SCRAPER_REGISTRY.get(name)?.label ?? name
}

/**
 * Find a registry key named anywhere in the normalised text.
 *
 * Matches against the key, the key with underscores as spaces, and the
 * lowercased label. LONGEST MATCH WINS, which is the whole reason this is a
 * scan rather than a regex: `highland_square` is a prefix of
 * `highland_square_theatre`, and "how did highland square theatre do" must not
 * resolve to the PorchROKR scraper. Sorting by candidate length descending is
 * what makes the resolution deterministic instead of Map-insertion-ordered.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function extractScraperName(text: string): string | null {
  let best: { key: string; length: number } | null = null
  for (const [key, entry] of SCRAPER_REGISTRY) {
    const candidates = [key, key.replaceAll('_', ' '), entry.label.toLowerCase()]
    for (const candidate of candidates) {
      if (candidate.length < 4) continue
      // WORD BOUNDARIES, not `includes`. A bare substring test routes "how are
      // the musicals doing" to the `musica` scraper, and there are 156 keys,
      // so the odds of some key sitting inside an ordinary English word are
      // not small. `\b` is wrong here because several candidates end in a
      // non-word character (`blu jazz+`), so the guards are explicit
      // character-class lookarounds instead.
      const bounded = new RegExp(`(?<![a-z0-9])${escapeRegex(candidate)}(?![a-z0-9])`)
      if (!bounded.test(text)) continue
      if (!best || candidate.length > best.length) best = { key, length: candidate.length }
    }
  }
  return best?.key ?? null
}

// ── The venue slot ────────────────────────────────────────────────────────

/** Window vocabulary that must be peeled off the tail of a captured venue name. */
const TRAILING_WINDOW = new RegExp(
  `\\s+(?:${[
    'tonight', 'tonite', 'this evening', 'today', 'tomorrow', 'tomorow', 'tmrw', 'tmr',
    'yesterday', 'this weekend', 'next weekend', 'last weekend', 'the weekend', 'weekend',
    'this week', 'next week', 'last week', 'this month', 'next month', 'last month',
    `(?:next|coming|upcoming|last|past)\\s+${NUM}\\s*(?:days?|d)`,
    `(?:${MONTH_ALT})(?:\\s+\\d{1,2})?`,
    '\\d{4}-\\d{2}-\\d{2}', '\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?',
  ].join('|')})\\s*$`,
)

/**
 * Pull a venue name out of "what's on at the rialto this weekend".
 *
 * Returns a SEARCH TERM, never a SQL fragment: handlers pass it to an `ilike`
 * filter as a bound value, and `sanitizeVenueQuery` strips the wildcard
 * metacharacters so a user typing `%` cannot widen their own query into a
 * table scan.
 */
export function extractVenueQuery(text: string): string | null {
  // RIGHT-anchored. A leftmost regex match on `\bat\s+(.{2,60})$` takes the
  // FIRST "at" in the sentence, so "look at whats on at musica" yields
  // "whats on at musica" as the venue. The venue is always after the LAST
  // "at", so the search runs from the right.
  const marker = ' at '
  const idx = text.lastIndexOf(marker)
  const from = idx !== -1 ? idx + marker.length : (text.startsWith('at ') ? 3 : -1)
  if (from === -1) return null
  let term = text.slice(from).trim()
  if (term.length < 2 || term.length > 60) return null
  // Peel trailing window phrases, possibly more than one ("at musica this weekend").
  for (let i = 0; i < 3; i++) {
    const stripped = term.replace(TRAILING_WINDOW, '')
    if (stripped === term) break
    term = stripped.trim()
  }
  term = term.replace(/^(the)\s+/, '').trim()
  return term.length >= 2 ? term : null
}

/**
 * Neutralise LIKE metacharacters and PostgREST's own value separators.
 *
 * `%` and `_` are LIKE wildcards; leaving them in lets a question widen its
 * own match to every row. Commas and parentheses are PostgREST filter-value
 * separators. Everything else outside a conservative allowlist becomes a
 * space. The result is a plain search term, capped, that the handler wraps in
 * its own `%…%`.
 */
export function sanitizeVenueQuery(term: string): string {
  return term
    .replace(/[%_(),*]/g, ' ')
    .replace(/[^a-z0-9'&.\- ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

// ══════════════════════════════════════════════════════════════════════════
// 3. THE RULE TABLE
// ══════════════════════════════════════════════════════════════════════════

interface Rule {
  readonly name: string
  readonly handlerId: HandlerId
  readonly test: (text: string, now: Date) => HandlerParams | null
}

// Shared vocabulary, named once so the rules read as English and a phrasing
// added here reaches every rule that uses it.
/**
 * Two tiers of scraper vocabulary, and the split is load-bearing.
 *
 * `sources?` is genuinely ambiguous in this product: "which sources are
 * failing" is an ops question, "events by source" is a content breakdown. So
 * the weak set (which includes it) gates the ops rules that ALSO require
 * failure/zero/stale vocabulary, where the ambiguity cannot bite, while the
 * scraper_health_summary CATCH-ALL at position 8 requires the strong set.
 * Without that split, "events by source" is answered with a health report.
 */
const SCRAPER_WORD_STRONG = /\b(scrapers?|scrapes?|scraping|scraped|crawlers?|feeds?|ingest(ion)?|pipeline)\b/
const SCRAPER_WORD = /\b(scrapers?|scrapes?|scraping|scraped|crawlers?|feeds?|sources?|ingest(ion)?|pipeline)\b/
const FAIL_WORD = /\b(fail(s|ed|ing|ure|ures)?|error(s|ed|ing)?|broke|broken|busted|down|dead|red|erroring|not working|problems?)\b/
// `sessions?` is in here because in this product a session is a yoga class or
// a story time, not a web analytics session. See ANALYTICS_WEAK below.
const EVENT_WORD = /\b(events?|shows?|gigs?|concerts?|sessions?|classes|workshops?|things to do|whats on|what is on|whats happening|whats going on|happening|going on|calendar|listings?)\b/
const COUNT_WORD = /\b(how many|count|number of|total|totals)\b/

/**
 * Analytics vocabulary, split three ways because the tokens behave differently.
 *
 * TRAFFIC_WORD has no other meaning in this product, so it routes to a traffic
 * handler unconditionally. `views` is here deliberately: nothing on Akron Pulse
 * is measured in views except web traffic.
 *
 * `sessions` is the exception and the reason WEAK exists. Release Yoga and the
 * libraries run sessions, and "how many sessions at the library" is an events
 * question. It only routes to traffic when an analytics context word is present
 * ("web sessions", "ga4 sessions"), and EVENT_WORD includes `sessions?` so the
 * events path picks it up otherwise.
 *
 * GENERIC is the "what do the analytics say" case: no metric named, so the
 * traffic overview is the right default.
 */
const TRAFFIC_WORD =
  /\b(page ?views?|pageviews|views|viewed|traffic|visitors?|visits|visited|audience|readers?|unique users|users online)\b/
const ANALYTICS_WEAK = /\bsessions?\b/
const ANALYTICS_CONTEXT = /\b(site|website|web|page|pages|app|ga4|analytics|google|traffic|visitors?)\b/
const ANALYTICS_GENERIC = /\b(ga4|google analytics|analytics)\b/

/**
 * Nouns that make a superlative somebody else's question.
 *
 * Used by the three broad analytics rules. "most visited venues this month"
 * carries `visited`, which is traffic vocabulary, so without this the
 * traffic_overview catch-all answers a venue ranking with a site-wide view
 * count. top_pages needs the same guard for the same reason, and sharing one
 * list means the two cannot drift.
 */
const NON_PAGE_NOUN =
  /\b(venues?|orgs?|organi[sz]ations?|organi[sz]ers?|categor(y|ies)|neighbou?rhoods?|areas?|sources?|scrapers?)\b/
const SUPERLATIVE = /\b(top|most|busiest|biggest|popular|which)\b/

/** A ranking question about something that is not a page. Hand it down. */
const ranksANonPageNoun = (t: string): boolean => SUPERLATIVE.test(t) && NON_PAGE_NOUN.test(t)

/** True when the message is asking about web analytics at all. */
const isAnalyticsQuestion = (t: string): boolean =>
  TRAFFIC_WORD.test(t) || ANALYTICS_GENERIC.test(t) ||
  (ANALYTICS_WEAK.test(t) && ANALYTICS_CONTEXT.test(t))

/**
 * The analytics that are STILL not stored, after migration 062 mirrored six
 * GA4 reports into Postgres.
 *
 * Split for the same reason as everything else in this file: one half is
 * unambiguous, the other half is made of ordinary English words.
 *
 * STRONG fires on its own. Nothing on Akron Pulse is called a referrer, an
 * acquisition, a bounce rate or an impression except in a GA4 sense. Note what
 * is NOT here: `clickthrough` and `ctr` USED to mean "unavailable" and now mean
 * outbound clicks, which are stored, so they moved to the outbound rule.
 * `bounce` on its own is also absent -- a bounced email is a real thing in this
 * product and belongs to the digest.
 *
 * CONTEXTUAL needs an analytics word alongside it, because `channel` is a
 * Slack channel, `city` is where an event is, and "what's happening right now"
 * is a calendar question.
 */
const UNSUPPORTED_STRONG =
  /\b(referrers?|referrals?|acquisition|utm|bounce rate|conversions?|conversion rate|session duration|time on (page|site)|engagement rate|impressions|search console|organic search|seo|devices?|mobile vs desktop|real ?time)\b/
const UNSUPPORTED_CONTEXTUAL =
  /\b(channels?|mobile vs|vs desktop|browsers?|cit(y|ies)|geograph(y|ic|ical)|countr(y|ies)|live users|right now|come from|coming from|came from)\b/

/**
 * Windows that look BACKWARD. Used by the events-added-recently rule to tell
 * "added in the last 24 hours" (an ingestion question, stays) from "any new
 * events this weekend" (a calendar question, falls through to
 * events_in_window so the weekend is not silently dropped).
 *
 * `today` counts as backward here: "anything new today" means added today.
 */
const BACKWARD_WINDOWS: ReadonlySet<string> = new Set([
  'today',
  'yesterday',
  'last_night',
  'last_days',
  'last_hours',
])

const windowOr = (text: string, now: Date, fallback: () => TimeWindow): TimeWindow =>
  parseWindow(text, now) ?? fallback()

const nextDaysWindow = upcomingWindow

/**
 * ══════════════════════════════════════════════════════════════════════════
 * ORDER IS THE DISAMBIGUATION MECHANISM. FIRST MATCH WINS.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Ambiguous input resolves by position, deterministically, and each position
 * below is a decision rather than an accident:
 *
 *  1-7 THE ANALYTICS BLOCK, and it stays at the top for the reason the old
 *     single veto did: "how many page views this week" contains "this week"
 *     and would otherwise be answered by events_in_window with a confidently
 *     wrong number. What changed with migration 062 is that six of these
 *     questions now have real answers, so the block is a ROUTER rather than a
 *     refusal.
 *
 *     1  analytics_unavailable first, because it is the narrowest: it fires
 *        only on the analytics this build still does not store (referrers,
 *        devices, bounce rate, anything real-time). Above the answerable
 *        rules, so "traffic by referrer" is refused rather than answered as
 *        plain traffic, which would silently drop the half of the question
 *        that cannot be met.
 *     2  pwa_installs, on install vocabulary. Narrow and unambiguous.
 *     3  embed_traffic, ABOVE embed_requests_count (14): "embed traffic" is a
 *        GA4 question and "embed requests" is a business one, and the rule
 *        hands anything containing `request` down so the pair separate on the
 *        word that actually distinguishes them.
 *     4  top_pages, which hands DOWN whenever the superlative is attached to
 *        venues, orgs, categories, neighbourhoods or sources, so "most
 *        popular venues" still reaches top_venues (20).
 *     5  outbound_clicks. `clickthrough` and `ctr` route here now: on this
 *        site the clickthrough IS the outbound click.
 *     6  traffic_trend before traffic_overview, because a comparison question
 *        is the more specific of the two and both match the same vocabulary.
 *     7  traffic_overview, the family catch-all.
 *
 *  8  scraper_last_run needs BOTH a registry key and scraper vocabulary. It
 *     sits above events_at_venue because "akron_civic" is simultaneously a
 *     scraper key and a venue name; requiring scraper vocabulary here and
 *     event vocabulary there means "when did akron civic last run" and
 *     "what's on at akron civic" separate cleanly instead of racing.
 *
 *  9-14 the specific ops questions, each gated on a distinguishing keyword,
 *     ending with scraper_health_summary as the family catch-all so a bare
 *     "scrapers?" still lands somewhere useful. last_night_totals (13) hands
 *     the question DOWN when an event word is present and no scraper word is,
 *     so "how many events last night" reaches events_in_window with the
 *     last_night window instead of being answered with run counts.
 *
 *  15 status_summary is ANCHORED to whole-message phrasings ("status",
 *     "what's broken", "all good"). Unanchored, a bare `\bstatus\b` would
 *     swallow "subscriber status" and "embed request status". Anchoring is
 *     what lets the most-used handler sit high in the list without stealing
 *     from the specific ones below it.
 *
 *  16-21 the site-business questions. digest_status precedes
 *     subscriber_counts because "did the newsletter go out" mentions the
 *     newsletter but is not a subscriber-count question. partner_orgs_count
 *     (21) hands "top partner organizations" DOWN to top_organizations,
 *     because a superlative makes it a ranking question, not a headcount.
 *
 *  22-31 the event breakdowns, every one gated on an explicit "by X" /
 *     "top X" / "missing X" phrase. featured_events (30) accepts only
 *     vocabulary that names the editorial FLAG, and events_added_recently
 *     (31) hands the question down whenever the window looks forward, so
 *     neither can swallow a window and answer about the wrong thing.
 *
 *  32 events_in_window is LAST among the event rules, on purpose. It is the
 *     broadest ("anything with an event word or a bare window phrase"), so
 *     any earlier event rule that also matches is by definition more
 *     specific and should win.
 *
 * Adding a rule: put it above everything broader than it, below everything
 * narrower, and add a case to intent.test.ts proving the pair it could race.
 */
export const RULES: readonly Rule[] = Object.freeze([
  {
    name: 'analytics-unsupported',
    handlerId: 'analytics_unavailable',
    test: (t) => {
      if (UNSUPPORTED_STRONG.test(t)) return {}
      if (UNSUPPORTED_CONTEXTUAL.test(t) && isAnalyticsQuestion(t)) return {}
      return null
    },
  },
  {
    name: 'pwa-installs',
    handlerId: 'pwa_installs',
    test: (t, now) => {
      if (
        !/\b(installs?|installed|install base|downloads?|downloaded|home ?screen|standalone|pwa)\b/.test(t) &&
        // Bare stems included: "how many people USE the app" is the plural
        // subject form and is the phrasing a person actually types. Without
        // it that question fell through to events_in_window and came back
        // with a count of published events in the next seven days, which is
        // the exact wrong-number failure the analytics block sits first to
        // prevent.
        !/\b(use|using|uses|used|open|opens|opened|opening|installed) the app\b/.test(t) &&
        !/\bapp users?\b/.test(t)
      ) {
        return null
      }
      return { window: parseWindow(t, now) ?? undefined }
    },
  },
  {
    name: 'embed-traffic',
    handlerId: 'embed_traffic',
    test: (t, now) => {
      if (!/\bembeds?\b|\bembedded\b|\bembedding\b|\bwidgets?\b|\bpartner sites?\b/.test(t)) return null
      // "how many embed requests" is a business question and belongs to
      // embed_requests_count, which sits further down. The word `request` is
      // what separates the pair, so it is checked before anything else.
      if (/\brequests?\b/.test(t)) return null
      if (
        !isAnalyticsQuestion(t) &&
        !/\bhosts?\b|\bwho embeds\b|\bwhich sites?\b|\bwhat sites?\b/.test(t)
      ) {
        return null
      }
      return { window: parseWindow(t, now) ?? undefined }
    },
  },
  {
    name: 'top-pages',
    handlerId: 'top_pages',
    test: (t, now) => {
      if (
        !/\btop pages?\b|\bmost[- ]?(viewed|read|popular)\b|\bbest pages?\b|\bpopular pages?\b|\bmost views\b|\bwhich pages?\b|\bpage ranking\b/
          .test(t)
      ) {
        return null
      }
      // A superlative attached to something that is NOT a page is somebody
      // else's question. Without this, "most popular venues" is answered with
      // a list of URLs and top_venues never gets a chance.
      if (NON_PAGE_NOUN.test(t)) return null
      return { window: parseWindow(t, now) ?? undefined }
    },
  },
  {
    name: 'outbound-clicks',
    handlerId: 'outbound_clicks',
    test: (t, now) =>
      /\boutbound\b|\bclick ?throughs?\b|\bclicked? (out|through|off)\b|\bclicks?\b|\bctr\b|\bticket links?\b|\bhandoffs?\b|\bsent (people|users|them|anyone) (to|off)\b/
        .test(t)
        ? { window: parseWindow(t, now) ?? undefined }
        : null,
  },
  {
    name: 'traffic-trend',
    handlerId: 'traffic_trend',
    test: (t, now) => {
      if (!isAnalyticsQuestion(t) || ranksANonPageNoun(t)) return null
      if (
        !/\b(vs|versus|compared? (to|with)|comparison|trend(ing|s)?|up or down|growing|growth|better than|worse than|week over week|month over month)\b/
          .test(t)
      ) {
        return null
      }
      return { window: parseWindow(t, now) ?? undefined }
    },
  },
  {
    name: 'traffic-overview',
    handlerId: 'traffic_overview',
    // Hands DOWN a ranking of something that is not a page. `visited` is
    // traffic vocabulary, so "most visited venues this month" reaches here
    // and would otherwise be answered with a site-wide view count.
    test: (t, now) =>
      isAnalyticsQuestion(t) && !ranksANonPageNoun(t)
        ? { window: parseWindow(t, now) ?? undefined }
        : null,
  },
  {
    name: 'scraper-last-run',
    handlerId: 'scraper_last_run',
    test: (t) => {
      const name = extractScraperName(t)
      if (!name) return null
      if (!SCRAPER_WORD.test(t) && !/\b(last ran|last run|ran|run|when did|health|doing|status|ok|okay)\b/.test(t)) {
        return null
      }
      if (EVENT_WORD.test(t) && /\bat\b/.test(t) && !SCRAPER_WORD.test(t)) return null
      return { scraperName: name }
    },
  },
  {
    name: 'scrapers-failing',
    handlerId: 'scrapers_failing',
    test: (t) => (SCRAPER_WORD.test(t) && FAIL_WORD.test(t) ? {} : null),
  },
  {
    name: 'scrapers-zero-events',
    handlerId: 'scrapers_zero_events',
    test: (t) =>
      SCRAPER_WORD.test(t) && /\b(zero|0|no events|nothing|empty|blank|returned nothing|came back empty)\b/.test(t)
        ? {}
        : null,
  },
  {
    name: 'scrapers-stale',
    handlerId: 'scrapers_stale',
    test: (t) => {
      if (!SCRAPER_WORD.test(t)) return null
      if (!/\b(stale|havent run|hasnt run|have not run|has not run|not run|no run|silent|gone quiet|quiet|missing|dormant|asleep)\b/.test(t)) {
        return null
      }
      return { days: parseDays(t) ?? 2 }
    },
  },
  {
    name: 'scraper-registry-coverage',
    handlerId: 'scraper_registry_coverage',
    test: (t) =>
      /\b(how many scrapers|how many sources|total scrapers|scraper count|number of scrapers|all the scrapers|registry)\b/
        .test(t)
        ? {}
        : null,
  },
  {
    name: 'last-night-totals',
    handlerId: 'last_night_totals',
    test: (t) => {
      if (
        !/\b(last night|lastnight|overnight|last nights?|nightly run|nights? haul|how did the scrape go|hows? the scrape go)\b/
          .test(t)
      ) {
        return null
      }
      // "how many events were on last night" is a CALENDAR question that
      // happens to contain ops vocabulary. Falling through lets
      // events_in_window answer it with the last_night window, which is the
      // only phrasing that reaches that window at all. "how did last night
      // go" and "overnight totals" carry no event word and still land here.
      if (EVENT_WORD.test(t) && !SCRAPER_WORD.test(t)) return null
      return {}
    },
  },
  {
    name: 'scraper-health-summary',
    handlerId: 'scraper_health_summary',
    // STRONG only. See the SCRAPER_WORD_STRONG comment: this is the family
    // catch-all, so it must not claim "events by source" or "top sources".
    test: (t) => (SCRAPER_WORD_STRONG.test(t) ? {} : null),
  },
  {
    name: 'status-summary',
    handlerId: 'status_summary',
    test: (t) =>
      /^(status|sitrep|sit rep|whats up|hows it going|hows everything|how are we|how are we doing|all good|everything ok|everything okay|everything fine|any problems|anything wrong|any issues|whats broken|what is broken|anything broken|anything on fire|health|health check|sup)$/
        .test(t) ||
        /\b(whats broken|what is broken|anything broken|anything on fire|anything wrong|is anything broken|what needs attention|what should i look at)\b/
          .test(t)
        ? {}
        : null,
  },
  {
    name: 'review-queue',
    handlerId: 'review_queue',
    test: (t) =>
      /\b(review queue|needs review|need review|needing review|awaiting review|pending review|to review|moderation queue|queue depth|flagged events?)\b/
        .test(t)
        ? {}
        : null,
  },
  {
    name: 'digest-status',
    handlerId: 'digest_status',
    test: (t) =>
      /\b(digest|newsletter|email send|email sends|emails? go out|emails? went out|emails? sent|did the email|did the digest|did the newsletter|send-?digest)\b/
        .test(t)
        ? { days: parseDays(t) ?? 2 }
        : null,
  },
  {
    name: 'subscriber-counts',
    handlerId: 'subscriber_counts',
    test: (t) =>
      /\b(subscribers?|subs|sign ?ups?|signed up|mailing list|email list|list size)\b/.test(t)
        ? { days: parseDays(t) ?? 7 }
        : null,
  },
  {
    name: 'feedback-recent',
    handlerId: 'feedback_recent',
    test: (t) => (/\bfeedback\b|\bbug reports?\b|\bsuggestions?\b/.test(t) ? { days: parseDays(t) ?? 7 } : null),
  },
  {
    name: 'embed-requests',
    handlerId: 'embed_requests_count',
    test: (t) => (/\bembeds?\b|\bembedded\b|\bembed requests?\b|\bwidget requests?\b/.test(t) ? {} : null),
  },
  {
    name: 'partner-orgs',
    handlerId: 'partner_orgs_count',
    test: (t) => {
      if (!/\bpartners?\b/.test(t)) return null
      // "top partner organizations" is a ranking question that happens to say
      // "partner", not a question about how many partners exist. Superlatives
      // hand it down to top_organizations.
      if (/\b(top|busiest|biggest|which|most)\s+partner/.test(t)) return null
      return {}
    },
  },
  {
    name: 'events-at-venue',
    handlerId: 'events_at_venue',
    test: (t, now) => {
      if (!EVENT_WORD.test(t) && !/^whats at\b/.test(t)) return null
      const raw = extractVenueQuery(t)
      if (!raw) return null
      const venueQuery = sanitizeVenueQuery(raw)
      if (venueQuery.length < 2) return null
      return { venueQuery, window: windowOr(t, now, () => nextDaysWindow(now, 30)) }
    },
  },
  {
    name: 'events-by-source',
    handlerId: 'events_by_source',
    test: (t, now) =>
      /\b(by source|per source|source breakdown|breakdown by source|which sources?|top sources?|sources? breakdown|where.{0,20}from)\b/
        .test(t)
        ? { window: windowOr(t, now, () => nextDaysWindow(now, 30)) }
        : null,
  },
  {
    name: 'events-by-category',
    handlerId: 'events_by_category',
    test: (t, now) =>
      /\b(by category|per category|category breakdown|breakdown by category|which categor(y|ies)|top categor(y|ies)|categor(y|ies) breakdown|by type)\b/
        .test(t)
        ? { window: windowOr(t, now, () => nextDaysWindow(now, 30)) }
        : null,
  },
  {
    name: 'events-by-neighborhood',
    handlerId: 'events_by_neighborhood',
    test: (t, now) =>
      /\b(by (neighbou?rhood|area|community|part of town)|per (neighbou?rhood|area)|(neighbou?rhood|area) breakdown|which (neighbou?rhoods?|areas?)|top (neighbou?rhoods?|areas?)|where in akron)\b/
        .test(t)
        ? { window: windowOr(t, now, () => nextDaysWindow(now, 30)) }
        : null,
  },
  {
    name: 'top-venues',
    handlerId: 'top_venues',
    test: (t, now) =>
      /\b(top venues?|busiest venues?|which venues?|most (popular|visited) venues?|most events.{0,20}venues?|venues?.{0,20}most events|biggest venues?)\b/
        .test(t)
        ? { window: windowOr(t, now, () => nextDaysWindow(now, 30)) }
        : null,
  },
  {
    name: 'top-organizations',
    handlerId: 'top_organizations',
    test: (t, now) =>
      // `.{0,20}` between the superlative and the noun so "top partner
      // organizations" and "which local orgs" both land here.
      /\b(top|busiest|biggest|which)\b.{0,20}\b(orgs?|organi[sz]ations?|organi[sz]ers?)\b|\b(most events.{0,20}orgs?|orgs?.{0,20}most events)\b/
        .test(t)
        ? { window: windowOr(t, now, () => nextDaysWindow(now, 30)) }
        : null,
  },
  {
    name: 'events-missing-image',
    handlerId: 'events_missing_image',
    test: (t, now) =>
      /\b(missing|without|no|lacking|need|needs|needing)\b.{0,20}\b(images?|photos?|pictures?|thumbnails?|artwork|art)\b/
        .test(t) || /\bimageless\b|\bno art\b/.test(t)
        ? { window: windowOr(t, now, () => nextDaysWindow(now, 30)) }
        : null,
  },
  {
    name: 'free-vs-paid',
    handlerId: 'free_vs_paid',
    test: (t, now) =>
      /\b(free vs paid|free versus paid|free or paid|free\/paid|price split|paid vs free|how many.{0,20}free|free events?|ticketed|free stuff)\b/
        .test(t)
        ? { window: windowOr(t, now, () => nextDaysWindow(now, 30)) }
        : null,
  },
  {
    name: 'featured-events',
    handlerId: 'featured_events',
    // `big events` and `highlights` are DELIBERATELY not here. `featured` is a
    // manual editorial flag with two rows in the whole table and none of them
    // upcoming, so "what are the big events this weekend" answered by this
    // handler returns "No featured events upcoming" and drops the weekend
    // entirely: fluent, confident, and wrong, which is the failure the ADR
    // spends section 3 warning about. Those phrasings belong to
    // events_in_window. Only vocabulary that names the FLAG routes here.
    test: (t) =>
      /\b(featured|marquee|headliners?|headline events?|spotlight)\b/.test(t) ? {} : null,
  },
  {
    name: 'events-added-recently',
    handlerId: 'events_added_recently',
    test: (t, now) => {
      if (
        !/\b(added|newly added|new events?|whats new|what is new|anything new|came in|ingested|imported|created|fresh)\b/
          .test(t)
      ) {
        return null
      }
      // A FORWARD-looking window means the question is about a future span
      // rather than about ingestion recency. "any new events this weekend"
      // must keep the weekend, so it falls through to events_in_window.
      // Backward-looking windows ("added in the last 24 hours", "anything new
      // today") are exactly this handler's question and stay.
      const w = parseWindow(t, now)
      if (w && !BACKWARD_WINDOWS.has(w.kind)) return null
      return { days: parseDays(t) ?? (w?.kind === 'yesterday' ? 2 : 1) }
    },
  },
  {
    name: 'events-in-window',
    handlerId: 'events_in_window',
    test: (t, now) => {
      const window = parseWindow(t, now)
      if (EVENT_WORD.test(t) || COUNT_WORD.test(t)) {
        return { window: window ?? nextDaysWindow(now, 7) }
      }
      // A bare window phrase and nothing else ("tonight", "this weekend") is
      // the terse form Byron actually types on a phone. Only accept it when
      // the window is essentially the whole message, so "last week's digest"
      // does not get read as an event count.
      if (window && t.split(' ').length <= 3) return { window }
      return null
    },
  },
])

/**
 * The single entry point. Always returns a handler id: a miss is `no_match`,
 * which is a real handler that renders the menu, so the caller has no null
 * branch to forget and the bot has no silent dead end.
 */
export function matchIntent(rawText: string, now: Date = new Date()): IntentMatch {
  const normalized = normalizeQuestion(rawText)
  for (const rule of RULES) {
    const params = rule.test(normalized, now)
    if (params) return { handlerId: rule.handlerId, params, rule: rule.name, normalized }
  }
  return { handlerId: 'no_match', params: {}, rule: 'fallback', normalized }
}
