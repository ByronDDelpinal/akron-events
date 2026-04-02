/**test-painting-twist.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { F1, F2, ALL } from './fixtures/painting-twist-events.js'

function parsePwtDateTime(raw) {
  const m = raw.match(/^(\d{1,2}):(\d{2})(am|pm)$/i)
  if (!m) return null
  let h = parseInt(m[1], 10)
  if (m[3].toLowerCase() === 'pm' && h !== 12) h += 12
  return `${String(h).padStart(2, '0')}:${m[2]}`
}

function parsePrice(raw) {
  const rangePat = /\$(\d+)\s*-\s*\$?(\d+)/
  const m = raw.match(rangePat)
  if (m) return { min: parseInt(m[1]), max: parseInt(m[2]) }
  const singlePat = /\$(\d+)/
  const sm = raw.match(singlePat)
  if (sm) {
    const p = parseInt(sm[1])
    return { min: p, max: p }
  }
  return null
}

describe('Painting with a Twist: DateTime Parsing', () => {
  it('parses time format', () => {
    assert.equal(parsePwtDateTime(F1.raw), F1.exp)
  })
})

describe('Painting with a Twist: Price Parsing', () => {
  it('parses price range', () => {
    const p = parsePrice(F2.price)
    assert.ok(p)
    assert.equal(p.min, F2.expMin)
    assert.equal(p.max, F2.expMax)
  })
})
