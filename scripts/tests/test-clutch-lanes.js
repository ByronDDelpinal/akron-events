/**test-clutch-lanes.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import {
  parseEvents,
  parseEventDate,
  parseTimeRange,
  timeToMinutes,
  computeSchedule,
  parseCategory,
} from '../scrape-clutch-lanes.js'

// Realistic fixture captured from the live SpotApps-rendered events page.
// Covers: a bowling special (games), a live-band night (music), a cross-
// midnight late show, and an event with an .event-info-text note.
const EVENTS_HTML = `
<div class="events-holder">
<section id="2892015"><div class="row event-content"><div class="col-md-6 event-content-item event-image-holder"><img alt="" class="event-image" src="//static.spotapps.co/spots/50/17e7e7e5c44685ab7869489990c91e/w926"/></div><div class="col-md-6 event-content-item event-text-holder"><h2>Superhero Bowling</h2><p class="event-main-text event-day">Saturday July 18th</p><div class="event-info-text"><div data-event-id="2892015" data-is-recurring="false" data-origin-event-id="2892015" data-spot-promotion-id="" data-tags="" style="display: none"></div></div><p class="event-main-text event-time">11:00 AM - 01:00 PM</p></div></div></section>
</div>
<div class="events-holder">
<section id="2892026"><div class="row event-content"><div class="col-md-6 event-content-item event-image-holder"><img alt="" class="event-image" src="//static.spotapps.co/spots/c2/3abdd8c31a4452acbc32fc99fd6b21/w926"/></div><div class="col-md-6 event-content-item event-text-holder"><h2>Mick &amp; Rick Band</h2><p class="event-main-text event-day">Saturday August 1st</p><div class="event-info-text"><div data-event-id="2892026" data-is-recurring="false" data-origin-event-id="2892026" data-spot-promotion-id="" data-tags="" style="display: none"></div></div><p class="event-main-text event-time">07:00 PM - 10:00 PM</p></div></div></section>
</div>
<div class="events-holder">
<section id="2793873"><div class="row event-content"><div class="col-md-6 event-content-item event-image-holder"><img alt="" class="event-image" src="//static.spotapps.co/spots/c2/3abdd8c31a4452acbc32fc99fd6b21/w926"/></div><div class="col-md-6 event-content-item event-text-holder"><h2>Chagrin River Band</h2><p class="event-main-text event-day">Saturday September 5th</p><div class="event-info-text"><div data-event-id="2793873" data-is-recurring="false" data-origin-event-id="2793873" data-spot-promotion-id="" data-tags="" style="display: none"></div></div><p class="event-main-text event-time">09:00 PM - 12:00 AM</p></div></div></section>
</div>
<div class="events-holder">
<section id="2793915"><div class="row event-content"><div class="col-md-6 event-content-item event-image-holder"><img alt="" class="event-image" src="//static.spotapps.co/spots/c2/3abdd8c31a4452acbc32fc99fd6b21/w926"/></div><div class="col-md-6 event-content-item event-text-holder"><h2>Lees Brothers</h2><p class="event-main-text event-day">Wednesday November 25th</p><div class="event-info-text"><div data-event-id="2793915" data-is-recurring="false" data-origin-event-id="2793915" data-spot-promotion-id="" data-tags="" style="display: none"></div><p style="text-align:center">Thanksgiving Eve</p></div><p class="event-main-text event-time">09:30 PM - 12:00 AM</p></div></div></section>
</div>`

// Anchor "now" so year-rollover assertions are deterministic (mid-July 2026).
const NOW = new Date('2026-07-14T16:00:00Z')

describe('Clutch Lanes: parseEvents', () => {
  const events = parseEvents(EVENTS_HTML)

  it('parses every section', () => {
    assert.equal(events.length, 4)
  })

  it('extracts stable numeric source_ids', () => {
    assert.deepEqual(events.map(e => e.sourceId), ['2892015', '2892026', '2793873', '2793915'])
  })

  it('decodes entity-escaped titles', () => {
    assert.equal(events[1].title, 'Mick & Rick Band')
  })

  it('captures the prose date and time range', () => {
    assert.equal(events[0].dayText, 'Saturday July 18th')
    assert.equal(events[0].timeText, '11:00 AM - 01:00 PM')
  })

  it('absolutizes protocol-relative image URLs', () => {
    assert.equal(events[0].imageUrl, 'https://static.spotapps.co/spots/50/17e7e7e5c44685ab7869489990c91e/w926')
  })

  it('captures an event-info-text note but leaves note-less events null', () => {
    assert.equal(events[3].note, 'Thanksgiving Eve')
    assert.equal(events[0].note, null)
    assert.equal(events[1].note, null)
  })
})

describe('Clutch Lanes: parseEventDate (year inference via weekday)', () => {
  it('resolves the current-year date when in the future', () => {
    assert.equal(parseEventDate('Saturday July 18th', NOW), '2026-07-18')
  })

  it('strips ordinal suffixes and parses full month names', () => {
    assert.equal(parseEventDate('Wednesday November 25th', NOW), '2026-11-25')
    assert.equal(parseEventDate('Saturday August 1st', NOW), '2026-08-01')
  })

  it('rolls a January event forward to next year when run in December', () => {
    // Realistic New-Year rollover: a Dec run sees a January listing whose
    // weekday belongs to next year. Jan 8 2027 is a Friday.
    const dec = new Date('2026-12-20T16:00:00Z')
    assert.equal(parseEventDate('Friday January 8th', dec), '2027-01-08')
  })

  it('lets the stated weekday pick the year (not merely the nearest)', () => {
    // July 18 2026 is a Saturday; July 18 2027 is a Sunday. A "Sunday" listing
    // must skip the nearer 2026 and land on 2027 — this fails loudly if the
    // weekday disambiguator is ever dropped in favor of "nearest future".
    assert.equal(parseEventDate('Sunday July 18th', NOW), '2027-07-18')
  })

  it('skips impossible day/month pairs instead of emitting a fake date', () => {
    // Feb 29 only exists in a leap year — from mid-2026 the next is 2028.
    assert.equal(parseEventDate('Saturday February 29th', NOW), '2028-02-29')
    // A truly impossible date must fail loud (null), never roll into March.
    assert.equal(parseEventDate('Tuesday February 30th', NOW), null)
    assert.equal(parseEventDate('Monday April 31st', NOW), null)
  })

  it('returns null for unparseable input', () => {
    assert.equal(parseEventDate('coming soon', NOW), null)
    assert.equal(parseEventDate('', NOW), null)
  })
})

describe('Clutch Lanes: time parsing', () => {
  it('splits a time range into start/end', () => {
    assert.deepEqual(parseTimeRange('07:00 PM - 10:00 PM'), { startTime: '07:00 PM', endTime: '10:00 PM' })
  })

  it('handles a lone start time', () => {
    assert.deepEqual(parseTimeRange('08:00 PM'), { startTime: '08:00 PM', endTime: null })
  })

  it('converts clock tokens to minutes', () => {
    assert.equal(timeToMinutes('11:00 AM'), 660)
    assert.equal(timeToMinutes('12:00 AM'), 0)
    assert.equal(timeToMinutes('12:00 PM'), 720)
    assert.equal(timeToMinutes('09:30 PM'), 1290)
  })
})

describe('Clutch Lanes: computeSchedule', () => {
  it('builds start/end ISO from an in-day range (EDT = UTC-4)', () => {
    const { startAt, endAt } = computeSchedule('Saturday August 1st', '07:00 PM - 10:00 PM', NOW)
    assert.equal(startAt, '2026-08-01T23:00:00.000Z') // 7pm EDT
    assert.equal(endAt, '2026-08-02T02:00:00.000Z')   // 10pm EDT
  })

  it('rolls end_at to the next day when the show crosses midnight', () => {
    const { startAt, endAt } = computeSchedule('Saturday September 5th', '09:00 PM - 12:00 AM', NOW)
    assert.equal(startAt, '2026-09-06T01:00:00.000Z')  // 9pm EDT Sep 5
    assert.equal(endAt, '2026-09-06T04:00:00.000Z')    // midnight EDT → Sep 6 00:00
    assert.ok(Date.parse(endAt) > Date.parse(startAt))
  })

  it('rolls a post-DST (EST = UTC-5) late show across midnight', () => {
    // Nov 7 2026 is a Saturday and falls after DST ends (Nov 1), so the venue
    // is on EST. 9pm EST → 02:00 UTC Nov 8; midnight EST → 05:00 UTC Nov 8.
    const { startAt, endAt } = computeSchedule('Saturday November 7th', '09:00 PM - 12:00 AM', NOW)
    assert.equal(startAt, '2026-11-08T02:00:00.000Z')
    assert.equal(endAt, '2026-11-08T05:00:00.000Z')
    assert.ok(Date.parse(endAt) > Date.parse(startAt))
  })

  it('returns null when the date is unparseable', () => {
    assert.equal(computeSchedule('TBA', '07:00 PM - 10:00 PM', NOW), null)
  })
})

describe('Clutch Lanes: category mapping', () => {
  it('maps bowling / tournament / trivia titles to games', () => {
    assert.equal(parseCategory('Superhero Bowling'), 'games')
    assert.equal(parseCategory('Cosmic Bowling Tournament'), 'games')
    assert.equal(parseCategory('Trivia Night'), 'games')
    assert.equal(parseCategory('Summer Bowling League'), 'games')
  })

  it('defaults band / act names to music', () => {
    assert.equal(parseCategory('Chagrin River Band'), 'music')
    assert.equal(parseCategory('1st Chance'), 'music')
    assert.equal(parseCategory('Karaoke Night'), 'music')
  })
})

describe('Clutch Lanes: cancelled/postponed guard', () => {
  const CANCELLED_HTML = `
<section id="9001"><div class="event-content"><h2>CANCELED - Time Machine</h2><p class="event-day">Saturday July 18th</p><p class="event-time">07:00 PM - 10:00 PM</p></div></section>
<section id="9002"><div class="event-content"><h2>Storm (Postponed)</h2><p class="event-day">Friday September 4th</p><p class="event-time">08:00 PM - 11:00 PM</p></div></section>
<section id="9003"><div class="event-content"><h2>The Reckless Betties</h2><p class="event-day">Saturday August 15th</p><p class="event-time">07:00 PM - 10:00 PM</p></div></section>`

  it('drops cancelled and postponed events, keeping the live show', () => {
    const events = parseEvents(CANCELLED_HTML)
    assert.deepEqual(events.map(e => e.sourceId), ['9003'])
    assert.equal(events[0].title, 'The Reckless Betties')
  })
})
