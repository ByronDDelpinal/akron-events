/**
 * dayPlanGap.ts
 *
 * Pure calculations for the day planner's timeline: overlap flagging (§9.1
 * of the design) and the gap/distance line between consecutive items (§9.2).
 * Both are intentionally conservative and neutral per the maintainer's scope
 * ruling (2026-08-08): 84.3% of upcoming published events (4,060 of 4,817)
 * carry a usable end_at — well above the design's 40% viability bar — so
 * overlap flagging IS in scope. Venue-to-venue hop FEASIBILITY warnings are
 * OUT of scope: ~99 venues lack coordinates, and a warning that silently
 * disappears for a third of venues would read as "this hop is fine," which
 * is worse than no feature at all.
 */

export interface TimelineItem {
  event_id: string
  start_at: string | null
  end_at: string | null
  venue?: { lat: number | null; lng: number | null } | null
}

export interface OverlapFlag {
  aId: string
  bId: string
}

/**
 * Flag a conflict ONLY when both events have a non-null end_at. With end_at
 * null we would be comparing against an assumed block and inventing the
 * conflict.
 *
 * The load-bearing caveat: ~14 scrapers apply a SANCTIONED-DEFAULT-TIME when
 * a source omits a time, and that marker exists ONLY as a source-code
 * comment — there is no DB column, no flag, nothing in the row. The frontend
 * cannot distinguish an invented 7:00pm from a real one, so some fraction of
 * flagged overlaps will be artifacts of two sources independently defaulting
 * to the same placeholder time. Gating on both end_at values being present
 * removes most of these (a defaulted-time event rarely also carries a real
 * end time), but not all — callers must render this with soft, neutral
 * copy ("These two overlap"), never "conflict" and never a red/error
 * treatment. A false positive here should read as a shrug, not a bug.
 */
export function findOverlaps(items: TimelineItem[]): OverlapFlag[] {
  const timed = items
    .filter((i) => i.start_at && i.end_at)
    .map((i) => ({
      id: i.event_id,
      start: Date.parse(i.start_at as string),
      end: Date.parse(i.end_at as string),
    }))
    .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .sort((a, b) => a.start - b.start)

  const flags: OverlapFlag[] = []
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      // Sorted by start ascending: once item j starts at/after item i ends,
      // nothing further in the list can overlap item i either.
      if (timed[j].start >= timed[i].end) break
      flags.push({ aId: timed[i].id, bId: timed[j].id })
    }
  }
  return flags
}

/**
 * Minutes between the end of `prev` and the start of `next`. Falls back to
 * prev.start_at when prev.end_at is missing (a rough lower bound, never
 * shown as anything but a plain number of minutes — this is pure arithmetic
 * on times we already have, always shown, never gated).
 */
export function gapMinutes(prev: TimelineItem, next: TimelineItem): number | null {
  if (!next.start_at) return null
  const prevEndSource = prev.end_at ?? prev.start_at
  if (!prevEndSource) return null
  const prevEnd = Date.parse(prevEndSource)
  const nextStart = Date.parse(next.start_at)
  if (!Number.isFinite(prevEnd) || !Number.isFinite(nextStart)) return null
  return Math.round((nextStart - prevEnd) / 60_000)
}

const EARTH_RADIUS_MI = 3958.8

/**
 * Straight-line (haversine) distance in miles between two venues, or null
 * when either lacks coordinates. NEVER render a null here as a warning or a
 * placeholder ("unknown distance") — just omit the distance clause entirely.
 * See this file's header for why an always-present distance line would be
 * actively misleading for the ~99 venues with no lat/lng.
 */
export function distanceMiles(
  a: { lat: number | null; lng: number | null } | null | undefined,
  b: { lat: number | null; lng: number | null } | null | undefined,
): number | null {
  if (!a || !b || a.lat == null || a.lng == null || b.lat == null || b.lng == null) return null
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)))
  return EARTH_RADIUS_MI * c
}
