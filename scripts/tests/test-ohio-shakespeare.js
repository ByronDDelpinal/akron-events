/**test-ohio-shakespeare.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { F1, F2, ALL } from './fixtures/ohio-shakespeare-events.js'

function parseDateString(raw) {
  const rangePat = /^(\w+)\s+(\d{1,2})\s*-\s*(\w+)\s+(\d{1,2}),\s+(\d{4})$/
  const rangeMatch = raw.match(rangePat)
  if (rangeMatch) {
    const startStr = new Date(`${rangeMatch[1]} ${rangeMatch[2]}, ${rangeMatch[5]}`).toISOString().split('T')[0]
    const endStr = new Date(`${rangeMatch[3]} ${rangeMatch[4]}, ${rangeMatch[5]}`).toISOString().split('T')[0]
    return { start: startStr, end: endStr }
  }

  const singlePat = /^(\w+)\s+(\d{1,2}),\s+(\d{4})$/
  const singleMatch = raw.match(singlePat)
  if (singleMatch) {
    const dateStr = new Date(`${singleMatch[1]} ${singleMatch[2]}, ${singleMatch[3]}`).toISOString().split('T')[0]
    return { start: dateStr, end: dateStr }
  }

  return null
}

describe('Ohio Shakespeare: Date Parsing', () => {
  it('parses month range', () => {
    const p = parseDateString(F1.raw)
    assert.ok(p)
    assert.equal(p.start, F1.exp.start)
    assert.equal(p.end, F1.exp.end)
  })

  it('parses single date', () => {
    const p = parseDateString(F2.raw)
    assert.ok(p)
    assert.equal(p.start, F2.exp.start)
  })
})
