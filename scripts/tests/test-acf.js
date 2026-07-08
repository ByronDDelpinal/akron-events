/**
 * test-acf.js
 *
 * Unit tests for the Akron Community Foundation scraper's HTML parser —
 * covering:
 *   • extractEventbriteEvents / parseEvents (primary path) — inline
 *     blocksForEventbrite JSON from the Blocks for Eventbrite plugin,
 *     including multiple assignments, dedupe, and brace/quote edge cases
 *   • parseEvents legacy fallback — title, date, time, venue, fund
 *     affiliation, Eventbrite source ID extraction, slug fallback when
 *     no ticket URL
 *
 * Run:
 *   node --test scripts/tests/test-acf.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY  || 'dummy-key'

import { parseEvents, extractEventbriteEvents } from '../scrape-acf.js'

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

// ── Blocks for Eventbrite inline JSON (primary path since 2026-07) ──────────

const EB_EVENT = {
  id: '1989952907715',
  name: { text: "ACF's 71st Annual Meeting", html: 'ACF&#39;s 71st Annual Meeting' },
  summary: 'Short summary with {braces} and "quotes".',
  description: { text: 'Join Akron Community Foundation as we celebrate the extraordinary impact of our donors "and" partners.' },
  url: 'https://www.eventbrite.com/e/acfs-71st-annual-meeting-registration-1989952907715',
  start: { timezone: 'America/New_York', local: '2026-07-14T17:30:00', utc: '2026-07-14T21:30:00Z' },
  end:   { timezone: 'America/New_York', local: '2026-07-14T19:00:00', utc: '2026-07-14T23:00:00Z' },
  is_free: true,
  logo: { crop_mask: null, original: { url: 'https://img.evbuc.com/foo/original.jpg' } },
  venue: { name: 'DoubleTree by Hilton Akron Fairlawn', address: { address_1: '3180 West Market Street', city: 'Fairlawn' } },
}

// Mirrors the real page: an empty placeholder assignment followed by the
// populated one, both inside <script> tags.
const EB_FIXTURE = `
<html><head><script>
blocksForEventbrite = {"events":[],"attributes":[],"assets":{"placeholderImage":"x.jpg"}};
</script></head><body>
<div id="root-blocks-for-eventbrite" class="blocks-for-eventbrite"></div>
<script>blocksForEventbrite = ${JSON.stringify({ events: [EB_EVENT], attributes: [] })};</script>
</body></html>`

describe('extractEventbriteEvents: inline JSON extraction', () => {
  it('merges all assignments and dedupes by event id', () => {
    const events = extractEventbriteEvents(EB_FIXTURE)
    assert.equal(events.length, 1)
    assert.equal(events[0].id, '1989952907715')
  })

  it('returns [] when no blocksForEventbrite assignment exists', () => {
    assert.deepEqual(extractEventbriteEvents(FIXTURE), [])
  })
})

describe('parseEvents: Eventbrite JSON primary path', () => {
  it('maps the Eventbrite payload to the internal shape', () => {
    const [ev] = parseEvents(EB_FIXTURE)
    assert.equal(ev.title, "ACF's 71st Annual Meeting")
    assert.equal(ev.dateStr, '2026-07-14')
    assert.equal(ev.timeStr, '17:30:00')
    assert.equal(ev.endLocal, '2026-07-14T19:00:00')
    assert.equal(ev.venueName, 'DoubleTree by Hilton Akron Fairlawn')
    assert.equal(ev.ticketUrl, EB_EVENT.url)
    assert.equal(ev.sourceId, '1989952907715')
    assert.equal(ev.isFree, true)
    assert.equal(ev.imageUrl, 'https://img.evbuc.com/foo/original.jpg')
    assert.ok(ev.description.includes('extraordinary impact'))
  })

  it('falls back to legacy DOM parsing when no JSON blob is present', () => {
    const events = parseEvents(FIXTURE)
    assert.equal(events.length, 2)
    assert.equal(events[0].title, 'Gala Night')
  })
})
