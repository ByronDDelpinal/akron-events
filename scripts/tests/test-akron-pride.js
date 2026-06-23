/**
 * test-akron-pride.js — pure parsers for the Akron Pride Festival scraper
 * (Events Manager iCal feed). Fixtures are the real LOCATION strings from
 * akronpridefestival.org/events/ical/.
 *
 * Run:  node --test scripts/tests/test-akron-pride.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseEventsManagerLocation, includeEvent, mapTags, SOURCE_KEY } =
  await import('../scrape-akron-pride.js')

describe('parseEventsManagerLocation', () => {
  it('splits a name-with-comma + street + city/state/zip/country', () => {
    const r = parseEventsManagerLocation('Main Street, Downtown Akron, Main Street, Akron, OH, 44308, United States')
    assert.equal(r.name, 'Main Street, Downtown Akron')
    assert.deepEqual(r.details, { address: 'Main Street', city: 'Akron', state: 'OH', zip: '44308' })
  })

  it('parses a venue name + street address', () => {
    const r = parseEventsManagerLocation('Main St. and Bowery, 200 S. Main St., Akron, OH, 44308, United States')
    assert.equal(r.name, 'Main St. and Bowery')
    assert.equal(r.details.address, '200 S. Main St.')
    assert.equal(r.details.zip, '44308')
  })

  it('handles a name with no separate street', () => {
    const r = parseEventsManagerLocation('Some Venue, Akron, OH, 44308, United States')
    assert.equal(r.name, 'Some Venue')
    assert.equal(r.details.address, null)
    assert.equal(r.details.city, 'Akron')
  })

  it('returns null for empty input', () => {
    assert.equal(parseEventsManagerLocation(''), null)
    assert.equal(parseEventsManagerLocation(null), null)
  })
})

describe('includeEvent', () => {
  it('skips the 5K race (owned by runsignup + akron_promise)', () => {
    assert.equal(includeEvent({ SUMMARY: '2026 Akron Pride Festival 5K' }), false)
  })
  it('keeps the Festival & Equity March', () => {
    assert.equal(includeEvent({ SUMMARY: 'Akron Pride Festival and Equity March 2026' }), true)
  })
})

describe('mapTags + SOURCE_KEY', () => {
  it('tags pride/lgbtq', () => {
    const t = mapTags()
    assert.ok(t.includes('pride') && t.includes('lgbtq'))
  })
  it('source key', () => assert.equal(SOURCE_KEY, 'akron_pride'))
})
