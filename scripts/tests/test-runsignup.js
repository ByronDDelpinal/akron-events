/**
 * test-runsignup.js — shared RunSignup module (lib/runsignup.js).
 * Network calls (fetchRunSignupRaceData) are integration concerns; here we cover
 * the pure parsers.
 *
 * Run:  node --test scripts/tests/test-runsignup.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { isRunSignupUrl, extractRaceId, parseRunSignupRace, runSignupDateTimeToIso, runSignupStartIso, runSignupPriceRange } =
  await import('../lib/runsignup.js')
const { isIngestableRace, fallbackStartIso, buildTags } = await import('../scrape-runsignup.js')

// A detail-shaped race object with multiple events (distances) + tiered fees.
const DETAIL = {
  name: 'Flight of the Heron 5k, 10k, & 1mi',
  next_date: '07/18/2026',
  is_draft_race: 'F', is_private_race: 'F',
  description: '<p>A river run in Akron.</p>',
  logo_url: 'https://cdn.example.com/logo.jpg',
  url: 'https://runsignup.com/Race/OH/Akron/FlightOfTheHeron5k',
  address: { street: '57 West North Street', city: 'Akron', state: 'OH', zipcode: '44304' },
  events: [
    { name: '5k', start_time: '7/18/2026 10:00', registration_periods: [{ race_fee: '$30.00' }, { race_fee: '$35.00' }] },
    { name: '1 Mile', start_time: '7/18/2026 10:00', registration_periods: [{ race_fee: '$20.00' }, { race_fee: '$25.00' }] },
  ],
}

describe('runSignupDateTimeToIso', () => {
  it('parses M/D/YYYY H:MM (24h) to Eastern ISO', () => {
    assert.equal(runSignupDateTimeToIso('7/18/2026 10:00'), new Date('2026-07-18T14:00:00Z').toISOString()) // 10AM EDT
    assert.equal(runSignupDateTimeToIso('8/21/2026 18:30'), new Date('2026-08-21T22:30:00Z').toISOString()) // 6:30PM EDT
    assert.equal(runSignupDateTimeToIso('nope'), null)
  })
})

describe('runSignupStartIso + runSignupPriceRange', () => {
  it('takes the earliest event start time', () => {
    assert.equal(runSignupStartIso(DETAIL), new Date('2026-07-18T14:00:00Z').toISOString())
  })
  it('returns min/max fee across events + periods', () => {
    assert.deepEqual(runSignupPriceRange(DETAIL), { priceMin: 20, priceMax: 35 })
  })
  it('null/empty when no events', () => {
    assert.equal(runSignupStartIso({}), null)
    assert.deepEqual(runSignupPriceRange({}), { priceMin: null, priceMax: null })
  })
})

describe('parseRunSignupRace with events', () => {
  it('includes startIso + price + unlisted bare-address venue', () => {
    const r = parseRunSignupRace(DETAIL)
    assert.equal(r.startIso, new Date('2026-07-18T14:00:00Z').toISOString())
    assert.equal(r.priceMin, 20)
    assert.equal(r.priceMax, 35)
    assert.equal(r.bareAddress, true)            // "57 West North Street"
    assert.equal(r.venueDetails.address, '57 West North Street')
  })
})

describe('scraper: isIngestableRace', () => {
  it('accepts a dated, public, Akron race', () => {
    assert.equal(isIngestableRace(DETAIL), true)
  })
  it('rejects drafts, private, undated, test, and out-of-county races', () => {
    assert.equal(isIngestableRace({ ...DETAIL, is_draft_race: 'T' }), false)
    assert.equal(isIngestableRace({ ...DETAIL, is_private_race: 'T' }), false)
    assert.equal(isIngestableRace({ ...DETAIL, next_date: null }), false)
    assert.equal(isIngestableRace({ ...DETAIL, name: 'Cupcakes Test Race' }), false)
    assert.equal(isIngestableRace({ ...DETAIL, address: { city: 'Streetsboro' } }), false) // Portage County
  })
})

describe('scraper: fallbackStartIso + buildTags', () => {
  it('defaults an undated-time race to 8 AM ET on next_date', () => {
    assert.equal(fallbackStartIso('07/18/2026'), new Date('2026-07-18T12:00:00Z').toISOString())
    assert.equal(fallbackStartIso('bad'), null)
  })
  it('derives tags from name + description', () => {
    const t = buildTags({ name: 'Akron Half Marathon & 5K Fun Run' }, 'A charity walk for kids')
    assert.ok(t.includes('half-marathon') && t.includes('5k') && t.includes('walk') && t.includes('family') && t.includes('fundraiser'))
    assert.ok(!t.includes('marathon')) // half-marathon shouldn't also tag plain marathon
  })
})


describe('isRunSignupUrl', () => {
  it('matches runsignup.com hosts (incl. www + subdomains)', () => {
    assert.equal(isRunSignupUrl('https://runsignup.com/Race/OH/Akron/X'), true)
    assert.equal(isRunSignupUrl('https://www.runsignup.com/Race/X'), true)
    assert.equal(isRunSignupUrl('https://akronpridefestival.org/5k'), false)
    assert.equal(isRunSignupUrl(''), false)
    assert.equal(isRunSignupUrl(null), false)
  })
})

describe('extractRaceId', () => {
  it('pulls the numeric race_id from various page patterns', () => {
    assert.equal(extractRaceId('...raceId=189540&foo'), '189540')
    assert.equal(extractRaceId('{"race_id":"184621"}'), '184621')
    assert.equal(extractRaceId('href="/Race/Register/?raceId=113475"'), '113475')
    assert.equal(extractRaceId('no id here'), null)
  })
})

describe('parseRunSignupRace', () => {
  it('mints a named venue when the street field is a real place name', () => {
    const r = parseRunSignupRace({
      description: '<p>Run for a good cause.</p>',
      logo_url: 'https://cdn.example.com/logo.png',
      address: { street: 'Kohl Family YMCA', city: 'Akron', state: 'OH', zipcode: '44304' },
    })
    assert.equal(r.venueName, 'Kohl Family YMCA')
    assert.deepEqual(r.venueDetails, { city: 'Akron', state: 'OH', zip: '44304' })  // no street address
    assert.equal(r.bareAddress, false)   // named venue → listed normally
    assert.equal(r.description, 'Run for a good cause.')
    assert.equal(r.logo, 'https://cdn.example.com/logo.png')
  })

  it('flags a bare street address (caller mints it unlisted)', () => {
    const r = parseRunSignupRace({ address: { street: '1307 E. Market St.', city: 'Akron', state: 'OH', zipcode: '44305' } })
    assert.equal(r.venueName, '1307 E. Market St.')
    assert.equal(r.venueDetails.address, '1307 E. Market St.')
    assert.equal(r.venueDetails.city, 'Akron')
    assert.equal(r.bareAddress, true)
  })

  it('handles a missing address + description gracefully', () => {
    const r = parseRunSignupRace({ name: 'X' })
    assert.equal(r.venueName, null)
    assert.equal(r.description, null)
  })

  it('returns null for a non-object', () => {
    assert.equal(parseRunSignupRace(null), null)
  })
})
