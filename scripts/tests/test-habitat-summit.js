/**
 * test-habitat-summit.js — pure parsers for the Habitat for Humanity of Summit
 * County scraper. Fixtures mirror the real hfhsummitcounty.org/joinus/events/
 * markup (fundraiser cards + ECWD calendar grid).
 *
 * Run:  node --test scripts/tests/test-habitat-summit.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseCardDate, inferFundraiserTime, parseFundraiserCards, parseEcwdEvents, SOURCE_KEY } =
  await import('../scrape-habitat-summit.js')

const CARDS = `
<h2>Events</h2>
<h1>Annual Fundraising Events</h1>
<div><a href="/buildinstyle/"><img></a></div>
<div><div>
  <h2>Build In Style</h2>
  <h4>Tuesday, March 9th, 2027</h4>
  <h4>Summit County ReStore</h4>
  <p>Support our Women Build Project and connect with other amazing women. Enjoy shopping for fashion accessories, a delicious lunch, and raffle prizes.</p>
  <a href="https://hfhsummitcounty.org/buildinstyle/">More Here</a>
</div></div>
<div><a href="/golfouting/"><img></a></div>
<div><div>
  <h2>Home In One</h2>
  <h4>Monday, July 27th, 2026</h4>
  <h4>Gleneagles Golf Club</h4>
  <p>Tee off for a fun-filled day of golf, complete with games, raffles, lunch, and prizes.</p>
  <a href="https://hfhsummitcounty.org/golfouting/">More Here</a>
</div></div>
<div><a href="/bourbonbuild/"><img></a></div>
<div><div>
  <h2>Bourbon Build</h2>
  <h4>Thursday, September 3rd, 2026</h4>
  <h4>The Akron RubberDucks Duck Club</h4>
  <p>Sip and support Habitat's mission with bourbon flights, food, live music, and a bottle raffle.</p>
  <a href="https://hfhsummitcounty.org/bourbonbuild/">More Here</a>
</div></div>
<h3>Support these Fundraising Events</h3>
<h2>Footer Heading Should Be Ignored</h2><h4>Junk</h4><h4>Junk</h4>
`

const ECWD = `
<li><a href="https://hfhsummitcounty.org/event/barberton-neighborhood-reborn-26/"><span>Barberton Neighborhood Reborn 2026</span></a>
  <div><div><h5><a>Barberton Neighborhood Reborn 2026</a></h5></div>
  <div><span>9:00 am-3:00 pm</span></div>
  <div><span> 2026.06.05-2026.06.06</span></div><img></div></li>
<li><a href="https://hfhsummitcounty.org/event/barberton-neighborhood-reborn-26/"><span>Barberton Neighborhood Reborn 2026</span></a>
  <div><span>9:00 am-3:00 pm</span></div><div><span> 2026.06.06-2026.06.06</span></div></li>
`

describe('parseCardDate', () => {
  it('parses "Weekday, Month Dth, YYYY"', () => {
    assert.equal(parseCardDate('Tuesday, March 9th, 2027'), '2027-03-09')
    assert.equal(parseCardDate('Monday, July 27th, 2026'), '2026-07-27')
    assert.equal(parseCardDate('Thursday, September 3rd, 2026'), '2026-09-03')
  })
  it('returns null for non-dates', () => assert.equal(parseCardDate('soon'), null))
})

describe('inferFundraiserTime', () => {
  it('golf → morning, luncheon → midday, else evening', () => {
    assert.equal(inferFundraiserTime('Home In One', 'a day of golf'), '9:00 AM')
    assert.equal(inferFundraiserTime('Build In Style', 'fashion + lunch'), '11:00 AM')
    assert.equal(inferFundraiserTime('Bourbon Build', 'bourbon flights and music'), '6:00 PM')
  })
})

describe('parseFundraiserCards', () => {
  const cards = parseFundraiserCards(CARDS)
  it('parses all 3 cards and ignores headings outside the section', () => {
    assert.equal(cards.length, 3)
    assert.deepEqual(cards.map((c) => c.title), ['Build In Style', 'Home In One', 'Bourbon Build'])
  })
  it('captures date, location, inferred time, and link', () => {
    const golf = cards.find((c) => c.title === 'Home In One')
    assert.equal(golf.date, '2026-07-27')
    assert.equal(golf.location, 'Gleneagles Golf Club')
    assert.equal(golf.time, '9:00 AM')
    assert.equal(golf.url, 'https://hfhsummitcounty.org/golfouting/')
    assert.match(golf.description, /day of golf/)
  })
})

describe('parseEcwdEvents', () => {
  const evs = parseEcwdEvents(ECWD)
  it('extracts the volunteer event, deduped by slug, with date + time', () => {
    assert.equal(evs.length, 1)
    assert.equal(evs[0].title, 'Barberton Neighborhood Reborn 2026')
    assert.equal(evs[0].date, '2026-06-05')
    assert.equal(evs[0].time, '9:00 AM')
    assert.equal(evs[0].kind, 'volunteer')
    assert.equal(evs[0].url, 'https://hfhsummitcounty.org/event/barberton-neighborhood-reborn-26/')
  })
})

describe('SOURCE_KEY', () => {
  it('is habitat_summit', () => assert.equal(SOURCE_KEY, 'habitat_summit'))
})
