// @ts-check
/**
 * Resolve a named date-range preset into inclusive [start, end] Date bounds.
 *
 * Shared by useEvents and useMapEvents so the list and map views stay in sync.
 * `now` is injectable so the weekday-boundary logic is unit-testable without
 * mocking the clock.
 *
 * Weekend semantics: "this weekend" runs Friday 4pm → end of Sunday (Friday
 * night counts — people want to go out). When the query runs *during* the
 * weekend (Fri evening through Sun) it anchors to the current weekend rather
 * than skipping a week ahead; the caller's `start_at >= now` filter trims the
 * part that's already past. "this week" runs from today through the coming
 * Sunday (today, when today is already Sunday).
 *
 * @param {string} dateRange  One of 'today' | 'this_weekend' | 'this_week' | 'this_month'.
 * @param {Date} [now]        Reference instant; defaults to the current time.
 * @returns {{ start: Date, end: Date }}
 */
export function dateRangeBounds(dateRange, now = new Date()) {
  const start = new Date(now)
  const end   = new Date(now)

  if (dateRange === 'today') {
    start.setHours(0, 0, 0, 0)
    end.setHours(23, 59, 59, 999)
  } else if (dateRange === 'this_weekend') {
    const dayOfWeek = now.getDay() // 0 = Sun … 6 = Sat
    // Offset to this weekend's Friday. Sat/Sun fall *inside* the weekend, so
    // their Friday is in the past (−1, −2); Mon–Fri point to the upcoming Friday.
    const daysToFri =
      dayOfWeek === 6 ? -1 :
      dayOfWeek === 0 ? -2 :
      5 - dayOfWeek
    start.setDate(now.getDate() + daysToFri)
    start.setHours(16, 0, 0, 0) // Friday 4pm — Friday night counts
    // End of the weekend is Sunday night = Friday + 2 days. Clone the start so
    // the +2 rolls across month boundaries correctly.
    end.setTime(start.getTime())
    end.setDate(end.getDate() + 2)
    end.setHours(23, 59, 59, 999)
  } else if (dateRange === 'this_week') {
    start.setHours(0, 0, 0, 0)
    // Days remaining until Sunday; 0 when today is already Sunday (the end of
    // the week) so the window doesn't roll a full week forward.
    const daysToSun = (7 - now.getDay()) % 7
    end.setDate(now.getDate() + daysToSun)
    end.setHours(23, 59, 59, 999)
  } else if (dateRange === 'this_month') {
    start.setHours(0, 0, 0, 0)
    end.setMonth(now.getMonth() + 1, 0)
    end.setHours(23, 59, 59, 999)
  }

  return { start, end }
}
