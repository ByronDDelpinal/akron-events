/**
 * test-tangier.js — pure parsers for the Tangier (Webflow /events) scraper.
 *
 * The FIXTURE reproduces the LIVE page's real quirks (which an earlier, cleaner
 * fixture missed and let two bugs ship): the inline "Purchase Tickets / Reserve
 * A Table / View Menu" buttons that htmlToText concatenates onto the next
 * title's line (so titles MUST come from the raw <h2>, not the flattened text),
 * and start times stated only in prose ("lounge at 6:00 pm", "Open Bar from 7
 * pm", "Doors open at 6:30PM"). Parsing runs through the real htmlToText.
 *
 * Run:  node --test scripts/tests/test-tangier.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseTangierEvents, parseDate, parseStartTime, parseHeldAt, parsePrices, titleCase } =
  await import('../scrape-tangier.js')

const CDN = 'https://cdn.prod.website-files.com/67fd0be8b993a3a0bcf50b41'
const HELD = 'This EVENT WILL BE HELD AT tangier west:<br>3150 w market street<br>Fairlawn, Oh 44333'
// The four inline buttons that repeat in every card (boilerplate id 51986841 +
// the event's real link). Rendered inline so htmlToText joins them with no break.
const buttons = (realId, realSlug) =>
  `<a href="https://www.etix.com/ticket/p/51986841/disco-infernos-new-years-party-at-the-bank-at-east-end-fairlawn-the-tangier?gclid=">Purchase Tickets</a>` +
  `<a href="https://www.thetangier.com/mothers-day-reservations-2026">Reserve A Table</a>` +
  `<a href="https://cdn.prod.website-files.com/x/Menu.pdf">View Menu</a>` +
  `<a href="https://www.etix.com/ticket/p/${realId}/${realSlug}?gclid=">Purchase Tickets</a>`

const FIXTURE = `
<h2>Upcoming Events</h2>
<img src="${CDN}/6a4d223f00c0ce587ba2b869_Frankie-Scinta-Banner%20(1).png" alt="">
<h2>Frankie Scinta</h2>
<div>August 19, 2026</div>
<div>${HELD}</div>
<div>After 65 years of great food and entertainment in Akron, Tangier is proud to invite you to our GRAND OPENING of Tangier West. Dinner Package includes access to our new Isabella's lounge at 6:00 pm; dinner will start at 7:00 pm.</div>
<div>$105.70 Reserved Table &amp; Dinner Package</div>
${buttons('83269894', 'frankie-scintathe-showman-fairlawn-tangier-west')}
<img src="${CDN}/6a4d272c54407c2d7fb539a0_Halloween-Party-Banner.png" alt="">
<h2>Halloween Party with Roxxymoron</h2>
<div>October 31, 2026</div>
<div>${HELD}</div>
<div>Come dress up featuring Roxxymoron, an 8-piece cover band. Appetizer and Bar Package includes an Open Bar from 7 pm to 11 pm.</div>
<div>$32.20 GA Show Only</div>
<div>$105.70 GA with Dinner</div>
${buttons('92258107', 'tangier-west-1st-annual-halloween-party-featuring-roxxymoron-fairlawn-tangier-west')}
<img src="${CDN}/6a4d1f2b92830336e94df5d1_6812cc4f1cb25e0dab1def87_NewYears-bkg.png" alt="">
<h2>New Year's Eve with Disco Inferno</h2>
<div>December 31, 2026</div>
<div>${HELD}</div>
<div>Bring in 2027 with dinner and a countdown by Disco Inferno! Doors open at 6:30PM. Buffet at 8:15PM.</div>
<div>$142.45 Reserved Seating and Dinner Package</div>
${buttons('92344237', 'disco-inferno-new-years-eve-fairlawn-tangier-west')}
<h2>Event Gallery</h2>
<img src="${CDN}/EventGallery1.jpg" alt="">
`

describe('tangier: field parsers', () => {
  it('parseDate', () => { assert.equal(parseDate('August 19, 2026'), '2026-08-19') })
  it('parseStartTime — first clock time in prose', () => {
    assert.equal(parseStartTime('lounge at 6:00 pm; dinner at 7:00 pm'), '18:00')
    assert.equal(parseStartTime('Open Bar from 7 pm to 11 pm'), '19:00')
    assert.equal(parseStartTime('Doors open at 6:30PM.'), '18:30')
    assert.equal(parseStartTime('no time here'), '')   // date-only, never fabricated
  })
  it('parseHeldAt', () => {
    assert.deepEqual(
      parseHeldAt('This EVENT WILL BE HELD AT tangier west: 3150 w market street Fairlawn, Oh 44333'),
      { name: 'Tangier West', address: '3150 W Market Street', city: 'Fairlawn', state: 'OH', zip: '44333' })
  })
  it('parsePrices', () => { assert.deepEqual(parsePrices('$32.20 / $105.70'), { min: 32.20, max: 105.70 }) })
  it('titleCase', () => { assert.equal(titleCase('tangier west'), 'Tangier West') })
})

describe('tangier: parseTangierEvents (real htmlToText path)', () => {
  const events = parseTangierEvents(FIXTURE)

  it('CLEAN titles despite the concatenated buttons (the shipped bug)', () => {
    assert.equal(events.length, 3)
    assert.deepEqual(events.map((e) => e.title),
      ['Frankie Scinta', 'Halloween Party with Roxxymoron', "New Year's Eve with Disco Inferno"])
    // none must carry button noise
    assert.ok(events.every((e) => !/Purchase Tickets|Reserve A Table|View Menu/i.test(e.title)))
    assert.ok(events.every((e) => !e.ticketUrl.includes('51986841')))
  })

  it('start times parsed from prose (not midnight)', () => {
    assert.equal(events[0].time, '18:00')  // Frankie — lounge at 6:00 pm
    assert.equal(events[1].time, '19:00')  // Halloween — Open Bar from 7 pm
    assert.equal(events[2].time, '18:30')  // NYE — Doors open at 6:30PM
  })

  it('Frankie: venue, price, ticket, image, source_id', () => {
    const e = events[0]
    assert.equal(e.dateYmd, '2026-08-19')
    assert.deepEqual(e.venue, { name: 'Tangier West', address: '3150 W Market Street', city: 'Fairlawn', state: 'OH', zip: '44333' })
    assert.equal(e.priceMin, 105.70); assert.equal(e.priceMax, 105.70)
    assert.equal(e.ticketUrl, 'https://www.etix.com/ticket/p/83269894/frankie-scintathe-showman-fairlawn-tangier-west')
    assert.equal(e.sourceId, 'tangier-83269894')
    assert.ok(e.imageUrl.includes('Frankie-Scinta-Banner') && !e.imageUrl.includes(' '))
    assert.ok(e.description && e.description.includes('GRAND OPENING') && !e.description.includes('$'))
  })

  it('Halloween: price range + right ticket', () => {
    const e = events[1]
    assert.equal(e.dateYmd, '2026-10-31')
    assert.equal(e.priceMin, 32.20); assert.equal(e.priceMax, 105.70)
    assert.equal(e.sourceId, 'tangier-92258107')
    assert.ok(e.imageUrl.includes('Halloween-Party-Banner'))
  })

  it('NYE: date + ticket', () => {
    const e = events[2]
    assert.equal(e.dateYmd, '2026-12-31')
    assert.equal(e.priceMin, 142.45)
    assert.equal(e.sourceId, 'tangier-92344237')
  })
})
