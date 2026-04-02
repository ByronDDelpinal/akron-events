/**test-ticketmaster.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { F1, F2, F3, F4, ALL } from './fixtures/ticketmaster-events.js'

function parsePrice(priceRanges = []) {
  if (!priceRanges.length) return { min: 0, max: null }
  const prices = priceRanges.map(p => p.min).filter(p => p != null)
  const min = prices.length ? Math.min(...prices) : 0
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
