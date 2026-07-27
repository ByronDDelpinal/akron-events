/**
 * test-run-all.js — exercises the REAL scripts/run-all.js module (not an
 * inlined copy), focused on the pure functions behind the nightly failure
 * threshold: `run-all.js` used to exit 1 if ANY of ~137 third-party scrapers
 * failed, which would turn the nightly Actions job red essentially every
 * night. `computeMaxFailures` / `shouldExitFailure` implement the policy
 * that a run is only unhealthy when failures exceed a threshold (default
 * 15% of the plan, or an explicit --max-failures override) OR when
 * dedupe-cross-source itself failed (always red, regardless of the cap).
 *
 * run-all.js guards its own execution behind an entry-point check (mirrors
 * dedupe-cross-source.js's `main()` pattern), so importing it here is safe —
 * it never runs a real scraper or calls process.exit.
 *
 * Run:  node --test scripts/tests/test-run-all.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const { computeMaxFailures, shouldExitFailure, parseEqualsFlag } =
  await import('../run-all.js')

describe('parseEqualsFlag', () => {
  it('extracts the value after --flag=', () => {
    assert.equal(parseEqualsFlag(['--max-failures=10'], '--max-failures'), '10')
  })
  it('returns undefined when the flag is absent', () => {
    assert.equal(parseEqualsFlag(['--dry-run'], '--max-failures'), undefined)
  })
  it('does not match a differently-named flag', () => {
    assert.equal(parseEqualsFlag(['--max-deletes=5'], '--max-failures'), undefined)
  })
})

describe('computeMaxFailures', () => {
  it('defaults to floor(15% of the plan) with no override', () => {
    assert.equal(computeMaxFailures(137, undefined), Math.floor(137 * 0.15)) // 20
    assert.equal(computeMaxFailures(10, undefined), 1)
    assert.equal(computeMaxFailures(0, undefined), 0)
  })
  it('an explicit --max-failures value overrides the percentage default', () => {
    assert.equal(computeMaxFailures(137, '5'), 5)
    assert.equal(computeMaxFailures(137, '0'), 0)
  })
  it('falls back to the percentage default on a non-numeric or negative override', () => {
    assert.equal(computeMaxFailures(137, 'not-a-number'), Math.floor(137 * 0.15))
    assert.equal(computeMaxFailures(137, '-1'), Math.floor(137 * 0.15))
  })
})

describe('shouldExitFailure', () => {
  it('exits clean when there are no failures', () => {
    assert.equal(shouldExitFailure([], 137, undefined), false)
  })
  it('stays green when failures are within the default 15% threshold', () => {
    const failed = Array.from({ length: 20 }, (_, i) => `source_${i}`) // exactly the cap for 137
    assert.equal(shouldExitFailure(failed, 137, undefined), false)
  })
  it('goes red when failures exceed the default 15% threshold', () => {
    const failed = Array.from({ length: 21 }, (_, i) => `source_${i}`) // one over the cap
    assert.equal(shouldExitFailure(failed, 137, undefined), true)
  })
  it('goes red when dedupe fails, even with zero scraper failures', () => {
    assert.equal(shouldExitFailure(['dedupe'], 137, undefined), true)
  })
  it('goes red when dedupe fails, even if scraper failures are well under the cap', () => {
    assert.equal(shouldExitFailure(['source_1', 'dedupe'], 137, undefined), true)
  })
  it('an explicit --max-failures override changes the threshold', () => {
    const failed = ['a', 'b', 'c']
    assert.equal(shouldExitFailure(failed, 137, '2'), true)   // 3 > 2
    assert.equal(shouldExitFailure(failed, 137, '3'), false)  // 3 <= 3
    assert.equal(shouldExitFailure(failed, 137, '10'), false) // 3 <= 10
  })
  it('a single-scraper run (--key) has a threshold of 0 by default', () => {
    // computeMaxFailures(1, undefined) === floor(1 * 0.15) === 0, so any
    // failure in a --key-filtered single-scraper run is red.
    assert.equal(shouldExitFailure(['blu_jazz'], 1, undefined), true)
  })
})
