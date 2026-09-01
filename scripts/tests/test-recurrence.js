/**
 * test-recurrence.js -- unit tests for the shared RRULE engine in
 * src/lib/recurrence.js (ADR-069).
 *
 * The engine is pure civil-date math, so every expectation here is a list
 * of 'YYYY-MM-DD' strings. The DST cases (March and November 2026) pin the
 * whole reason the engine works on calendar dates: a series that spans a
 * clock change must keep stepping seven civil days, and the instant is
 * minted per occurrence by the caller.
 */

// Pinned to the zone the site runs in so a local-getter regression in the
// engine (getDate() instead of getUTCDate()) shows up as a wrong civil date
// in the DST cases below rather than passing by luck on a UTC runner.
process.env.TZ = 'America/New_York'

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import {
  parseRrule, formatRrule, expandRuleDates, validateOrganizerRule,
  occurrenceSourceId, parseOccurrenceSourceId, weekdayOfYmd,
  nthWeekdayOfMonth, addDaysYmd, WEEKDAY_CODE,
  MAX_SERIES_OCCURRENCES, MAX_SERIES_SPAN_DAYS, DEFAULT_HORIZON_DAYS,
} from '../../src/lib/recurrence.js'
import { parseRrule as icsParseRrule } from '../lib/ics.js'

const expand = (rule, dtstart, opts) => expandRuleDates(parseRrule(rule), dtstart, opts)

describe('recurrence: parse / format', () => {
  it('round-trips a canonical rule', () => {
    const parts = parseRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;COUNT=6')
    assert.deepEqual(parts, { FREQ: 'WEEKLY', INTERVAL: '2', BYDAY: 'TH', COUNT: '6' })
    assert.equal(formatRrule(parts), 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;COUNT=6')
    assert.deepEqual(parseRrule(formatRrule(parts)), parts)
  })

  it('formatRrule emits canonical key order, uppercase, no trailing separator', () => {
    assert.equal(
      formatRrule({ COUNT: '3', BYDAY: 'th', FREQ: 'weekly', INTERVAL: '1' }),
      'FREQ=WEEKLY;INTERVAL=1;BYDAY=TH;COUNT=3',
    )
    assert.equal(formatRrule({ UNTIL: '20261231', FREQ: 'MONTHLY', BYDAY: '3SA' }), 'FREQ=MONTHLY;BYDAY=3SA;UNTIL=20261231')
    assert.equal(formatRrule({ FREQ: 'WEEKLY', BYDAY: undefined, COUNT: '' }), 'FREQ=WEEKLY')
  })

  it('exports the constants the migration and the form agree on', () => {
    assert.equal(MAX_SERIES_OCCURRENCES, 52)
    assert.equal(MAX_SERIES_SPAN_DAYS, 366)
    assert.equal(DEFAULT_HORIZON_DAYS, 91)
    assert.deepEqual(WEEKDAY_CODE, { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 })
  })
})

describe('recurrence: WEEKLY expansion', () => {
  it('steps seven civil days across the March DST change', () => {
    assert.deepEqual(expand('FREQ=WEEKLY;BYDAY=TH;COUNT=3', '2026-03-05'), ['2026-03-05', '2026-03-12', '2026-03-19'])
  })

  it('steps seven civil days across the November DST change', () => {
    assert.deepEqual(expand('FREQ=WEEKLY;BYDAY=TH;COUNT=3', '2026-10-29'), ['2026-10-29', '2026-11-05', '2026-11-12'])
  })

  it('INTERVAL=2 alternates weeks anchored on the dtstart Monday-based week', () => {
    // 2026-03-05 is a Thursday; its week's Monday is 03-02.
    assert.deepEqual(expand('FREQ=WEEKLY;BYDAY=TH;INTERVAL=2;COUNT=3', '2026-03-05'), ['2026-03-05', '2026-03-19', '2026-04-02'])
    // Two weekdays, dtstart on the later one: the earlier weekday of the
    // SAME week is before dtstart, so the next hit is two weeks on.
    assert.deepEqual(
      expand('FREQ=WEEKLY;BYDAY=MO,TH;INTERVAL=2;COUNT=4', '2026-03-05'),
      ['2026-03-05', '2026-03-16', '2026-03-19', '2026-03-30'],
    )
  })

  it('UNTIL is inclusive of its civil date', () => {
    assert.deepEqual(expand('FREQ=WEEKLY;BYDAY=TH', '2026-03-05', { untilYmd: '2026-03-19' }), ['2026-03-05', '2026-03-12', '2026-03-19'])
    assert.deepEqual(expand('FREQ=WEEKLY;BYDAY=TH', '2026-03-05', { untilYmd: '2026-03-18' }), ['2026-03-05', '2026-03-12'])
  })

  it('fromYmd hides earlier dates but they still consume COUNT', () => {
    assert.deepEqual(expand('FREQ=WEEKLY;BYDAY=TH;COUNT=3', '2026-03-05', { fromYmd: '2026-03-10' }), ['2026-03-12', '2026-03-19'])
  })

  it('exdates are removed after COUNT accounting', () => {
    assert.deepEqual(expand('FREQ=WEEKLY;BYDAY=TH;COUNT=3', '2026-03-05', { exdates: ['2026-03-12'] }), ['2026-03-05', '2026-03-19'])
  })

  it('maxOccurrences caps the result and defaults to MAX_SERIES_OCCURRENCES', () => {
    assert.deepEqual(expand('FREQ=WEEKLY;BYDAY=TH', '2026-03-05', { maxOccurrences: 2 }), ['2026-03-05', '2026-03-12'])
    const uncapped = expand('FREQ=WEEKLY;BYDAY=TH', '2026-03-05')
    assert.equal(uncapped.length, MAX_SERIES_OCCURRENCES)
    assert.equal(uncapped[51], addDaysYmd('2026-03-05', 51 * 7))
  })
})

describe('recurrence: MONTHLY expansion', () => {
  it('BYDAY=3SA walks the third Saturday of each month', () => {
    assert.deepEqual(expand('FREQ=MONTHLY;BYDAY=3SA;COUNT=4', '2026-09-19'), ['2026-09-19', '2026-10-17', '2026-11-21', '2026-12-19'])
  })

  it('BYDAY=-1SU finds the last Sunday across 28/30/31-day months', () => {
    // Feb 2026 has 28 days (last Sunday 02-22), April 30 (04-26), March 31 (03-29).
    assert.deepEqual(expand('FREQ=MONTHLY;BYDAY=-1SU;COUNT=4', '2026-01-25'), ['2026-01-25', '2026-02-22', '2026-03-29', '2026-04-26'])
    assert.equal(nthWeekdayOfMonth(2026, 2, 0, -1), '2026-02-22')
    assert.equal(nthWeekdayOfMonth(2026, 4, 0, -1), '2026-04-26')
  })

  it('BYDAY=5FR skips months without a fifth Friday and COUNT counts produced dates only', () => {
    // Fifth Fridays in 2026: Jan 30, May 29, Jul 31, Oct 30.
    assert.deepEqual(expand('FREQ=MONTHLY;BYDAY=5FR;COUNT=3', '2026-01-30'), ['2026-01-30', '2026-05-29', '2026-07-31'])
    assert.equal(nthWeekdayOfMonth(2026, 2, 5, 5), null)
  })

  it('BYDAY-less month-end skips short months instead of rolling over', () => {
    assert.deepEqual(expand('FREQ=MONTHLY;COUNT=4', '2026-01-31'), ['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31'])
  })

  it('INTERVAL=2 steps every other month', () => {
    assert.deepEqual(expand('FREQ=MONTHLY;BYDAY=3SA;INTERVAL=2;COUNT=3', '2026-09-19'), ['2026-09-19', '2026-11-21', '2027-01-16'])
  })

  it('multi-token BYDAY applies COUNT per date, not per month', () => {
    // Jan: 01-03 (1SA), 01-25 (-1SU); Feb: 02-07, 02-22; Mar: 03-07 is the 5th.
    assert.deepEqual(
      expand('FREQ=MONTHLY;BYDAY=1SA,-1SU;COUNT=5', '2026-01-03'),
      ['2026-01-03', '2026-01-25', '2026-02-07', '2026-02-22', '2026-03-07'],
    )
  })

  it('multi-token BYDAY applies UNTIL in calendar order regardless of token order', () => {
    // 3SA is listed first but Feb 2 (1MO) precedes Feb 21 (3SA); the UNTIL
    // hit on the Saturday must not hide the Monday.
    assert.deepEqual(
      expand('FREQ=MONTHLY;BYDAY=3SA,1MO', '2026-01-05', { untilYmd: '2026-02-10' }),
      ['2026-01-05', '2026-01-17', '2026-02-02'],
    )
  })
})

describe('recurrence: validateOrganizerRule', () => {
  const ok = (rule, dt) => assert.equal(validateOrganizerRule(rule, dt).ok, true, `${rule} @ ${dt}`)
  const bad = (rule, dt, needle) => {
    const res = validateOrganizerRule(rule, dt)
    assert.equal(res.ok, false, `${rule} @ ${dt} should be rejected`)
    if (needle) assert.match(res.reason, needle)
  }

  it('accepts the organizer subset', () => {
    ok('FREQ=WEEKLY;BYDAY=TH;COUNT=6', '2026-03-05')
    ok('FREQ=WEEKLY;INTERVAL=4;BYDAY=TH;UNTIL=20260604', '2026-03-05')
    ok('FREQ=MONTHLY;BYDAY=3SA;COUNT=4', '2026-09-19')
    ok('FREQ=MONTHLY;BYDAY=-1SU;COUNT=4', '2026-01-25')
    // 2026-09-26 is both the 4th and the last Saturday of September.
    ok('FREQ=MONTHLY;BYDAY=4SA;COUNT=2', '2026-09-26')
    ok('FREQ=MONTHLY;BYDAY=-1SA;COUNT=2', '2026-09-26')
    assert.deepEqual(validateOrganizerRule('FREQ=WEEKLY;BYDAY=TH;COUNT=6', '2026-03-05'), {
      ok: true, parts: { FREQ: 'WEEKLY', BYDAY: 'TH', COUNT: '6' }, rrule: 'FREQ=WEEKLY;BYDAY=TH;COUNT=6',
    })
  })

  it('only accepts the canonical text the 069 CHECK accepts', () => {
    bad('freq=WEEKLY;BYDAY=TH;COUNT=6', '2026-03-05', /canonical/)
    bad('FREQ=WEEKLY; BYDAY=TH; COUNT=6', '2026-03-05', /canonical/)
    bad('BYDAY=TH;FREQ=WEEKLY;COUNT=6', '2026-03-05', /canonical/)
    bad('FREQ=WEEKLY;BYDAY=TH;COUNT=6;', '2026-03-05', /canonical/)
    const res = validateOrganizerRule('FREQ=WEEKLY;BYDAY=TH;COUNT=6', '2026-03-05')
    assert.equal(res.ok && res.rrule, 'FREQ=WEEKLY;BYDAY=TH;COUNT=6')
  })

  it('bounds the expanded series, not only COUNT and UNTIL individually', () => {
    // 52 monthly occurrences is four years; the span check catches it.
    bad('FREQ=MONTHLY;BYDAY=1MO;COUNT=52', '2026-01-05', /366 days/)
    // INTERVAL=4 monthly with COUNT=52 would run out the month-step guard
    // and silently truncate; it is refused up front instead.
    bad('FREQ=MONTHLY;INTERVAL=4;BYDAY=1MO;COUNT=52', '2026-01-05', /366 days/)
    // A weekly UNTIL exactly a year and a day out yields 53 dates.
    bad('FREQ=WEEKLY;BYDAY=MO;UNTIL=20270106', '2026-01-05', /52 occurrences/)
    ok('FREQ=WEEKLY;BYDAY=MO;UNTIL=20261228', '2026-01-05')
    ok('FREQ=MONTHLY;BYDAY=1MO;COUNT=12', '2026-01-05')
  })

  it('rejects everything outside the subset with a reason', () => {
    bad('FREQ=WEEKLY;BYDAY=FR;COUNT=6', '2026-03-05', /weekday/)
    bad('FREQ=WEEKLY;BYDAY=TH;INTERVAL=5;COUNT=6', '2026-03-05', /INTERVAL/)
    bad('FREQ=WEEKLY;BYDAY=TH;COUNT=53', '2026-03-05', /COUNT/)
    bad('FREQ=WEEKLY;BYDAY=TH;UNTIL=20270308', '2026-03-05', /366/)
    bad('FREQ=WEEKLY;BYDAY=TH;UNTIL=20260304', '2026-03-05', /after dtstart/)
    bad('FREQ=WEEKLY;BYDAY=TH;COUNT=6;UNTIL=20260604', '2026-03-05', /exactly one/)
    bad('FREQ=WEEKLY;BYDAY=TH', '2026-03-05', /exactly one/)
    bad('FREQ=DAILY;COUNT=6', '2026-03-05', /FREQ/)
    bad('FREQ=WEEKLY;BYDAY=TH;COUNT=6;BYHOUR=19', '2026-03-05', /BYHOUR/)
    bad('FREQ=MONTHLY;BYDAY=2SA;COUNT=4', '2026-09-19', /position/)
    bad('FREQ=MONTHLY;BYDAY=3SA,1SA;COUNT=4', '2026-09-19', /one ordinal/)
    bad('FREQ=WEEKLY;BYDAY=TH;COUNT=6', '2026-02-30', /civil date/)
  })
})

describe('recurrence: source ids and stability', () => {
  it('occurrenceSourceId round-trips through parseOccurrenceSourceId', () => {
    const id = 'b0000000-0000-4000-8000-00000000c069'
    const sid = occurrenceSourceId(id, '2026-10-01')
    assert.equal(sid, `series:${id}:2026-10-01`)
    assert.deepEqual(parseOccurrenceSourceId(sid), { seriesId: id, ymd: '2026-10-01' })
    assert.equal(parseOccurrenceSourceId('the-grove-x-2026-01-01'), null)
    assert.equal(parseOccurrenceSourceId(null), null)
  })

  it('re-expansion with fromYmd advanced by a week is a strict suffix of the first run', () => {
    const rule = 'FREQ=WEEKLY;BYDAY=TH;COUNT=10'
    const first = expand(rule, '2026-03-05', { fromYmd: '2026-03-01' })
    const second = expand(rule, '2026-03-05', { fromYmd: addDaysYmd('2026-03-01', 7) })
    assert.ok(second.length > 0 && second.length < first.length)
    assert.deepEqual(second, first.slice(first.length - second.length))
  })

  it('returns [] once fromYmd is past UNTIL', () => {
    assert.deepEqual(expand('FREQ=WEEKLY;BYDAY=TH', '2026-03-05', { fromYmd: '2026-03-20', untilYmd: '2026-03-19' }), [])
  })

  it('weekdayOfYmd and addDaysYmd are plain civil arithmetic', () => {
    assert.equal(weekdayOfYmd('2026-03-05'), 4)
    assert.equal(addDaysYmd('2026-02-28', 1), '2026-03-01')
    assert.equal(addDaysYmd('2026-03-01', -1), '2026-02-28')
  })

  it('drift guard: ics.js re-exports the very same parseRrule', () => {
    assert.equal(icsParseRrule, parseRrule)
  })
})
