/**
 * reviewReasons.ts
 *
 * The ONE place the review-queue membership predicate and reason taxonomy
 * live. Badge (rail pip), overview tile, queue page, and facet counts all
 * import from here; if what "needs review" means ever changes, it changes
 * here and nowhere else. A badge frozen at an old predicate while the page
 * shows a new one is bug 4 from the 08-18 review (badge != page), and this
 * module is what keeps that bug dead.
 *
 * Membership is the UNION of the two old tabs:
 *   - flagged by the scraper and not yet human-adjudicated
 *     (needs_review = true AND reviewed_at IS NULL), and
 *   - still awaiting publish (status = 'pending_review').
 *
 * The time scope (hide ended events) is applied SEPARATELY and positively via
 * `notEndedFilter()` from expiry.ts -- PostgREST ANDs successive `.or()`
 * params, so membership and time scope compose without either predicate
 * knowing about the other.
 */

import type { LooseQuery } from '@/types'

/**
 * PostgREST `.or()` argument for queue membership. Both branches of the
 * union, defined once. Badge, tiles, queue, and facet counts all pass this
 * exact string.
 */
export const REVIEW_MEMBERSHIP_OR =
  'and(needs_review.eq.true,reviewed_at.is.null),status.eq.pending_review'

/** Apply queue membership to a query. Time scope is added separately. */
export const reviewQueueScope = (q: LooseQuery): LooseQuery =>
  q.or(REVIEW_MEMBERSHIP_OR)

/**
 * Reason taxonomy -- honestly derivable Phase 1, existing columns only.
 *   cat   -> the scraper's per-run confidence flag, not yet human-adjudicated
 *   pend  -> the status column
 *   time  -> end_at IS NULL. An ANNOTATION, not a membership cause: a null
 *            end_at alone never puts a row in the queue.
 *   venue -> a venue-mint block (2026-09-17, sev-2): ensureVenue minted a
 *            venue with no address and no lat/lng, so linkEventVenue flagged
 *            the event needs_review (scripts/lib/normalize.js). On the wire
 *            this is the SAME needs_review flag `cat` reads, so today it is
 *            defined here -- honestly labeled instead of silently reusing
 *            "Category unsure" -- but NOT in FACET_IDS and NOT distinguished
 *            by rowReason yet: telling it apart from `cat` needs a
 *            event_venues -> venues join that SELECT_LIST in
 *            ReviewQueueSurface.tsx does not fetch. That join is Phase 2.
 * Not designed Phase 1 (data not retained): duplicate similarity, moderation
 * origin, confidence percentages, run linkage.
 */
export type ReasonId = 'cat' | 'pend' | 'time' | 'venue'

export interface ReasonDef {
  id: ReasonId
  label: string
  /** True for reasons that cause membership; false for annotations. */
  membership: boolean
}

export const REASONS: Record<ReasonId, ReasonDef> = {
  cat:   { id: 'cat',   label: 'Category unsure',    membership: true },
  pend:  { id: 'pend',  label: 'Awaiting publish',   membership: true },
  time:  { id: 'time',  label: 'Missing end time',   membership: false },
  venue: { id: 'venue', label: 'Venue has no location', membership: false },
}

/**
 * The facet ids offered in the UI, in display order. `venue` is deliberately
 * excluded until the Phase 2 join above lands -- surfacing it now would
 * double-count against `cat` (every venue-flagged row is already a `cat`
 * row on the wire) rather than replace it.
 */
export const FACET_IDS: ReasonId[] = ['cat', 'pend', 'time']

interface ReviewRowShape {
  needs_review?: boolean | null
  reviewed_at?: string | null
  status?: string | null
  end_at?: string | null
}

/** Client-side twin of the `cat` facet predicate. */
export function isCategoryUnsure(row: ReviewRowShape): boolean {
  return row.needs_review === true && row.reviewed_at == null
}

/** Client-side twin of the `pend` facet predicate. */
export function isAwaitingPublish(row: ReviewRowShape): boolean {
  return row.status === 'pending_review'
}

/** Client-side twin of the `time` annotation (within membership). */
export function isMissingEnd(row: ReviewRowShape): boolean {
  return row.end_at == null
}

/**
 * The ONE chip a row shows. Precedence cat > pend: a row that is both shows
 * "Category unsure" and the drawer narrates both. Returns null for a row
 * that satisfies neither membership branch (should not happen for rows the
 * membership query returned, but the queue must not invent a reason).
 */
export function rowReason(row: ReviewRowShape): ReasonId | null {
  if (isCategoryUnsure(row)) return 'cat'
  if (isAwaitingPublish(row)) return 'pend'
  return null
}

/**
 * Server-side facet predicate builders. Each is applied ON TOP of
 * `reviewQueueScope` + the time scope; the queue query composes them.
 * `time` filters within membership, so its builder only adds the null check.
 */
export const FACET_FILTERS: Record<ReasonId, (q: LooseQuery) => LooseQuery> = {
  cat:   (q) => q.eq('needs_review', true).is('reviewed_at', null),
  pend:  (q) => q.eq('status', 'pending_review'),
  time:  (q) => q.is('end_at', null),
  // Same predicate as `cat` for now -- see the ReasonId doc comment above.
  // Inert today (not in FACET_IDS); kept correct rather than omitted so the
  // Record stays exhaustive and a future caller gets a safe superset, not a
  // silently wrong empty set.
  venue: (q) => q.eq('needs_review', true).is('reviewed_at', null),
}
