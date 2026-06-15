// @ts-check
/**
 * Resolve a named date-range preset into inclusive [start, end] Date bounds.
 *
 * Shared by useEvents and useMapEvents so the list and map views stay in sync.
 * `now` is injectable so the weekday-boundary logic is unit-testable without
 * mocking the clock.
 *
 * Weekend semantics: "this weekend" is the upcoming Saturday + Sunday, but when
 * the query runs *on* the weekend the window includes the current day rather
 * than skipping a week ahead. "this week" runs from today through the coming
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
    // Sunday: the weekend window is just today (Sat is already past). Mon–Sat:
    // advance to (or stay on, when today is Saturday) the upcoming Saturday.
    const daysToSat = dayOfWeek === 0 ? 0 : 6 - dayOfWeek
    // End of the weekend is Sunday: one day after a Saturday start, same day
    // when the window already starts on Sunday.
    const weekendSpan = dayOfWeek === 0 ? 0 : 1
    start.setDate(now.getDate() + daysToSat)
    start.setHours(0, 0, 0, 0)
    end.setDate(now.getDate() + daysToSat + weekendSpan)
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
