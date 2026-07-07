/**
 * test-summit-county-fairgrounds.js — pure parsers for the Summit County
 * Fairgrounds scraper. The fixture mirrors the real summitfair.com
 * /schedule-of-events/ markup: a "YYYY Schedule of Events" section marker,
 * then repeated <h3> date / <h4> title pairs with free-text bodies and a
 * "More Info" link (usually an outside promoter).
 *
 * Run:  node --test scripts/tests/test-summit-county-fairgrounds.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseFairDate, parseFairTime, parseFairPrice, parseEvents, SOURCE_KEY } =
  await import('../scrape-summit-county-fairgrounds.js')

// Trimmed slice of the live page, keeping the two year sections and a mix of
// single-day, same-month range, and cross-month range headings, plus events
// with/without times and stated prices.
const HTML = `
<h2 class="wp-block-heading"><strong>2026 Schedule of Events</strong></h2>
<h3 class="wp-block-heading">JUNE 28</h3>
<h4 class="wp-block-heading"><strong>COMIC BOOK SHOW</strong></h4>
<p>In the Virginia OCasek Party Center</p>
<p>23rd Akron-Summit Comic Convention</p>
<p><a href="https://www.facebook.com/profile.php?id=100049294376401">More Info</a></p>
<h3 class="wp-block-heading">JULY 28-AUGUST 2</h3>
<h4 class="wp-block-heading"><strong>SUMMIT COUNTY FAIR</strong></h4>
<p><a href="https://summitfair.com/fair/">More Info</a></p>
<h3 class="wp-block-heading">AUGUST 22-23</h3>
<h4 class="wp-block-heading"><strong>SUGARBUSH DOG SHOW</strong></h4>
<p>Doors Open at 8am</p>
<p>$8 per car admission</p>
<p><a href="https://www.infodog.com/show/club_page.htm?ev=2025173508">More Info</a></p>
<h3 class="wp-block-heading">September 26-27</h3>
<h4 class="wp-block-heading"><strong>Ohio Gun, Knife, &amp; Military Show</strong></h4>
<p>Saturday 9 &#8211; 5 / Sunday 9 &#8211; 3</p>
<p>FREE PARKING / $8 ADMISSION FEE PER PERSON</p>
<p><a href="https://ohiogunshows.com/wp/">More Info</a></p>
<h3 class="wp-block-heading">October 2-4</h3>
<h4 class="wp-block-heading"><strong>SUMMIT COUNTY HOME SHOW</strong></h4>
<p>Free Admission Public Welcome</p>
<p><a href="https://summitcountyhomeexpo.com/">More Info</a></p>
<h2 class="wp-block-heading"><strong>2027 Schedule of Events</strong></h2>
<h3 class="wp-block-heading">January 30-Feb 1</h3>
<h4 class="wp-block-heading"><strong>Ohio Gun, Knife, &amp; Military Show</strong></h4>
<p>Saturday 9 &#8211; 5 / Sunday 9 &#8211; 3</p>
<p>FREE PARKING / $8 ADMISSION FEE PER PERSON</p>
<p><a href="https://ohiogunshows.com/wp/">More Info</a></p>
<h3 class="wp-block-heading">February 28- March 1</h3>
<h4 class="wp-block-heading"><strong>Medina Club Dog Show</strong></h4>
<p>Admission: $10.00 per car / Two Day Pass $15.00 per car</p>
<p><a href="https://medinakennelclub.org/">More Info</a></p>
`

describe('parseFairDate', () => {
  it('single-day headings', () => {
    assert.equal(parseFairDate('JUNE 28', 2026), '2026-06-28')
    assert.equal(parseFairDate('September 5', 2026), '2026-09-05')
  })
  it('same-month ranges use the start day', () => {
    assert.equal(parseFairDate('October 2-4', 2026), '2026-10-02')
    assert.equal(parseFairDate('November 28-29', 2026), '2026-11-28')
  })
  it('cross-month ranges use the start month/day', () => {
    assert.equal(parseFairDate('JULY 28-AUGUST 2', 2026), '2026-07-28')
    assert.equal(parseFairDate('January 30-Feb 1', 2027), '2027-01-30')
    assert.equal(parseFairDate('February 28- March 1', 2027), '2027-02-28')
  })
  it('returns null without a year or a parseable month', () => {
    assert.equal(parseFairDate('JUNE 28', null), null)
    assert.equal(parseFairDate('Coming Soon', 2026), null)
  })
})

describe('parseFairTime', () => {
  it('reads a "Doors Open at" line', () => {
    assert.equal(parseFairTime('Doors Open at 8am'), '8:00 AM')
    assert.equal(parseFairTime('Doors Open at 3pm'), '3:00 PM')
  })
  it('reads the opening bound of a range', () => {
    assert.equal(parseFairTime('11am – 4pm'), '11:00 AM')
    assert.equal(parseFairTime('10am to 4pm / $1 donation'), '10:00 AM')
  })
  it('returns empty when no time is present', () => {
    assert.equal(parseFairTime('Free Admission Public Welcome'), '')
  })
})

describe('parseFairPrice', () => {
  it('recognizes free admission', () => {
    assert.deepEqual(parseFairPrice('Free Admission Public Welcome'), { price_min: 0, price_max: null })
  })
  it('captures a single stated price', () => {
    assert.deepEqual(parseFairPrice('$8 per car admission'), { price_min: 8, price_max: null })
  })
  it('captures a min/max spread', () => {
    assert.deepEqual(
      parseFairPrice('Admission: $10.00 per car / Two Day Pass $15.00 per car'),
      { price_min: 10, price_max: 15 },
    )
  })
  it('returns nulls when no price stated', () => {
    assert.deepEqual(parseFairPrice('In the Party Center'), { price_min: null, price_max: null })
  })
})

describe('parseEvents', () => {
  const events = parseEvents(HTML)

  it('parses every h3/h4 event across both year sections', () => {
    assert.equal(events.length, 7)
  })

  it('attributes the right year to each section', () => {
    const fair = events.find((e) => e.title === 'SUMMIT COUNTY FAIR')
    assert.equal(fair.date, '2026-07-28')
    const gun2027 = events.find((e) => e.date.startsWith('2027') && /Gun/.test(e.title))
    assert.equal(gun2027.date, '2027-01-30')
  })

  it('captures title, start date, time, price, and the outside-promoter link', () => {
    const dog = events.find((e) => e.title === 'SUGARBUSH DOG SHOW')
    assert.equal(dog.date, '2026-08-22')
    assert.equal(dog.time, '8:00 AM')
    assert.equal(dog.priceMin, 8)
    assert.equal(dog.url, 'https://www.infodog.com/show/club_page.htm')
  })

  it('leaves time empty and price null when the fairgrounds lists neither', () => {
    const fair = events.find((e) => e.title === 'SUMMIT COUNTY FAIR')
    assert.equal(fair.time, '')
    assert.equal(fair.priceMin, null)
    assert.equal(fair.url, 'https://summitfair.com/fair/')
  })

  it('decodes entities in titles', () => {
    const gun = events.find((e) => /Military Show/.test(e.title))
    assert.equal(gun.title, 'Ohio Gun, Knife, & Military Show')
  })
})

describe('SOURCE_KEY', () => {
  it('is summit_county_fairgrounds', () => assert.equal(SOURCE_KEY, 'summit_county_fairgrounds'))
})
