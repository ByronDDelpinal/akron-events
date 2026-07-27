/**test-downtown-akron.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { F1, F2, CALENDAR_HTML } from './fixtures/downtown-akron-events.js'
import { LATE_EDT, LATE_EST, LATE_EDT_TODAY, LATE_EST_TODAY } from './fixtures/late-night-clocks.js'
import {
  parseCalendarHtml,
  parseTime,
  reconstructDate,
  filterFutureEvents,
  directlyScrapedVenue,
  directlyScrapedTitle,
  parseDetailPage,
} from '../scrape-downtown-akron.js'
import { easternTodayIso } from '../lib/normalize.js'

// The bug: at 11pm ET the UTC calendar date is already tomorrow, so both the
// year-rollover heuristic and the past-event filter treated today as past.
describe('Downtown Akron: late-evening ET runs keep today\'s events', () => {
  it('reconstructDate does not roll today into next year (EDT)', () => {
    assert.equal(reconstructDate('15', 'Jul', LATE_EDT), '2026-07-15')  // not 2027-07-15
  })

  it('reconstructDate does not roll today into next year (EST)', () => {
    assert.equal(reconstructDate('15', 'Jan', LATE_EST), '2026-01-15')  // not 2027-01-15
  })

  it('reconstructDate still rolls a genuinely past month/day forward', () => {
    assert.equal(reconstructDate('14', 'Jul', LATE_EDT), '2027-07-14')
  })

  it('filterFutureEvents keeps today and drops yesterday', () => {
    const rows = [
      { slug: 'yesterday', dateStr: '2026-07-14' },
      { slug: 'today',     dateStr: '2026-07-15' },
      { slug: 'tomorrow',  dateStr: '2026-07-16' },
    ]
    const today = easternTodayIso(LATE_EDT)
    assert.equal(today, LATE_EDT_TODAY)
    assert.deepEqual(filterFutureEvents(rows, today).map((r) => r.slug), ['today', 'tomorrow'])
  })

  it('filterFutureEvents keeps today in winter too', () => {
    const rows = [{ slug: 'today', dateStr: '2026-01-15' }, { slug: 'yesterday', dateStr: '2026-01-14' }]
    assert.equal(easternTodayIso(LATE_EST), LATE_EST_TODAY)
    assert.deepEqual(filterFutureEvents(rows, easternTodayIso(LATE_EST)).map((r) => r.slug), ['today'])
  })

  it('end-to-end: a card dated today survives the calendar parse', () => {
    // The shipped fixture plus one card for "today" in Eastern terms.
    const todayCard = `
      <a href="/event/opens-tonight" class="event-card">
        <div class="title">Opens Tonight</div>
        <div class="time">7pm</div>
        <div class="venue">Musica</div>
        <div class="dow">Wednesday</div><div class="day">15</div><div class="mon">Jul</div>
      </a>`
    const events = parseCalendarHtml(CALENDAR_HTML + todayCard, LATE_EDT)
    const tonight = events.find((e) => e.slug === 'opens-tonight')
    assert.ok(tonight, 'today\'s card must parse')
    assert.equal(tonight.dateStr, '2026-07-15')   // not 2027-07-15
    assert.equal(tonight.timeStr, '19:00:00')

    const future = filterFutureEvents(events, easternTodayIso(LATE_EDT))
    assert.ok(future.some((e) => e.slug === 'opens-tonight'), 'and must survive the past-filter')
  })
})

describe('Downtown Akron: detail-page parser (description + image)', () => {
  const DETAIL = `
    <div class="col-lg-6 padding-bottom">
      <h2>Location</h2>
      <p><a href="/go/akronym-biergarten">Akronym Biergarten</a><br>11 S Main St</p>
      <p><a href="https://facebook.com/x">visit website</a></p>
      <h2>Details</h2>
      <p>We&rsquo;re throwing a party on Main Street with a local-favorite band, GHOST SLIME!</p>
      <p>Stop by around 6:30 on the 4th for an awesome show and a cold beer.</p>
    </div>
    <div class="owl-item"><img src="https://ctycms.com/oh-akron/akron-logo-filter.svg"></div>
    <div class="owl-item"><img src="https://img.ctykit.com/cdn/oh-akron/images/tr:w-900/733095582-x.jpg" alt=""></div>
    <div class="footer">Downtown Akron Partnership<br>Greystone Hall<br>103 S. High St.</div>`

  const { description, imageUrl } = parseDetailPage(DETAIL)

  it('pulls the Details description, entity-decoded', () => {
    assert.match(description, /GHOST SLIME/)
    assert.match(description, /Stop by around 6:30/)
    assert.match(description, /We['’]re throwing/)      // &rsquo; decoded
  })
  it('excludes the Location section and boilerplate', () => {
    assert.ok(!/Akronym Biergarten/.test(description))  // Location sits above Details
    assert.ok(!/visit website/i.test(description))
    assert.ok(!/Greystone Hall/.test(description))      // footer cut
  })
  it('grabs the ctykit poster (not the logo svg)', () => {
    assert.equal(imageUrl, 'https://img.ctykit.com/cdn/oh-akron/images/tr:w-900/733095582-x.jpg')
  })
  it('returns nulls when there is no Details section', () => {
    assert.deepEqual(parseDetailPage('<div><h2>Location</h2><p>x</p></div>'),
      { description: null, imageUrl: null })
  })
})

describe('Downtown Akron: time parsing', () => {
  it('extracts the start time from am/pm strings', () => {
    assert.equal(parseTime(F1.time), F1.exp)
    assert.equal(parseTime(F2.time), F2.exp)
  })
  it('takes the start of a time range', () => {
    assert.equal(parseTime('12pm - 8pm'), '12:00:00')
  })
  it('returns null for missing input (no fabricated noon)', () => {
    assert.equal(parseTime(null), null)
  })
  it('returns null for unparseable input (no fabricated noon)', () => {
    assert.equal(parseTime('no clock here'), null)
  })
})

describe('Downtown Akron: venue parsing', () => {
  const events = parseCalendarHtml(CALENDAR_HTML, LATE_EDT)

  it('parses all three event cards', () => {
    assert.equal(events.length, 3)
  })

  it('captures a venue that contains "am" (regression: "Full Grip Games")', () => {
    // The old detector excluded any part matching /(?:a.?m.?|p.?m.?)/i, so the
    // "am" inside "Games" dropped the venue and left it null.
    const cc = events.find(e => e.slug === 'casual-commander-days-1')
    assert.ok(cc, 'Casual Commander card parsed')
    assert.equal(cc.venueName, 'Full Grip Games')
    assert.equal(cc.timeStr, '12:00:00')
    assert.ok(cc.dateStr.endsWith('-06-30'), `expected Jun 30, got ${cc.dateStr}`)
  })

  it('captures a normal venue', () => {
    const s = events.find(e => e.slug === 'sketchbook-social')
    assert.equal(s.venueName, 'Akron Art Museum')
  })

  it('leaves timeStr null when the card has no time div (no fabricated noon)', () => {
    const t = events.find(e => e.slug === 'all-day-art-walk')
    assert.ok(t, 'timeless card parsed')
    assert.equal(t.timeStr, null)
    assert.equal(t.venueName, 'Akron Soul Train')
  })
})

describe('Downtown Akron: directly-scraped venue suppression', () => {
  it('flags venues with verified-complete direct coverage', () => {
    assert.equal(directlyScrapedVenue('Full Grip Games'), 'full_grip_games')
    assert.equal(directlyScrapedVenue('full grip games'), 'full_grip_games')
    assert.equal(directlyScrapedVenue('BLU Jazz+'), 'blu_jazz')
    assert.equal(directlyScrapedVenue("Akron Children's Museum"), 'akron_childrens_museum')
    assert.equal(directlyScrapedVenue('The Nightlight'), 'nightlight_cinema')
    assert.equal(directlyScrapedVenue('The Nightlight Cinema'), 'nightlight_cinema')
  })

  it('does not flag venues that carry unique DAP content', () => {
    // Art Museum lists exhibitions the direct scraper lacks; Soul Train, Musica,
    // and Jilly's all have DAP-only events — must stay.
    assert.equal(directlyScrapedVenue('Akron Art Museum'), null)
    assert.equal(directlyScrapedVenue('Akron Soul Train'), null)
    assert.equal(directlyScrapedVenue('Musica'), null)
    assert.equal(directlyScrapedVenue(null), null)
  })

  it('removes the Full Grip event when filtering a parsed batch', () => {
    const events  = parseCalendarHtml(CALENDAR_HTML, LATE_EDT)
    const visible = events.filter(e => !directlyScrapedVenue(e.venueName))
    assert.equal(visible.length, 2)
    assert.deepEqual(visible.map(e => e.slug).sort(), ['all-day-art-walk', 'sketchbook-social'])
  })
})

describe('Downtown Akron: directly-scraped title suppression', () => {
  it('flags RubberDucks home games (owned by the rubberducks feed, often venue-less on DAP)', () => {
    assert.equal(directlyScrapedTitle('Akron RubberDucks vs Erie SeaWolves'), 'rubberducks')
    assert.equal(directlyScrapedTitle('RubberDucks vs. Chesapeake Baysox'), 'rubberducks')
  })

  it('leaves DAP-only RubberDucks promos alone', () => {
    assert.equal(directlyScrapedTitle('Win RubberDucks Tickets at the Lockview'), null)
    assert.equal(directlyScrapedTitle(null), null)
  })
})
