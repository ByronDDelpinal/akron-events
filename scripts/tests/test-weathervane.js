/**test-weathervane.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { F1, F2, ALL } from './fixtures/weathervane-events.js'

function parseDateString(raw) {
  const rangePat = /^(\w+)\s+(\d{1,2})\s*-\s*(?:(\w+)\s+)?(\d{1,2}),\s+(\d{4})$/
  const m = raw.match(rangePat)
  if (!m) return null
  const startStr = new Date(`${m[1]} ${m[2]}, ${m[5]}`).toISOString().split('T')[0]
  const endMonth = m[3] || m[1]
  const endStr = new Date(`${endMonth} ${m[4]}, ${m[5]}`).toISOString().split('T')[0]
  return { start: startStr, end: endStr }
}

describe('Weathervane: Date Range Parsing', () => {
  it('parses month-to-month range', () => {
    const p = parseDateString(F1.raw)
    assert.ok(p)
    assert.equal(p.start, F1.expStart)
    assert.equal(p.end, F1.expEnd)
  })

  it('parses day range in same month', () => {
    const p = parseDateString(F2.raw)
    assert.ok(p)
    assert.equal(p.start, F2.expStart)
    assert.equal(p.end, F2.expEnd)
  })
})
