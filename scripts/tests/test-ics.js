/**
 * test-ics.js — tests for the shared iCalendar (RFC 5545) parser in lib/ics.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { parseIcs, icsDateToIso, normaliseIcsEvent, expandRecurrence, parseRrule } from '../lib/ics.js'
import {
  SIMPLE_FEED,
  FOLDED_FEED,
  ALL_DAY_FEED,
  FEED_WITH_ALARM,
  ESCAPED_FEED,
  IMAGE_FEED,
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
    // Default is no category hint — upsert-time text inference decides.
    assert.equal(row.category, null)
    assert.deepEqual(row.tags, [])
    assert.equal(row.price_min, null)
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

  it('prefers X-ALT-IMAGE over X-IMAGE for the feed image', () => {
    const [raw] = parseIcs(IMAGE_FEED)
    const row = normaliseIcsEvent(raw, { source: 'test' })
    assert.equal(row.image_url, 'https://cdn.example.com/alt.jpg')
  })

  it('falls back to X-IMAGE when X-ALT-IMAGE is absent', () => {
    const [, raw] = parseIcs(IMAGE_FEED)
    const row = normaliseIcsEvent(raw, { source: 'test' })
    assert.equal(row.image_url, 'https://cdn.example.com/second.jpg')
  })

  it('never treats X-APPLE-STRUCTURED-LOCATION as an image', () => {
    // Regression: an operator-precedence bug forced image_url to null for every
    // ICS event. Here the only X-… property is a geo payload, so the image must
    // resolve to the provided default rather than the geo string or null.
    const [, , raw] = parseIcs(IMAGE_FEED)
    const row = normaliseIcsEvent(raw, {
      source: 'test',
      defaultImageUrl: 'https://example.com/fallback.jpg',
    })
    assert.equal(row.image_url, 'https://example.com/fallback.jpg')
  })
})

describe('ICS: parseRrule', () => {
  it('parses a rule string into key→value pairs', () => {
    const r = parseRrule('FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2;UNTIL=20260301T000000Z')
    assert.equal(r.FREQ, 'WEEKLY')
    assert.equal(r.BYDAY, 'MO,WE')
    assert.equal(r.INTERVAL, '2')
    assert.equal(r.UNTIL, '20260301T000000Z')
  })

  it('returns {} for empty/invalid input', () => {
    assert.deepEqual(parseRrule(''), {})
    assert.deepEqual(parseRrule(null), {})
  })
})

describe('ICS: parseIcs recurrence fields', () => {
  const RECUR_FEED = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:weekly-1',
    'SUMMARY:Friday Night Magic',
    'DTSTART;TZID=America/New_York:20260102T180000',
    'RRULE:FREQ=WEEKLY;BYDAY=FR',
    'EXDATE;TZID=America/New_York:20260109T180000',
    'EXDATE;TZID=America/New_York:20260116T180000',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')

  it('keeps RRULE as a raw string', () => {
    const [ev] = parseIcs(RECUR_FEED)
    assert.equal(ev.RRULE, 'FREQ=WEEKLY;BYDAY=FR')
  })

  it('accumulates multiple EXDATE lines into an array', () => {
    const [ev] = parseIcs(RECUR_FEED)
    assert.ok(Array.isArray(ev.EXDATE))
    assert.equal(ev.EXDATE.length, 2)
    assert.equal(ev.EXDATE[0].value, '20260109T180000')
    assert.equal(ev.EXDATE[1].params.TZID, 'America/New_York')
  })
})

describe('ICS: expandRecurrence', () => {
  const JAN1 = Date.parse('2026-01-01T00:00:00Z')
  const master = (over = {}) => ({
    UID: 'm1',
    SUMMARY: 'Game Night',
    DTSTART: { value: '20260105T190000', params: {} },  // Mon Jan 5 2026, floating ET
    ...over,
  })
  const starts = (occs) => occs.map(o => o.DTSTART.value)

  it('passes a non-recurring event through unchanged', () => {
    const ev = { UID: 'x', SUMMARY: 'One-off', DTSTART: { value: '20260105T190000', params: {} } }
    const out = expandRecurrence(ev, { windowStartMs: JAN1, windowDays: 30 })
    assert.equal(out.length, 1)
    assert.equal(out[0], ev)
  })

  it('expands WEEKLY BYDAY across the window', () => {
    const out = expandRecurrence(
      master({ RRULE: 'FREQ=WEEKLY;BYDAY=MO,WE' }),
      { windowStartMs: JAN1, windowDays: 18 },
    )
    assert.deepEqual(starts(out), [
      '20260105T190000', '20260107T190000', '20260112T190000', '20260114T190000',
    ])
  })

  it('honours INTERVAL (every other week)', () => {
    const out = expandRecurrence(
      master({ RRULE: 'FREQ=WEEKLY;BYDAY=MO;INTERVAL=2' }),
      { windowStartMs: JAN1, windowDays: 35 },
    )
    assert.deepEqual(starts(out), ['20260105T190000', '20260119T190000', '20260202T190000'])
  })

  it('stops at UNTIL', () => {
    const out = expandRecurrence(
      master({ RRULE: 'FREQ=WEEKLY;BYDAY=MO;UNTIL=20260120' }),
      { windowStartMs: JAN1, windowDays: 60 },
    )
    assert.deepEqual(starts(out), ['20260105T190000', '20260112T190000', '20260119T190000'])
  })

  it('excludes EXDATE occurrences', () => {
    const out = expandRecurrence(
      master({ RRULE: 'FREQ=WEEKLY;BYDAY=MO', EXDATE: [{ value: '20260112T190000', params: {} }] }),
      { windowStartMs: JAN1, windowDays: 21 },
    )
    assert.deepEqual(starts(out), ['20260105T190000', '20260119T190000'])
  })

  it('expands MONTHLY with an ordinal BYDAY (3rd Saturday)', () => {
    const out = expandRecurrence(
      { UID: 'm2', SUMMARY: 'Pokémon League', DTSTART: { value: '20260117T140000', params: {} }, RRULE: 'FREQ=MONTHLY;BYDAY=3SA' },
      { windowStartMs: JAN1, windowDays: 70 },
    )
    // Jan 17 (3rd Sat), Feb 21 (3rd Sat); Mar's 3rd Sat is past the 70-day window.
    assert.deepEqual(starts(out), ['20260117T140000', '20260221T140000'])
  })

  it('gives each occurrence a unique date-suffixed UID and preserves duration', () => {
    const out = expandRecurrence(
      master({ RRULE: 'FREQ=WEEKLY;BYDAY=MO', DTEND: { value: '20260105T210000', params: {} } }),
      { windowStartMs: JAN1, windowDays: 8 },
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].UID, 'm1_20260105')
    // 19:00 ET → 00:00Z next day; +2h duration → 02:00Z.
    assert.equal(out[0].DTEND.value, '20260106T020000Z')
    // The materialised occurrence carries no RRULE.
    assert.equal(out[0].RRULE, undefined)
  })

  it('excludes occurrences before the window start', () => {
    // Master started in 2022; only future occurrences should surface.
    const out = expandRecurrence(
      { UID: 'old', SUMMARY: 'Weekly', DTSTART: { value: '20220103T190000', params: {} }, RRULE: 'FREQ=WEEKLY;BYDAY=MO' },
      { windowStartMs: JAN1, windowDays: 14 },
    )
    assert.deepEqual(starts(out), ['20260105T190000', '20260112T190000'])
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
