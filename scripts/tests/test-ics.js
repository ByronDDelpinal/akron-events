/**
 * test-ics.js — tests for the shared iCalendar (RFC 5545) parser in lib/ics.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { parseIcs, icsDateToIso, normaliseIcsEvent } from '../lib/ics.js'
import {
  SIMPLE_FEED,
  FOLDED_FEED,
  ALL_DAY_FEED,
  FEED_WITH_ALARM,
  ESCAPED_FEED,
  NOT_ICS,
} from './fixtures/ics-feeds.js'

describe('ICS: parseIcs basic extraction', () => {
  it('returns [] for non-ICS content', () => {
    assert.deepEqual(parseIcs(NOT_ICS), [])
  })

  it('parses a simple feed with two VEVENTs', () => {
    const events = parseIcs(SIMPLE_FEED)
    assert.equal(events.length, 2)
    assert.equal(events[0].UID, 'concert-42@akronsymphony.org')
    assert.equal(events[0].SUMMARY, 'Mozart & Vivaldi')
    assert.equal(events[1].SUMMARY, 'Carmina Burana')
  })

  it('captures property parameters on date fields', () => {
    const [first] = parseIcs(SIMPLE_FEED)
    assert.equal(first.DTSTART.value, '20260307T190000')
    assert.equal(first.DTSTART.params.TZID, 'America/New_York')
  })

  it('unescapes TEXT values (commas, semicolons, newlines)', () => {
    const [ev] = parseIcs(ESCAPED_FEED)
    assert.equal(ev.SUMMARY, 'Wine, Cheese, & Chocolate')
    assert.ok(ev.DESCRIPTION.includes('Line one.\nLine two.'))
    assert.ok(ev.DESCRIPTION.includes('Semi; colon.'))
  })

  it('unfolds continuation lines', () => {
    const [ev] = parseIcs(FOLDED_FEED)
    assert.ok(ev.DESCRIPTION.includes('continueson the next line'))
  })

  it('ignores nested VALARM blocks', () => {
    const [ev] = parseIcs(FEED_WITH_ALARM)
    // VALARM's own DESCRIPTION should not overwrite the VEVENT's missing one
    assert.equal(ev.UID, 'with-alarm-1')
    assert.equal(ev.SUMMARY, 'Reminder Event')
    // The parser strips nested block lines, so no ACTION/TRIGGER on the event
    assert.equal(ev.ACTION, undefined)
    assert.equal(ev.TRIGGER, undefined)
  })
})

describe('ICS: icsDateToIso', () => {
  it('converts UTC (Z-suffix) datetime as-is', () => {
    const iso = icsDateToIso('20260509T200000Z')
    assert.equal(iso, '2026-05-09T20:00:00.000Z')
  })

  it('converts Eastern TZID datetime to UTC (EDT = UTC-4)', () => {
    const iso = icsDateToIso('20260307T190000', { TZID: 'America/New_York' })
    // March 7, 2026 is before DST (starts 2nd Sun of March = Mar 8 in 2026),
    // so Eastern is EST (UTC-5): 19:00 EST → 00:00 UTC next day
    assert.equal(iso, '2026-03-08T00:00:00.000Z')
  })

  it('converts Eastern DST datetime correctly (EDT = UTC-4)', () => {
    // May 9 is firmly in DST: 20:00 EDT → 00:00 UTC next day
    const iso = icsDateToIso('20260509T200000', { TZID: 'America/New_York' })
    assert.equal(iso, '2026-05-10T00:00:00.000Z')
  })

  it('treats floating times as Eastern', () => {
    const iso = icsDateToIso('20260509T200000')
    assert.equal(iso, '2026-05-10T00:00:00.000Z')
  })

  it('handles all-day DATE values', () => {
    const iso = icsDateToIso('20260704')
    // Midnight Eastern on July 4 → 04:00 UTC (EDT)
    assert.equal(iso, '2026-07-04T04:00:00.000Z')
  })

  it('returns null for malformed input', () => {
    assert.equal(icsDateToIso(null), null)
    assert.equal(icsDateToIso('not-a-date'), null)
  })
})

describe('ICS: normaliseIcsEvent', () => {
  it('produces a valid event row from a well-formed VEVENT', () => {
    const [raw] = parseIcs(SIMPLE_FEED)
    const row = normaliseIcsEvent(raw, {
      source: 'akron_symphony',
      mapCategory: () => 'music',
      mapTags: () => ['symphony', 'akron'],
    })
    assert.ok(row)
    assert.equal(row.source, 'akron_symphony')
    assert.equal(row.source_id, 'concert-42@akronsymphony.org')
    assert.equal(row.title, 'Mozart & Vivaldi')
    assert.equal(row.category, 'music')
    assert.deepEqual(row.tags, ['symphony', 'akron'])
    assert.equal(row.ticket_url, 'https://akronsymphony.org/event/mozart-vivaldi')
    assert.ok(row.start_at.endsWith('Z'))
    assert.ok(row.end_at.endsWith('Z'))
  })

  it('returns null when SUMMARY is missing', () => {
    const row = normaliseIcsEvent({ UID: '1', DTSTART: { value: '20260101T120000Z' } }, { source: 'x' })
    assert.equal(row, null)
  })

  it('returns null when DTSTART is missing', () => {
    const row = normaliseIcsEvent({ UID: '1', SUMMARY: 'Test' }, { source: 'x' })
    assert.equal(row, null)
  })

  it('uses defaults when mappers are not supplied', () => {
    const [raw] = parseIcs(ALL_DAY_FEED)
    const row = normaliseIcsEvent(raw, { source: 'test' })
    assert.ok(row)
    assert.equal(row.category, 'community')
    assert.deepEqual(row.tags, [])
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, null)
    assert.equal(row.age_restriction, 'not_specified')
  })

  it('applies defaultImageUrl when feed lacks an image', () => {
    const [raw] = parseIcs(SIMPLE_FEED)
    const row = normaliseIcsEvent(raw, {
      source: 'test',
      defaultImageUrl: 'https://example.com/fallback.jpg',
    })
    assert.equal(row.image_url, 'https://example.com/fallback.jpg')
  })
})

describe('ICS: defensive parsing', () => {
  it('does not crash on undefined input', () => {
    assert.deepEqual(parseIcs(undefined), [])
    assert.deepEqual(parseIcs(null), [])
    assert.deepEqual(parseIcs(''), [])
  })

  it('tolerates LF-only line endings', () => {
    const lfOnly = SIMPLE_FEED.replace(/\r\n/g, '\n')
    const events = parseIcs(lfOnly)
    assert.equal(events.length, 2)
  })
})
