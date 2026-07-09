/**test-ticketmaster.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { F1, F2, F3, F4 } from './fixtures/ticketmaster-events.js'

function parsePrice(priceRanges = []) {
  if (!priceRanges.length) return { min: null, max: null }
  const prices = priceRanges.map(p => p.min).filter(p => p != null)
  const min = prices.length ? Math.min(...prices) : null
  const maxes = priceRanges.map(p => p.max).filter(p => p != null)
  const max = maxes.length ? Math.max(...maxes) : null
  return { min, max }
}

function parseCategory(classifications = []) {
  const segments = classifications.map(c => (c.segment?.name ?? '').toLowerCase())
  if (segments.some(s => s.includes('music'))) return 'music'
  if (segments.some(s => s.includes('sport'))) return 'sports'
  if (segments.some(s => s.includes('art'))) return 'art'
  return 'other'
}

describe('Ticketmaster: Price Parsing', () => {
  it('extracts price range', () => {
    const p = parsePrice(F1.prices)
    assert.equal(p.min, F1.expMin)
    assert.equal(p.max, F1.expMax)
  })

  it('handles empty prices', () => {
    const p = parsePrice(F2.prices)
    assert.equal(p.min, F2.expMin)
    assert.equal(p.max, F2.expMax)
  })
})

describe('Ticketmaster: Category Parsing', () => {
  it('maps music classifications', () => {
    assert.equal(parseCategory(F3.classifications), F3.expCat)
  })

  it('maps sports classifications', () => {
    assert.equal(parseCategory(F4.classifications), F4.expCat)
  })
})

// ── Summit County locality gate (The Isaacs fix 2026-07-08) ────────────────
// The 25-mile radius search reaches Hartville (Stark), Canton (Stark), and
// Rootstown (Portage); 28 of 140 upcoming rows were out-of-county. These
// tests import the REAL module (env dummied) and use REAL venue coords from
// the audit.

describe('isSummitVenue locality gate', async () => {
  process.env.TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY || 'dummy-key'
  const { isSummitVenue } = await import('../fetch-ticketmaster.js')
  const { preloadSummitCountyBoundary } = await import('../lib/summit-county.js')
  await preloadSummitCountyBoundary()

  it('rejects Hartville Kitchen (Stark County) despite being inside the radius', () => {
    assert.equal(isSummitVenue({ city: { name: 'Hartville' }, location: { latitude: '40.972228', longitude: '-81.360164' } }), false)
  })
  it('accepts Akron Civic Theatre coords', () => {
    assert.equal(isSummitVenue({ city: { name: 'Akron' }, location: { latitude: '41.0805', longitude: '-81.5214' } }), true)
  })
  it('coordinates beat the city label (coords win even when city text is odd)', () => {
    // MGM Northfield Park sits in Summit even if TM labels the city oddly
    assert.equal(isSummitVenue({ city: { name: 'Northfield' }, location: { latitude: '41.3084', longitude: '-81.5266' } }), true)
  })
  it('coord-less venues fall back to the city allowlist', () => {
    assert.equal(isSummitVenue({ city: { name: 'Canton' } }), false)
    assert.equal(isSummitVenue({ city: { name: 'Cuyahoga Falls' } }), true)
  })
  it('defaults in only when neither coords nor city exist', () => {
    assert.equal(isSummitVenue({}), true)
  })
})
