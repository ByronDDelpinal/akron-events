/**
 * dayPlanDate.ts
 *
 * Eastern-calendar-date helpers for the day planner ONLY.
 *
 * The rest of this site groups/displays dates in the VIEWER's local
 * timezone (project convention -- see eventGrouping.ts's groupEventsByDate,
 * which uses `format(new Date(...), 'yyyy-MM-dd')` in local time). The day
 * planner is a deliberate, narrow exception: a plan's day headings and its
 * own identity ("Saturday's plan") are Akron-local, not viewer-local,
 * because "Saturday" means the local Saturday to everyone who opens the
 * link, wherever they are. Times WITHIN a day still render viewer-local, per
 * the site-wide rule -- only the day-grouping key is pinned to Eastern here.
 *
 * Never derive "today" from `new Date().toISOString()` or compare a Date
 * object to a date string -- both are the classic off-by-one-day trap this
 * module exists to avoid (a UTC-derived "today" rolls over up to 5 hours
 * before Eastern midnight). Every function here goes through
 * Intl.DateTimeFormat with an explicit America/New_York timeZone instead of
 * arithmetic on UTC offsets, so it stays correct across the EST/EDT
 * boundary without a manual DST table.
 */

const EASTERN_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/**
 * `yyyy-MM-dd` of an ISO instant, AS OBSERVED IN America/New_York.
 * `en-CA` locale formats numeric dates as `yyyy-MM-dd` directly, so no
 * further reassembly of Intl's parts is needed.
 */
export function easternDateKey(isoInstant: string | Date): string {
  const d = isoInstant instanceof Date ? isoInstant : new Date(isoInstant)
  return EASTERN_DATE_FORMATTER.format(d)
}

/** Today's date, as observed in America/New_York, as `yyyy-MM-dd`. */
export function easternTodayIso(): string {
  return easternDateKey(new Date())
}

/** True when `isoInstant`'s Eastern calendar date is today's Eastern calendar date. */
export function isEasternToday(isoInstant: string | Date): boolean {
  return easternDateKey(isoInstant) === easternTodayIso()
}

/**
 * Days between two `yyyy-MM-dd` Eastern date keys (b - a). Constructed at
 * fixed local-noon (matching DateHeading's own approach) so neither string
 * ever crosses a day boundary due to a UTC offset during the diff itself.
 */
export function easternDateKeyDiffDays(a: string, b: string): number {
  const da = new Date(`${a}T12:00:00`)
  const db = new Date(`${b}T12:00:00`)
  return Math.round((db.getTime() - da.getTime()) / 86_400_000)
}
