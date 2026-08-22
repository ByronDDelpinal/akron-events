/**
 * expiry.ts
 *
 * One definition of "expired" for every admin surface.
 *
 * EXPIRED MEANS THE EVENT ALREADY ENDED, NOT THAT IT ALREADY STARTED.
 * The distinction is load-bearing. Filtering on `start_at >= now` drops an
 * event the instant it begins, which is the same defect already logged
 * against the public feed ranking, and it is worst exactly when an admin
 * needs the row most: 36 events in the table are in progress right now
 * (measured 2026-08-18), and a start-only filter hides every one of them.
 *
 * NULL `end_at` (about 15% of rows, 1,717 of 11,132 measured 2026-08-18)
 * is the hard case. This module deliberately does NOT invent a duration.
 * That convention is already settled elsewhere in the codebase and the
 * reasoning holds here:
 *   - `festivalSchedule.ts` `isHappeningNow` returns false when `endMs` is
 *     null, on the stated grounds that being honest beats guessing.
 *   - `dayPlanGap.ts` `findOverlaps` refuses to flag a conflict unless both
 *     rows carry a real `end_at`, because comparing against an assumed block
 *     invents the conflict.
 * So a row with no `end_at` is treated as having ended at the close of its
 * own Eastern calendar day. That is a statement about the calendar, not a
 * guessed runtime: we know which day it happened on, we do not know the
 * hour it finished, so it stays visible for the remainder of that day and
 * then expires. Same-day rows are never dropped mid-afternoon, and a
 * null-end row from last March does not linger forever.
 *
 * Day boundaries go through `easternDate.ts`. Never derive "today" from
 * `new Date().toISOString()`: a UTC-derived day rolls over up to 5 hours
 * before Eastern midnight, and `scripts/tests/test-no-utc-today.js` fails
 * on it.
 */

import { easternDateKey, easternIsoAt } from '@/lib/easternDate'

export interface UpcomingBounds {
  /** The instant to compare a known `end_at` against. */
  nowIso: string
  /** Eastern midnight that starts today, for the null-`end_at` fallback. */
  dayFloorIso: string
}

/**
 * `now` is injectable so tests can pin the clock. Callers in the app pass
 * nothing and get the real one.
 */
export function upcomingBounds(now: Date = new Date()): UpcomingBounds {
  return {
    nowIso: now.toISOString(),
    dayFloorIso: easternIsoAt(easternDateKey(now), '00:00:00'),
  }
}

/**
 * A PostgREST `.or()` argument selecting rows that have NOT ended.
 *
 * Reads as: the event has a real end time still in the future, OR it has no
 * end time and its Eastern day has not closed yet.
 *
 * ONLY EVER USE THIS POSITIVELY. Do not build the "expired" set by negating
 * it. In SQL three-valued logic a null `end_at` makes the first branch NULL,
 * so `NOT (...)` discards those rows instead of selecting them, and the two
 * sets silently fail to sum to the total. Get the expired count by
 * subtracting the visible count from an unfiltered count instead, which is
 * what `expiredCount` below does.
 *
 * ISO instants contain no commas, so they need no quoting inside the
 * comma-separated `or()` grammar.
 */
export function notEndedFilter(bounds: UpcomingBounds = upcomingBounds()): string {
  return `end_at.gte.${bounds.nowIso},and(end_at.is.null,start_at.gte.${bounds.dayFloorIso})`
}

/** Client-side twin of `notEndedFilter`, for rows already in memory. */
export function hasEnded(
  row: { start_at: string | null; end_at: string | null },
  bounds: UpcomingBounds = upcomingBounds(),
): boolean {
  if (row.end_at) return row.end_at < bounds.nowIso
  if (!row.start_at) return false
  return row.start_at < bounds.dayFloorIso
}

/**
 * How many rows the default view is hiding. Derived by subtraction, never by
 * negating the filter, for the NULL reason spelled out above. A negative
 * result is impossible in a consistent snapshot but is clamped anyway, since
 * the two counts are two round trips and rows can land between them.
 */
export function expiredCount(totalUnfiltered: number, visible: number): number {
  return Math.max(0, totalUnfiltered - visible)
}
