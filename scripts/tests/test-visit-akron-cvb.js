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
  isFirstPartyOwnedTitle,
  fetchAllEvents,
  nextPageSize,
  PAGE_SIZE,
  MIN_PAGE_SIZE,
} from '../scrape-visit-akron-cvb.js'

describe('isFirstPartyOwnedTitle', () => {
  it('cedes Akron Pride events to the first-party akron_pride scraper', () => {
    assert.equal(isFirstPartyOwnedTitle('Akron Pride March & Festival'), true)
    assert.equal(isFirstPartyOwnedTitle('Akron Pride Festival and Equity March 2026'), true)
    assert.equal(isFirstPartyOwnedTitle('2026 Akron Pride Festival 5K'), true)
  })
  it('leaves unrelated CVB events alone', () => {
    assert.equal(isFirstPartyOwnedTitle('Roast Battle Cleveland'), false)
    assert.equal(isFirstPartyOwnedTitle('Downtown Art Walk'), false)
    assert.equal(isFirstPartyOwnedTitle(''), false)
  })
})

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
    const { start_at, end_at, timeSynthesized } = buildStartEnd(DANCE_PARTY)
    assert.equal(start_at, '2026-06-21T00:00:00.000Z') // Jun 20 20:00 EDT
    assert.equal(end_at,   '2026-06-21T03:00:00.000Z') // Jun 20 23:00 EDT
    assert.equal(timeSynthesized, false) // real 20:00:00 from the feed
  })

  it('falls back to startDate when date/nextDate are absent and still agrees', () => {
    const { date, nextDate, ...rest } = DANCE_PARTY
    const fromStartDate = buildStartEnd({ ...rest, endDate: undefined, endTime: undefined })
    assert.equal(fromStartDate.start_at, '2026-06-21T00:00:00.000Z')
  })
})

describe('buildStartEnd — general behavior', () => {
  it('defaults startTime to 09:00 ET when missing', () => {
    const { start_at, timeSynthesized } = buildStartEnd({ date: '2026-06-21T03:59:59.000Z' })
    assert.equal(start_at, '2026-06-20T13:00:00.000Z') // Jun 20 09:00 EDT
    assert.equal(timeSynthesized, true)
  })

  it('flags a malformed startTime as synthesized and falls back to 09:00 ET', () => {
    const { start_at, timeSynthesized } = buildStartEnd({
      date:      '2026-06-21T03:59:59.000Z',
      startTime: 'TBD',
    })
    assert.equal(start_at, '2026-06-20T13:00:00.000Z') // Jun 20 09:00 EDT
    assert.equal(timeSynthesized, true)
  })

  it('does not flag a genuine 09:00:00 from the feed (false-disclosure guard)', () => {
    const { start_at, timeSynthesized } = buildStartEnd({
      date:      '2026-06-21T03:59:59.000Z',
      startTime: '09:00:00',
    })
    assert.equal(start_at, '2026-06-20T13:00:00.000Z') // same instant as the default
    assert.equal(timeSynthesized, false) // parsed, not invented
  })

  it('leaves end_at null when endTime is missing', () => {
    const { end_at } = buildStartEnd({ date: '2026-06-21T03:59:59.000Z' })
    assert.equal(end_at, null)
  })

  it('returns nulls when no date field is present', () => {
    assert.deepEqual(buildStartEnd({}), { start_at: null, end_at: null, timeSynthesized: true })
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

// ── Paging under the edge's response-size refusal ───────────────────────────
//
// The site's edge answers 403 to any response over roughly 250 KB (measured
// 2026-11-10; see PAGE_SIZE in the scraper). These pin the recovery: a refused
// page is retried smaller from the SAME offset, and nothing else is retried.

const forbidden = () => Object.assign(new Error('Events fetch failed: HTTP 403 Access Denied'), { status: 403 })
const noSleep = async () => {}
const rows = (from, n) => Array.from({ length: n }, (_, i) => ({ recid: from + i }))

/** A fake endpoint over `total` rows that refuses any page larger than `maxOk`. */
function fakeEndpoint(total, maxOk = Infinity) {
  const calls = []
  const fetchPage = async (_token, _start, _end, skip, limit) => {
    calls.push({ skip, limit })
    if (limit > maxOk) throw forbidden()
    return { count: total, docs: rows(skip, Math.max(0, Math.min(limit, total - skip))) }
  }
  return { calls, fetchPage }
}
const run = (fetchPage) => fetchAllEvents({ fetchPage, getToken: async () => 't', sleep: noSleep })

describe('nextPageSize', () => {
  it('halves on the 403 size refusal', () => {
    assert.equal(nextPageSize(50, forbidden()), 25)
    assert.equal(nextPageSize(25, forbidden()), 12)
  })
  it('stops shrinking at the floor', () => {
    assert.equal(nextPageSize(MIN_PAGE_SIZE, forbidden()), null)
    assert.equal(nextPageSize(MIN_PAGE_SIZE * 2 - 1, forbidden()), null)
  })
  it('does not treat any other failure as a size refusal', () => {
    assert.equal(nextPageSize(50, Object.assign(new Error('boom'), { status: 500 })), null)
    assert.equal(nextPageSize(50, new Error('fetch failed')), null)
  })
})

describe('fetchAllEvents paging', () => {
  it('starts well under the size that used to be refused', () => {
    assert.ok(PAGE_SIZE <= 50, `PAGE_SIZE is ${PAGE_SIZE}; 105 rows was the largest page the edge allowed`)
  })

  it('pages through every row when nothing is refused', async () => {
    const { calls, fetchPage } = fakeEndpoint(155)
    const docs = await run(fetchPage)
    assert.equal(docs.length, 155)
    assert.deepEqual(docs.map((d) => d.recid), rows(0, 155).map((d) => d.recid))
    assert.deepEqual(calls.map((c) => c.skip), [0, 50, 100, 150])
  })

  it('shrinks a refused page and retries from the same offset, losing no rows', async () => {
    const { calls, fetchPage } = fakeEndpoint(60, 20)
    const docs = await run(fetchPage)
    assert.deepEqual(docs.map((d) => d.recid), rows(0, 60).map((d) => d.recid), 'every row exactly once, in order')
    assert.deepEqual(calls.slice(0, 3), [{ skip: 0, limit: 50 }, { skip: 0, limit: 25 }, { skip: 0, limit: 12 }])
    assert.ok(calls.slice(3).every((c) => c.limit === 12), 'stays at the size that worked')
  })

  it('gives up with the original error once the page cannot shrink further', async () => {
    const { calls, fetchPage } = fakeEndpoint(60, 0)
    await assert.rejects(run(fetchPage), /HTTP 403/)
    assert.ok(calls.length <= 5, `shrinking must be bounded, saw ${calls.length} calls`)
    assert.ok(calls.at(-1).limit >= MIN_PAGE_SIZE)
  })

  it('does not retry a non-403 failure', async () => {
    let n = 0
    const fetchPage = async () => { n++; throw Object.assign(new Error('Events fetch failed: HTTP 500'), { status: 500 }) }
    await assert.rejects(run(fetchPage), /HTTP 500/)
    assert.equal(n, 1)
  })

  it('returns nothing for an empty calendar', async () => {
    const { fetchPage } = fakeEndpoint(0)
    assert.deepEqual(await run(fetchPage), [])
  })
})
