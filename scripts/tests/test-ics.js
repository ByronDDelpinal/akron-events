/**
 * test-ics.js — tests for the shared iCalendar (RFC 5545) parser in lib/ics.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import {
  parseIcs, icsDateToIso, normaliseIcsEvent, expandRecurrence, parseRrule,
  applyNeedsReviewHook, icsDateOnlyToNoonIso, withDateOnlyTimeNote,
  DATE_ONLY_TIME_NOTE, MAX_DESCRIPTION,
} from '../lib/ics.js'
// Imported through civicplus.js on purpose: the predicate moved to ics.js and
// civicplus.js re-exports it, so this also asserts the re-export still works
// for the scrapers that import it from there.
import { isDateOnlyIcsEvent } from '../lib/civicplus.js'
import {
  SIMPLE_FEED,
  FOLDED_FEED,
  ALL_DAY_FEED,
  DATE_ONLY_DEFAULT_TIME_FEED,
  VALUE_DATE_WITH_TIME_FEED,
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

// ── SANCTIONED-DEFAULT-TIME: date-only DTSTART → noon ET ────────────────────
//
// These run the REAL normaliseIcsEvent over REAL parseIcs output. The bug this
// covers (49 future published rows stranded at 00:00 ET, invisible from
// 00:00:01 on their own morning) survived two rounds of "flag it" fixes
// precisely because the flag was tested and the resulting timestamp was not.
describe('ICS: date-only DTSTART defaults to noon ET', () => {
  const feed = parseIcs(DATE_ONLY_DEFAULT_TIME_FEED)
  const byUid = Object.fromEntries(feed.map((ev) => [ev.UID, ev]))
  const normalise = (ev) => normaliseIcsEvent(ev, { source: 'test_ics' })

  it('parses every fixture VEVENT (guards the fixture itself)', () => {
    assert.deepEqual(Object.keys(byUid).sort(), [
      'dateonly-desc', 'dateonly-morning', 'dateonly-nodesc',
      'dateonly-quoted', 'dateonly-sameday', 'timed-control',
    ])
  })

  it('lands a date-only start at 12:00 ET, not 00:00', () => {
    const row = normalise(byUid['dateonly-desc'])
    // 2026-07-04 is EDT (UTC-4), so noon ET is 16:00Z. The old behaviour was
    // 04:00Z — same calendar day, but before every "upcoming" cutoff.
    assert.equal(row.start_at, '2026-07-04T16:00:00.000Z')
    // Sanity-check the intent rather than only the constant: the stored
    // instant must render as 12:00 in Eastern.
    assert.equal(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(row.start_at)),
      '12:00',
    )
  })

  it('holds across the DST boundary (November date, EST)', () => {
    const row = normalise(byUid['dateonly-nodesc'])
    // 2026-11-16 is EST (UTC-5) → noon ET is 17:00Z. An arithmetic -4 offset
    // would put this at 16:00Z, i.e. 11:00 ET.
    assert.equal(row.start_at, '2026-11-16T17:00:00.000Z')
  })

  it('appends the disclosure note verbatim, as the final clause', () => {
    const row = normalise(byUid['dateonly-desc'])
    assert.ok(row.description.startsWith('Stop by the lawn'))
    assert.ok(row.description.endsWith(DATE_ONLY_TIME_NOTE), 'note must be last')
    assert.equal(row.description.split(DATE_ONLY_TIME_NOTE).length - 1, 1)
  })

  it('DOUBLE-APPEND GUARD: normalising the same VEVENT twice appends once', () => {
    const ev = byUid['dateonly-desc']
    const first  = normalise(ev)
    const second = normalise(ev)
    assert.equal(second.description.split(DATE_ONLY_TIME_NOTE).length - 1, 1)
    assert.equal(first.description, second.description)

    // And the shape that actually bites: a description that already carries
    // the sentence, whether the feed quoted it or it was read back out of the
    // database and re-normalised.
    const quoted = normalise(byUid['dateonly-quoted'])
    assert.equal(quoted.description.split(DATE_ONLY_TIME_NOTE).length - 1, 1)
    assert.ok(quoted.description.startsWith('A day on the square.'))
  })

  it('never invents a description out of the note alone', () => {
    // A note-only description scores on the digest's `described` weight and
    // would promote an event that has no prose at all.
    const row = normalise(byUid['dateonly-nodesc'])
    assert.equal(row.description, null)
  })

  it('END_AT INVERSION: nulls a DTEND that the shift puts at or before start', () => {
    const sameDay = normalise(byUid['dateonly-sameday'])
    assert.equal(sameDay.start_at, '2026-07-04T16:00:00.000Z')
    assert.equal(sameDay.end_at, null, 'a same-date DTEND would now precede the start')

    const morning = normalise(byUid['dateonly-morning'])
    assert.equal(morning.start_at, '2026-07-04T16:00:00.000Z')
    assert.equal(morning.end_at, null, '09:00 ET precedes the new noon start')
  })

  it('keeps a DTEND that still follows the shifted start', () => {
    // The RFC-correct all-day shape: exclusive DTEND on the NEXT day.
    const row = normalise(byUid['dateonly-desc'])
    assert.equal(row.end_at, '2026-07-05T04:00:00.000Z')
    assert.ok(Date.parse(row.end_at) > Date.parse(row.start_at))
  })

  it('CONTROL: a timed VEVENT in the same feed is completely unaffected', () => {
    const row = normalise(byUid['timed-control'])
    assert.equal(row.start_at, '2026-07-04T23:30:00.000Z')  // 19:30 ET
    assert.equal(row.end_at,   '2026-07-05T01:00:00.000Z')  // 21:00 ET
    assert.equal(row.description, 'Bring a lawn chair.')
    assert.ok(!row.description.includes(DATE_ONLY_TIME_NOTE))
    assert.equal(row.needs_review, undefined)
    assert.equal(row.featured, false)
  })

  it('does NOT overwrite a real time on a mislabelled VALUE=DATE property', () => {
    const [ev] = parseIcs(VALUE_DATE_WITH_TIME_FEED)
    // The broad predicate still flags it for review…
    assert.equal(isDateOnlyIcsEvent(ev), true)
    const row = normalise(ev)
    // …but 19:00 ET is a real time, so neither the clock nor the prose moves.
    assert.equal(row.start_at, '2026-07-04T23:00:00.000Z')
    assert.equal(row.description, 'Regular session.')
  })

  it('the pre-existing ALL_DAY_FEED fixture moves to noon too', () => {
    const [ev] = parseIcs(ALL_DAY_FEED)
    assert.equal(normalise(ev).start_at, '2026-07-04T16:00:00.000Z')
  })
})

describe('ICS: date-only helpers', () => {
  it('icsDateOnlyToNoonIso only fires on a bare date', () => {
    assert.equal(icsDateOnlyToNoonIso('20260704'), '2026-07-04T16:00:00.000Z')
    assert.equal(icsDateOnlyToNoonIso('20260704T190000'), null)
    assert.equal(icsDateOnlyToNoonIso(''), null)
    assert.equal(icsDateOnlyToNoonIso(null), null)
    assert.equal(icsDateOnlyToNoonIso(undefined), null)
  })

  it('icsDateToIso itself still reads VALUE=DATE as RFC midnight', () => {
    // DTEND depends on this: an all-day event's exclusive end really is 00:00
    // on the following day. The noon default is a normaliseIcsEvent decision
    // about start_at, deliberately not baked into the RFC converter.
    assert.equal(icsDateToIso('20260704'), '2026-07-04T04:00:00.000Z')
  })

  it('withDateOnlyTimeNote leaves an empty base alone', () => {
    assert.equal(withDateOnlyTimeNote(null), null)
    assert.equal(withDateOnlyTimeNote(''), '')
    assert.equal(withDateOnlyTimeNote('   '), '   ')
  })

  it('reserves room for the note rather than truncating it', () => {
    const out = withDateOnlyTimeNote('a'.repeat(MAX_DESCRIPTION))
    assert.ok(out.length <= MAX_DESCRIPTION, `description was ${out.length} chars`)
    assert.ok(out.endsWith(DATE_ONLY_TIME_NOTE), 'the note must survive the cap intact')
  })

  it('does not split a surrogate pair while making room', () => {
    // clampChars, not slice: a lone surrogate is invalid UTF-8 for Postgres.
    const room = MAX_DESCRIPTION - DATE_ONLY_TIME_NOTE.length - 1
    const out = withDateOnlyTimeNote('x'.repeat(room - 1) + '😀' + 'y'.repeat(50))
    assert.ok(out.length <= MAX_DESCRIPTION)
    assert.ok(out.endsWith(DATE_ONLY_TIME_NOTE))
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out), false, 'lone high surrogate')
  })
})

describe('ICS: runIcsScraper flagNeedsReview hook', () => {
  // Unit coverage of the hook itself. The end-to-end wiring — that
  // scrape-life-gurukula.js's real exported config actually carries
  // `flagNeedsReview: isDateOnlyIcsEvent` — is asserted against the imported
  // module in test-life-gurukula.js.
  const normalise = (ev) => normaliseIcsEvent(ev, { source: 'test_ics' })

  it('flags a date-only VEVENT whose 00:00 ET start is synthesized', () => {
    const [ev] = parseIcs(ALL_DAY_FEED)
    const row = applyNeedsReviewHook(normalise(ev), ev, isDateOnlyIcsEvent)
    // normaliseIcsEvent has already moved the start to the sanctioned noon
    // default; the flag is what records that no human confirmed it.
    assert.equal(row.needs_review, true)
    assert.equal(row.start_at, '2026-07-04T16:00:00.000Z')
    assert.equal(row.status, 'published')
  })

  it('leaves timed VEVENTs untouched (never writes false)', () => {
    const [ev] = parseIcs(SIMPLE_FEED)
    const row = applyNeedsReviewHook(normalise(ev), ev, isDateOnlyIcsEvent)
    assert.equal(row.needs_review, undefined)
    assert.equal(Object.hasOwn(row, 'needs_review'), false)
  })

  it('is a no-op when no hook is configured — the other runIcsScraper callers', () => {
    const [allDay] = parseIcs(ALL_DAY_FEED)
    assert.equal(applyNeedsReviewHook(normalise(allDay), allDay, undefined).needs_review, undefined)
    assert.equal(applyNeedsReviewHook(normalise(allDay), allDay, null).needs_review, undefined)
    // A non-function config value must not throw either.
    assert.equal(applyNeedsReviewHook(normalise(allDay), allDay, true).needs_review, undefined)
  })

  it('tolerates a null row without throwing', () => {
    assert.equal(applyNeedsReviewHook(null, {}, isDateOnlyIcsEvent), null)
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
