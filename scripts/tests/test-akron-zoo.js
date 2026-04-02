/**test-akron-zoo.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { FIXTURE_1, FIXTURE_2, ALL_FIXTURES } from './fixtures/zoo-events.js'

function parseDateText(raw) {
  const pat = /(\w+)\s+(\d{1,2}),\s+(\d{4})/
  const m = raw.match(pat)
  if (!m) return null
  try {
    return new Date(`${m[1]} ${m[2]}, ${m[3]}`).toISOString().split('T')[0]
  } catch {
    return null
  }
}

describe('Zoo: Date Parsing', () => {
  it('parses month day year format', () => {
    assert.equal(parseDateText(FIXTURE_1.raw), FIXTURE_1.expectedDate)
  })

  it('parses different months', () => {
    assert.equal(parseDateText(FIXTURE_2.raw), FIXTURE_2.expectedDate)
  })
})

describe('Zoo: Batch Invariants', () => {
  it('all fixtures parse successfully', () => {
    for (const fixture of ALL_FIXTURES) {
      const result = parseDateText(fixture.raw)
      assert.equal(result, fixture.expectedDate)
    }
  })
})
