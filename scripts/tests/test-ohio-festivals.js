/**
 * test-ohio-festivals.js — pure parsers for the Ohio Festivals scraper.
 * Fixtures are real lines from ohiofestivals.net/ohio-festivals/ (en-dash
 * separated: "M/D[-M/D][*] – Name – City [– My Review]").
 *
 * Run:  node --test scripts/tests/test-ohio-festivals.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseFestivalLine, parseFestivals, buildYmd, SOURCE_KEY } =
  await import('../scrape-ohio-festivals.js')
const { isSummitCountyLocation } = await import('../lib/summit-county.js')

const NOW = new Date('2026-06-19T12:00:00Z')  // month = June (6)

describe('buildYmd', () => {
  it('keeps this year for current/future months, rolls earlier months to next year', () => {
    assert.equal(buildYmd(7, 10, NOW), '2026-07-10')   // July ≥ June
    assert.equal(buildYmd(6, 25, NOW), '2026-06-25')   // June = June
    assert.equal(buildYmd(1, 15, NOW), '2027-01-15')   // January < June → next year
  })
})

describe('parseFestivalLine', () => {
  it('parses a date range + name + city + "My Review"', () => {
    const f = parseFestivalLine('7/10-7/11 – Summit County Italian American Festival – Akron – My Review', NOW)
    assert.equal(f.name, 'Summit County Italian American Festival')
    assert.equal(f.city, 'Akron')
    assert.equal(f.startYmd, '2026-07-10')
    assert.equal(f.endYmd, '2026-07-11')
    assert.equal(f.unconfirmed, false)
  })
  it('parses a single date and flags an unconfirmed (*) date', () => {
    const f = parseFestivalLine('7/18* – Halfway to Christmas – Akron', NOW)
    assert.equal(f.name, 'Halfway to Christmas')
    assert.equal(f.startYmd, '2026-07-18')
    assert.equal(f.endYmd, null)
    assert.equal(f.unconfirmed, true)
  })
  it('returns null for non-festival lines', () => {
    assert.equal(parseFestivalLine('2026 Ohio Festival Guide'), null)
    assert.equal(parseFestivalLine(''), null)
  })
})

describe('parseFestivals + Summit County gate', () => {
  const text = [
    '6/30-7/4 – Ashville 4th of July Celebration – Ashville',           // not Summit
    '7/10-7/11 – Summit County Italian American Festival – Akron',      // Summit
    '7/11 – The Fairlawn Fest – Fairlawn',                              // Summit
    '7/5 – Peninsula Flea at Heritage Farms III – Peninsula',           // Summit
    '7/11-7/12 – Barnstorming Carnival – Springfield',                  // Clark County — excluded
  ].join('\n')

  const all = parseFestivals(text, NOW)
  const summit = all.filter((f) => isSummitCountyLocation({ city: f.city }))

  it('parses every line, then the gate keeps only Summit County cities', () => {
    assert.equal(all.length, 5)
    assert.deepEqual(summit.map((f) => f.city).sort(), ['Akron', 'Fairlawn', 'Peninsula'])
    assert.ok(!summit.some((f) => f.city === 'Springfield'))   // Clark County dropped
    assert.ok(!summit.some((f) => f.city === 'Ashville'))
  })
})

describe('SOURCE_KEY', () => {
  it('is ohio_festivals', () => assert.equal(SOURCE_KEY, 'ohio_festivals'))
})

describe('year tracking from month section headers (2026-07 fix)', () => {
  // The guide is a rolling ~14-month doc: JULY…DECEMBER (current year), then
  // "JANUARY (2027)"…AUGUST. The old month-vs-now inference mapped the second
  // JUL-DEC into the CURRENT year — phantom tentative dupes at wrong dates.
  const GUIDE = [
    'JULY',
    '7/11 – The Fairlawn Fest – Fairlawn',
    'AUGUST',
    '8/22 – Akron Pride Festival – Akron',
    'DECEMBER',
    '12/28-1/2 – New Year Fest – Akron',
    'JANUARY (2027)',
    '1/15* – Winter Blast – Akron',
    'JUNE',
    '6/26* – Peninsula Flea at Heritage Farms II – Peninsula',
    'JULY',
    '7/10* – The Fairlawn Fest – Fairlawn',
  ].join('\n')

  it('assigns the current year to the first sections and the marked year after "(YYYY)"', () => {
    const fests = parseFestivals(GUIDE, NOW)
    const byId = Object.fromEntries(fests.map(f => [`${f.name}|${f.startYmd}`, f]))
    assert.ok(byId['The Fairlawn Fest|2026-07-11'], '2026 section entry keeps 2026')
    assert.ok(byId['Akron Pride Festival|2026-08-22'])
    assert.ok(byId['Winter Blast|2027-01-15'], 'explicit (2027) marker sets the year')
    assert.ok(byId['Peninsula Flea at Heritage Farms II|2027-06-26'])
    assert.ok(byId['The Fairlawn Fest|2027-07-10'], 'second JULY section is 2027, NOT current year')
    assert.equal(fests.filter(f => f.name === 'The Fairlawn Fest' && f.startYmd.startsWith('2026-07-10')).length, 0,
      'the old wrong-year phantom must not exist')
  })

  it('rolls a range across the year boundary inside a DECEMBER section', () => {
    const fests = parseFestivals(GUIDE, NOW)
    const nyf = fests.find(f => f.name === 'New Year Fest')
    assert.equal(nyf.startYmd, '2026-12-28')
    assert.equal(nyf.endYmd, '2027-01-02')
  })

  it('increments the year on month rollover even without an explicit marker', () => {
    const fests = parseFestivals(['DECEMBER', '12/5 – Winterfest – Akron', 'JANUARY', '1/9 – Ice Fest – Akron'].join('\n'), NOW)
    assert.equal(fests.find(f => f.name === 'Winterfest').startYmd, '2026-12-05')
    assert.equal(fests.find(f => f.name === 'Ice Fest').startYmd, '2027-01-09')
  })

  it('falls back to month-vs-now inference when no headers exist', () => {
    const fests = parseFestivals('7/11 – The Fairlawn Fest – Fairlawn\n1/15 – Winter Blast – Akron', NOW)
    assert.equal(fests.find(f => f.name === 'The Fairlawn Fest').startYmd, '2026-07-11')
    assert.equal(fests.find(f => f.name === 'Winter Blast').startYmd, '2027-01-15')
  })

  it('parseFestivalLine honors an explicit sectionYear', () => {
    const f = parseFestivalLine('7/10* – The Fairlawn Fest – Fairlawn', NOW, 2027)
    assert.equal(f.startYmd, '2027-07-10')
    assert.equal(f.unconfirmed, true)
  })
})

describe('range preservation through normalization (2026-07 fix)', () => {
  it('does not split a multi-day range into a phantom single-day event', () => {
    const fests = parseFestivals('JULY\n7/25-7/26 – Akron Arts Expo – Akron\n7/23 – Taste of Akron – Akron', NOW)
    const expo = fests.find(f => f.name === 'Akron Arts Expo')
    assert.ok(expo, 'range entry must parse')
    assert.equal(expo.startYmd, '2026-07-25')
    assert.equal(expo.endYmd, '2026-07-26')
    assert.equal(fests.length, 2, 'no fragment rows')
  })
  it('still splits run-together single-day entries', () => {
    const fests = parseFestivals('7/23 – Taste of Akron – Akron 8/1 – Nepali Fest – Cuyahoga Falls', NOW)
    assert.equal(fests.length, 2)
    assert.equal(fests[1].startYmd, '2026-08-01')
  })
})

describe('direct-source suppression (2026-07 fix)', async () => {
  const { directSourceFor, SUPPRESSED_DIRECT } = await import('../scrape-ohio-festivals.js')

  it('suppresses guide copies of directly-scraped festivals', () => {
    assert.equal(directSourceFor({ name: 'Highland Square PorchRokr Festival', city: 'Akron' }), 'highland_square')
    assert.equal(directSourceFor({ name: 'Akron Pride Festival', city: 'Akron' }), 'akron_pride')
    assert.equal(directSourceFor({ name: 'Hale Farm Civil War Reenactment', city: 'Bath' }), 'hale_farm')
    assert.equal(directSourceFor({ name: 'Hale Harvest Festival I', city: 'Bath' }), 'hale_farm')
    assert.equal(directSourceFor({ name: 'The Made in Ohio Arts and Crafts Festival', city: 'Bath' }), 'hale_farm')
    assert.equal(directSourceFor({ name: 'Summer Sunset Blast', city: 'Stow' }), 'city_of_stow')
    assert.equal(directSourceFor({ name: 'Akron Zoo Wild Lights II', city: 'Akron' }), 'akron_zoo')
  })

  it('city gate keeps generic titles from over-matching', () => {
    // A different town's Harvest Festival is NOT Hale Farm's
    assert.equal(directSourceFor({ name: 'Harvest Festival', city: 'Green' }), null)
    assert.equal(directSourceFor({ name: 'Harvest Festival', city: 'Bath' }), 'hale_farm')
  })

  it('leaves festivals with no direct coverage alone', () => {
    // DB-verified 2026-07-08: no direct source carries these yet
    assert.equal(directSourceFor({ name: 'Circle Festival and Light Parade', city: 'Tallmadge' }), null)
    assert.equal(directSourceFor({ name: 'Akron CityFest', city: 'Akron' }), null)
    assert.equal(directSourceFor({ name: 'Twins Days Festival', city: 'Twinsburg' }), null)
    assert.equal(directSourceFor({ name: 'Peninsula Flea at Heritage Farms IV', city: 'Peninsula' }), null)
  })

  it('every rule names a real manifest source', async () => {
    const { SCRAPER_BY_KEY } = await import('../manifest.js')
    for (const rule of SUPPRESSED_DIRECT) {
      assert.ok(SCRAPER_BY_KEY[rule.source], `unknown source key: ${rule.source}`)
    }
  })
})
