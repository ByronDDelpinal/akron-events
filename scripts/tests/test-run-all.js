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

const { computeMaxFailures, shouldExitFailure, parseEqualsFlag, buildRunManifest, writeRunManifest } =
  await import('../run-all.js')

const samplePlan = [
  { key: 'blu_jazz',  script: 's', label: 'BLU', group: 'custom' },
  { key: 'jillys',    script: 's', label: 'Jillys', group: 'custom' },
]

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

// ── buildRunManifest — provenance for scrape-report.js ─────────────────────
//
// scrape-report.js's 137-source census has no idea whether tonight's
// invocation was `--key musica` or the full fleet — this manifest is the
// seam that tells it. run-all.js is the only component that knows the true
// plan, so buildRunManifest derives scope/filter from argv the same way
// main()'s parseArgs does.
describe('buildRunManifest', () => {
  const base = { plan: samplePlan, activeCount: 137, startedAt: '2026-07-26T05:00:00.000Z' }

  it('scope "full" when neither --key nor --group is given', () => {
    const m = buildRunManifest({ argv: [], ...base })
    assert.equal(m.scope, 'full')
    assert.deepEqual(m.filter, { key: null, group: null, noDedupe: false })
  })
  it('scope "group" for --group', () => {
    const m = buildRunManifest({ argv: ['--group', 'civicplus'], ...base })
    assert.equal(m.scope, 'group')
    assert.equal(m.filter.group, 'civicplus')
    assert.equal(m.filter.key, null)
  })
  it('scope "single" for --key', () => {
    const m = buildRunManifest({ argv: ['--key', 'musica'], ...base })
    assert.equal(m.scope, 'single')
    assert.equal(m.filter.key, 'musica')
  })
  it('--key overrides --group (matches run-all.js:152-153 sequential filtering)', () => {
    const m = buildRunManifest({ argv: ['--group', 'civicplus', '--key', 'musica'], ...base })
    assert.equal(m.scope, 'single')
    assert.equal(m.filter.key, 'musica')
    assert.equal(m.filter.group, 'civicplus') // both recorded — key just wins the scope label
  })
  it('carries plannedKeys/plannedCount/activeCount from the plan', () => {
    const m = buildRunManifest({ argv: [], ...base })
    assert.deepEqual(m.plannedKeys, ['blu_jazz', 'jillys'])
    assert.equal(m.plannedCount, 2)
    assert.equal(m.activeCount, 137)
  })
  it('dedupe: "ran" for an unfiltered, completed run with dedupe present, no --no-dedupe, and no failure', () => {
    assert.equal(buildRunManifest({
      argv: [], ...base, includesDedupe: true, finishedAt: '2026-07-26T05:10:00.000Z',
    }).dedupe, 'ran')
  })
  it('dedupe: "skipped_flag" when --no-dedupe is set', () => {
    assert.equal(buildRunManifest({ argv: ['--no-dedupe'], ...base }).dedupe, 'skipped_flag')
  })
  it('dedupe: "skipped_filtered" for a --key or --group run, even without --no-dedupe', () => {
    assert.equal(buildRunManifest({ argv: ['--key', 'musica'], ...base }).dedupe, 'skipped_filtered')
    assert.equal(buildRunManifest({ argv: ['--group', 'civicplus'], ...base }).dedupe, 'skipped_filtered')
  })
  it('dedupe: "skipped_missing" when dedupe-cross-source.js is not on disk/in scope, even on a completed unfiltered run', () => {
    assert.equal(buildRunManifest({
      argv: [], ...base, includesDedupe: false, finishedAt: '2026-07-26T05:10:00.000Z',
    }).dedupe, 'skipped_missing')
  })
  it('dedupe: "pending" on the pre-run write (finishedAt == null), even though dedupe is present and in scope', () => {
    assert.equal(buildRunManifest({ argv: [], ...base, includesDedupe: true }).dedupe, 'pending')
  })
  it('dedupe: "failed" when dedupeFailed is passed on the second (post-run) call', () => {
    assert.equal(buildRunManifest({
      argv: [], ...base, includesDedupe: true, finishedAt: '2026-07-26T05:10:00.000Z', dedupeFailed: true,
    }).dedupe, 'failed')
  })
  it('ordering: a run that would otherwise be "failed" resolves to "pending" first when finishedAt is still null', () => {
    assert.equal(buildRunManifest({
      argv: [], ...base, includesDedupe: true, dedupeFailed: true,
    }).dedupe, 'pending')
  })
  it('ordering: "skipped_missing" wins over "pending"/"failed" when the dedupe script is not in scope', () => {
    assert.equal(buildRunManifest({ argv: [], ...base, includesDedupe: false }).dedupe, 'skipped_missing')
    assert.equal(buildRunManifest({
      argv: [], ...base, includesDedupe: false, finishedAt: '2026-07-26T05:10:00.000Z', dedupeFailed: true,
    }).dedupe, 'skipped_missing')
  })
  it('defaults finishedAt/failedKeys/exitCode for the first (pre-run) write', () => {
    const m = buildRunManifest({ argv: [], ...base })
    assert.equal(m.finishedAt, null)
    assert.deepEqual(m.failedKeys, [])
    assert.equal(m.exitCode, null)
  })
  it('carries finishedAt/failedKeys/exitCode through on the second (post-run) write', () => {
    const m = buildRunManifest({
      argv: [], ...base,
      finishedAt: '2026-07-26T05:10:00.000Z', failedKeys: ['jillys'], exitCode: 1,
    })
    assert.equal(m.finishedAt, '2026-07-26T05:10:00.000Z')
    assert.deepEqual(m.failedKeys, ['jillys'])
    assert.equal(m.exitCode, 1)
  })
  it('runner: "local" when GITHUB_ACTIONS is not set', () => {
    const m = buildRunManifest({ argv: [], ...base, env: {} })
    assert.equal(m.runner.kind, 'local')
    assert.equal(m.runner.runId, null)
  })
  it('runner: "github-actions" with a synthesized run URL when GITHUB_ACTIONS=true', () => {
    const env = {
      GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '123', GITHUB_RUN_NUMBER: '7',
      GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'org/repo',
    }
    const m = buildRunManifest({ argv: [], ...base, env })
    assert.equal(m.runner.kind, 'github-actions')
    assert.equal(m.runner.runId, '123')
    assert.equal(m.runner.runNumber, '7')
    assert.equal(m.runner.url, 'https://github.com/org/repo/actions/runs/123')
  })
  it('schemaVersion is present', () => {
    assert.equal(buildRunManifest({ argv: [], ...base }).schemaVersion, 1)
  })
})

// ── writeRunManifest — must never abort the scrape on a write failure ──────
//
// run-all.js's main() has no top-level try/catch, so an unhandled throw from
// mkdirSync/writeFileSync would kill the whole scrape before any scraper
// runs. Both filesystem calls are individually wrapped; this proves a
// failure in either degrades to a console.warn instead of propagating.
describe('writeRunManifest', () => {
  it('swallows an mkdirSync failure and does not throw', () => {
    let warned = false
    const origWarn = console.warn
    console.warn = () => { warned = true }
    try {
      assert.doesNotThrow(() => writeRunManifest({ schemaVersion: 1 }, {
        mkdirSync: () => { throw new Error('EACCES: permission denied') },
        writeFileSync: () => { throw new Error('should never be called') },
      }))
    } finally {
      console.warn = origWarn
    }
    assert.equal(warned, true)
  })
  it('swallows a writeFileSync failure and does not throw', () => {
    let warned = false
    const origWarn = console.warn
    console.warn = () => { warned = true }
    try {
      assert.doesNotThrow(() => writeRunManifest({ schemaVersion: 1 }, {
        mkdirSync: () => {},
        writeFileSync: () => { throw new Error('ENOSPC: no space left on device') },
      }))
    } finally {
      console.warn = origWarn
    }
    assert.equal(warned, true)
  })
  it('writes the manifest JSON when both filesystem calls succeed', () => {
    let written = null
    writeRunManifest({ schemaVersion: 1, scope: 'full' }, {
      mkdirSync: () => {},
      writeFileSync: (_path, data) => { written = data },
    })
    assert.deepEqual(JSON.parse(written), { schemaVersion: 1, scope: 'full' })
  })
})
