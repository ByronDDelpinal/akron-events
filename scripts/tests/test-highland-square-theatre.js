/**
 * test-highland-square-theatre.js — the templated screening description.
 * The homepage carries no per-film synopsis, so we compose an honest
 * description of the screening (venue/format/runtime/rating) instead of null.
 *
 * Run:  node --test scripts/tests/test-highland-square-theatre.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { buildDescription } = await import('../scrape-highland-square-theatre.js')

describe('Highland Square buildDescription', () => {
  it('includes runtime and rating when present', () => {
    const d = buildDescription({ rating: 'PG13', runtimeMin: 132 })
    assert.ok(d.includes('132 min'))
    assert.ok(d.includes('rated PG13'))
    assert.ok(d.includes('Highland Square Theatre'))
    assert.ok(d.includes('$5'))
  })

  it('omits the meta parenthetical when rating/runtime are missing', () => {
    const d = buildDescription({})
    assert.ok(!d.includes('('), 'no empty parenthetical')
    assert.ok(d.includes('Highland Square Theatre'))
  })

  it('never returns empty', () => {
    assert.ok(buildDescription(undefined).length > 20)
  })
})
