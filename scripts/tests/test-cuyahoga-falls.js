/**
 * test-cuyahoga-falls.js
 *
 * Unit tests for the City of Cuyahoga Falls scraper's pure parsers:
 *   • parseGrid         — resolves each event to its date via the Drupal
 *                         calendar's week-block structure (a `date-box` row of
 *                         weekday→date links, followed by `single-day` event
 *                         rows that name the day only by a headers="<Weekday>"
 *                         attribute). Also excludes adjacent-month spillover.
 *   • parseTimeFromText — extracts the START time from prose, taking the start
 *                         of a range (not the end) and inheriting the meridiem.
 *
 * The fixture mirrors the live markup observed on /calendar/YYYYMM: only days
 * that have events carry the /calendar-field_cal_date/day/YYYYMMDD link, and the
 * event cells reference their column purely through `headers`.
 *
 * Run:
 *   node --test scripts/tests/test-cuyahoga-falls.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY  || 'dummy-key'

import {
  parseGrid,
  parseTimeFromText,
  parseTimeFromTextDetailed,
  buildDescription,
  TIME_NOTE,
} from '../scrape-city-of-cuyahoga-falls.js'
// The real strip helper, so the double-strip regression below runs against the
// shipped implementation rather than a stand-in.
import { stripHtml } from '../lib/normalize.js'

// A two-week slice of the July 2026 grid in the real shape:
//   • Week of Jul 5–11: Riverfront Cruise In (Mon Jul 6), Community Band +
//     Front Street Live (Thu Jul 9). Days without events render a bare number
//     with no day link; an event placed on such a column must NOT resolve.
//   • Week of Jul 26–Aug 1: Flix on the Falls (Fri Jul 31) plus an August
//     spillover cell (Sat Aug 1) whose event must be excluded by the ym filter.
const FIXTURE = `
<tr class="date-box">
  <td class="date-box future no-entry" headers="Sunday">5</td>
  <td class="date-box future" headers="Monday"><a href="/calendar-field_cal_date/day/20260706">6</a></td>
  <td class="date-box future no-entry" headers="Tuesday">7</td>
  <td class="date-box future no-entry" headers="Wednesday">8</td>
  <td class="date-box future" headers="Thursday"><a href="/calendar-field_cal_date/day/20260709">9</a></td>
  <td class="date-box future no-entry" headers="Friday">10</td>
  <td class="date-box future no-entry" headers="Saturday">11</td>
</tr>
<tr class="single-day">
  <td class="single-day future no-entry" headers="Sunday"></td>
  <td class="single-day future" headers="Monday"><a href="/events/riverfront-cruise">Riverfront Cruise In</a></td>
  <td class="single-day future" headers="Tuesday"><a href="/events/stray-orphan">Stray Orphan</a></td>
  <td class="single-day future no-entry" headers="Wednesday"></td>
  <td class="single-day future" headers="Thursday"><a href="/events/community-band">Community Band</a><a href="/events/front-street-live-1">Front Street Live</a></td>
  <td class="single-day future no-entry" headers="Friday"></td>
  <td class="single-day future no-entry" headers="Saturday"></td>
</tr>
<tr class="date-box">
  <td class="date-box future no-entry" headers="Sunday">26</td>
  <td class="date-box future no-entry" headers="Monday">27</td>
  <td class="date-box future no-entry" headers="Tuesday">28</td>
  <td class="date-box future no-entry" headers="Wednesday">29</td>
  <td class="date-box future no-entry" headers="Thursday">30</td>
  <td class="date-box future" headers="Friday"><a href="/calendar-field_cal_date/day/20260731">31</a></td>
  <td class="date-box future next-month" headers="Saturday"><a href="/calendar-field_cal_date/day/20260801">1</a></td>
</tr>
<tr class="single-day">
  <td class="single-day future no-entry" headers="Sunday"></td>
  <td class="single-day future no-entry" headers="Monday"></td>
  <td class="single-day future no-entry" headers="Tuesday"></td>
  <td class="single-day future no-entry" headers="Wednesday"></td>
  <td class="single-day future no-entry" headers="Thursday"></td>
  <td class="single-day future" headers="Friday"><a href="/events/flix-falls-0">Flix on the Falls</a></td>
  <td class="single-day future" headers="Saturday"><a href="/events/national-night-out">National Night Out</a></td>
</tr>`

describe('parseGrid', () => {
  const rows = parseGrid(FIXTURE, '202607')

  it('resolves an event to the correct weekday/date column', () => {
    const cruise = rows.find(r => r.slug === 'riverfront-cruise')
    assert.ok(cruise, 'riverfront-cruise not found')
    assert.equal(cruise.dateStr, '2026-07-06') // the Monday in that week
    assert.equal(cruise.title, 'Riverfront Cruise In')
  })

  it('attaches multiple events sharing a day to that same date', () => {
    const onThursday = rows.filter(r => r.dateStr === '2026-07-09').map(r => r.slug).sort()
    assert.deepEqual(onThursday, ['community-band', 'front-street-live-1'])
  })

  it('does NOT cluster events onto the most-recent day link', () => {
    // The regression: Community Band must land on its own Thursday, not on the
    // Monday (the last date-box link before it in document order).
    const band = rows.find(r => r.slug === 'community-band')
    assert.equal(band.dateStr, '2026-07-09')
  })

  it('skips events on a column whose date-box cell has no day link', () => {
    // Tuesday had a bare "7" (no link) → no resolvable date → drop the orphan.
    assert.ok(!rows.some(r => r.slug === 'stray-orphan'), 'orphan should be dropped')
  })

  it('includes an in-month event in the final week', () => {
    const flix = rows.find(r => r.slug === 'flix-falls-0')
    assert.ok(flix, 'flix-falls-0 not found')
    assert.equal(flix.dateStr, '2026-07-31')
  })

  it('excludes adjacent-month spillover via the ym filter', () => {
    // National Night Out sits on the Aug 1 spillover cell of the July grid.
    assert.ok(!rows.some(r => r.slug === 'national-night-out'), 'August spillover should be excluded')
  })
})

describe('parseTimeFromText', () => {
  const cases = [
    ['7 - 8 p.m.',                   '19:00:00'], // range: take the start, inherit p.m.
    ['from 4 – 7 p.m.',              '16:00:00'], // en-dash range
    ['11:30 a.m. – 1 p.m.',          '11:30:00'], // start states its own meridiem
    ['take place from 6 to 10 p.m.', '18:00:00'], // "to" range
    ['9 a.m. - 3 p.m.',              '09:00:00'], // a.m. start
    ['beginning at 7 p.m.',          '19:00:00'], // single time
    ['10:30am',                      '10:30:00'], // single, compact
    ['12 - 2 p.m.',                  '12:00:00'], // noon start, not midnight
    ['11 - 1 p.m.',                  '11:00:00'], // crosses noon → start is a.m.
    ['',                             '12:00:00'], // empty → noon default
    ['Free admission, all welcome.', '12:00:00'], // no clock time → noon default
  ]
  for (const [input, expected] of cases) {
    it(`"${input}" → ${expected}`, () => {
      assert.equal(parseTimeFromText(input), expected)
    })
  }

  it('still returns a bare HH:MM:SS string (signature unchanged)', () => {
    // parseTimeFromText is now a wrapper over parseTimeFromTextDetailed; its
    // one-arg signature and string return must not have changed.
    assert.equal(parseTimeFromText.length, 1)
    assert.equal(typeof parseTimeFromText('beginning at 7 p.m.'), 'string')
  })
})

describe('parseTimeFromTextDetailed (2026-07-28 decision)', () => {
  it('flags only the two fallback paths as inferred', () => {
    assert.deepEqual(parseTimeFromTextDetailed(''),                            { time: '12:00:00', inferred: true })
    assert.deepEqual(parseTimeFromTextDetailed('Free admission, all welcome.'),{ time: '12:00:00', inferred: true })
  })

  it('does NOT flag a genuine noon event, even though the time matches the default', () => {
    // The false positive that motivated `inferred`: a real 12:00 PM event
    // returns the same string as the fallback, so the string cannot be the test.
    assert.deepEqual(parseTimeFromTextDetailed('12 - 2 p.m.'),  { time: '12:00:00', inferred: false })
    assert.deepEqual(parseTimeFromTextDetailed('at 12 p.m.'),   { time: '12:00:00', inferred: false })
  })

  it('agrees with parseTimeFromText on every case above', () => {
    for (const [input] of [['7 - 8 p.m.'], ['11 - 1 p.m.'], ['10:30am'], [''], ['no time here']]) {
      assert.equal(parseTimeFromTextDetailed(input).time, parseTimeFromText(input))
    }
  })
})

describe('default-time disclosure (2026-07-28 decision)', () => {
  // Detail objects built exactly the way fetchDetail builds them, from the real
  // parser, so these cover the shipped path rather than a copy of it.
  const detailFor = (desc) => {
    const parsed = parseTimeFromTextDetailed(desc || '')
    return { description: desc, timeStr: parsed.time, timeInferred: parsed.inferred }
  }

  it('does NOT append the note for a real, parsed 12:00 PM event', () => {
    const detail = detailFor('Doors open 12 - 2 p.m. at Riverfront Plaza.')
    assert.equal(detail.timeStr, '12:00:00')
    assert.equal(buildDescription(detail), detail.description)
    assert.ok(!buildDescription(detail).includes(TIME_NOTE))
  })

  it('appends the note when the time was inferred', () => {
    const detail = detailFor('Family fun on the riverfront. Free admission, all welcome.')
    assert.equal(detail.timeInferred, true)
    const description = buildDescription(detail)
    assert.ok(description.startsWith('Family fun on the riverfront.'))
    assert.ok(description.endsWith(TIME_NOTE), 'note must be the final clause')
  })

  it('does not double the note when the description already contains it', () => {
    const detail = { description: `Some blurb. ${TIME_NOTE}`, timeInferred: true }
    assert.equal(buildDescription(detail), detail.description)
    assert.equal(buildDescription(detail).split(TIME_NOTE).length - 1, 1)
  })

  it('leaves a null description null: the note is a suffix, never a description', () => {
    // A note-only description would be 100+ chars of boilerplate that reads as
    // a complete listing to anything measuring description length, including
    // the digest's `described` weight. Null in, null out.
    assert.equal(buildDescription({ description: null, timeInferred: true }), null)
    assert.equal(buildDescription({ description: null, timeInferred: false }), null)
    assert.equal(buildDescription({ description: '', timeInferred: true }), null)
    assert.equal(buildDescription({ description: '   ', timeInferred: true }), '   ')
  })

  it('adds nothing on the detail-fetch failure path (description stays null)', () => {
    // fetchDetail's initializer, which the catch branch keeps. timeInferred is
    // true there, but with no prose there is nothing to append the note to, so
    // a failed fetch must never come out looking like a described event.
    const fallback = { title: null, description: null, imageUrl: null, timeStr: '12:00:00', timeInferred: true }
    assert.equal(buildDescription(fallback), null)
  })

  it('never exceeds the 5000-char description cap', () => {
    // fetchDetail slices the base to 5000; appending a ~130-char note used to
    // push the stored value to 5122.
    const base = 'a'.repeat(5000)
    const out = buildDescription({ description: base, timeInferred: true })
    assert.ok(out.length <= 5000, `description was ${out.length} chars`)
    assert.ok(out.endsWith(TIME_NOTE), 'the note must survive the cap intact')
  })

  it('truncates on a character boundary, not mid-surrogate-pair', () => {
    // room = 5000 - TIME_NOTE.length - 1. Put an emoji (one code point, TWO
    // UTF-16 units) so it straddles the cut: a bare slice(0, room) ends on a
    // lone high surrogate, which is not well-formed UTF-16 and round-trips
    // through Postgres as U+FFFD. Same defect class as commit 960c219.
    const room = 5000 - TIME_NOTE.length - 1
    const base = `${'a'.repeat(room - 1)}🎪${'b'.repeat(200)}`
    const out = buildDescription({ description: base, timeInferred: true })
    assert.ok(out.isWellFormed(), 'truncation produced a lone surrogate')
    assert.ok(out.length <= 5000, `description was ${out.length} chars`)
    assert.ok(out.endsWith(TIME_NOTE), 'the note must survive the cap intact')
    // The emoji did not fit whole, so it is dropped entirely rather than halved.
    assert.ok(!out.includes('🎪'))
  })

  it('keeps a multi-byte character that fits entirely within the cap', () => {
    const room = 5000 - TIME_NOTE.length - 1
    const base = `${'a'.repeat(room - 2)}🎪${'b'.repeat(200)}`
    const out = buildDescription({ description: base, timeInferred: true })
    assert.ok(out.isWellFormed())
    assert.ok(out.includes('🎪'), 'a character that fits must not be dropped')
  })
})

describe('description is not double-stripped (2026-07-28 regression)', () => {
  // stripHtml strips tags and THEN decodes entities, so running it twice over
  // the same text un-escapes one level of encoding. fetchDetail already strips
  // the meta content once; buildDescription must not strip it again, or a
  // double-encoded source becomes literal markup in the stored description.
  const RAW_META = 'Family fun at the park. &amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt; Bring a chair.'

  // Exactly what fetchDetail stores, using the real stripHtml.
  const baseFor = () => stripHtml(RAW_META).slice(0, 5000)

  it('keeps double-encoded markup escaped on the inferred path', () => {
    const base = baseFor()
    assert.match(base, /&lt;script&gt;/, 'fixture must still be escaped after one strip')

    const out = buildDescription({ description: base, timeInferred: true })
    assert.ok(!out.includes('<script>'),  'markup was un-escaped by a second strip')
    assert.ok(!out.includes('</script>'), 'markup was un-escaped by a second strip')
    assert.ok(!/<[a-z/]/i.test(out),      'no tag-like sequence may appear')
    assert.match(out, /&lt;script&gt;/)
  })

  it('both branches agree on the prose, differing only by the appended note', () => {
    const base = baseFor()
    const inferred = buildDescription({ description: base, timeInferred: true })
    const parsed   = buildDescription({ description: base, timeInferred: false })
    assert.equal(parsed, base, 'the parsed branch must pass the base through unchanged')
    assert.equal(inferred, `${base} ${TIME_NOTE}`)
    assert.equal(inferred.slice(0, base.length), parsed)
  })
})
