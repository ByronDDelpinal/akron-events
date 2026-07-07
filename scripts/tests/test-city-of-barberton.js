/**test-city-of-barberton.js — pure parsers for the Barberton (Tribe iCal) scraper*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseBarbertonLocation, includeEvent, mapCategory } =
  await import('../scrape-city-of-barberton.js')

describe('barberton: parseBarbertonLocation', () => {
  it('splits "Name, Street, City, ST, Zip, Country"', () => {
    assert.deepEqual(
      parseBarbertonLocation('Lake Anna Gazebo, 615 W. Park Ave, Barberton, OH, 44203, United States'),
      { name: 'Lake Anna Gazebo', details: { address: '615 W. Park Ave', city: 'Barberton', state: 'OH', zip: '44203' } })
  })
  it('handles a LOCATION with the state omitted', () => {
    assert.deepEqual(
      parseBarbertonLocation('Decker Park, 631 Brady Ave., Barberton, 44203, United States'),
      { name: 'Decker Park', details: { address: '631 Brady Ave.', city: 'Barberton', state: 'OH', zip: '44203' } })
  })
  it('returns null for empty', () => {
    assert.equal(parseBarbertonLocation(''), null)
  })
})

describe('barberton: includeEvent drops governance rows', () => {
  const keep = t => includeEvent({ SUMMARY: t })
  it('drops meetings', () => {
    assert.equal(keep('City Council Meeting'), false)
    assert.equal(keep('Committee of the Whole Meeting'), false)
  })
  it('keeps community events', () => {
    assert.equal(keep('Friday Summer Concert Series- Akron Symphonic Winds'), true)
    assert.equal(keep('5th Annual Purple Paw Party- Pet Safety Event'), true)
    assert.equal(keep('2026 Labor Day Fireworks'), true)
  })
})

describe('barberton: mapCategory', () => {
  it('concerts → music, fireworks/party → festival, else null', () => {
    assert.equal(mapCategory({ SUMMARY: 'Friday Summer Concert Series- LedSmith' }), 'music')
    assert.equal(mapCategory({ SUMMARY: '2026 Labor Day Fireworks' }), 'festival')
    assert.equal(mapCategory({ SUMMARY: 'Purple Paw Party' }), 'festival')
    assert.equal(mapCategory({ SUMMARY: 'Something Else' }), null)
  })
})
