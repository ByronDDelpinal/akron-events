/**
 * test-plan-map.js — pure-logic unit tests for planMapPoints.ts (the day
 * plan's route map: ordering/numbering shared with DayPlanTimeline, the
 * mapped/unmapped split, per-coordinate marker grouping, the per-day
 * connector line, and camera bounds) plus the two dayPlanDraft.ts changes
 * that unblock it (add-time venue coordinates on the local draft).
 *
 * Follows scripts/tests/test-day-plan-lib.js's precedent of importing the
 * .ts modules directly into `node --test`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  groupPlanItemsByDay,
  numberPlanItems,
  toPlanMapPoints,
  boundsForPoints,
  roundCoordKey,
  isMapped,
} from '../../src/lib/planMapPoints.ts'
import { distanceMiles } from '../../src/lib/dayPlanGap.ts'
import { DRAFT_KEY, readDraft, writeDraft, snapshotItem } from '../../src/lib/dayPlanDraft.ts'

/** Minimal PlanRenderItem fixture. Defaults to a fully mapped, plain 'ok' item. */
function makeItem(key, startAt, opts = {}) {
  return {
    key,
    title: opts.title ?? `Event ${key}`,
    startAt,
    endAt: opts.endAt ?? null,
    venueName: 'venueName' in opts ? opts.venueName : `Venue ${key}`,
    venueGeo: 'venueGeo' in opts ? opts.venueGeo : { lat: 41.0810 + Number(key.length) * 0.001, lng: -81.5190 },
    eventPath: 'eventPath' in opts ? opts.eventPath : `/events/e/${key}`,
    rotStatus: opts.rotStatus,
    onRemove: () => {},
  }
}

/** Minimal in-memory localStorage shim -- this environment has no global
 *  localStorage (it's a browser API), and dayPlanDraft.ts's try/catch
 *  silently swallows the resulting ReferenceError, which would make the
 *  backward-compatibility test below pass for the wrong reason (an empty
 *  draft, not a parsed one) if we didn't provide a real implementation. */
function makeMemoryStorage() {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => store.clear(),
  }
}

describe('groupPlanItemsByDay: ordering parity with the pre-refactor DayPlanTimeline memo', () => {
  it('groups by Eastern day ascending, sorted by start time within each day, from out-of-order input', () => {
    const items = [
      makeItem('b1', '2026-08-15T18:00:00.000Z'), // 2pm EDT Aug 15
      makeItem('c1', '2026-08-16T14:00:00.000Z'), // 10am EDT Aug 16
      makeItem('a1', '2026-08-15T14:00:00.000Z'), // 10am EDT Aug 15
    ]
    const groups = groupPlanItemsByDay(items)
    assert.deepEqual(groups.map(([day]) => day), ['2026-08-15', '2026-08-16'])
    assert.deepEqual(groups[0][1].map((i) => i.key), ['a1', 'b1'])
    assert.deepEqual(groups[1][1].map((i) => i.key), ['c1'])
  })

  it('a corrupt (NaN) startAt never throws -- it lands in a trailing pseudo-day group, ordered by key', () => {
    const items = [
      makeItem('z', 'not-a-real-date'),
      makeItem('a', '2026-08-15T14:00:00.000Z'),
      makeItem('m', 'also-not-a-date'),
    ]
    assert.doesNotThrow(() => groupPlanItemsByDay(items))
    const groups = groupPlanItemsByDay(items)
    assert.equal(groups.length, 2)
    assert.deepEqual(groups[0][1].map((i) => i.key), ['a'])
    // The two corrupt items share one trailing group, sorted by key.
    assert.deepEqual(groups[1][1].map((i) => i.key), ['m', 'z'])
  })
})

describe('numberPlanItems: 1..N across the whole plan, including unmapped items', () => {
  it('numbers contiguously across a multi-day plan, not restarting per day', () => {
    const items = [
      makeItem('a', '2026-08-15T14:00:00.000Z'),
      makeItem('b', '2026-08-15T18:00:00.000Z'),
      makeItem('c', '2026-08-16T14:00:00.000Z'),
    ]
    const numbers = numberPlanItems(items)
    assert.equal(numbers.get('a'), 1)
    assert.equal(numbers.get('b'), 2)
    assert.equal(numbers.get('c'), 3)
  })

  it('an unmapped item still consumes a number', () => {
    const items = [
      makeItem('a', '2026-08-15T14:00:00.000Z'),
      makeItem('b', '2026-08-15T15:00:00.000Z', { venueGeo: null }),
      makeItem('c', '2026-08-15T16:00:00.000Z'),
    ]
    const numbers = numberPlanItems(items)
    assert.deepEqual([numbers.get('a'), numbers.get('b'), numbers.get('c')], [1, 2, 3])
  })
})

describe('toPlanMapPoints: the numbering gap is real (§5.2 -- gapped-but-true beats contiguous-but-wrong)', () => {
  it('four items, #3 unmapped -> mapped points number [1, 2, 4], never renumbered to [1, 2, 3]', () => {
    const items = [
      makeItem('a', '2026-08-15T14:00:00.000Z'),
      makeItem('b', '2026-08-15T15:00:00.000Z'),
      makeItem('c', '2026-08-15T16:00:00.000Z', { venueGeo: null }),
      makeItem('d', '2026-08-15T17:00:00.000Z'),
    ]
    const { points, unmappedKeys } = toPlanMapPoints(items)
    assert.deepEqual(points.map((p) => p.number), [1, 2, 4])
    assert.ok(unmappedKeys.has('c'))
    assert.equal(unmappedKeys.size, 1)
  })
})

describe('toPlanMapPoints: Eastern day boundary and the per-day connector', () => {
  it('an 11:30pm-Eastern item numbers under the earlier calendar day, and the connector never crosses days', () => {
    const items = [
      makeItem('d1', '2026-08-15T14:00:00.000Z'), // 10am EDT Aug 15
      makeItem('d2', '2026-08-16T03:30:00.000Z'), // 11:30pm EDT Aug 15 (UTC rolls to Aug 16)
      makeItem('d3', '2026-08-16T14:00:00.000Z'), // 10am EDT Aug 16 -- lone stop that day
    ]
    const numbers = numberPlanItems(items)
    // d1 and d2 both land in the Aug-15 group (ascending by start), d3 in Aug-16.
    assert.deepEqual([numbers.get('d1'), numbers.get('d2'), numbers.get('d3')], [1, 2, 3])

    const { connector } = toPlanMapPoints(items)
    // Only Aug 15 has >=2 mapped stops -- Aug 16 (d3 alone) draws nothing.
    assert.equal(connector.features.length, 1)
    const [feature] = connector.features
    assert.equal(feature.geometry.type, 'LineString')
    assert.equal(feature.geometry.coordinates.length, 2)
  })
})

describe('toPlanMapPoints: same-venue grouping (§4.3 -- two events at one place must not stack invisibly)', () => {
  it('two items whose coordinates round to the same 5-decimal key form one marker group, ordered by number', () => {
    const items = [
      makeItem('a', '2026-08-15T14:00:00.000Z', { venueGeo: { lat: 41.0810004, lng: -81.5190001 } }),
      makeItem('b', '2026-08-15T15:00:00.000Z', { venueGeo: { lat: 41.0810001, lng: -81.5190002 } }),
    ]
    const { groups } = toPlanMapPoints(items)
    assert.equal(groups.length, 1)
    assert.deepEqual(groups[0].points.map((p) => p.key), ['a', 'b'])
  })

  it('coordinates 0.001 degrees apart (well past the 5-decimal tolerance) do NOT group', () => {
    const items = [
      makeItem('a', '2026-08-15T14:00:00.000Z', { venueGeo: { lat: 41.0810, lng: -81.5190 } }),
      makeItem('b', '2026-08-15T15:00:00.000Z', { venueGeo: { lat: 41.0820, lng: -81.5190 } }),
    ]
    const { groups } = toPlanMapPoints(items)
    assert.equal(groups.length, 2)
  })

  it('roundCoordKey itself: matches at 5 decimals, differs beyond it', () => {
    assert.equal(roundCoordKey(41.0810004, -81.5190001), roundCoordKey(41.0810001, -81.5190002))
    assert.notEqual(roundCoordKey(41.0810, -81.5190), roundCoordKey(41.0820, -81.5190))
  })
})

describe('boundsForPoints', () => {
  it('null for zero points', () => {
    assert.equal(boundsForPoints([]), null)
  })

  it('a degenerate but non-NaN bbox for a single point', () => {
    const b = boundsForPoints([{ lat: 41.08, lng: -81.52 }])
    assert.ok(b !== null)
    assert.deepEqual(b, [-81.52, 41.08, -81.52, 41.08])
    for (const n of b) assert.ok(Number.isFinite(n), 'no NaN may reach the camera for a single point')
  })

  it('correct min/max across N points', () => {
    const b = boundsForPoints([
      { lat: 41.0, lng: -81.6 },
      { lat: 41.2, lng: -81.5 },
      { lat: 41.1, lng: -81.55 },
    ])
    assert.deepEqual(b, [-81.6, 41.0, -81.5, 41.2])
  })
})

describe('rot_status classification in toPlanMapPoints', () => {
  it("gone: unmapped (get_day_plan's venue: null) but still numbered", () => {
    const items = [
      makeItem('a', '2026-08-15T14:00:00.000Z'),
      makeItem('b', '2026-08-15T15:00:00.000Z', { venueGeo: null, eventPath: null, rotStatus: 'gone' }),
    ]
    const { points, unmappedKeys } = toPlanMapPoints(items)
    assert.ok(unmappedKeys.has('b'))
    assert.ok(!points.some((p) => p.key === 'b'))
    assert.equal(numberPlanItems(items).get('b'), 2)
  })

  it('cancelled: mapped, struck true, numbered normally', () => {
    const items = [makeItem('a', '2026-08-15T14:00:00.000Z', { rotStatus: 'cancelled' })]
    const { points } = toPlanMapPoints(items)
    assert.equal(points.length, 1)
    assert.equal(points[0].struck, true)
    assert.equal(points[0].number, 1)
  })

  it('merged_duplicate items are filtered upstream by both pages -- passing only the surviving items never resurrects one', () => {
    // DayPlanPage.tsx / SharedPlanPage.tsx both drop merged_duplicate before
    // building `items`, so this module only ever sees what's left.
    const items = [
      makeItem('a', '2026-08-15T14:00:00.000Z'),
      makeItem('c', '2026-08-15T16:00:00.000Z'),
    ]
    const numbers = numberPlanItems(items)
    assert.equal(numbers.size, 2)
    assert.deepEqual([...numbers.keys()].sort(), ['a', 'c'])
  })
})

describe('isMapped', () => {
  it('true only when both lat and lng are present', () => {
    assert.equal(isMapped(makeItem('a', '2026-08-15T14:00:00.000Z', { venueGeo: { lat: 41, lng: -81 } })), true)
    assert.equal(isMapped(makeItem('a', '2026-08-15T14:00:00.000Z', { venueGeo: { lat: null, lng: -81 } })), false)
    assert.equal(isMapped(makeItem('a', '2026-08-15T14:00:00.000Z', { venueGeo: null })), false)
  })
})

describe('dayPlanDraft: snapshotItem carries coordinates', () => {
  it('carries lat/lng when the source event has them', () => {
    const event = { id: 'e1', title: 'Show', start_at: '2026-08-15T19:00:00.000Z', venue: { name: 'Lock 3', lat: 41.08, lng: -81.52 } }
    const item = snapshotItem(event)
    assert.equal(item.snap_venue_lat, 41.08)
    assert.equal(item.snap_venue_lng, -81.52)
  })

  it('is null (never undefined-and-crashing) when the source event has no coordinates', () => {
    const event = { id: 'e2', title: 'Show', start_at: '2026-08-15T19:00:00.000Z', venue: { name: 'Lock 3' } }
    const item = snapshotItem(event)
    assert.equal(item.snap_venue_lat, null)
    assert.equal(item.snap_venue_lng, null)
  })

  it('is null when there is no venue at all', () => {
    const event = { id: 'e3', title: 'Show', start_at: '2026-08-15T19:00:00.000Z', venue: null }
    const item = snapshotItem(event)
    assert.equal(item.snap_venue_lat, null)
    assert.equal(item.snap_venue_lng, null)
  })
})

describe('dayPlanDraft: backward compatibility with a pre-coordinate draft (the regression that matters)', () => {
  it('a literal v:1 JSON string in the OLD shape still passes isValidDraft, round-trips through readDraft, and its item classifies as unmapped', () => {
    // Hard-coded, not produced by snapshotItem -- this is exactly what a
    // draft written before 2026-08-08 looks like on disk.
    const OLD_SHAPE_JSON = '{"v":1,"title":"My Saturday","items":[{"event_id":"a1","snap_title":"Old Event","snap_start_at":"2026-08-15T19:00:00.000Z","snap_end_at":null,"snap_venue":"Lock 3","added_at":"2026-08-01T12:00:00.000Z"}],"updated_at":"2026-08-01T12:00:00.000Z"}'

    const previousLocalStorage = globalThis.localStorage
    globalThis.localStorage = makeMemoryStorage()
    try {
      globalThis.localStorage.setItem(DRAFT_KEY, OLD_SHAPE_JSON)

      const draft = readDraft()
      assert.equal(draft.items.length, 1, 'a pre-coordinate draft must not degrade to empty')
      assert.equal(draft.items[0].snap_title, 'Old Event')
      assert.equal(draft.items[0].snap_venue_lat, undefined)
      assert.equal(draft.items[0].snap_venue_lng, undefined)

      // Round-trips: writing it back out and re-reading yields the same data.
      writeDraft(draft)
      const rewritten = readDraft()
      assert.equal(rewritten.items[0].event_id, 'a1')
      assert.equal(rewritten.items[0].snap_title, 'Old Event')

      // Classifies as unmapped, not a throw -- the exact predicate PlanMap
      // and DayPlanTimeline both use.
      const renderItem = makeItem(draft.items[0].event_id, draft.items[0].snap_start_at, {
        venueName: draft.items[0].snap_venue,
        venueGeo: { lat: draft.items[0].snap_venue_lat ?? null, lng: draft.items[0].snap_venue_lng ?? null },
      })
      assert.equal(isMapped(renderItem), false)
    } finally {
      if (previousLocalStorage === undefined) delete globalThis.localStorage
      else globalThis.localStorage = previousLocalStorage
    }
  })
})

describe('distanceMiles now fires on the draft path (previously always null on /day)', () => {
  it('two consecutive draft items with snapshot coordinates produce a non-null distance', () => {
    const prevGeo = { lat: 41.0814, lng: -81.5190 } // downtown Akron
    const nextGeo = { lat: 41.0928, lng: -81.5501 } // Highland Square, a few miles away
    const miles = distanceMiles(prevGeo, nextGeo)
    assert.ok(miles !== null && miles > 1 && miles < 5, `expected a few miles, got ${miles}`)
  })
})
