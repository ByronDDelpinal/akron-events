/**test-downtown-akron.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { F1, F2, ALL } from './fixtures/downtown-akron-events.js'

function parseTime(raw) {
  const m = raw.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (!m) return null
  let h = parseInt(m[1], 10)
  const meridiem = m[3].toUpperCase()
  if (meridiem === 'PM' && h !== 12) h += 12
  if (meridiem === 'AM' && h === 12) h = 0
  return `${String(h).padStart(2, '0')}:${m[2]}`
}

describe('Downtown Akron: Time Parsing', () => {
  it('converts 24-hour from AM/PM', () => {
    assert.equal(parseTime(F1.time), F1.exp)
    assert.equal(parseTime(F2.time), F2.exp)
  })
})
