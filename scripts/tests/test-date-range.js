/**
 * test-date-range.js — tests for the shared date-range preset resolver in
 * src/lib/dateRange.js. Guards the weekday-boundary logic that powers the
 * "Today / This weekend / This week / This month" filters on both the list and
 * map views.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { dateRangeBounds } from '../../src/lib/dateRange.js'

/** Build a local-time Date for a given Y-M-D at noon (stable, DST-safe). */
function at(y, m, d, hh = 12) {
  return new Date(y, m - 1, d, hh, 0, 0, 0)
}

/** 'YYYY-MM-DD' of a Date in local time. */
function ymd(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

describe('dateRangeBounds: today', () => {
  it('spans midnight to end-of-day on the reference date', () => {
    const now = at(2026, 6, 17) // a Wednesday
    const { start, end } = dateRangeBounds('today', now)
    assert.equal(ymd(start), '2026-06-17')
    assert.equal(ymd(end), '2026-06-17')
    assert.equal(start.getHours(), 0)
    assert.equal(end.getHours(), 23)
  })
})

describe('dateRangeBounds: this_weekend', () => {
  // June 2026: 19th = Fri, 20th = Sat, 21st = Sun.
  it('from a weekday, runs Friday 4pm through Sunday', () => {
    const now = at(2026, 6, 17) // Wednesday
    const { start, end } = dateRangeBounds('this_weekend', now)
    assert.equal(ymd(start), '2026-06-19') // Friday
    assert.equal(start.getHours(), 16)     // 4pm
    assert.equal(ymd(end), '2026-06-21')   // Sunday
    assert.equal(end.getHours(), 23)
  })

  it('on Friday, starts today at 4pm', () => {
    const now = at(2026, 6, 19) // Friday
    const { start, end } = dateRangeBounds('this_weekend', now)
    assert.equal(ymd(start), '2026-06-19')
    assert.equal(start.getHours(), 16)
    assert.equal(ymd(end), '2026-06-21')
  })

  it('on Saturday, anchors to this weekend’s Friday (not next week)', () => {
    const now = at(2026, 6, 20) // Saturday
    const { start, end } = dateRangeBounds('this_weekend', now)
    assert.equal(ymd(start), '2026-06-19') // Friday of this weekend
    assert.equal(ymd(end), '2026-06-21')   // Sunday
  })

  it('on Sunday, still spans this weekend (Fri–Sun)', () => {
    const now = at(2026, 6, 21) // Sunday
    const { start, end } = dateRangeBounds('this_weekend', now)
    assert.equal(ymd(start), '2026-06-19')
    assert.equal(ymd(end), '2026-06-21')
  })
})

describe('dateRangeBounds: this_week', () => {
  it('from a weekday, runs from today through the coming Sunday', () => {
    const now = at(2026, 6, 17) // Wednesday
    const { start, end } = dateRangeBounds('this_week', now)
    assert.equal(ymd(start), '2026-06-17')
    assert.equal(ymd(end), '2026-06-21') // Sunday
  })

  it('on Sunday, ends today rather than rolling a week forward (regression)', () => {
    const now = at(2026, 6, 21) // Sunday
    const { start, end } = dateRangeBounds('this_week', now)
    assert.equal(ymd(start), '2026-06-21')
    assert.equal(ymd(end), '2026-06-21') // not 2026-06-28
  })

  it('on Saturday, ends tomorrow (Sunday)', () => {
    const now = at(2026, 6, 20) // Saturday
    const { start, end } = dateRangeBounds('this_week', now)
    assert.equal(ymd(start), '2026-06-20')
    assert.equal(ymd(end), '2026-06-21')
  })
})

describe('dateRangeBounds: this_month', () => {
  it('spans the first through the last day of the reference month', () => {
    const now = at(2026, 6, 17)
    const { start, end } = dateRangeBounds('this_month', now)
    assert.equal(ymd(start), '2026-06-17') // start stays at "now"; lower bound is today
    assert.equal(ymd(end), '2026-06-30')   // last day of June
  })

  it('handles month rollover (Jan 31 → end of Jan, not Feb)', () => {
    const now = at(2026, 1, 31)
    const { end } = dateRangeBounds('this_month', now)
    assert.equal(ymd(end), '2026-01-31')
  })
})

describe('dateRangeBounds: every weekday is covered for weekend/week', () => {
  it('weekend always starts Friday 4pm and ends Sunday', () => {
    // Walk a full week (June 15 Mon … June 21 Sun).
    for (let d = 15; d <= 21; d++) {
      const now = at(2026, 6, d)
      const { start, end } = dateRangeBounds('this_weekend', now)
      assert.equal(start.getDay(), 5, `start dow for day ${d} should be Friday`)
      assert.equal(start.getHours(), 16, `start hour for day ${d} should be 4pm`)
      assert.equal(end.getDay(), 0, `weekend end for day ${d} should be Sunday`)
      assert.ok(end > start, `end after start for day ${d}`)
    }
  })
})
