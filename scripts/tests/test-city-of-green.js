/**
 * test-city-of-green.js
 *
 * Unit tests for the City of Green scraper's public-event filter. The
 * master CivicPlus calendar (catID=14) interleaves attendable events with
 * administrative meetings and all-day "City offices will be closed"
 * holiday markers; isPublicSpecialEvent / isClosureNotice are what keep
 * the latter out of the calendar.
 *
 * Run:
 *   node --test scripts/tests/test-city-of-green.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Import-safe module (guarded main + lazy supabase client), but set dummy
// env vars defensively so importing never trips an env check.
process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { isPublicSpecialEvent, isClosureNotice, parseGreenLocation } = await import('../scrape-city-of-green.js')

describe('parseGreenLocation: splits the LOCATION field into name + address', () => {
  it('strips stray HTML tags from the name', () => {
    const r = parseGreenLocation('<p>Green Recycling Center</p> - 5383 Massillon Rd  Green OH 44720')
    assert.equal(r.name, 'Green Recycling Center')
    assert.deepEqual(r.details, { address: '5383 Massillon Rd', city: 'Green', state: 'OH', zip: '44720' })
  })

  it('parses a plain "Name - Street  City State Zip" value', () => {
    const r = parseGreenLocation('Boettler Park - 5300 Massillon Road  Green OH 44720')
    assert.equal(r.name, 'Boettler Park')
    assert.deepEqual(r.details, { address: '5300 Massillon Road', city: 'Green', state: 'OH', zip: '44720' })
  })

  it('handles a multi-word city', () => {
    const r = parseGreenLocation('Foo Hall - 12 Main St  North Canton OH 44720')
    assert.equal(r.name, 'Foo Hall')
    assert.equal(r.details.city, 'North Canton')
    assert.equal(r.details.address, '12 Main St')
  })

  it('returns a bare name (no address) when there is no " - " separator', () => {
    const r = parseGreenLocation('Boettler Park')
    assert.equal(r.name, 'Boettler Park')
    assert.deepEqual(r.details, { address: null, city: 'Green', state: 'OH', zip: null })
  })

  it('returns null for empty/blank input', () => {
    assert.equal(parseGreenLocation(''), null)
    assert.equal(parseGreenLocation(null), null)
  })

  it('never leaves HTML in the parsed name', () => {
    const r = parseGreenLocation('<strong>Veterans Memorial Park</strong> - 1900 Steese Road  Green OH 44685')
    assert.equal(r.name, 'Veterans Memorial Park')
    assert.ok(!/[<>]/.test(r.name))
    assert.equal(r.details.zip, '44685')
  })
})

describe('isClosureNotice: detects office-closure descriptions', () => {
  it('flags the exact "City offices will be closed" Juneteenth row', () => {
    assert.equal(isClosureNotice({ DESCRIPTION: 'City offices will be closed. https://www.cityofgreen.org/calendar.aspx?EID=3159' }), true)
  })

  it('flags shorthand closure phrasings', () => {
    assert.equal(isClosureNotice({ DESCRIPTION: 'City offices closed' }), true)
    assert.equal(isClosureNotice({ DESCRIPTION: 'The office will be closed for the holiday.' }), true)
  })

  it('does not flag normal event descriptions', () => {
    assert.equal(isClosureNotice({ DESCRIPTION: 'Live music on the lawn at Boettler Park. Bring a chair!' }), false)
    assert.equal(isClosureNotice({ DESCRIPTION: '' }), false)
    assert.equal(isClosureNotice({}), false)
  })
})

describe('isPublicSpecialEvent: keeps real events, drops noise', () => {
  it('drops the Juneteenth office-closure marker (summary AND description gated)', () => {
    assert.equal(isPublicSpecialEvent({ SUMMARY: 'Juneteenth', DESCRIPTION: 'City offices will be closed.' }), false)
  })

  it('drops a closure even if a future holiday summary is not in the exact list', () => {
    assert.equal(isPublicSpecialEvent({ SUMMARY: 'Indigenous Peoples Day', DESCRIPTION: 'City offices will be closed.' }), false)
  })

  it('drops exact-match holiday summaries and admin meetings', () => {
    assert.equal(isPublicSpecialEvent({ SUMMARY: 'Veterans Day', DESCRIPTION: '' }), false)
    assert.equal(isPublicSpecialEvent({ SUMMARY: 'City Council Meeting', DESCRIPTION: '' }), false)
    assert.equal(isPublicSpecialEvent({ SUMMARY: 'Memorial Day', DESCRIPTION: '' }), false)
  })

  it('keeps the public ceremony that mirrors a holiday name', () => {
    assert.equal(isPublicSpecialEvent({ SUMMARY: 'Veterans Day Ceremony', DESCRIPTION: 'Join us at Central Park.' }), true)
  })

  it('keeps genuine special events', () => {
    assert.equal(isPublicSpecialEvent({ SUMMARY: 'Summer Concert Series: The Shootouts', DESCRIPTION: 'Free concert at Boettler Park.' }), true)
    assert.equal(isPublicSpecialEvent({ SUMMARY: 'FreedomFest', DESCRIPTION: 'Fireworks, food trucks, and live music.' }), true)
  })

  it('keeps a hypothetical real Juneteenth celebration (not a bare closure)', () => {
    assert.equal(isPublicSpecialEvent({ SUMMARY: 'Juneteenth Celebration', DESCRIPTION: 'Live entertainment and vendors at Central Park.' }), true)
  })

  it('drops canceled markers and empty summaries', () => {
    assert.equal(isPublicSpecialEvent({ SUMMARY: 'Summer Concert — Canceled for Rain', DESCRIPTION: '' }), false)
    assert.equal(isPublicSpecialEvent({ SUMMARY: '', DESCRIPTION: 'whatever' }), false)
  })
})
