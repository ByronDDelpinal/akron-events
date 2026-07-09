/**
 * test-weekly-occurrences.js — tests for lib/weekly-occurrences.js
 *
 * The critical cases are the evening-Eastern UTC-rollover (a 10:30 pm ET
 * Wednesday run is already Thursday in UTC — "next Wednesday" must still
 * anchor to the ET Wednesday) and DST boundaries.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { nextWeeklyOccurrences, easternTodayYmd, WEEKDAY } from '../lib/weekly-occurrences.js'

describe('weekly-occurrences: easternTodayYmd', () => {
  it('reports the Eastern calendar date, not the UTC one, for evening runs', () => {
    // 2026-07-09T02:30Z = Wed 2026-07-08 10:30 pm EDT
    assert.equal(easternTodayYmd(new Date('2026-07-09T02:30:00Z')), '2026-07-08')
  })

  it('matches the UTC date during Eastern daytime', () => {
    // 2026-07-08T15:00Z = Wed 2026-07-08 11:00 am EDT
    assert.equal(easternTodayYmd(new Date('2026-07-08T15:00:00Z')), '2026-07-08')
  })
})

describe('weekly-occurrences: nextWeeklyOccurrences', () => {
  it('generates consecutive same-weekday dates starting from the next match', () => {
    // Thu 2026-07-09 (ET) → next Wednesday is 2026-07-15
    const dates = nextWeeklyOccurrences(WEEKDAY.wednesday, {
      count: 4, now: new Date('2026-07-09T15:00:00Z'),
    })
    assert.deepEqual(dates, ['2026-07-15', '2026-07-22', '2026-07-29', '2026-08-05'])
  })

  it('includes today by default when today is the target weekday', () => {
    // Thu 2026-07-09 (ET), asking for Thursdays
    const dates = nextWeeklyOccurrences(WEEKDAY.thursday, {
      count: 2, now: new Date('2026-07-09T15:00:00Z'),
    })
    assert.deepEqual(dates, ['2026-07-09', '2026-07-16'])
  })

  it('skips today when includeToday is false', () => {
    const dates = nextWeeklyOccurrences(WEEKDAY.thursday, {
      count: 2, now: new Date('2026-07-09T15:00:00Z'), includeToday: false,
    })
    assert.deepEqual(dates, ['2026-07-16', '2026-07-23'])
  })

  it('anchors to the Eastern date across the UTC midnight rollover', () => {
    // 2026-07-09T02:30Z is still Wed 2026-07-08 in ET. "Next Wednesday"
    // must be TODAY (ET Wednesday), not the UTC-Thursday-derived 07-15.
    const dates = nextWeeklyOccurrences(WEEKDAY.wednesday, {
      count: 2, now: new Date('2026-07-09T02:30:00Z'),
    })
    assert.deepEqual(dates, ['2026-07-08', '2026-07-15'])
  })

  it('steps cleanly across the fall-back DST boundary (Nov 1 2026)', () => {
    // Thu 2026-10-29 ET → Thursdays: Oct 29, Nov 5 (crosses fall-back Nov 1)
    const dates = nextWeeklyOccurrences(WEEKDAY.thursday, {
      count: 2, now: new Date('2026-10-29T15:00:00Z'),
    })
    assert.deepEqual(dates, ['2026-10-29', '2026-11-05'])
  })

  it('steps cleanly across the spring-forward DST boundary (Mar 8 2026)', () => {
    // Wed 2026-03-04 ET → Wednesdays: Mar 4, Mar 11 (crosses spring-forward Mar 8)
    const dates = nextWeeklyOccurrences(WEEKDAY.wednesday, {
      count: 2, now: new Date('2026-03-04T15:00:00Z'),
    })
    assert.deepEqual(dates, ['2026-03-04', '2026-03-11'])
  })

  it('crosses month and year boundaries', () => {
    // Wed 2026-12-30 ET → Wednesdays: Dec 30, Jan 6 2027
    const dates = nextWeeklyOccurrences(WEEKDAY.wednesday, {
      count: 2, now: new Date('2026-12-30T15:00:00Z'),
    })
    assert.deepEqual(dates, ['2026-12-30', '2027-01-06'])
  })

  it('rejects out-of-range weekday values', () => {
    assert.throws(() => nextWeeklyOccurrences(7), RangeError)
    assert.throws(() => nextWeeklyOccurrences(-1), RangeError)
    assert.throws(() => nextWeeklyOccurrences(2.5), RangeError)
  })
})
