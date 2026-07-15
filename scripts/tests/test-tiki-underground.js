/**test-tiki-underground.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import {
  parseEvents,
  parseTimeRange,
  timeToMinutes,
  computeSchedule,
  expandOccurrences,
  parseCategory,
  detectAge,
} from '../scrape-tiki-underground.js'

// Realistic fixture captured from the live SpotApps pinboard. Covers a
// single-night live-music card, a card whose description is bare text (no <p>
// wrapper), a multi-day "Daily" promotion with an end date, and the calendar
// duplicates that MUST be ignored (they live past the agenda-view marker).
const EVENTS_HTML = `
<div class="events-general-holder events-pinboard-view" id="pinboardAgendaContainer">
<div aria-controls="eventCalendarModal" class="event-calendar-card " data-event-end-date="" data-event-recurrence-type="Does not Repeat" data-event-start-date="2026-07-16T00:00:00.000+00:00" data-event-start-time="17:00" id="3131642" role="button" tabindex="0"><div class="event-image-holder"><img alt="" class="img-responsive" src="//static.spotapps.co/spots/0f/8d63b32c564b678ac22e517c6e4142/w926"/></div><div class="event-text-holder"><h2>Akron Roller Derby Nonprofit Night</h2><p class="event-main-text event-day">Thursday July 16th</p><div class="event-info-text"><div data-event-id="3131642" data-is-recurring="false" data-origin-event-id="3131642" data-spot-promotion-id="" data-tags="" style="display: none"></div> Hang, get some good bites, beautiful &amp; tasty tiki cocktails, and enjoy some back patio live music with Vinyl DJ Roman Angelos! A portion of your sales go towards continuing our roller derby mission! 21+ only                         </div><div class="event-read-more" inert="inert">Read more</div><p class="event-main-text event-time">05:00 PM - 09:00 PM</p></div></div>
<div aria-controls="eventCalendarModal" class="event-calendar-card " data-event-end-date="" data-event-recurrence-type="Does not Repeat" data-event-start-date="2026-07-18T00:00:00.000+00:00" data-event-start-time="18:00" id="3155749" role="button" tabindex="0"><div class="event-image-holder"><img alt="" class="img-responsive" src="//static.spotapps.co/spots/14/0bab558ef04672bcd44da8089e1f39/w926"/></div><div class="event-text-holder"><h2>Velocity Stax with David Loy &amp; The Ramrods</h2><p class="event-main-text event-day">Saturday July 18th</p><div class="event-info-text"><div data-event-id="3155749" data-is-recurring="false" data-origin-event-id="3155749" data-spot-promotion-id="" data-tags="" style="display: none"></div><p style="text-align:center">Two killer local bands take on the Tiki Underground patio stage! 21+ only</p></div><div class="event-read-more" inert="inert">Read more</div><p class="event-main-text event-time">06:00 PM - 09:00 PM</p></div></div>
<div aria-controls="eventCalendarModal" class="event-calendar-card " data-event-end-date="2026-07-25T00:00:00.000+00:00" data-event-recurrence-type="Daily" data-event-start-date="2026-07-20T00:00:00.000+00:00" data-event-start-time="10:00" id="3155782" role="button" tabindex="0"><div class="event-image-holder"><img alt="" class="img-responsive" src="//static.spotapps.co/spots/c4/27aaebaf6d4969a516269e78938df2/w926"/></div><div class="event-text-holder"><h2>XMAS IN JULY</h2><p class="event-main-text event-day">Daily Event</p><div class="event-info-text"><div data-event-id="3155782" data-is-recurring="true" data-origin-event-id="3155782" data-spot-promotion-id="" data-tags="" style="display: none"></div><p style="text-align:center">Celebrate Christmas in July all week with seasonal cocktails and holiday tunes.</p></div><div class="event-read-more" inert="inert">Read more</div><p class="event-main-text event-time">10:00 AM - 10:00 PM</p></div></div>
</div>
<div class="events-general-holder events-agenda-view">
<div aria-controls="eventCalendarModal" class="event-calendar-card " data-event-start-date="2026-07-16T00:00:00.000+00:00" data-event-start-time="17:00" id="3131642" role="button"><div class="event-text-holder"><h2>DUPLICATE MUST BE IGNORED</h2></div></div>
</div>`

// Anchor "now" so horizon/expansion assertions are deterministic (mid-July 2026).
const NOW = new Date('2026-07-14T16:00:00Z')

describe('Tiki Underground: parseEvents', () => {
  const events = parseEvents(EVENTS_HTML)

  it('parses only the pinboard cards, ignoring agenda/calendar duplicates', () => {
    assert.equal(events.length, 3)
    assert.ok(!events.some(e => e.title === 'DUPLICATE MUST BE IGNORED'))
  })

  it('reads stable numeric source ids and structured start dates/times', () => {
    assert.deepEqual(events.map(e => e.sourceId), ['3131642', '3155749', '3155782'])
    assert.equal(events[0].startDate, '2026-07-16')
    assert.equal(events[0].startTime24, '17:00')
  })

  it('decodes entity-escaped titles', () => {
    assert.equal(events[1].title, 'Velocity Stax with David Loy & The Ramrods')
  })

  it('captures descriptions whether bare text or <p>-wrapped, dropping the hidden data div', () => {
    assert.ok(events[0].description.startsWith('Hang, get some good bites'))
    assert.ok(!events[0].description.includes('data-event-id'))
    assert.equal(events[1].description, 'Two killer local bands take on the Tiki Underground patio stage! 21+ only')
  })

  it('captures the prose time range', () => {
    assert.equal(events[0].timeText, '05:00 PM - 09:00 PM')
  })

  it('absolutizes protocol-relative image URLs', () => {
    assert.equal(events[0].imageUrl, 'https://static.spotapps.co/spots/0f/8d63b32c564b678ac22e517c6e4142/w926')
  })

  it('surfaces the Daily recurrence with its end date', () => {
    assert.equal(events[2].recurrence, 'Daily')
    assert.equal(events[2].endDate, '2026-07-25')
  })
})

describe('Tiki Underground: expandOccurrences', () => {
  const events = parseEvents(EVENTS_HTML)

  it('yields a single occurrence for non-recurring cards', () => {
    assert.deepEqual(expandOccurrences(events[0], NOW), [{ sourceId: '3131642', date: '2026-07-16' }])
  })

  it('expands a Daily span into one dated occurrence per day (inclusive)', () => {
    const occ = expandOccurrences(events[2], NOW)
    assert.equal(occ.length, 6) // Jul 20..25
    assert.equal(occ[0].sourceId, '3155782-2026-07-20')
    assert.equal(occ[5].sourceId, '3155782-2026-07-25')
    assert.deepEqual(occ.map(o => o.date), [
      '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25',
    ])
  })

  it('falls back to a single day when a Daily card has no end date', () => {
    const ev = { sourceId: '999', startDate: '2026-08-01', endDate: null, recurrence: 'Daily' }
    assert.deepEqual(expandOccurrences(ev, NOW), [{ sourceId: '999', date: '2026-08-01' }])
  })

  it('caps an unbounded Daily span at the ~190-day horizon (and rolls Dec→Jan)', () => {
    // A year-long Daily span must NOT flood the DB: expansion stops at the
    // horizon (today .. today+190 inclusive = 191 occurrences), never the full span.
    const ev = { sourceId: '777', startDate: '2026-07-14', endDate: '2027-07-14', recurrence: 'Daily' }
    const occ = expandOccurrences(ev, NOW)
    assert.equal(occ.length, 191)                       // today (2026-07-14) .. +190
    assert.ok(occ.length < 366)                         // far short of the 365-day span
    assert.equal(occ[0].date, '2026-07-14')
    assert.equal(occ[190].date, '2027-01-20')           // crosses year boundary
    assert.ok(occ.every(o => o.sourceId === `777-${o.date}`))
  })

  it('produces stable, unique source ids across re-runs (no duplicate churn)', () => {
    const a = expandOccurrences(events[2], NOW)
    const b = expandOccurrences(events[2], NOW)
    assert.deepEqual(a, b)                               // deterministic
    const ids = a.map(o => o.sourceId)
    assert.equal(new Set(ids).size, ids.length)          // unique per occurrence
  })
})

describe('Tiki Underground: time parsing', () => {
  it('splits a time range into start/end', () => {
    assert.deepEqual(parseTimeRange('05:00 PM - 09:00 PM'), { startTime: '05:00 PM', endTime: '09:00 PM' })
  })

  it('handles a lone start time', () => {
    assert.deepEqual(parseTimeRange('08:00 PM'), { startTime: '08:00 PM', endTime: null })
  })

  it('converts both 12h and 24h clock tokens to minutes', () => {
    assert.equal(timeToMinutes('11:00 AM'), 660)
    assert.equal(timeToMinutes('12:00 AM'), 0)
    assert.equal(timeToMinutes('12:00 PM'), 720)
    assert.equal(timeToMinutes('17:00'), 1020) // 24h, no meridiem
  })
})

describe('Tiki Underground: computeSchedule', () => {
  it('builds start/end ISO from a prose range (EDT = UTC-4)', () => {
    const { startAt, endAt } = computeSchedule('2026-07-16', '05:00 PM - 09:00 PM', '17:00')
    assert.equal(startAt, '2026-07-16T21:00:00.000Z') // 5pm EDT
    assert.equal(endAt, '2026-07-17T01:00:00.000Z')   // 9pm EDT
  })

  it('falls back to the 24h data-attribute start when prose has no range', () => {
    const { startAt, endAt } = computeSchedule('2026-07-16', '', '17:00')
    assert.equal(startAt, '2026-07-16T21:00:00.000Z')
    assert.equal(endAt, null)
  })

  it('rolls end_at to the next day when the show crosses midnight', () => {
    const { startAt, endAt } = computeSchedule('2026-09-05', '09:00 PM - 12:00 AM', '21:00')
    assert.equal(startAt, '2026-09-06T01:00:00.000Z') // 9pm EDT Sep 5
    assert.equal(endAt, '2026-09-06T04:00:00.000Z')   // midnight EDT → Sep 6 00:00
    assert.ok(Date.parse(endAt) > Date.parse(startAt))
  })

  it('returns null when no start time can be resolved', () => {
    assert.equal(computeSchedule('', '05:00 PM - 09:00 PM', '17:00'), null)
  })

  it('returns null (never a synthesized midnight) when the clock is missing', () => {
    // No prose time AND no data-attribute fallback → must NOT publish 12:00 AM.
    assert.equal(computeSchedule('2026-07-16', '', ''), null)
    assert.equal(computeSchedule('2026-07-16', '   ', undefined), null)
  })
})

describe('Tiki Underground: category + age mapping', () => {
  it('defaults live-music / themed nights to music', () => {
    assert.equal(parseCategory('Velocity Stax with David Loy & The Ramrods', 'Two killer local bands'), 'music')
    assert.equal(parseCategory('Goth Yacht Sails to Manchester', 'DJ night'), 'music')
  })

  it('maps trivia / bingo / game nights to games', () => {
    assert.equal(parseCategory('Trivia Night', ''), 'games')
    assert.equal(parseCategory('Tiki Bingo', ''), 'games')
  })

  it('maps explicit food pop-ups to food', () => {
    assert.equal(parseCategory('Island Eats', 'A special food pop-up with the chef'), 'food')
  })

  it('sets 21_plus only when the event text states it', () => {
    assert.equal(detectAge('Live Band', '21+ only'), '21_plus')
    assert.equal(detectAge('Live Band', 'Fun for everyone'), 'not_specified')
  })
})

describe('Tiki Underground: cancelled/postponed guard', () => {
  const CANCELLED_HTML = `
<div class="events-general-holder events-pinboard-view">
<div class="event-calendar-card " data-event-end-date="" data-event-recurrence-type="Does not Repeat" data-event-start-date="2026-07-22T00:00:00.000+00:00" data-event-start-time="18:00" id="8001"><div class="event-text-holder"><h2>CANCELED: Goth Yacht Sails to Manchester</h2><p class="event-main-text event-day">Wednesday July 22nd</p><p class="event-main-text event-time">06:00 PM - 09:00 PM</p></div></div>
<div class="event-calendar-card " data-event-end-date="" data-event-recurrence-type="Does not Repeat" data-event-start-date="2026-07-24T00:00:00.000+00:00" data-event-start-time="18:00" id="8002"><div class="event-text-holder"><h2>Second Born Sons live and local</h2><p class="event-main-text event-day">Friday July 24th</p><p class="event-main-text event-time">06:00 PM - 09:00 PM</p></div></div>
</div>`

  it('drops a cancelled card while keeping the live one', () => {
    const events = parseEvents(CANCELLED_HTML)
    assert.deepEqual(events.map(e => e.sourceId), ['8002'])
    assert.equal(events[0].title, 'Second Born Sons live and local')
  })
})
