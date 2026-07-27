/**
 * test-tangier.js — pure parsers for the Tangier (Webflow /events) scraper.
 *
 * The FIXTURE is raw HTML mirroring the live thetangier.com/events page: the
 * flat img → h2 → date → HELD-AT → description → prices → tickets sequence, the
 * repeating BOILERPLATE Etix button (id 51986841) that must be dropped, the real
 * per-event Etix links, the real banner URLs (including the "(1)" in the Frankie
 * banner), and the doors-time prose. Parsing runs through the real htmlToText.
 *
 * Run:  node --test scripts/tests/test-tangier.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseTangierEvents, parseDate, parseDoorsTime, parseHeldAt, parsePrices, titleCase } =
  await import('../scrape-tangier.js')

const CDN = 'https://cdn.prod.website-files.com/67fd0be8b993a3a0bcf50b41'
const BOILER = '<a href="https://www.etix.com/ticket/p/51986841/disco-infernos-new-years-party-at-the-bank-at-east-end-fairlawn-the-tangier?gclid=">Purchase Tickets</a>'

const FIXTURE = `
<h2>Upcoming Events</h2>
<img src="${CDN}/6a4d223f00c0ce587ba2b869_Frankie-Scinta-Banner%20(1).png" alt="">
<h2>Frankie Scinta</h2>
<p>August 19, 2026</p>
<p>This EVENT WILL BE HELD AT tangier west:<br>3150 w market street<br>Fairlawn, Oh 44333</p>
<p>After 65 years of great food and entertainment in Akron, Tangier is proud to invite you to our GRAND OPENING of Tangier West featuring our favorite performer!!</p>
<p>$105.70 Reserved Table &amp; Dinner Package</p>
${BOILER}
<a href="https://www.etix.com/ticket/p/83269894/frankie-scintathe-showman-fairlawn-tangier-west?gclid=">Purchase Tickets</a>

<img src="${CDN}/6a4d272c54407c2d7fb539a0_Halloween-Party-Banner.png" alt="">
<h2>Halloween Party with Roxxymoron</h2>
<p>October 31, 2026</p>
<p>This EVENT WILL BE HELD AT tangier west:<br>3150 w market street<br>Fairlawn, Oh 44333</p>
<p>Come dress up and show us your moves featuring Roxxymoron, an 8-piece cover band in Akron, Ohio.</p>
<p>$32.20 GA Show Only</p>
<p>$105.70 GA with Dinner</p>
${BOILER}
<a href="https://www.etix.com/ticket/p/92258107/tangier-west-1st-annual-halloween-party-featuring-roxxymoron-fairlawn-tangier-west?gclid=">Purchase Tickets</a>

<img src="${CDN}/6a4d1f2b92830336e94df5d1_6812cc4f1cb25e0dab1def87_NewYears-bkg.png" alt="">
<h2>New Year's Eve with Disco Inferno</h2>
<p>December 31, 2026</p>
<p>This EVENT WILL BE HELD AT tangier west:<br>3150 w market street<br>Fairlawn, Oh 44333</p>
<p>Bring in 2027 with our buffet style dinner, open bar, and countdown by Disco Inferno! Doors open at 6:30PM.</p>
<p>$142.45 Reserved Seating and Dinner Package</p>
${BOILER}
<a href="https://www.etix.com/ticket/p/92344237/disco-inferno-new-years-eve-fairlawn-tangier-west?gclid=">Purchase Tickets</a>
<h2>Event Gallery</h2>
<img src="${CDN}/EventGallery1.jpg" alt="">
`

describe('tangier: field parsers', () => {
  it('parseDate', () => {
    assert.equal(parseDate('August 19, 2026'), '2026-08-19')
    assert.equal(parseDate('December 31, 2026'), '2026-12-31')
    assert.equal(parseDate('nope'), null)
  })
  it('parseDoorsTime — only when stated', () => {
    assert.equal(parseDoorsTime('Doors open at 6:30PM.'), '18:30')
    assert.equal(parseDoorsTime('Doors open at 7 pm'), '19:00')
    assert.equal(parseDoorsTime('dinner at 7:00 pm'), '')   // not a doors cue → date-only
  })
  it('parseHeldAt', () => {
    assert.deepEqual(
      parseHeldAt('This EVENT WILL BE HELD AT tangier west: 3150 w market street Fairlawn, Oh 44333'),
      { name: 'Tangier West', address: '3150 W Market Street', city: 'Fairlawn', state: 'OH', zip: '44333' })
    assert.equal(parseHeldAt('no location here'), null)
  })
  it('parsePrices', () => {
    assert.deepEqual(parsePrices('$32.20 GA / $105.70 dinner'), { min: 32.20, max: 105.70 })
    assert.deepEqual(parsePrices('no price'), { min: null, max: null })
  })
  it('titleCase', () => { assert.equal(titleCase('tangier west'), 'Tangier West') })
})

describe('tangier: parseTangierEvents (real htmlToText path)', () => {
  const events = parseTangierEvents(FIXTURE)

  it('finds exactly the 3 real events (boilerplate link dropped)', () => {
    assert.equal(events.length, 3)
    assert.deepEqual(events.map((e) => e.title),
      ['Frankie Scinta', 'Halloween Party with Roxxymoron', "New Year's Eve with Disco Inferno"])
    // the boilerplate id must never become a ticket url
    assert.ok(events.every((e) => !e.ticketUrl.includes('51986841')))
  })

  it('Frankie Scinta: date, venue, price, ticket, image, date-only time', () => {
    const e = events[0]
    assert.equal(e.dateYmd, '2026-08-19')
    assert.equal(e.time, '')                       // no doors time stated
    assert.deepEqual(e.venue, { name: 'Tangier West', address: '3150 W Market Street', city: 'Fairlawn', state: 'OH', zip: '44333' })
    assert.equal(e.priceMin, 105.70); assert.equal(e.priceMax, 105.70)
    assert.equal(e.ticketUrl, 'https://www.etix.com/ticket/p/83269894/frankie-scintathe-showman-fairlawn-tangier-west')
    assert.equal(e.sourceId, 'tangier-83269894')
    assert.ok(e.imageUrl.includes('Frankie-Scinta-Banner'))
    assert.ok(e.imageUrl.endsWith('.png') && !e.imageUrl.includes(' '))  // stays percent-encoded
    assert.ok(e.description && e.description.includes('GRAND OPENING') && !e.description.includes('$'))
  })

  it('Halloween: price range across two tiers', () => {
    const e = events[1]
    assert.equal(e.dateYmd, '2026-10-31')
    assert.equal(e.priceMin, 32.20); assert.equal(e.priceMax, 105.70)
    assert.equal(e.sourceId, 'tangier-92258107')
  })

  it('NYE: parses the stated doors time', () => {
    const e = events[2]
    assert.equal(e.dateYmd, '2026-12-31')
    assert.equal(e.time, '18:30')
    assert.equal(e.priceMin, 142.45); assert.equal(e.priceMax, 142.45)
    assert.equal(e.sourceId, 'tangier-92344237')
  })
})
