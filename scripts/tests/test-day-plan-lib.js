/**
 * test-day-plan-lib.js — pure-logic unit tests for the day planner's
 * frontend lib modules: Eastern-date grouping, the analytics path
 * redaction (the non-negotiable GA4 leak fix), local-draft mutation, and
 * the overlap/gap/distance calculations.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { easternDateKey, easternTodayIso, isEasternToday, easternDateKeyDiffDays } from '../../src/lib/dayPlanDate.ts'
import { redactPath } from '../../src/lib/planPathRedaction.ts'
import {
  emptyDraft,
  addItemToDraft,
  removeItemFromDraft,
  isItemInDraft,
  setDraftTitle,
  MAX_ITEMS,
} from '../../src/lib/dayPlanDraft.ts'
import { findOverlaps, gapMinutes, distanceMiles } from '../../src/lib/dayPlanGap.ts'

describe('easternDateKey: the classic 11:30pm-Eastern-crossing-into-tomorrow-UTC bug', () => {
  it('a 2026-08-15 23:30 ET event stays under Aug 15, not Aug 16 (EDT, UTC-4)', () => {
    // 2026-08-15T23:30:00 EDT == 2026-08-16T03:30:00Z.
    assert.equal(easternDateKey('2026-08-16T03:30:00.000Z'), '2026-08-15')
  })

  it('a midnight-UTC instant that is still evening Eastern the day before groups correctly', () => {
    // 2026-01-15T00:00:00Z == 2026-01-14T19:00:00 EST (UTC-5).
    assert.equal(easternDateKey('2026-01-15T00:00:00.000Z'), '2026-01-14')
  })

  it('accepts a Date object identically to an ISO string', () => {
    const iso = '2026-06-01T12:00:00.000Z'
    assert.equal(easternDateKey(new Date(iso)), easternDateKey(iso))
  })
})

describe('easternTodayIso / isEasternToday', () => {
  it('easternTodayIso matches easternDateKey(now)', () => {
    assert.equal(easternTodayIso(), easternDateKey(new Date()))
  })

  it('isEasternToday is true for right now and false for a date far in the past', () => {
    assert.equal(isEasternToday(new Date().toISOString()), true)
    assert.equal(isEasternToday('2020-01-01T12:00:00.000Z'), false)
  })
})

describe('easternDateKeyDiffDays', () => {
  it('counts whole days between two date keys, either direction', () => {
    assert.equal(easternDateKeyDiffDays('2026-08-15', '2026-08-18'), 3)
    assert.equal(easternDateKeyDiffDays('2026-08-18', '2026-08-15'), -3)
    assert.equal(easternDateKeyDiffDays('2026-08-15', '2026-08-15'), 0)
  })
})

describe('redactPath: the plan-code-in-GA4 leak (non-negotiable fix)', () => {
  // QA (2026-08-08) FAIL: the previous `$`-anchored, exact-single-segment
  // regex leaked the full code on most shapes below. The fix is a PREFIX
  // match on `/d/` — there are no nested routes under `/d/<code>` by design,
  // so any path starting with `/d/` is treated as sensitive, full stop.
  // Verified against the pre-fix regex (`^\/d\/[0-9a-hjkmnp-tv-z]{12}\/?$`,
  // matched against `path.split('?')[0]`) before applying this fix: the
  // nested-segment, uppercase, double-slash, wrong-length, whitespace, and
  // wrong-shape cases below all leaked the raw path. The `?utm=x` and
  // trailing-slash cases already redacted correctly under the old regex too
  // (the old code already split off the query string and allowed a trailing
  // slash) — kept here as regression coverage, not because they were broken.
  it('redacts a well-formed plan code path', () => {
    assert.equal(redactPath('/d/7k3m9qx2vbn4'), '/d/(code)')
  })
  it('redacts with a trailing slash too', () => {
    assert.equal(redactPath('/d/7k3m9qx2vbn4/'), '/d/(code)')
  })
  it('redacts with a query string', () => {
    assert.equal(redactPath('/d/7k3m9qx2vbn4?utm=x'), '/d/(code)')
  })
  it('redacts with a fragment', () => {
    assert.equal(redactPath('/d/7k3m9qx2vbn4#frag'), '/d/(code)')
  })
  it('redacts a nested/trailing segment — the reachable-in-ordinary-use case: React Router only ' +
     'matches /d/:code as an exact single segment, so a fat-fingered trailing segment or a chat ' +
     'client autolinker grabbing trailing text renders NotFound but must still redact', () => {
    assert.equal(redactPath('/d/7k3m9qx2vbn4/anything'), '/d/(code)')
  })
  it('redacts an uppercase code', () => {
    assert.equal(redactPath('/d/7K3M9QX2VBN4'), '/d/(code)')
  })
  it('redacts a double slash', () => {
    assert.equal(redactPath('/d//7k3m9qx2vbn4'), '/d/(code)')
  })
  it('redacts a 13-char (wrong-length) code', () => {
    assert.equal(redactPath('/d/7k3m9qx2vbn4x'), '/d/(code)')
  })
  it('redacts a whitespace-padded path', () => {
    assert.equal(redactPath('  /d/7k3m9qx2vbn4  '), '/d/(code)')
  })
  it('redacts a code-shaped-but-wrong-length segment (over-redaction is the deliberately safe ' +
     'direction now — see planPathRedaction.ts header)', () => {
    assert.equal(redactPath('/d/short'), '/d/(code)')
  })
  it('redacts any /d/ prefixed path, even one that is not code-shaped at all', () => {
    assert.equal(redactPath('/d/not-a-real-code-at-all'), '/d/(code)')
  })
  it('leaves an unrelated path unchanged', () => {
    assert.equal(redactPath('/events/jazz-night/abc123'), '/events/jazz-night/abc123')
  })
  it('leaves /day unchanged (no code in that path, and /day does not share the /d/ prefix)', () => {
    assert.equal(redactPath('/day'), '/day')
  })
  it('leaves /day?e=... unchanged', () => {
    assert.equal(redactPath('/day?e=abc123'), '/day?e=abc123')
  })
})

describe('dayPlanDraft: local draft mutation', () => {
  const event = (id, startAt) => ({ id, title: `Event ${id}`, start_at: startAt, end_at: null, venue: { name: 'Test Venue' } })

  it('addItemToDraft adds a new item and snapshots its fields', () => {
    const next = addItemToDraft(emptyDraft(), event('a', '2026-08-15T19:00:00.000Z'))
    assert.equal(next.items.length, 1)
    assert.equal(next.items[0].event_id, 'a')
    assert.equal(next.items[0].snap_title, 'Event a')
    assert.equal(next.items[0].snap_venue, 'Test Venue')
  })

  it('re-adding the same event preserves the original added_at', () => {
    const first = addItemToDraft(emptyDraft(), event('a', '2026-08-15T19:00:00.000Z'))
    const originalAddedAt = first.items[0].added_at
    const second = addItemToDraft(first, event('a', '2026-08-15T20:00:00.000Z'))
    assert.equal(second.items[0].added_at, originalAddedAt)
    assert.equal(second.items[0].snap_start_at, '2026-08-15T20:00:00.000Z', 'the snapshot itself should refresh')
  })

  it('refuses to add a 31st distinct item and returns null', () => {
    let draft = emptyDraft()
    for (let i = 0; i < MAX_ITEMS; i++) {
      draft = addItemToDraft(draft, event(`e${i}`, '2026-08-15T19:00:00.000Z'))
    }
    assert.equal(draft.items.length, MAX_ITEMS)
    const result = addItemToDraft(draft, event('one-too-many', '2026-08-15T19:00:00.000Z'))
    assert.equal(result, null)
  })

  it('removeItemFromDraft hard-splices the item (no tombstone — see this module\'s own header)', () => {
    const withItem = addItemToDraft(emptyDraft(), event('a', '2026-08-15T19:00:00.000Z'))
    const removed = removeItemFromDraft(withItem, 'a')
    assert.equal(removed.items.length, 0)
  })

  it('isItemInDraft reflects membership', () => {
    const withItem = addItemToDraft(emptyDraft(), event('a', '2026-08-15T19:00:00.000Z'))
    assert.equal(isItemInDraft(withItem, 'a'), true)
    assert.equal(isItemInDraft(withItem, 'b'), false)
  })

  it('setDraftTitle trims, caps at 80 chars, and treats blank as null', () => {
    assert.equal(setDraftTitle(emptyDraft(), '  My Plan  ').title, 'My Plan')
    assert.equal(setDraftTitle(emptyDraft(), '   ').title, null)
    assert.equal(setDraftTitle(emptyDraft(), 'x'.repeat(200)).title.length, 80)
  })
})

describe('dayPlanGap: overlap flagging is conservative (only when BOTH end_at values exist)', () => {
  it('flags two events with overlapping [start,end) windows', () => {
    const items = [
      { event_id: 'a', start_at: '2026-08-15T19:00:00.000Z', end_at: '2026-08-15T21:00:00.000Z' },
      { event_id: 'b', start_at: '2026-08-15T20:00:00.000Z', end_at: '2026-08-15T22:00:00.000Z' },
    ]
    const overlaps = findOverlaps(items)
    assert.equal(overlaps.length, 1)
    assert.deepEqual([overlaps[0].aId, overlaps[0].bId].sort(), ['a', 'b'])
  })

  it('does NOT flag two adjacent (touching, non-overlapping) events', () => {
    const items = [
      { event_id: 'a', start_at: '2026-08-15T19:00:00.000Z', end_at: '2026-08-15T21:00:00.000Z' },
      { event_id: 'b', start_at: '2026-08-15T21:00:00.000Z', end_at: '2026-08-15T22:00:00.000Z' },
    ]
    assert.equal(findOverlaps(items).length, 0)
  })

  it('never flags an event with a null end_at, even if another event starts during its assumed block', () => {
    const items = [
      { event_id: 'a', start_at: '2026-08-15T19:00:00.000Z', end_at: null },
      { event_id: 'b', start_at: '2026-08-15T19:30:00.000Z', end_at: '2026-08-15T20:30:00.000Z' },
    ]
    assert.equal(findOverlaps(items).length, 0, 'a null end_at must never be treated as an assumed block for overlap purposes')
  })
})

describe('dayPlanGap: gapMinutes', () => {
  it('computes minutes between the end of one item and the start of the next', () => {
    const prev = { event_id: 'a', start_at: '2026-08-15T19:00:00.000Z', end_at: '2026-08-15T20:00:00.000Z' }
    const next = { event_id: 'b', start_at: '2026-08-15T20:18:00.000Z', end_at: null }
    assert.equal(gapMinutes(prev, next), 18)
  })

  it('returns null when the next item has no start_at', () => {
    const prev = { event_id: 'a', start_at: '2026-08-15T19:00:00.000Z', end_at: '2026-08-15T20:00:00.000Z' }
    assert.equal(gapMinutes(prev, { event_id: 'b', start_at: null, end_at: null }), null)
  })
})

describe('dayPlanGap: distanceMiles', () => {
  it('computes a plausible haversine distance between two known Akron-area points', () => {
    // Lock 3 (downtown Akron) to roughly Highland Square — a few miles.
    const miles = distanceMiles({ lat: 41.0814, lng: -81.5190 }, { lat: 41.0928, lng: -81.5501 })
    assert.ok(miles !== null && miles > 1 && miles < 5, `expected a few miles, got ${miles}`)
  })

  it('returns null (never a placeholder) when either venue lacks coordinates', () => {
    assert.equal(distanceMiles(null, { lat: 41, lng: -81 }), null)
    assert.equal(distanceMiles({ lat: 41, lng: -81 }, { lat: null, lng: null }), null)
  })
})
