/**
 * lib/weekly-occurrences.js
 *
 * Generate upcoming occurrence dates for "every <weekday> at <time>" events
 * whose source page states a standing schedule but publishes no per-date
 * listings (bar trivia nights, weekly live-music series, open mics).
 *
 * The footgun this exists to avoid (see the Delight Nights off-by-one):
 * computing "today" with local Date methods and then calling toISOString()
 * rolls evening-Eastern runs forward a day, because the process clock is UTC
 * in CI. All calendar math here is anchored to the America/New_York date via
 * Intl, then advanced with pure UTC date arithmetic — never local getters
 * mixed with toISOString().
 *
 * Usage:
 *   import { nextWeeklyOccurrences, WEEKDAY } from './lib/weekly-occurrences.js'
 *   const dates = nextWeeklyOccurrences(WEEKDAY.wednesday, { count: 8 })
 *   // → ['2026-07-15', '2026-07-22', …]  (YYYY-MM-DD, Eastern calendar dates)
 *
 * Pair each date with the stated clock time via easternToIso(ymd, '7:00 pm').
 */

/** JS Date weekday numbering, named for readable call sites. */
export const WEEKDAY = Object.freeze({
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
  thursday: 4, friday: 5, saturday: 6,
})

const ET_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
})

/** The current calendar date in America/New_York as 'YYYY-MM-DD'. */
export function easternTodayYmd(now = new Date()) {
  return ET_DATE_FMT.format(now)
}

/**
 * The next `count` calendar dates (Eastern) falling on `weekday`.
 *
 * @param {number} weekday — 0 (Sunday) … 6 (Saturday); use the WEEKDAY map
 * @param {object} [opts]
 * @param {number}  [opts.count=8]        — how many occurrences to generate
 * @param {Date}    [opts.now=new Date()] — injection point for tests
 * @param {boolean} [opts.includeToday=true] — count today when it matches;
 *   the scraper's own past-start guard drops it if the start time has passed
 * @returns {string[]} — 'YYYY-MM-DD' strings in ascending order
 */
export function nextWeeklyOccurrences(weekday, opts = {}) {
  const { count = 8, now = new Date(), includeToday = true } = opts
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new RangeError(`weekday must be an integer 0–6, got ${weekday}`)
  }

  const [y, m, d] = easternTodayYmd(now).split('-').map(Number)
  // Anchor at UTC midnight of the Eastern calendar date; from here every
  // step is whole-day UTC arithmetic, immune to DST and local-clock drift.
  const todayUtcMs = Date.UTC(y, m - 1, d)
  const todayDow = new Date(todayUtcMs).getUTCDay()

  let delta = (weekday - todayDow + 7) % 7
  if (delta === 0 && !includeToday) delta = 7

  const out = []
  for (let i = 0; i < count; i++) {
    out.push(new Date(todayUtcMs + (delta + 7 * i) * 86_400_000).toISOString().slice(0, 10))
  }
  return out
}
