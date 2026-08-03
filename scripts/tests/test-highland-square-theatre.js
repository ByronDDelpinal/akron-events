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

const {
  buildDescription,
  parseDatePart,
  resolveYear,
  getUnmappedMonthCount,
  resetUnmappedMonthCount,
} = await import('../scrape-highland-square-theatre.js')

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

describe('Highland Square month abbreviations (regression)', () => {
  it('resolveYear resolves the 3-letter abbreviation "Aug"', () => {
    assert.strictEqual(resolveYear('Aug', 1), resolveYear('August', 1))
  })

  it('resolveYear resolves the "Sept" variant', () => {
    assert.strictEqual(resolveYear('Sept', 1), resolveYear('September', 1))
  })

  it('parseDatePart resolves "Monday Aug 1" the same as the full month name', () => {
    resetUnmappedMonthCount()
    const abbrev = parseDatePart('Monday Aug 1')
    const full   = parseDatePart('Monday August 1')
    assert.deepStrictEqual(abbrev, full)
    assert.ok(abbrev.length > 0, 'abbreviated month should resolve to a date')
    assert.strictEqual(getUnmappedMonthCount(), 0)
  })

  it('parseDatePart resolves "Monday Sept 1" the same as the full month name', () => {
    resetUnmappedMonthCount()
    const abbrev = parseDatePart('Monday Sept 1')
    const full   = parseDatePart('Monday September 1')
    assert.deepStrictEqual(abbrev, full)
    assert.ok(abbrev.length > 0, 'Sept should resolve to a date')
    assert.strictEqual(getUnmappedMonthCount(), 0)
  })

  it('rejects a garbage month token and counts it as unmapped', () => {
    resetUnmappedMonthCount()
    const result = parseDatePart('Monday Foo 1')
    assert.deepStrictEqual(result, [])
    assert.strictEqual(getUnmappedMonthCount(), 1)
  })
})
