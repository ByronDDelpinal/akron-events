/**
 * DateHeading
 *
 * The "Friday, June 12" + Today/Tomorrow badge bar that sits above
 * each day's grid of events. Extracted from HomePage so CategoryPage
 * (and any future grouped-by-day view) can render the same heading
 * without duplicating styles or date logic.
 *
 * Styles live in HomePage.css today (.date-group, .date-heading,
 * .date-label, .today-badge, .date-line).
 */

import { format, isToday, isTomorrow } from 'date-fns'

export default function DateHeading({ dateKey }: { dateKey: string }) {
  // Construct from a fixed local-noon to avoid ever crossing a day
  // boundary due to UTC offsets — Akron is UTC-5 / UTC-4 so midnight
  // would land on the wrong day in tests / SSR with a UTC server clock.
  const d = new Date(dateKey + 'T12:00:00')
  return (
    <div className="date-group">
      <div className="date-heading">
        <span className="date-label">{format(d, 'EEEE, MMMM d')}</span>
        {isToday(d)    && <span className="today-badge">Today</span>}
        {isTomorrow(d) && (
          <span className="today-badge" style={{ background: 'var(--green-mid)' }}>
            Tomorrow
          </span>
        )}
        <div className="date-line" />
      </div>
    </div>
  )
}
