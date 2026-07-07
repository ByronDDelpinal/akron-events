/**test-downtown-akron.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { F1, F2, CALENDAR_HTML } from './fixtures/downtown-akron-events.js'
import {
  parseCalendarHtml,
  parseTime,
  directlyScrapedVenue,
  directlyScrapedTitle,
  parseDetailPage,
} from '../scrape-downtown-akron.js'

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
})

describe('Downtown Akron: venue parsing', () => {
  const events = parseCalendarHtml(CALENDAR_HTML)

  it('parses both event cards', () => {
    assert.equal(events.length, 2)
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
    const events  = parseCalendarHtml(CALENDAR_HTML)
    const visible = events.filter(e => !directlyScrapedVenue(e.venueName))
    assert.equal(visible.length, 1)
    assert.equal(visible[0].slug, 'sketchbook-social')
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
