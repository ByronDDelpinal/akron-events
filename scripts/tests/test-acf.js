/**
 * test-acf.js
 *
 * Unit tests for the Akron Community Foundation scraper's HTML parser —
 * covering:
 *   • parseEvents — title, date, time, venue, fund affiliation, Eventbrite
 *                   source ID extraction, slug fallback when no ticket URL
 *
 * Run:
 *   node --test scripts/tests/test-acf.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY  || 'dummy-key'

import { parseEvents } from '../scrape-acf.js'

const FIXTURE = `
<div class="banner-text">
<h2 class="event-title">Gala Night</h2>
<div class="event-details"><div class="event-details-left">
  <div class="event-start-date">July 14, 2026</div>
  <div class="event-start-time">5:30 pm</div>
  <div class="event-location">DoubleTree by Hilton<br>3150 W Market St, Akron, OH 44333</div>
  <div class="event-fund-affiliation">Bath Community Fund</div>
  <div class="event-website"><a class="btn" href="https://www.eventbrite.com/e/gala-tickets-123456789?aff=x">Register</a></div>
</div></div>
<div class="event-description"><p>Join us for a celebration of impact.</p></div>
<h2 class="event-title">All Day Fund Fair</h2>
<div class="event-details"><div class="event-details-left">
  <div class="event-start-date">August 28, 2026</div>
  <div class="event-location">The Bank at East End</div>
</div></div>
<div class="event-description"><p>Breakfast gathering.</p></div>
</div>`

describe('parseEvents: field extraction', () => {
  it('parses both events from fixture', () => {
    const ev = parseEvents(FIXTURE)
    assert.equal(ev.length, 2)
  })

  it('extracts title, date, time, venue, fund, and Eventbrite source ID', () => {
    const [first] = parseEvents(FIXTURE)
    assert.equal(first.title,     'Gala Night')
    assert.equal(first.dateStr,   '2026-07-14')
    assert.equal(first.timeStr,   '17:30:00')
    assert.equal(first.venueName, 'DoubleTree by Hilton')
    assert.equal(first.fund,      'Bath Community Fund')
    assert.equal(first.sourceId,  '123456789')
    assert.ok(first.description.includes('celebration'))
  })
})

describe('parseEvents: missing fields', () => {
  it('defaults missing time to midnight', () => {
    const [, second] = parseEvents(FIXTURE)
    assert.equal(second.timeStr, '00:00:00')
  })

  it('handles missing ticket URL and uses slug fallback for source ID', () => {
    const [, second] = parseEvents(FIXTURE)
    assert.equal(second.venueName, 'The Bank at East End')
    assert.equal(second.ticketUrl, null)
    assert.ok(second.sourceId.startsWith('all-day-fund-fair'))
  })
})
