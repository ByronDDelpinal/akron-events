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

const { isRunSignupUrl, extractRaceId, parseRunSignupRace } = await import('../lib/runsignup.js')

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
