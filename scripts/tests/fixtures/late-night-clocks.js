/**
 * Frozen clocks for the "nightly scrape runs late" regression tests.
 *
 * The nightly job is moving from 7pm ET to 11pm ET. At 11pm ET the UTC calendar
 * date is ALREADY TOMORROW, so any scraper that derives "today" from
 * `new Date().toISOString()` drops (or mis-dates) everything happening today.
 *
 * Both DST phases matter: the cron is fixed in UTC, so an 11pm EDT run drifts
 * to 10pm EST in winter — still inside the 7pm–midnight EST danger window.
 *
 *   LATE_EDT — 2026-07-15 23:30 America/New_York (UTC-4) → UTC says 2026-07-16
 *   LATE_EST — 2026-01-15 23:30 America/New_York (UTC-5) → UTC says 2026-01-16
 */
export const LATE_EDT = new Date('2026-07-16T03:30:00Z')
export const LATE_EST = new Date('2026-01-16T04:30:00Z')

/** The Eastern calendar date at each frozen clock (what "today" must mean). */
export const LATE_EDT_TODAY = '2026-07-15'
export const LATE_EST_TODAY = '2026-01-15'
