/**
 * test-cvfm.js — pure parsers for the Cuyahoga Valley Farmers Market scraper.
 *
 * The FIXTURE mirrors what htmlToText() produces from the cvfm.org homepage
 * footer (season blocks stated as prose), so the season/venue/closure parsing
 * is exercised against the real content shape.
 *
 * Run:  node --test scripts/tests/test-cvfm.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  parseMonthDay, parseVenueLine, resolveSeasonYears, parseSeasons, seasonForDate,
} = await import('../scrape-cvfm.js')
const { htmlToText } = await import('../lib/normalize.js')

// Footer text as htmlToText would render it (block elements → newlines).
const FIXTURE = `About the market
Located in the heart of the Cuyahoga Valley National Park. Registered as a 501C3 in 2022 to carry on the tradition of Countryside Market.
SUMMER MARKET
May 2 - October 31, 2026
Howe Meadow 4040 Riverview Rd. Peninsula, OH 44264
info@cvfm.org
WINTER MARKET
November 7 - April 24, 2027
CLOSED: Nov 28, Dec 26, Jan 2
Old Trail School 2315 Ira Rd. Akron, OH 44333
info@cvfm.org
HOURS
Open Rain or Shine
Every Saturday
9am - 12pm`

describe('cvfm: parseMonthDay', () => {
  it('parses full and abbreviated months', () => {
    assert.deepEqual(parseMonthDay('May 2'), { month: 4, day: 2 })
    assert.deepEqual(parseMonthDay('October 31'), { month: 9, day: 31 })
    assert.deepEqual(parseMonthDay('Nov 28'), { month: 10, day: 28 })
    assert.deepEqual(parseMonthDay('Jan 2'), { month: 0, day: 2 })
  })
  it('rejects junk', () => {
    assert.equal(parseMonthDay('Someday'), null)
    assert.equal(parseMonthDay(''), null)
    assert.equal(parseMonthDay('May 40'), null)
  })
})

describe('cvfm: parseVenueLine', () => {
  it('splits the summer venue', () => {
    assert.deepEqual(parseVenueLine('Howe Meadow 4040 Riverview Rd. Peninsula, OH 44264'), {
      name: 'Howe Meadow', address: '4040 Riverview Rd', city: 'Peninsula', state: 'OH', zip: '44264',
    })
  })
  it('splits the winter venue', () => {
    assert.deepEqual(parseVenueLine('Old Trail School 2315 Ira Rd. Akron, OH 44333'), {
      name: 'Old Trail School', address: '2315 Ira Rd', city: 'Akron', state: 'OH', zip: '44333',
    })
  })
  it('returns null when there is no OH zip tail', () => {
    assert.equal(parseVenueLine('Just a name with no address'), null)
  })
})

describe('cvfm: resolveSeasonYears', () => {
  it('keeps one year for a same-year season', () => {
    assert.deepEqual(
      resolveSeasonYears({ month: 4, day: 2 }, { month: 9, day: 31 }, 2026),
      { startYear: 2026, endYear: 2026 })
  })
  it('rolls the start back a year when the season spans the New Year', () => {
    assert.deepEqual(
      resolveSeasonYears({ month: 10, day: 7 }, { month: 3, day: 24 }, 2027),
      { startYear: 2026, endYear: 2027 })
  })
})

describe('cvfm: parseSeasons', () => {
  const seasons = parseSeasons(FIXTURE)

  it('finds both seasons', () => {
    assert.equal(seasons.length, 2)
    assert.deepEqual(seasons.map((s) => s.label), ['Summer', 'Winter'])
  })
  it('summer: dates + venue', () => {
    const s = seasons[0]
    assert.equal(s.startYmd, '2026-05-02')
    assert.equal(s.endYmd, '2026-10-31')
    assert.equal(s.venue.name, 'Howe Meadow')
    assert.equal(s.venue.city, 'Peninsula')
    assert.equal(s.closedYmds.size, 0)
  })
  it('winter: spans the New Year + closures get correct years', () => {
    const s = seasons[1]
    assert.equal(s.startYmd, '2026-11-07')
    assert.equal(s.endYmd, '2027-04-24')
    assert.equal(s.venue.name, 'Old Trail School')
    assert.equal(s.venue.city, 'Akron')
    // Nov 28 2026, Dec 26 2026, Jan 2 2027
    assert.ok(s.closedYmds.has('2026-11-28'))
    assert.ok(s.closedYmds.has('2026-12-26'))
    assert.ok(s.closedYmds.has('2027-01-02'))
    assert.equal(s.closedYmds.size, 3)
  })
})

// The scraper runs parseSeasons on htmlToText(rawHtml) at runtime, so validate
// that whole path through the REAL htmlToText — for both a line-broken footer
// (WordPress <p>/<br>) and a worst-case single-line collapse. The single-line
// case is what caught the two-comma venue-regex bug.
describe('cvfm: parseSeasons over real htmlToText', () => {
  const RAW_MULTILINE = `
    <h5>SUMMER MARKET</h5>
    <p>May 2 - October 31, 2026<br>
    <a href="https://maps.app.goo.gl/x">Howe Meadow 4040 Riverview Rd. Peninsula, OH 44264</a><br>
    <a href="mailto:info@cvfm.org">info@cvfm.org</a></p>
    <h5>WINTER MARKET</h5>
    <p>November 7 - April 24, 2027<br>
    <em>CLOSED: Nov 28, Dec 26, Jan 2</em><br>
    <a href="https://maps.app.goo.gl/y">Old Trail School 2315 Ira Rd. Akron, OH 44333</a></p>
    <h5>HOURS</h5><p>Open Rain or Shine Every Saturday 9am - 12pm</p>`
  const RAW_SINGLELINE = `
    <div>SUMMER MARKET May 2 - October 31, 2026 <a href="#">Howe Meadow 4040 Riverview Rd. Peninsula, OH 44264</a> info@cvfm.org</div>
    <div>WINTER MARKET November 7 - April 24, 2027 CLOSED: Nov 28, Dec 26, Jan 2 <a href="#">Old Trail School 2315 Ira Rd. Akron, OH 44333</a> info@cvfm.org</div>
    <div>HOURS Open Rain or Shine Every Saturday 9am - 12pm</div>`

  for (const [name, raw] of [['line-broken footer', RAW_MULTILINE], ['single-line collapse', RAW_SINGLELINE]]) {
    it(`extracts both seasons from a ${name}`, () => {
      const s = parseSeasons(htmlToText(raw))
      assert.equal(s.length, 2, 'both seasons found')
      assert.deepEqual(s[0].venue, { name: 'Howe Meadow', address: '4040 Riverview Rd', city: 'Peninsula', state: 'OH', zip: '44264' })
      assert.equal(s[0].startYmd, '2026-05-02'); assert.equal(s[0].endYmd, '2026-10-31')
      assert.deepEqual(s[1].venue, { name: 'Old Trail School', address: '2315 Ira Rd', city: 'Akron', state: 'OH', zip: '44333' })
      assert.equal(s[1].startYmd, '2026-11-07'); assert.equal(s[1].endYmd, '2027-04-24')
      assert.deepEqual([...s[1].closedYmds].sort(), ['2026-11-28', '2026-12-26', '2027-01-02'])
    })
  }
})

describe('cvfm: seasonForDate', () => {
  const seasons = parseSeasons(FIXTURE)
  it('routes a summer Saturday to Howe Meadow', () => {
    assert.equal(seasonForDate(seasons, '2026-07-18')?.venue.name, 'Howe Meadow')
  })
  it('routes a winter Saturday to Old Trail School', () => {
    assert.equal(seasonForDate(seasons, '2026-12-06')?.venue.name, 'Old Trail School')
  })
  it('skips a winter closure date', () => {
    assert.equal(seasonForDate(seasons, '2026-12-26'), null)
  })
  it('skips the between-seasons gap (Nov 1)', () => {
    assert.equal(seasonForDate(seasons, '2026-11-01'), null)
  })
  it('skips an off-season summer date', () => {
    assert.equal(seasonForDate(seasons, '2026-03-14'), null)
  })
})
