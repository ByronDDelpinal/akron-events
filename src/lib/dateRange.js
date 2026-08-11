// @ts-check
import { easternDateKey, easternIsoAt } from './easternDate.ts'

/**
 * Resolve a named date-range preset into inclusive [start, end] Date bounds.
 *
 * Shared by useEvents and useMapEvents so the list and map views stay in sync.
 * `now` is injectable so the weekday-boundary logic is unit-testable without
 * mocking the clock.
 *
 * Every boundary resolves in AMERICA/NEW_YORK, not the viewer's local
 * timezone. Previously this file computed with viewer-local getters
 * (`now.getDay()`, `setHours`), so a visitor in Denver clicking "Today" got
 * Denver's today -- fixed 2026-08-10 as part of the "When" filter design.
 * `todayKey` below is the Eastern calendar date; every other date this
 * function touches is derived from it by pure calendar-key arithmetic (never
 * the wall clock), then converted to a real instant with `easternIsoAt`.
 *
 * Weekend semantics: "this weekend" runs Friday 4pm -> end of Sunday (Friday
 * night counts -- people want to go out). When the query runs *during* the
 * weekend (Fri evening through Sun) it anchors to the current weekend rather
 * than skipping a week ahead; the caller's `start_at >= now` filter trims the
 * part that's already past. No roll-forward once Sunday's window is nearly
 * exhausted -- see docs note in whenFilter.ts. "this week" (legacy, no chip
 * -- see whenFilter.ts) runs from today through the coming Sunday (today,
 * when today is already Sunday). "next_7_days" is today through today+6, i.e.
 * seven calendar days INCLUDING today, not today+7.
 *
 * @param {string} dateRange  One of 'today' | 'tomorrow' | 'this_weekend' |
 *   'next_7_days' | 'this_month' | 'this_week' (legacy).
 * @param {Date} [now]        Reference instant; defaults to the current time.
 * @returns {{ start: Date, end: Date }}
 */
export function dateRangeBounds(dateRange, now = new Date()) {
  const todayKey = easternDateKey(now)

  if (dateRange === 'today') {
    return dayBounds(todayKey)
  }
  if (dateRange === 'tomorrow') {
    return dayBounds(addDaysToKey(todayKey, 1))
  }
  if (dateRange === 'this_weekend') {
    const dow = dayOfWeekOfKey(todayKey) // 0 = Sun … 6 = Sat
    // Offset to this weekend's Friday. Sat/Sun fall *inside* the weekend, so
    // their Friday is in the past (−1, −2); Mon–Fri point to the upcoming Friday.
    const daysToFri =
      dow === 6 ? -1 :
      dow === 0 ? -2 :
      5 - dow
    const friKey = addDaysToKey(todayKey, daysToFri)
    const sunKey = addDaysToKey(friKey, 2)
    return {
      start: new Date(easternIsoAt(friKey, '16:00:00')), // Friday 4pm — Friday night counts
      end: endOfDay(sunKey),
    }
  }
  if (dateRange === 'next_7_days') {
    return {
      start: new Date(easternIsoAt(todayKey, '00:00:00')),
      end: endOfDay(addDaysToKey(todayKey, 6)),
    }
  }
  // COMPATIBILITY GHOST -- 'this_week' has no chip anywhere in the UI (see
  // filterOptions.ts's WHEN_PRESETS `ghost: true` entry and its comment) and
  // the embed builder no longer offers it (EmbedBuilderPage.tsx). It is kept
  // here, handled, and VALID forever because a partner embed minted before
  // 2026-08-10 may still carry `date=this_week` in its iframe src and must
  // keep resolving. Do not delete this branch when "cleaning up" this file.
  if (dateRange === 'this_week') {
    const dow = dayOfWeekOfKey(todayKey)
    // Days remaining until Sunday; 0 when today is already Sunday (the end of
    // the week) so the window doesn't roll a full week forward.
    const daysToSun = (7 - dow) % 7
    return {
      start: new Date(easternIsoAt(todayKey, '00:00:00')),
      end: endOfDay(addDaysToKey(todayKey, daysToSun)),
    }
  }
  if (dateRange === 'this_month') {
    return {
      start: new Date(easternIsoAt(todayKey, '00:00:00')),
      end: endOfDay(lastDayOfMonthKey(todayKey)),
    }
  }

  // Unknown/absent preset — an unmodified now-to-now window, matching the
  // pre-rewrite behavior. Callers gate on `dateRange` being truthy before
  // calling this, so this branch is only reached by an unrecognized string.
  return { start: new Date(now), end: new Date(now) }
}

/** @param {string} key */
function dayBounds(key) {
  return {
    start: new Date(easternIsoAt(key, '00:00:00')),
    end: endOfDay(key),
  }
}

/** @param {string} key */
function endOfDay(key) {
  // easternIsoAt only accepts whole seconds; add the trailing .999 in real
  // instant-space afterward rather than teaching it milliseconds for one caller.
  return new Date(Date.parse(easternIsoAt(key, '23:59:59')) + 999)
}

/** @param {number} n */
const pad2 = (n) => String(n).padStart(2, '0')

/**
 * Add `n` calendar days to a `'YYYY-MM-DD'` key, returning a new key.
 * Pure UTC-anchored arithmetic on an explicit Y/M/D triple -- never reads
 * the clock or the viewer's timezone, so this is safe calendar-key math, not
 * the wall-clock trap `scripts/tests/test-no-utc-today.js` guards against.
 * @param {string} ymd
 * @param {number} n
 */
function addDaysToKey(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}

/** Day of week (0 = Sun … 6 = Sat) of a `'YYYY-MM-DD'` key. Same UTC-anchored,
 * clock-independent technique as `addDaysToKey`.
 * @param {string} ymd */
function dayOfWeekOfKey(ymd) {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** The last day of the calendar month containing `'YYYY-MM-DD'` key `ymd`,
 * as a `'YYYY-MM-DD'` key. Day 0 of the next month is the last day of this one.
 * @param {string} ymd */
function lastDayOfMonthKey(ymd) {
  const [y, m] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m, 0))
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}
