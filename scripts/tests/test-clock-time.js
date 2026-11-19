/** test-clock-time.js — strict clock-time and month-name parsing. */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MONTHS, MONTH_RE, monthNumber, parseClockTime } from '../lib/clock-time.js'

describe('parseClockTime', () => {
  it('reads 12-hour times with or without minutes, spaces and dots', () => {
    assert.deepEqual(parseClockTime('7:30 PM'), { time: '7:30 pm', hhmm: '1930' })
    assert.deepEqual(parseClockTime('7:30pm'), { time: '7:30 pm', hhmm: '1930' })
    assert.deepEqual(parseClockTime(' 2 PM '), { time: '2:00 pm', hhmm: '1400' })
    assert.deepEqual(parseClockTime('7 p.m.'), { time: '7:00 pm', hhmm: '1900' })
    assert.deepEqual(parseClockTime('10:05 am'), { time: '10:05 am', hhmm: '1005' })
  })

  it('gets noon and midnight right', () => {
    assert.equal(parseClockTime('12:00 pm').hhmm, '1200')
    assert.equal(parseClockTime('12:30 a.m.').hhmm, '0030')
  })

  it('returns null for anything that is not exactly one clock time', () => {
    for (const t of ['', 'evening', '7:30', '13:00 pm', '0 pm', '7:60 pm', '7pm sharp', '7-9 pm', 'doors 7 pm', null, undefined]) {
      assert.equal(parseClockTime(t ?? undefined), null, String(t))
    }
  })
})

describe('months', () => {
  it('maps full names, abbreviations and a trailing period', () => {
    assert.equal(monthNumber('November'), 11)
    assert.equal(monthNumber('nov'), 11)
    assert.equal(monthNumber('Sept.'), 9)
    assert.equal(monthNumber('MAY'), 5)
  })

  it('refuses ambiguous or unknown names', () => {
    for (const n of ['', 'J', 'Ju', 'Ma', 'Smarch', 'Monday']) assert.equal(monthNumber(n), null, n)
  })

  it('MONTH_RE matches every month name', () => {
    const re = new RegExp(`^(?:${MONTH_RE})$`)
    for (const m of Object.keys(MONTHS)) assert.match(m, re)
  })
})
