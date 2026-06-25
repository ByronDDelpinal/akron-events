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

import { parseGrid, parseTimeFromText } from '../scrape-city-of-cuyahoga-falls.js'

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
})
