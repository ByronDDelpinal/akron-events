/**
 * test-event-grouping.js — pure-logic tests for the day-group helpers in
 * src/lib/eventGrouping.ts, focused on sortFeaturedFirst: within one day
 * group, featured events order ahead of every non-featured event; featured
 * events keep start_at order among themselves; non-featured keep theirs;
 * a day with no featured events passes through as the SAME array reference
 * (so the common path is byte-identical to the pre-sort behavior).
 *
 * Run:  node --test scripts/tests/test-event-grouping.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { groupEventsByDate, sortFeaturedFirst } from '../../src/lib/eventGrouping.ts'

/**
 * Build a minimal groupable event. Times are noon-UTC-anchored so the
 * local-timezone dateKey in groupEventsByDate lands on the same calendar
 * day in any US or UTC test environment.
 */
function ev(id, startAt, featured = false, source = 'src_a') {
  return { id, start_at: startAt, featured, source }
}

const ids = (events) => events.map((e) => e.id)

describe('sortFeaturedFirst', () => {
  it('day with 0 featured events returns the same array reference, order untouched', () => {
    const day = [
      ev('a', '2026-08-15T12:00:00Z'),
      ev('b', '2026-08-15T14:00:00Z'),
      ev('c', '2026-08-15T16:00:00Z'),
    ]
    const out = sortFeaturedFirst(day)
    assert.equal(out, day) // identity, not just deep-equality
    assert.deepEqual(ids(out), ['a', 'b', 'c'])
  })

  it('single featured event mid-day moves to the front; others keep order', () => {
    const day = [
      ev('early', '2026-08-15T12:00:00Z'),
      ev('star', '2026-08-15T15:00:00Z', true),
      ev('late', '2026-08-15T19:00:00Z'),
    ]
    const out = sortFeaturedFirst(day)
    assert.deepEqual(ids(out), ['star', 'early', 'late'])
  })

  it('two featured events lead the day and keep start_at order among themselves', () => {
    const day = [
      ev('a', '2026-08-15T12:00:00Z'),
      ev('f1', '2026-08-15T13:00:00Z', true),
      ev('b', '2026-08-15T14:00:00Z'),
      ev('f2', '2026-08-15T17:00:00Z', true),
      ev('c', '2026-08-15T18:00:00Z'),
    ]
    const out = sortFeaturedFirst(day)
    assert.deepEqual(ids(out), ['f1', 'f2', 'a', 'b', 'c'])
  })

  it('featured event already first is a pure pass-through of order', () => {
    const day = [
      ev('f1', '2026-08-15T12:00:00Z', true),
      ev('a', '2026-08-15T13:00:00Z'),
      ev('b', '2026-08-15T15:00:00Z'),
    ]
    assert.deepEqual(ids(sortFeaturedFirst(day)), ['f1', 'a', 'b'])
  })

  it('does not mutate its input', () => {
    const day = [
      ev('a', '2026-08-15T12:00:00Z'),
      ev('f1', '2026-08-15T15:00:00Z', true),
    ]
    sortFeaturedFirst(day)
    assert.deepEqual(ids(day), ['a', 'f1'])
  })

  it('null / missing featured are treated as non-featured', () => {
    const day = [
      { id: 'n1', start_at: '2026-08-15T12:00:00Z', featured: null, source: 'src_a' },
      { id: 'n2', start_at: '2026-08-15T13:00:00Z', source: 'src_a' },
      ev('f1', '2026-08-15T16:00:00Z', true),
    ]
    assert.deepEqual(ids(sortFeaturedFirst(day)), ['f1', 'n1', 'n2'])
  })
})

describe('sortFeaturedFirst applied per day group (multi-day)', () => {
  it('reorders only days that contain featured events; other days keep identity', () => {
    const events = [
      // Day 1: no featured
      ev('d1a', '2026-08-15T12:00:00Z'),
      ev('d1b', '2026-08-15T15:00:00Z'),
      // Day 2: featured mid-day
      ev('d2a', '2026-08-16T12:00:00Z'),
      ev('d2f', '2026-08-16T15:00:00Z', true),
      ev('d2b', '2026-08-16T18:00:00Z'),
      // Day 3: no featured
      ev('d3a', '2026-08-17T12:00:00Z'),
    ]
    const grouped = groupEventsByDate(events).map(
      ([dateKey, dayEvents]) => [dateKey, sortFeaturedFirst(dayEvents)],
    )
    assert.equal(grouped.length, 3)

    const [[, day1], [, day2], [, day3]] = grouped
    assert.deepEqual(ids(day1), ['d1a', 'd1b'])
    assert.deepEqual(ids(day2), ['d2f', 'd2a', 'd2b'])
    assert.deepEqual(ids(day3), ['d3a'])

    // A featured event never crosses its day boundary.
    assert.ok(!ids(day1).includes('d2f'))
    assert.ok(!ids(day3).includes('d2f'))
  })
})
