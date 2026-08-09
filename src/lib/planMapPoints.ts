/**
 * planMapPoints.ts
 *
 * Pure, DOM-free logic shared by DayPlanTimeline.tsx (the list) and
 * PlanMap.tsx (the map), via DayPlanBoard.tsx. Ordering, numbering, the
 * mapped/unmapped split, coordinate grouping, per-day connector geometry,
 * and camera bounds all live here so the two renderers can never disagree
 * about what "#3" means -- see DayPlanBoard.tsx's header for why that
 * matters. Node-testable: scripts/tests/test-plan-map.js imports this file
 * directly, following scripts/tests/test-day-plan-lib.js's precedent of
 * importing .ts modules straight into `node --test`.
 *
 * `PlanRenderItem` lives here rather than in DayPlanTimeline.tsx (its
 * previous home) so this module doesn't have to import a type back out of
 * the component that imports functions FROM here -- DayPlanTimeline.tsx
 * re-exports it so `import { type PlanRenderItem } from
 * '@/components/DayPlanTimeline'` at the two page call sites keeps working
 * unchanged.
 */

// Relative imports with explicit .ts extensions (not the usual `@/lib/...`
// alias) so this module resolves unmodified under plain `node --test` --
// scripts/tests/test-plan-map.js imports it directly, following
// scripts/tests/test-day-plan-lib.js's precedent for dayPlanDate.ts /
// dayPlanGap.ts / dayPlanDraft.ts. tsconfig's allowImportingTsExtensions
// makes this equally valid from Vite's side.
import { easternDateKey } from './dayPlanDate.ts'
import { formatEventDate } from './eventFormatting.ts'
import type { RotStatus } from './dayPlanApi.ts'

export interface PlanRenderItem {
  key: string
  title: string
  startAt: string
  /** Present and different from startAt only for rot_status='moved'. */
  oldStartAt?: string | null
  endAt: string | null
  venueName: string | null
  venueGeo?: { lat: number | null; lng: number | null } | null
  /** Only present for /d/:code (get_day_plan returns it); the local draft
   *  snapshot has no address. Optional so PlanMap's "Get directions" link
   *  is simply omitted rather than built with a hole in it -- see
   *  PlanMap.tsx's popup, which gates the link on this being present. */
  venueAddress?: string | null
  venueCity?: string | null
  /** null when there's nothing left to link to (rot_status='gone'). */
  eventPath: string | null
  /** undefined = plain 'ok' (the local pre-share draft has no rot concept at all). */
  rotStatus?: RotStatus
  onRemove: () => void
}

/** cancelled/gone render struck-through in the list and as a muted pin on
 *  the map. Shared here so the two surfaces apply the exact same predicate. */
export function isStruck(status: RotStatus | undefined): boolean {
  return status === 'cancelled' || status === 'gone'
}

/** An item is "mapped" (gets a pin, consumes a marker slot) exactly when it
 *  carries a full lat/lng pair. `gone` items always fail this (get_day_plan
 *  returns venue: null for them by construction), which is why `gone`
 *  reads as unmapped everywhere without special-casing the rot status. */
export function isMapped(item: PlanRenderItem): boolean {
  return item.venueGeo?.lat != null && item.venueGeo?.lng != null
}

/**
 * Deterministic tie-break for the within-day sort. For two valid
 * timestamps this is identical to the plain `Date.parse(a) - Date.parse(b)`
 * DayPlanTimeline used before this refactor (so the "ordering parity"
 * regression test holds). The addition: if either side is corrupt
 * (`Date.parse` -> NaN, e.g. hand-edited localStorage), a valid date always
 * sorts before an invalid one, and two invalid dates fall back to comparing
 * `key` so the order is reproducible instead of whatever V8's sort happens
 * to do with a NaN comparator result.
 */
function compareStart(a: PlanRenderItem, b: PlanRenderItem): number {
  const ta = Date.parse(a.startAt)
  const tb = Date.parse(b.startAt)
  const aValid = Number.isFinite(ta)
  const bValid = Number.isFinite(tb)
  if (aValid && bValid) return ta - tb
  if (aValid !== bValid) return aValid ? -1 : 1
  return a.key.localeCompare(b.key)
}

// PlanRenderItem.startAt is non-nullable and, on both real paths, always a
// well-formed ISO instant (DayPlanPage.tsx's snap_start_at / SharedPlanPage
// .tsx's start_at ?? snap_start_at, and day_plan_items.snap_start_at is
// NOT NULL in migration 052). A hand-edited/corrupt localStorage value is
// the one way a garbage string reaches here -- Intl.DateTimeFormat.format
// throws RangeError on an Invalid Date, so easternDateKey() itself is not
// safe to call on one. Any string that sorts after every real 'YYYY-MM-DD'
// key works; letters are all > digits in UTF-16, so this lands every
// corrupt item in one trailing pseudo-day rather than crashing the whole
// plan over one bad row.
const INVALID_DAY_KEY = 'invalid'

/**
 * Group items by Eastern calendar date (dayPlanDate.ts's deliberate,
 * narrow exception to the site's viewer-local grouping rule -- see that
 * module's header), sorted by start time within each day and by day
 * ascending. This is DayPlanTimeline's original private memo body, moved
 * here verbatim for the day-grouping and day-ordering behavior; the
 * within-day sort gained the NaN tie-break above, and the day-key itself
 * gained the INVALID_DAY_KEY fallback so a corrupt startAt degrades
 * (grouped, numbered, rendered "quietly wrong-dated") instead of throwing.
 */
export function groupPlanItemsByDay(items: PlanRenderItem[]): [string, PlanRenderItem[]][] {
  const byDay = new Map<string, PlanRenderItem[]>()
  for (const item of items) {
    const key = Number.isFinite(Date.parse(item.startAt)) ? easternDateKey(item.startAt) : INVALID_DAY_KEY
    if (!byDay.has(key)) byDay.set(key, [])
    byDay.get(key)!.push(item)
  }
  for (const list of byDay.values()) {
    list.sort(compareStart)
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
}

/**
 * Numbers 1..N across the WHOLE plan (not per day -- a two-day plan
 * numbered 1,2,3 / 1,2,3 would have two "stop 2"s and the map popup
 * couldn't disambiguate). Unmapped items still consume a number: the gap
 * in the map's sequence (1, 2, 4) is what tells the reader #3 exists but
 * isn't on the map, rather than silently renumbering the mapped subset and
 * making the list and the map disagree about what "#3" means.
 */
export function numberPlanItems(items: PlanRenderItem[]): Map<string, number> {
  const numbers = new Map<string, number>()
  let n = 1
  for (const [, dayItems] of groupPlanItemsByDay(items)) {
    for (const item of dayItems) {
      numbers.set(item.key, n)
      n++
    }
  }
  return numbers
}

/** [west, south, east, north] -- same shape as neighborhoodGeo.ts's BBox,
 *  feeds map.fitBounds([[west, south], [east, north]], ...) the same way. */
export type BBox = [number, number, number, number]

/**
 * Group key for "the same place" on the map. 5 decimals of lat/lng is
 * roughly 1.1 meters -- tight enough that two genuinely distinct addresses
 * never merge, loose enough that float noise between two rows of the same
 * venue doesn't split it into two pins. get_day_plan's venue jsonb carries
 * no venue id (unlike MapView's LooseRow, which groups by `venue.id`), so
 * this rounded-coordinate key is the only grouping key available.
 */
export function roundCoordKey(lat: number, lng: number): string {
  return `${lat.toFixed(5)}|${lng.toFixed(5)}`
}

/**
 * Camera bounds for a set of points. `null` for zero points (nothing to
 * fit); a degenerate but non-NaN bbox (west===east, south===north) for one
 * point -- callers must special-case a single point/place rather than
 * feeding a degenerate bbox to fitBounds, which is the classic source of a
 * NaN camera. See PlanMap.tsx's fit logic, which checks group count before
 * ever calling this.
 */
export function boundsForPoints(points: { lat: number; lng: number }[]): BBox | null {
  if (points.length === 0) return null
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
  for (const p of points) {
    if (p.lng < west) west = p.lng
    if (p.lng > east) east = p.lng
    if (p.lat < south) south = p.lat
    if (p.lat > north) north = p.lat
  }
  return [west, south, east, north]
}

/** One marker on PlanMap. Matches PlanRenderItem.key -- the ORIGINAL
 *  event_id, not resolved_event_id. */
export interface PlanMapPoint {
  key: string
  /** 1-based chronological position across the whole plan. May be
   *  non-contiguous across the mapped subset: unmapped items consume a
   *  number too. */
  number: number
  title: string
  venueName: string | null
  lat: number
  lng: number
  /** Preformatted by this module (PlanMap.tsx does no date math itself). */
  timeLabel: string
  /** null when there is nothing to link to (rot_status 'gone') -- though a
   *  'gone' item is never mapped in the first place (isMapped above), so
   *  this is null here only in the theoretical case of a future rot status
   *  that keeps a venue but drops the event page. */
  eventPath: string | null
  /** cancelled -- renders a muted pin and a struck popup row. 'gone' never
   *  reaches this type at all (it fails isMapped and lands in
   *  unmappedKeys instead), so struck+mapped means cancelled in practice. */
  struck: boolean
  /** For the popup's "Get directions" link. Omitted (null) when unknown --
   *  true for every /d/:code item, absent for local-draft items added
   *  before this shipped or where the source event never had one. */
  address?: string | null
  city?: string | null
}

/** Two or more PlanMapPoints that round to the same coordinate (§4.3 of
 *  the design) -- one marker, a count pip, and a popup listing every stop
 *  there in number order. `points` is always non-empty and already in
 *  ascending number order (it's built by iterating the same day/number
 *  order numberPlanItems and groupPlanItemsByDay produce). */
export interface PlanMarkerGroup {
  key: string
  lat: number
  lng: number
  points: PlanMapPoint[]
}

export interface PlanMapDerived {
  /** Mapped items only, in ascending number order. */
  points: PlanMapPoint[]
  /** Keys of items with no usable coordinates -- venue known or not, see
   *  DayPlanTimeline.tsx's row copy for the "Location not mapped" vs
   *  "No location listed" distinction, which is decided from venueName,
   *  not from this set. */
  unmappedKeys: Set<string>
  groups: PlanMarkerGroup[]
  /** One LineString per Eastern day with >=2 mapped stops; empty features
   *  array when every day has 0 or 1 mapped stop. Built here (not in
   *  PlanMap.tsx) because building it requires day grouping, i.e. date
   *  math, which PlanMap.tsx is deliberately kept free of. */
  connector: GeoJSON.FeatureCollection
}

/**
 * The single derivation both DayPlanBoard.tsx and PlanMap.tsx consume.
 * Mapped/unmapped split, per-coordinate grouping, and the per-day dotted
 * connector line, all built from ONE pass over groupPlanItemsByDay's
 * output using the SAME numbers numberPlanItems assigns -- so a marker's
 * glyph and a list row's position can never drift apart.
 *
 * Guardrails encoded here (design's §3.4, restated so this file doesn't
 * depend on a gitignored doc for its own rationale):
 *   - Never connect across a day boundary: one feature per day group.
 *   - Draw nothing for a day with fewer than 2 mapped stops.
 *   - Unmapped items are skipped, not gapped -- the line connects stop #2
 *     directly to #4 when #3 has no coordinates. That is a lie by
 *     omission (the same one the number gap already tells), and the list
 *     carries the honest version two feet away.
 */
export function toPlanMapPoints(items: PlanRenderItem[]): PlanMapDerived {
  const numbers = numberPlanItems(items)
  const unmappedKeys = new Set<string>()
  const points: PlanMapPoint[] = []
  const groupsByKey = new Map<string, PlanMarkerGroup>()
  const connectorFeatures: GeoJSON.Feature[] = []

  for (const [, dayItems] of groupPlanItemsByDay(items)) {
    const dayLine: [number, number][] = []
    for (const item of dayItems) {
      if (!isMapped(item)) {
        unmappedKeys.add(item.key)
        continue
      }
      const lat = item.venueGeo!.lat as number
      const lng = item.venueGeo!.lng as number
      const point: PlanMapPoint = {
        key: item.key,
        number: numbers.get(item.key)!,
        title: item.title,
        venueName: item.venueName,
        lat,
        lng,
        timeLabel: formatEventDate(item.startAt),
        eventPath: item.eventPath,
        struck: isStruck(item.rotStatus),
        address: item.venueAddress ?? null,
        city: item.venueCity ?? null,
      }
      points.push(point)
      dayLine.push([lng, lat])

      const coordKey = roundCoordKey(lat, lng)
      const existingGroup = groupsByKey.get(coordKey)
      if (existingGroup) {
        existingGroup.points.push(point)
      } else {
        groupsByKey.set(coordKey, { key: coordKey, lat, lng, points: [point] })
      }
    }
    if (dayLine.length >= 2) {
      connectorFeatures.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: dayLine },
      })
    }
  }

  return {
    points,
    unmappedKeys,
    groups: [...groupsByKey.values()],
    connector: { type: 'FeatureCollection', features: connectorFeatures },
  }
}
