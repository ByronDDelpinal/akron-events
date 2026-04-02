/**test-akron-civic.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { SINGLE_DATE, MONTH_RANGE, SINGLE_DAY_RANGE, TIME_EXTRACTION, ALL_FIXTURES } from './fixtures/civic-events.js'

function parseTime(raw) {
  const m = raw.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i)
  if (!m) return null
  return `${m[1]}:${m[2]} ${m[3].toLowerCase()}`
}

function parseDateString(raw) {
  // Single date: "March 15, 2026"
  const singlePat = /^(\w+)\s+(\d{1,2}),\s+(\d{4})$/
  const singleMatch = raw.match(singlePat)
  if (singleMatch) {
    const dateStr = new Date(`${singleMatch[1]} ${singleMatch[2]}, ${singleMatch[3]}`).toISOString().split('T')[0]
    return { start: dateStr, end: dateStr }
  }

  // Range: "March 15 - April 5, 2026" or "May 10 - 12, 2026"
  const rangePat = /^(\w+)\s+(\d{1,2})\s*-\s*(?:(\w+)\s+)?(\d{1,2}),\s+(\d{4})$/
  const rangeMatch = raw.match(rangePat)
  if (rangeMatch) {
    const [, month1, day1, month2, day2, year] = rangeMatch
    const startDateStr = new Date(`${month1} ${day1}, ${year}`).toISOString().split('T')[0]
    const endMonth = month2 || month1
    const endDateStr = new Date(`${endMonth} ${day2}, ${year}`).toISOString().split('T')[0]
    return { start: startDateStr, end: endDateStr }
  }

  return null
}

describe('Civic: Date Parsing', () => {
  it('parses single date', () => {
    const parsed = parseDateString(SINGLE_DATE.raw)
    assert.ok(parsed)
    assert.equal(parsed.start, SINGLE_DATE.expectedDate)
    assert.equal(parsed.end, SINGLE_DATE.expectedDate)
  })

  it('parses month range', () => {
    const parsed = parseDateString(MONTH_RANGE.raw)
    assert.ok(parsed)
    assert.equal(parsed.start, MONTH_RANGE.expectedStart)
    assert.equal(parsed.end, MONTH_RANGE.expectedEnd)
  })

  it('parses day range in same month', () => {
    const parsed = parseDateString(SINGLE_DAY_RANGE.raw)
    assert.ok(parsed)
    assert.equal(parsed.start, SINGLE_DAY_RANGE.expectedStart)
    assert.equal(parsed.end, SINGLE_DAY_RANGE.expectedEnd)
  })
})

describe('Civic: Time Parsing', () => {
  it('extracts time', () => {
    const time = parseTime(TIME_EXTRACTION.raw)
    assert.equal(time, TIME_EXTRACTION.expectedTime)
  })
})
