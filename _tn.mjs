// Logic tests for the 3 neighborhood scrapers' pure parsers.
import assert from 'node:assert'
import { parseEvents as wellParse, parseDate as wellDate, parseTime as wellTime } from './scripts/scrape-the-well-cdc.js'
import { parseEvents as bkParse } from './scripts/scrape-better-kenmore.js'
import { parseHomepage as hsParse } from './scripts/scrape-highland-square.js'

let pass = 0, fail = 0
const ok = (n, fn) => { try { fn(); pass++; console.log('✓', n) } catch (e) { fail++; console.error('✗', n, '\n   ', e.message) } }

// ── The Well (Divi) ─────────────────────────────────────────────────────────
const wellFixture = `
<h4 class="et_pb_module_header"><span>Taste of Middlebury</span></h4>
<div class="et_pb_blurb_description">
<p><strong>JUNE 4, 2026 | 5:30PM</strong></p>
<p><strong>THE EAST END – 1200 E MARKET ST</strong></p>
<p>Celebrate 10 years of The Well CDC and help us fundraise for Middlebury!</p>
<a href="https://thewellakron.com/fundraiser/">Learn more and register!</a>
</div>
<h4 class="et_pb_module_header"><span>Coffee &amp; Career Development</span></h4>
<div class="et_pb_blurb_description">
<p><strong>October 15, 2026 | 10 – 11:30AM</strong></p>
<p><strong>The Meeting Hall @ The Well CDC – 647 E MARKET ST</strong></p>
<p>Come enjoy coffee and brunch with us! Program updates from Career Development.</p>
<a href="mailto:tanisha@thewellakron.com">email</a>
</div>`
ok('Well time parsing ranges', () => {
  assert.strictEqual(wellTime('| 5:30PM'), '17:30:00')
  assert.strictEqual(wellTime('| 10 – 11:30AM'), '10:00:00')   // start hr 10, meridian from range
  assert.strictEqual(wellTime('| 6 – 8PM'), '18:00:00')        // start hr 6, PM inferred
  assert.strictEqual(wellTime(''), '00:00:00')
  assert.strictEqual(wellDate('JUNE 4, 2026'), '2026-06-04')
})
ok('Well parses two blurbs', () => {
  const ev = wellParse(wellFixture)
  assert.strictEqual(ev.length, 2)
  assert.strictEqual(ev[0].title, 'Taste of Middlebury')
  assert.strictEqual(ev[0].dateStr, '2026-06-04')
  assert.strictEqual(ev[0].timeStr, '17:30:00')
  assert.strictEqual(ev[0].venueName, 'The East End')
  assert.ok(ev[0].description.includes('Celebrate 10 years'))
  assert.strictEqual(ev[0].ticketUrl, 'https://thewellakron.com/fundraiser/')
  // second: entity-decoded title, AM range, mailto-only → null ticket
  assert.strictEqual(ev[1].title, 'Coffee & Career Development')
  assert.strictEqual(ev[1].timeStr, '10:00:00')
  assert.strictEqual(ev[1].venueName, 'The Meeting Hall @ The Well CDC')
  assert.strictEqual(ev[1].ticketUrl, null)
})

// ── Better Kenmore (Events Manager) ─────────────────────────────────────────
const bkFixture = `
<div class="em-event em-item">
  <div class="em-event-title"><a href="/events/chair-yoga-2-2026-06-05/">Chair Yoga</a></div>
  <div class="em-item-meta-line em-event-date">Friday June 5, 2026</div>
  <div class="em-item-meta-line em-event-time">9:30 am - 10:30 am</div>
  <div class="em-item-meta-line em-event-location">Kenmore Senior Community Center</div>
</div>
<div class="em-event em-item">
  <div class="em-event-title"><a href="/events/blvd-block-party/">BLVD Block Party</a></div>
  <div class="em-item-meta-line em-event-date">Saturday June 7, 2026</div>
  <div class="em-item-meta-line em-event-time">All Day</div>
  <div class="em-item-meta-line em-event-location">Kenmore Boulevard</div>
</div>`
ok('Better Kenmore parses em-event items', () => {
  const ev = bkParse(bkFixture)
  assert.strictEqual(ev.length, 2)
  assert.strictEqual(ev[0].title, 'Chair Yoga')
  assert.strictEqual(ev[0].dateStr, '2026-06-05')
  assert.strictEqual(ev[0].timeStr, '09:30:00')
  assert.strictEqual(ev[0].location, 'Kenmore Senior Community Center')
  assert.strictEqual(ev[0].ticketUrl, 'https://www.betterkenmore.org/events/chair-yoga-2-2026-06-05/')
  assert.strictEqual(ev[0].sourceId, 'chair-yoga-2026-06-05')
  // All Day → midnight
  assert.strictEqual(ev[1].timeStr, '00:00:00')
  assert.strictEqual(ev[1].title, 'BLVD Block Party')
})

// ── Highland Square (Wix SSR) ───────────────────────────────────────────────
const hsFixture = `
<html><head>
<meta property="og:description" content="PorchROKR is a music Festival in Highland Square, Akron."/>
<meta property="og:image" content="https://static.wixstatic.com/media/poster.jpg"/>
</head><body>
<h2>AUGUST 15, 2026</h2>
<p>Join us for a day of music, food and fun!</p>
</body></html>`
ok('Highland Square parses PorchROKR date + meta', () => {
  const ev = hsParse(hsFixture)
  assert.ok(ev)
  assert.strictEqual(ev.dateStr, '2026-08-15')
  assert.strictEqual(ev.title, 'PorchROKR Music & Arts Festival')
  assert.strictEqual(ev.startTime, '11:00:00')
  assert.strictEqual(ev.sourceId, 'porchrokr-2026')
  assert.ok(ev.description.includes('PorchROKR'))
  assert.ok(ev.imageUrl.includes('poster.jpg'))
})
ok('Highland Square returns null when no date', () => {
  assert.strictEqual(hsParse('<html><body>No festival announced</body></html>'), null)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
