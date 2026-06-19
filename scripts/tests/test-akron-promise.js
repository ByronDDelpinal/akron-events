/**
 * test-akron-promise.js — pure parsers for the Akron Promise City Series scraper
 * (akronpromise.org/cityseries, Drupal 10).
 *
 * Run:  node --test scripts/tests/test-akron-promise.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parsePromiseDate, fullImage, raceTags, parseRaces, SOURCE_KEY } =
  await import('../scrape-akron-promise.js')

describe('parsePromiseDate', () => {
  it('parses an explicit AM time', () => {
    assert.deepEqual(parsePromiseDate('8/01/26 8:00 AM'), { datePart: '2026-08-01', time: '8:00 AM' })
  })
  it('parses a PM time (converts to 24h then back)', () => {
    assert.deepEqual(parsePromiseDate('8/21/26 6:30 PM'), { datePart: '2026-08-21', time: '6:30 PM' })
  })
  it('treats a missing meridiem as the written (morning) hour', () => {
    assert.deepEqual(parsePromiseDate('7/18/26 8:00'), { datePart: '2026-07-18', time: '8:00 AM' })
  })
  it('returns null for non-date text', () => {
    assert.equal(parsePromiseDate('Registration Pending'), null)
  })
})

describe('fullImage', () => {
  it('strips the Drupal image-style segment to the original', () => {
    assert.equal(
      fullImage('/sites/default/files/styles/square_medium_400_400_/public/assets/race/Blue%20Heron%205k%20poster_0.jpg'),
      'https://www.akronpromise.org/sites/default/files/assets/race/Blue%20Heron%205k%20poster_0.jpg')
  })
  it('drops a query string and absolutizes', () => {
    assert.equal(fullImage('/sites/default/files/x.jpg?itok=abc'), 'https://www.akronpromise.org/sites/default/files/x.jpg')
  })
  it('returns null for no source', () => {
    assert.equal(fullImage(null), null)
  })
})

describe('raceTags', () => {
  it('adds conditional tags from the detail text', () => {
    const t = raceTags('Dog Friendly, Finisher Medal, Wheel Racers Welcome Kids Run Available')
    assert.ok(t.includes('city-series') && t.includes('dog-friendly') && t.includes('family') && t.includes('accessible'))
  })
})

// A fixture shaped exactly like the live City Series cards (two races: one with
// an image + register link, one without either — the "pending" case).
const HTML = `
<main>
  <h2>Upcoming Races</h2>
  <div class="item"><div class="wrap">
    <div class="image"><img loading="lazy" src="/sites/default/files/styles/square_medium_400_400_/public/assets/race/Blue%20Heron%205k%20poster_0.jpg?h=1&itok=HN2j" width="400" height="400" alt="Flight of the Heron 5K Logo" /></div>
    <div class="text">
      <h3>Flight of the Heron 5K</h3>
      <div class="date">7/18/26 8:00</div>
      Dog Friendly, Finisher Medal, Wheel Racers Welcome
      <a href="https://runsignup.com/Race/OH/Akron/FlightOfTheHeron5k" class="btn" target="_blank">Register Now</a>
    </div>
  </div></div>
  <div class="item"><div class="wrap">
    <div class="image"></div>
    <div class="text">
      <h3>Tread Together 5K (Date TBD)</h3>
      <div class="date">10/11/26 9:00 AM</div>
      Finisher Medal, Wheel Racers Welcome<br>Registration and Date Confirmation Pending
    </div>
  </div></div>
</main>
<footer><h3>Join Our Newsletter</h3></footer>
`

describe('parseRaces', () => {
  const races = parseRaces(HTML)

  it('parses every race card and ignores footer headings', () => {
    assert.equal(races.length, 2)
    assert.equal(races[0].title, 'Flight of the Heron 5K')
    assert.equal(races[1].title, 'Tread Together 5K (Date TBD)')
  })

  it('builds correct start times (8:00 AM EDT → 12:00Z)', () => {
    assert.equal(races[0].startIso, new Date('2026-07-18T12:00:00Z').toISOString())
    assert.equal(races[1].startIso, new Date('2026-10-11T13:00:00Z').toISOString())
  })

  it('captures image, register link, and detail description for the first race', () => {
    assert.match(races[0].imageUrl, /\/sites\/default\/files\/assets\/race\/Blue%20Heron/)
    assert.ok(!races[0].imageUrl.includes('styles/'))
    assert.equal(races[0].ticketUrl, 'https://runsignup.com/Race/OH/Akron/FlightOfTheHeron5k')
    assert.match(races[0].description, /Dog Friendly, Finisher Medal/)
  })

  it('handles a card with no image and no register link', () => {
    assert.equal(races[1].imageUrl, null)
    assert.equal(races[1].ticketUrl, null)
    assert.match(races[1].description, /Registration and Date Confirmation Pending/)
  })
})

describe('SOURCE_KEY', () => {
  it('is akron_promise', () => assert.equal(SOURCE_KEY, 'akron_promise'))
})
