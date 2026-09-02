/**
 * test-series-picker.js - the submit form's recurrence picker (ADR-069
 * slice 3): rule derivation from the start date, the horizon cap, the copy a
 * member of the public reads, and the DST behaviour the whole
 * date + time storage shape exists to deliver.
 *
 * TZ is pinned before any import, the same way test-recurrence.js does it and
 * for the same reason: a local-getter regression must surface as a wrong
 * civil date rather than pass by luck on a UTC runner.
 *
 * All logic under test is pure and lives in src/lib/seriesPicker.ts, which
 * Node imports directly (type stripping), the precedent
 * scripts/tests/test-when-filter.js already set for src/lib/*.ts.
 */
process.env.TZ = 'America/New_York'

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  buildSeriesRule, materialiseDates, describeSeries, pickerErrorCopy,
  monthlyOrdinal, daysBetweenYmd, occurrenceEndOffset,
} from '../../src/lib/seriesPicker.ts'
import { easternIsoAt } from '../../src/lib/easternDate.ts'
import {
  validateOrganizerRule, occurrenceSourceId, parseOccurrenceSourceId, addDaysYmd,
} from '../../src/lib/recurrence.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** A picker state, defaulting to "weekly, 12 dates". */
const state = (over = {}) => ({ repeat: 'weekly', endMode: 'count', count: '12', untilYmd: '', ...over })

/** buildSeriesRule, asserting it succeeded. */
function ruleOf(over, dtstart) {
  const built = buildSeriesRule(state(over), dtstart)
  assert.ok(built.ok, `expected a valid rule, got: ${built.ok ? '' : built.reason}`)
  return built
}

/** buildSeriesRule, asserting it failed, returning the reason. */
function reasonOf(over, dtstart) {
  const built = buildSeriesRule(state(over), dtstart)
  assert.equal(built.ok, false, 'expected this rule to be rejected')
  return built.reason
}

// ── a. Every picker choice produces the rrule we expect ──────────────────

describe('buildSeriesRule derives the rule from the start date', () => {
  // 2026-10-06 is a Tuesday and the FIRST Tuesday of October.
  const TU = '2026-10-06'

  it('weekly, 12 dates', () => {
    assert.equal(ruleOf({}, TU).rrule, 'FREQ=WEEKLY;BYDAY=TU;COUNT=12')
  })
  it('every 2 weeks, 12 dates', () => {
    assert.equal(ruleOf({ repeat: 'biweekly' }, TU).rrule, 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=12')
  })
  it('monthly, 6 dates', () => {
    assert.equal(ruleOf({ repeat: 'monthly', count: '6' }, TU).rrule, 'FREQ=MONTHLY;BYDAY=1TU;COUNT=6')
  })
  it('weekly until a date, rendered as YYYYMMDD', () => {
    assert.equal(
      ruleOf({ endMode: 'date', untilYmd: '2026-12-22' }, TU).rrule,
      'FREQ=WEEKLY;BYDAY=TU;UNTIL=20261222',
    )
  })
})

// ── b. Ordinal derivation, including the last-weekday case ───────────────

describe('monthly ordinal derivation', () => {
  it('2026-10-13 is the 2nd Tuesday', () => {
    assert.equal(monthlyOrdinal('2026-10-13'), '2')
    assert.equal(ruleOf({ repeat: 'monthly', count: '6' }, '2026-10-13').rrule, 'FREQ=MONTHLY;BYDAY=2TU;COUNT=6')
  })
  it('2026-10-20 is the 3rd Tuesday', () => {
    assert.equal(monthlyOrdinal('2026-10-20'), '3')
  })
  it('2026-10-27 is the LAST Tuesday, not a 4th (27 + 7 = 34 > 31)', () => {
    assert.equal(monthlyOrdinal('2026-10-27'), '-1')
    assert.equal(ruleOf({ repeat: 'monthly', count: '6' }, '2026-10-27').rrule, 'FREQ=MONTHLY;BYDAY=-1TU;COUNT=6')
  })

  // The documented judgement call: 2026-11-24 is BOTH the 4th and the last
  // Tuesday of a 30-day November, and both '4TU' and '-1TU' would validate.
  // We choose '-1TU' on purpose, because "the last Tuesday of the month" is
  // what an organizer who picked the 24th means, and it keeps the series on
  // the last Tuesday in a 31-day month instead of sliding to the fourth. Do
  // not "fix" this to '4TU'.
  it('2026-11-24 is the LAST Tuesday, deliberately, not the 4th', () => {
    assert.equal(monthlyOrdinal('2026-11-24'), '-1')
    assert.equal(ruleOf({ repeat: 'monthly', count: '4' }, '2026-11-24').rrule, 'FREQ=MONTHLY;BYDAY=-1TU;COUNT=4')
    const built = ruleOf({ repeat: 'monthly', count: '4' }, '2026-11-24')
    const { all } = materialiseDates(built.parts, '2026-11-24', '2026-10-01')
    const copy = describeSeries(state({ repeat: 'monthly', count: '4' }), '2026-11-24', '19:00:00', all)
    assert.match(copy, /^Monthly on the last Tuesday at 7:00 PM,/)
    assert.doesNotMatch(copy, /4th Tuesday/)
  })
})

// ── c. The derivation can never emit a rule the validator rejects ────────

describe('every derived rule passes validateOrganizerRule', () => {
  // Worth more than the rest combined: it is what catches an off-by-one in
  // the ordinal formula against the validator's own acceptance test.
  const days = []
  for (let d = 1; d <= 30; d++) days.push(`2026-11-${String(d).padStart(2, '0')}`)
  for (let d = 1; d <= 28; d++) days.push(`2027-02-${String(d).padStart(2, '0')}`)

  for (const ymd of days) {
    it(`${ymd} weekly and monthly`, () => {
      for (const repeat of ['weekly', 'monthly']) {
        const built = buildSeriesRule(state({ repeat, count: '6' }), ymd)
        assert.ok(built.ok, `${repeat} from ${ymd} was rejected: ${built.ok ? '' : built.reason}`)
        assert.equal(validateOrganizerRule(built.rrule, ymd).ok, true,
          `${built.rrule} from ${ymd} does not validate`)
      }
    })
  }
})

// ── d. Limits and their exact boundaries ─────────────────────────────────

describe('limits', () => {
  const TU = '2026-10-06'

  it('53 dates is refused, with the 52-dates copy', () => {
    const reason = reasonOf({ count: '53' }, TU)
    assert.equal(pickerErrorCopy(reason, TU), 'Pick between 1 and 52 dates.')
  })
  it('0 dates and a non-integer are refused the same way', () => {
    assert.equal(pickerErrorCopy(reasonOf({ count: '0' }, TU), TU), 'Pick between 1 and 52 dates.')
    assert.equal(pickerErrorCopy(reasonOf({ count: '4.5' }, TU), TU), 'Pick between 1 and 52 dates.')
    assert.equal(pickerErrorCopy(reasonOf({ count: '' }, TU), TU), 'Pick between 1 and 52 dates.')
  })
  it('weekly COUNT=52 from 2026-01-06 is accepted (51 steps is 357 days)', () => {
    assert.equal(ruleOf({ count: '52' }, '2026-01-06').rrule, 'FREQ=WEEKLY;BYDAY=TU;COUNT=52')
  })
  it('monthly COUNT=52 is refused by the span rule, with the one-year copy', () => {
    const reason = reasonOf({ repeat: 'monthly', count: '52' }, TU)
    assert.equal(reason, 'series would run past 366 days from dtstart')
    assert.equal(
      pickerErrorCopy(reason, TU),
      'A series can run at most one year from its first date. Pick an end date on or before Oct 7, 2027.',
    )
  })

  // The UNTIL boundary is exercised MONTHLY on purpose: a weekly rule running
  // the full 366 days produces 53 Tuesdays and trips the occurrence cap
  // first, which would test a different rule than the one intended.
  it('UNTIL exactly 366 days out is accepted; one day more is not', () => {
    assert.equal(addDaysYmd(TU, 366), '2027-10-07')
    assert.equal(
      ruleOf({ repeat: 'monthly', endMode: 'date', untilYmd: '2027-10-07' }, TU).rrule,
      'FREQ=MONTHLY;BYDAY=1TU;UNTIL=20271007',
    )
    const reason = reasonOf({ repeat: 'monthly', endMode: 'date', untilYmd: '2027-10-08' }, TU)
    assert.equal(reason, 'UNTIL must be within 366 days of dtstart')
    assert.equal(
      pickerErrorCopy(reason, TU),
      'A series can run at most one year from its first date. Pick an end date on or before Oct 7, 2027.',
    )
  })
  it('UNTIL equal to the start date is refused', () => {
    const reason = reasonOf({ endMode: 'date', untilYmd: TU }, TU)
    assert.equal(pickerErrorCopy(reason, TU), 'The end date has to be after the first date.')
  })
  it('an empty end date is refused before the validator ever runs', () => {
    const reason = reasonOf({ endMode: 'date', untilYmd: '' }, TU)
    assert.equal(pickerErrorCopy(reason, TU), 'Choose the date the series ends.')
  })
  it('an unrecognised reason falls through to the catch-all, never a raw reason', () => {
    const copy = pickerErrorCopy('BYDAY is required', TU)
    assert.equal(
      copy,
      'We could not read that repeat pattern. Pick a different option, or email us the pattern and we will set it up.',
    )
  })
})

// ── e. The horizon cap ───────────────────────────────────────────────────

describe('materialiseDates caps at the 91-day horizon', () => {
  const TODAY = '2026-10-01'   // horizon: 2026-12-31
  const TU = '2026-10-06'

  it('a 20-date weekly series mints the 13 dates inside the horizon', () => {
    const built = ruleOf({ count: '20' }, TU)
    const { all, toMint } = materialiseDates(built.parts, TU, TODAY)
    assert.equal(all.length, 20)
    assert.equal(toMint.length, 13)
    assert.equal(toMint[0], '2026-10-06')
    assert.deepEqual(toMint, [
      '2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27',
      '2026-11-03', '2026-11-10', '2026-11-17', '2026-11-24',
      '2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29',
    ])
    for (const d of toMint) assert.ok(d <= '2026-12-31', `${d} is past the horizon`)
  })

  it('a series starting past the horizon still mints its FIRST date', () => {
    // Not defensive padding: a series with zero occurrence rows can never
    // acquire a template, so the nightly extender would skip it forever and
    // the submission would be silently lost.
    const built = ruleOf({ count: '6' }, '2027-06-01')
    const { all, toMint } = materialiseDates(built.parts, '2027-06-01', TODAY)
    assert.equal(all.length, 6)
    assert.deepEqual(toMint, ['2027-06-01'])
  })

  it('a series that ends inside the horizon mints all of it', () => {
    const built = ruleOf({ count: '4' }, TU)
    const { all, toMint } = materialiseDates(built.parts, TU, TODAY)
    assert.equal(all.length, 4)
    assert.equal(toMint.length, 4)
    const copy = describeSeries(state({ count: '4' }), TU, '19:00:00', all, { mintedCount: toMint.length })
    assert.doesNotMatch(copy, /add the first/)
  })
})

// ── f. DST correctness through easternIsoAt, across 2026-11-01 ───────────

describe('a series keeps its Eastern wall clock across the DST change', () => {
  // The whole justification for storing a civil date + time on event_series
  // instead of a timestamptz. Exact strings, not a computed relationship, so
  // a "clever" refactor of easternIsoAt cannot make the test agree with
  // itself while both are wrong.
  const built = ruleOf({ count: '3' }, '2026-10-27')
  const { all } = materialiseDates(built.parts, '2026-10-27', '2026-10-01')

  it('expands across the fall-back weekend', () => {
    assert.deepEqual(all, ['2026-10-27', '2026-11-03', '2026-11-10'])
  })
  it('19:00 ET is 23:00Z under EDT and 00:00Z the next day under EST', () => {
    assert.equal(easternIsoAt('2026-10-27', '19:00:00'), '2026-10-27T23:00:00.000Z')
    assert.equal(easternIsoAt('2026-11-03', '19:00:00'), '2026-11-04T00:00:00.000Z')
    assert.equal(easternIsoAt('2026-11-10', '19:00:00'), '2026-11-11T00:00:00.000Z')
  })
})

// ── g. Summary copy, exact strings ───────────────────────────────────────

describe('describeSeries copy', () => {
  const TODAY = '2026-10-01'
  const TU = '2026-10-06'

  const summarise = (over, dtstart = TU, opts = {}) => {
    const s = state(over)
    const built = ruleOf(over, dtstart)
    const { all, toMint } = materialiseDates(built.parts, dtstart, TODAY)
    return describeSeries(s, dtstart, '19:00:00', all, { mintedCount: toMint.length, ...opts })
  }

  it('weekly', () => {
    assert.equal(summarise({}), 'Every Tuesday at 7:00 PM, 12 times, ending Dec 22.')
  })
  it('one date is "1 time", not "1 times"', () => {
    assert.equal(summarise({ count: '1' }), 'Every Tuesday at 7:00 PM, 1 time, ending Oct 6.')
  })
  it('every 2 weeks, crossing into the next year, gets the year suffix', () => {
    assert.equal(
      summarise({ repeat: 'biweekly' }),
      'Every other Tuesday at 7:00 PM, 12 times, ending Mar 9, 2027. ' +
      'We will add the first 7 dates now and the rest as each one gets closer.',
    )
  })
  it('monthly on an ordinal weekday', () => {
    assert.equal(
      summarise({ repeat: 'monthly', count: '6' }),
      'Monthly on the 1st Tuesday at 7:00 PM, 6 times, ending Mar 2, 2027. ' +
      'We will add the first 3 dates now and the rest as each one gets closer.',
    )
  })
  it('monthly on the last weekday', () => {
    assert.equal(
      summarise({ repeat: 'monthly', count: '4' }, '2026-11-24'),
      'Monthly on the last Tuesday at 7:00 PM, 4 times, ending Feb 23, 2027. ' +
      'We will add the first 2 dates now and the rest as each one gets closer.',
    )
  })
  it('a single minted date reads "the first date", not "the first 1 dates"', () => {
    assert.equal(
      summarise({ count: '6' }, '2027-06-01'),
      'Every Tuesday at 7:00 PM, 6 times, ending Jul 6. ' +
      'We will add the first date now and the rest as each one gets closer.',
    )
  })
  it('outside Eastern the time carries an explicit ET', () => {
    assert.equal(
      summarise({}, TU, { showZone: true }),
      'Every Tuesday at 7:00 PM ET, 12 times, ending Dec 22.',
    )
  })
  it('the count is the REAL expansion, not the requested COUNT', () => {
    // COUNT=12 with an UNTIL the series never reaches: 8 dates, not 12.
    assert.equal(
      summarise({ endMode: 'date', untilYmd: '2026-11-24' }),
      'Every Tuesday at 7:00 PM, 8 times, ending Nov 24.',
    )
  })
})

// ── h. source_id round trip ──────────────────────────────────────────────

describe('occurrence source_ids round trip', () => {
  it('every minted date survives occurrenceSourceId -> parseOccurrenceSourceId', () => {
    const sid = 'b0000000-0000-4000-8000-0000000069c1'
    const built = ruleOf({ count: '20' }, '2026-10-06')
    const { toMint } = materialiseDates(built.parts, '2026-10-06', '2026-10-01')
    for (const ymd of toMint) {
      assert.deepEqual(parseOccurrenceSourceId(occurrenceSourceId(sid, ymd)), { seriesId: sid, ymd })
    }
  })
})

// ── daysBetweenYmd, the occurrence end-day offset ────────────────────────

describe('daysBetweenYmd', () => {
  it('same day is 0, next day is 1, across a DST change too', () => {
    assert.equal(daysBetweenYmd('2026-10-06', '2026-10-06'), 0)
    assert.equal(daysBetweenYmd('2026-10-06', '2026-10-07'), 1)
    assert.equal(daysBetweenYmd('2026-11-01', '2026-11-02'), 1)
  })
})

// ── occurrenceEndOffset, the "End is not after Start" guard ──────────────

describe('occurrenceEndOffset', () => {
  it('same civil day, later end, is offset 0', () => {
    assert.equal(occurrenceEndOffset('2026-10-06', '19:00:00', '2026-10-06', '21:00:00'), 0)
  })
  it('a 10 PM to 1 AM event is offset 1', () => {
    assert.equal(occurrenceEndOffset('2026-10-06', '22:00:00', '2026-10-07', '01:00:00'), 1)
  })
  it('an end BEFORE the start on the same day is null, not a negative offset', () => {
    // Reapplying a negative offset would mint every occurrence of the series
    // ending before it begins; the caller treats null as "no end supplied".
    assert.equal(occurrenceEndOffset('2026-10-06', '19:00:00', '2026-10-06', '17:00:00'), null)
  })
  it('an end equal to the start is null', () => {
    assert.equal(occurrenceEndOffset('2026-10-06', '19:00:00', '2026-10-06', '19:00:00'), null)
  })
  it('an end on an EARLIER civil day is null', () => {
    assert.equal(occurrenceEndOffset('2026-10-06', '19:00:00', '2026-10-05', '23:00:00'), null)
  })
  it('the offset survives the DST weekend as whole civil days', () => {
    assert.equal(occurrenceEndOffset('2026-10-31', '22:00:00', '2026-11-01', '01:00:00'), 1)
  })
})

// ── i. Textual guard: the review queue still selects series_id ────────────

describe('ReviewQueueSurface still fetches series_id', () => {
  it("SELECT_LIST contains series_id", () => {
    // Without this column every series chip vanishes and every batch action
    // silently degrades to a single row, with no error anywhere.
    const src = readFileSync(new URL('src/pages/admin/review/ReviewQueueSurface.tsx', `file://${ROOT}`), 'utf8')
    const match = src.match(/const SELECT_LIST =([\s\S]*?)\n\n/)
    assert.ok(match, 'expected to find `const SELECT_LIST = ...` in ReviewQueueSurface.tsx')
    assert.ok(match[1].includes('series_id'), 'SELECT_LIST no longer selects series_id')
  })
})
