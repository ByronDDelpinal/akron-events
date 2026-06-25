/**
 * test-stan-hywet.js
 *
 * Tests for the Stan Hywet date/time parser. The estate's `<p class="date">`
 * strings are highly heterogeneous; these cases are taken verbatim from the
 * live /public-events listing (captured 2026-06-25) and lock in the fixes for:
 *   - "a.m."/"p.m." with periods (was silently falling back to 09:00)
 *   - time ranges whose meridiem appears only on the END ("5:30-8:30pm",
 *     "11:00-11:30am") — we take the START and inherit the end's am/pm
 *   - multi-date lists ("May 31, … October 25") — surface the next UPCOMING
 *     date instead of the first, which could roll a year into the future
 *
 * Run:
 *   node --test scripts/tests/test-stan-hywet.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Set dummy env vars before importing the scraper module ──────────────────
process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import { extractStartTime, parseStanHywetDate } from '../scrape-stan-hywet.js'

describe('extractStartTime — start-of-range + a.m./p.m. handling', () => {
  const cases = [
    // [input, expected]
    ['July 8, August 5 | 10:30 a.m. - 12:00 p.m.',                 '10:30:00'], // periods + range start
    ['July 7, and August 4 | 10:30 a.m.-11:30 a.m.',               '10:30:00'], // periods, no spaces
    ['July 22 | Session 1: 11:00-11:30am | Session 2: 11:30am-12:00pm', '11:00:00'], // start inherits am
    ['July 16, & September 3 | 11-11:30am',                        '11:00:00'], // bare-hour start inherits am
    ['July 30 | 1:00-3:00pm',                                      '13:00:00'], // start inherits pm
    ['July 31 | 5:30-8:30pm',                                      '17:30:00'], // start inherits pm
    ['August 6, 2026 | 12:00–1:00pm',                             '12:00:00'], // noon, en-dash range
    ['July 26, Sept 12 | 11:00am-1:00pm',                          '11:00:00'], // start already has am
    ['June 26 | 6pm-midnight',                                     '18:00:00'], // non-time end → single
    ['August 9, October 25, & December 6 | 11am',                  '11:00:00'], // single time
    ['As You Like It | 7:30pm',                                    '19:30:00'], // plain single time
  ]

  for (const [input, expected] of cases) {
    it(`"${input}" → ${expected}`, () => {
      assert.equal(extractStartTime(input), expected)
    })
  }

  it('does not misread a day range as a time range ("July 9-26 | 7:30pm")', () => {
    assert.equal(extractStartTime('July 9-26 | 7:30pm'), '19:30:00')
  })

  it('returns null when no clock time is published', () => {
    assert.equal(extractStartTime('July 11 & July 12 | Game Times: Coming soon!'), null)
  })

  it('returns null on empty input', () => {
    assert.equal(extractStartTime(''), null)
    assert.equal(extractStartTime(null), null)
  })
})

describe('parseStanHywetDate — time is correct across formats', () => {
  it('Nature Buddies keeps 10:30 (was 09:00 default)', () => {
    const { timeStr } = parseStanHywetDate('July 8, August 5 | 10:30 a.m. - 12:00 p.m.')
    assert.equal(timeStr, '10:30:00')
  })

  it('Secrets from the Archives keeps the 11:00 session start (was 11:30)', () => {
    const { timeStr } = parseStanHywetDate('July 22 | Session 1: 11:00-11:30am | Session 2: 11:30am-12:00pm')
    assert.equal(timeStr, '11:00:00')
  })

  it('Off the Vine keeps the 5:30 start (was 8:30pm)', () => {
    const { timeStr } = parseStanHywetDate('July 31 | 5:30-8:30pm')
    assert.equal(timeStr, '17:30:00')
  })
})

describe('parseStanHywetDate — multi-date lists surface the next upcoming date', () => {
  it('skips a past date and picks the upcoming one (Photography Walk bug)', () => {
    // May 31 2000 is firmly past; October 25 2099 is firmly future.
    const { dateStr } = parseStanHywetDate('May 31, 2000, October 25, 2099 | 2:00pm')
    assert.equal(dateStr, '2099-10-25')
  })

  it('picks the earliest of several upcoming dates', () => {
    const { dateStr, timeStr } = parseStanHywetDate('August 9, 2099, October 25, 2099, & December 6, 2099 | 11am')
    assert.equal(dateStr, '2099-08-09')
    assert.equal(timeStr, '11:00:00')
  })
})

describe('parseStanHywetDate — single dates and ranges are unchanged', () => {
  it('full single date with year', () => {
    const { dateStr, endDateStr } = parseStanHywetDate('April 21, 2026 | 6pm')
    assert.equal(dateStr, '2026-04-21')
    assert.equal(endDateStr, null)
  })

  it('month range keeps start and end', () => {
    const { dateStr, endDateStr } = parseStanHywetDate('May 23–September 13, 2026')
    assert.equal(dateStr, '2026-05-23')
    assert.equal(endDateStr, '2026-09-13')
  })

  it('recurring numeric end-date marker carries the end date', () => {
    const { endDateStr } = parseStanHywetDate('Sundays through 10/25/26')
    assert.equal(endDateStr, '2026-10-25')
  })

  it('returns null dateStr when nothing parses', () => {
    const { dateStr } = parseStanHywetDate('Continues until the End of May')
    assert.equal(dateStr, null)
  })
})
