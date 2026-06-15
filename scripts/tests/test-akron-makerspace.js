/**
 * test-akron-makerspace.js — Simple Calendar HTML parsing + the public-event
 * filter for the Akron Makerspace scraper.
 *
 * Run:  node --test scripts/tests/test-akron-makerspace.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  parseSimcalEvents, cleanTitle, to24h, isPublicMakerspaceEvent,
} = await import('../scrape-akron-makerspace.js')

const FIXTURE = `<dl class="simcal-events-list-container">
<dt class="simcal-day-label">June 16, 2026</dt>
<dd><ul class="simcal-events">
<li class="simcal-event simcal-event-recurring" data-start="1781647200">
  <div class="simcal-event-details">
    <span class="simcal-event-title"><a href="https://x/?ev=1">Turning Tuesday @ Akron Makerspace</a></span>
    <span class="simcal-event-start simcal-event-start-date">June 16, 2026</span>
    <span class="simcal-event-start simcal-event-start-time">6:00 pm</span>
    <span class="simcal-event-end simcal-event-end-time">9:00 pm</span>
    <span class="simcal-event-address simcal-event-start-location">Akron MakerSpace, 540 S Main St #951, Akron, OH 44311, USA</span>
    <div class="simcal-event-description">Wood turning demos with Bob.</div>
  </div>
</li>
<li class="simcal-event" data-start="1781647200">
  <div class="simcal-event-details">
    <span class="simcal-event-title">Weekly Open Workshop Hours @ Akron Makerspace</span>
    <span class="simcal-event-end-time">9:00 pm</span>
    <span class="simcal-event-address simcal-event-start-location">Akron MakerSpace, 540 S Main St #951, Akron, OH 44311, USA</span>
    <div class="simcal-event-description">These open workshop hours are only for members.</div>
  </div>
</li>
<li class="simcal-event" data-start="1781733600">
  <div class="simcal-event-details">
    <span class="simcal-event-title">Maker Fair @ Cleveland</span>
    <span class="simcal-event-end-time">5:00 pm</span>
    <span class="simcal-event-address simcal-event-start-location">100 Other St, Cleveland, OH 44113, USA</span>
    <div class="simcal-event-description">An around-town event.</div>
  </div>
</li>
</ul></dd></dl>`

describe('parseSimcalEvents', () => {
  const evs = parseSimcalEvents(FIXTURE)
  it('parses all event blocks with epoch + fields', () => {
    assert.equal(evs.length, 3)
    assert.equal(evs[0].startEpoch, 1781647200)
    assert.equal(evs[0].title, 'Turning Tuesday @ Akron Makerspace') // anchor text captured
    assert.equal(evs[0].endTime, '9:00 pm')
    assert.ok(evs[0].address.includes('540 S Main'))
    assert.equal(evs[0].description, 'Wood turning demos with Bob.')
  })
})

describe('cleanTitle + to24h', () => {
  it('strips the venue suffix', () => {
    assert.equal(cleanTitle('Turning Tuesday @ Akron Makerspace'), 'Turning Tuesday')
  })
  it('converts pm time', () => {
    assert.equal(to24h('9:00 pm'), '21:00:00')
    assert.equal(to24h('10:00 am'), '10:00:00')
  })
})

describe('isPublicMakerspaceEvent', () => {
  const evs = parseSimcalEvents(FIXTURE)
  it('keeps a public class at the Makerspace', () => {
    assert.equal(isPublicMakerspaceEvent(evs[0]), true)
  })
  it('drops members-only open workshop hours', () => {
    assert.equal(isPublicMakerspaceEvent(evs[1]), false)
  })
  it('drops around-town events at other venues', () => {
    assert.equal(isPublicMakerspaceEvent(evs[2]), false)
  })
})
