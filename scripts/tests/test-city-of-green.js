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

const { isPublicSpecialEvent, isClosureNotice } = await import('../scrape-city-of-green.js')

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
