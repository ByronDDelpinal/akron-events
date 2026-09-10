/**
 * scripts/lib/year-inference.js
 *
 * Infers the year for a month/day-only date (no explicit year in the source
 * text) relative to "today" in Eastern time.
 *
 * Equivalent framing: this rolls a yearless date forward to next year only
 * when the next-year occurrence is within ~182 days ahead of today — the
 * nearest-candidate rule below just picks whichever of last year / this
 * year / next year lands closest to today. A yearless date that already
 * passed by months is read as a past show this year, not one ~10 months out.
 * The New-Year rollback (an early-January clock reading "December 30"
 * resolves to the PREVIOUS year, not next year) falls out of the same rule
 * for free — no special-casing needed.
 *
 * Never construct a local `Date` here — `now` is always resolved through
 * easternTodayIso, which anchors "today" to America/New_York regardless of
 * the machine's local timezone or a late-night UTC rollover.
 */
import { easternTodayIso } from './normalize.js'

export function inferYearForMonthDay(month, day, now = new Date()) {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  if (!Number.isInteger(day) || day < 1 || day > 31) return null

  const [ty, tm, td] = easternTodayIso(now).split('-').map(Number)
  const todayMs = Date.UTC(ty, tm - 1, td)

  let best = null
  let bestDiff = Infinity
  for (const year of [ty - 1, ty, ty + 1]) {
    const candidateMs = Date.UTC(year, month - 1, day)
    const diff = Math.abs(candidateMs - todayMs)
    // <= (not <) so that on a tie the later-iterated, i.e. future, candidate wins.
    if (diff <= bestDiff) {
      bestDiff = diff
      best = year
    }
  }
  return best
}
