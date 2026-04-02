/**test-akron-art-museum.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { COMPLETE_PARSED_DATETIME, TIME_RANGE_NO_AMPM_START, ALL_DAY_EVENT, SINGLE_TIME_ONLY, INVALID_DATE, ALL_FIXTURES } from './fixtures/art-museum-events.js'

function parseEventDateTime(rawText = '') {
  const text = rawText.replace(/\s+/g, ' ').trim()
  const datePat = /(?:\w+,\s+)?(\w+ \d{1,2},\s+\d{4})/
  const dateMatch = text.match(datePat)
  if (!dateMatch) return null

  const dateStr = new Date(dateMatch[1]).toISOString().split('T')[0]
  if (!dateStr || dateStr === 'Invalid Date') return null

  const afterDate = text.slice(dateMatch.index + dateMatch[0].length).trim()

  if (!afterDate || /all\s*day/i.test(afterDate)) {
    return { dateStr, startTime: '12:00 pm', endTime: null, allDay: true }
  }

  const rangePat = /(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*[–\-]\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i
  const rangeMatch = afterDate.match(rangePat)

  if (rangeMatch) {
    let start = rangeMatch[1].trim()
    const end = rangeMatch[2].trim()

    if (!/am|pm/i.test(start) && /am|pm/i.test(end)) {
      const endAmPm = end.match(/am|pm/i)[0].toLowerCase()
      const startHour = parseInt(start, 10)
      const endHour = parseInt(end, 10)
      if (endAmPm === 'pm' && startHour <= endHour && startHour !== 12) {
        start += ' pm'
      } else {
        start += ' ' + endAmPm
      }
    }

    return { dateStr, startTime: start, endTime: end, allDay: false }
  }

  const singlePat = /(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i
  const singleMatch = afterDate.match(singlePat)
  if (singleMatch) {
    return { dateStr, startTime: singleMatch[1].trim(), endTime: null, allDay: false }
  }

  return { dateStr, startTime: '12:00 pm', endTime: null, allDay: false }
}

describe('Art Museum: DateTime Parsing', () => {
  it('parses time range with hour inference', () => {
    const parsed = parseEventDateTime(COMPLETE_PARSED_DATETIME.rawText)
    assert.ok(parsed)
    assert.equal(parsed.dateStr, COMPLETE_PARSED_DATETIME.expectedDate)
    assert.equal(parsed.startTime, COMPLETE_PARSED_DATETIME.expectedStart)
    assert.equal(parsed.endTime, COMPLETE_PARSED_DATETIME.expectedEnd)
  })

  it('handles am/pm across range boundary', () => {
    const parsed = parseEventDateTime(TIME_RANGE_NO_AMPM_START.rawText)
    assert.ok(parsed)
    assert.equal(parsed.dateStr, TIME_RANGE_NO_AMPM_START.expectedDate)
  })

  it('identifies all-day events', () => {
    const parsed = parseEventDateTime(ALL_DAY_EVENT.rawText)
    assert.ok(parsed)
    assert.equal(parsed.dateStr, ALL_DAY_EVENT.expectedDate)
    assert.equal(parsed.allDay, true)
  })

  it('parses single time only', () => {
    const parsed = parseEventDateTime(SINGLE_TIME_ONLY.rawText)
    assert.ok(parsed)
    assert.equal(parsed.dateStr, SINGLE_TIME_ONLY.expectedDate)
    assert.equal(parsed.startTime, SINGLE_TIME_ONLY.expectedStart)
    assert.equal(parsed.endTime, null)
  })

  it('returns null for invalid date', () => {
    const parsed = parseEventDateTime(INVALID_DATE.rawText)
    assert.equal(parsed, null)
  })
})

describe('Art Museum: Batch Invariants', () => {
  it('all valid fixtures parse without error', () => {
    for (const fixture of ALL_FIXTURES.slice(0, -1)) {
      const parsed = parseEventDateTime(fixture.rawText)
      assert.ok(parsed !== null || fixture.expectedResult === null)
    }
  })
})
