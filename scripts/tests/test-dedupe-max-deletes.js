/**
 * test-dedupe-max-deletes.js — exercises the REAL dedupe-cross-source.js
 * module (not an inlined copy), focused on `resolveMaxDeletesCap`: the
 * safety cap that stops an unattended `--apply` run (run-all.js, the
 * nightly Actions workflow) from deleting an unexpectedly large number of
 * rows if a matching bug ever over-groups events. An explicit
 * `--max-deletes=<n>` flag wins over the `DEDUPE_MAX_DELETES` env var,
 * which wins over the default of max(50, 2% of the events loaded that run).
 *
 * Run:  node --test scripts/tests/test-dedupe-max-deletes.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// The module constructs a Supabase client at import time — give it dummy creds.
process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { resolveMaxDeletesCap } = await import('../dedupe-cross-source.js')

describe('resolveMaxDeletesCap — default (no explicit override)', () => {
  it('is max(50, 2% of unique events) for a large event set', () => {
    // 2% of 10,000 = 200, which beats the 50 floor.
    assert.equal(
      resolveMaxDeletesCap({ argValue: undefined, envValue: undefined, uniqueLength: 10000 }),
      200,
    )
  })
  it('floors at 50 for a small event set', () => {
    // 2% of 500 = 10, below the 50 floor.
    assert.equal(
      resolveMaxDeletesCap({ argValue: undefined, envValue: undefined, uniqueLength: 500 }),
      50,
    )
  })
  it('rounds up (ceil) so a fractional 2% never under-caps', () => {
    // 2% of 501 = 10.02 -> ceil 11, still below the 50 floor.
    assert.equal(
      resolveMaxDeletesCap({ argValue: undefined, envValue: undefined, uniqueLength: 501 }),
      50,
    )
    // 2% of 5001 = 100.02 -> ceil 101
    assert.equal(
      resolveMaxDeletesCap({ argValue: undefined, envValue: undefined, uniqueLength: 5001 }),
      101,
    )
  })
})

describe('resolveMaxDeletesCap — explicit overrides', () => {
  it('--max-deletes=<n> (argValue) wins over the default', () => {
    assert.equal(
      resolveMaxDeletesCap({ argValue: '5', envValue: undefined, uniqueLength: 10000 }),
      5,
    )
  })
  it('DEDUPE_MAX_DELETES (envValue) wins over the default when no arg is given', () => {
    assert.equal(
      resolveMaxDeletesCap({ argValue: undefined, envValue: '25', uniqueLength: 10000 }),
      25,
    )
  })
  it('argValue wins over envValue when both are present', () => {
    assert.equal(
      resolveMaxDeletesCap({ argValue: '5', envValue: '25', uniqueLength: 10000 }),
      5,
    )
  })
  it('a cap of 0 is honored (not treated as falsy/absent)', () => {
    assert.equal(
      resolveMaxDeletesCap({ argValue: '0', envValue: undefined, uniqueLength: 10000 }),
      0,
    )
  })
  it('falls back to the default on a non-numeric or negative override', () => {
    assert.equal(
      resolveMaxDeletesCap({ argValue: 'not-a-number', envValue: undefined, uniqueLength: 10000 }),
      200,
    )
    assert.equal(
      resolveMaxDeletesCap({ argValue: '-5', envValue: undefined, uniqueLength: 10000 }),
      200,
    )
  })
})
