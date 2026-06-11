/**
 * test-visit-akron-cvb.js
 *
 * Unit tests for the Visit Akron CVB (Simpleview rest_v2) scraper's date
 * handling. Regression coverage for the 2026-06-11 off-by-one bug: the feed's
 * `date`/`nextDate`/`endDate` fields carry END-of-day Eastern timestamps
 * ("2026-06-21T03:59:59.000Z" = Jun 20 23:59:59 EDT) and a naive
 * `iso.slice(0, 10)` read the UTC date, shifting every event +1 calendar day.
 *
 * Run:
 *   node --test scripts/tests/test-visit-akron-cvb.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Set dummy env vars before any imports ───────────────────────────────────
process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  etCalendarDate,
  buildStartEnd,
  useEndDatePart,
  easternLocalToUtcIso,
  isEDT,
} from '../scrape-visit-akron-cvb.js'

// ── Fixtures ─────────────────────────────────────────────────────────────────

// Captured verbatim from the live rest_v2 API on 2026-06-11 (recid 1231).
// CVB site displays: Saturday June 20, 2026, 8:00 PM – 11:00 PM ET.
const DANCE_PARTY = {
  recid: '1231',
  cms_title: "NCCAkron presents 'Dance Party through the Decades' (1231)",
  title: "NCCAkron presents 'Dance Party through the Decades'",
  date:      '2026-06-21T03:59:59.000Z',  // end-of-day ET shape
  nextDate:  '2026-06-21T03:59:59.000Z',
  startDate: '2026-06-20T04:00:00.000Z',  // midnight-ET shape
  endDate:   '2026-06-21T03:59:59.000Z',
  startTime: '20:00:00',
  endTime:   '23:00:00',
}

describe('etCalendarDate', () => {
  it('resolves the end-of-day ET shape to the correct calendar date (EDT)', () => {
    assert.equal(etCalendarDate('2026-06-21T03:59:59.000Z'), '2026-06-20')
  })

  it('resolves the midnight-ET shape to the same calendar date (EDT)', () => {
    assert.equal(etCalendarDate('2026-06-20T04:00:00.000Z'), '2026-06-20')
  })

  it('resolves the end-of-day ET shape during EST', () => {
    // Jan 15 23:59:59 EST = Jan 16 04:59:59 UTC
    assert.equal(etCalendarDate('2026-01-16T04:59:59.000Z'), '2026-01-15')
  })

  it('resolves the midnight-ET shape during EST', () => {
    assert.equal(etCalendarDate('2026-01-15T05:00:00.000Z'), '2026-01-15')
  })

  it('returns null for missing or malformed input', () => {
    assert.equal(etCalendarDate(null), null)
    assert.equal(etCalendarDate(undefined), null)
    assert.equal(etCalendarDate(''), null)
    assert.equal(etCalendarDate('not-a-date'), null)
    assert.equal(etCalendarDate(12345), null)
  })
})

describe('buildStartEnd — off-by-one regression (recid 1231)', () => {
  it('stores the Dance Party as Jun 20 8pm ET (Jun 21 00:00 UTC), not Jun 21', () => {
    const { start_at, end_at } = buildStartEnd(DANCE_PARTY)
    assert.equal(start_at, '2026-06-21T00:00:00.000Z') // Jun 20 20:00 EDT
    assert.equal(end_at,   '2026-06-21T03:00:00.000Z') // Jun 20 23:00 EDT
  })

  it('falls back to startDate when date/nextDate are absent and still agrees', () => {
    const { date, nextDate, ...rest } = DANCE_PARTY
    const fromStartDate = buildStartEnd({ ...rest, endDate: undefined, endTime: undefined })
    assert.equal(fromStartDate.start_at, '2026-06-21T00:00:00.000Z')
  })
})

describe('buildStartEnd — general behavior', () => {
  it('defaults startTime to 09:00 ET when missing', () => {
    const { start_at } = buildStartEnd({ date: '2026-06-21T03:59:59.000Z' })
    assert.equal(start_at, '2026-06-20T13:00:00.000Z') // Jun 20 09:00 EDT
  })

  it('leaves end_at null when endTime is missing', () => {
    const { end_at } = buildStartEnd({ date: '2026-06-21T03:59:59.000Z' })
    assert.equal(end_at, null)
  })

  it('returns nulls when no date field is present', () => {
    assert.deepEqual(buildStartEnd({}), { start_at: null, end_at: null })
  })

  it('uses endDate for the final day of multi-day events', () => {
    // 3-day festival Jun 19–21, 10:00–22:00 ET each day.
    const { start_at, end_at } = buildStartEnd({
      date:      '2026-06-20T03:59:59.000Z', // occurrence: Jun 19
      endDate:   '2026-06-22T03:59:59.000Z', // last day:   Jun 21
      startTime: '10:00:00',
      endTime:   '22:00:00',
    })
    assert.equal(start_at, '2026-06-19T14:00:00.000Z') // Jun 19 10:00 EDT
    assert.equal(end_at,   '2026-06-22T02:00:00.000Z') // Jun 21 22:00 EDT
  })
})

describe('useEndDatePart', () => {
  it('converts endDate through ET, not a raw slice', () => {
    assert.equal(useEndDatePart({ endDate: '2026-06-21T03:59:59.000Z' }, '2026-06-01'), '2026-06-20')
  })

  it('falls back to the occurrence date when endDate is absent', () => {
    assert.equal(useEndDatePart({}, '2026-06-20'), '2026-06-20')
  })
})

describe('easternLocalToUtcIso', () => {
  it('converts EDT wall-clock to UTC', () => {
    assert.equal(easternLocalToUtcIso('2026-06-20 20:00:00'), '2026-06-21T00:00:00.000Z')
  })

  it('converts EST wall-clock to UTC', () => {
    assert.equal(easternLocalToUtcIso('2026-01-15 20:00:00'), '2026-01-16T01:00:00.000Z')
  })
})

describe('isEDT', () => {
  it('flags June as EDT and January as EST', () => {
    assert.equal(isEDT(new Date('2026-06-20T12:00:00Z')), true)
    assert.equal(isEDT(new Date('2026-01-15T12:00:00Z')), false)
  })

  it('handles the 2026 DST boundaries', () => {
    assert.equal(isEDT(new Date('2026-03-07T12:00:00Z')), false) // day before 2nd Sunday in March
    assert.equal(isEDT(new Date('2026-03-09T12:00:00Z')), true)  // day after
    assert.equal(isEDT(new Date('2026-11-02T12:00:00Z')), false) // after 1st Sunday in November
  })
})
