/**
 * test-planned-run.js — lib/planned-run.js, the dry-run half.
 *
 * The write half goes through normalize.js against a real database and is
 * exercised by each scraper's first live run. What is pinned here is the part
 * that must hold with no database at all:
 *
 *   • a dry run needs no credentials and returns the plan untouched;
 *   • zero listings is an error run by default, and only by default;
 *   • a collect() that throws is an error with exit code 1, not a crash.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { runPlannedScraper, formatSkips, describePlannedRow, isDryRun } from '../lib/planned-run.js'

const ROW = {
  title: 'Family Story Time', start_at: '2026-11-19T15:00:00.000Z', end_at: '2026-11-19T15:30:00.000Z',
  price_min: 0, price_max: null, categories: ['learning'], source: 'x', source_id: 'tpl_1', status: 'published',
}

describe('runPlannedScraper (dry run)', () => {
  // Prove the "needs no credentials" claim: nothing a database client would
  // read is present while these run.
  const saved = {}
  const KEYS = ['VITE_SUPABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY']
  let log
  before(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
    log = console.log; console.log = () => {}
  })
  after(() => {
    for (const k of KEYS) { if (saved[k] !== undefined) process.env[k] = saved[k] }
    console.log = log
  })

  it('returns the plan counts and writes nothing, with no credentials set', async () => {
    const result = await runPlannedScraper({
      source: 'x',
      collect: async () => ({ found: 3, rows: [{ row: ROW, venue: { name: 'Library' } }], skipped: { past: 2 } }),
      dryRun: true,
    })
    assert.deepEqual(
      { status: result.status, found: result.found, planned: result.planned, exitCode: result.exitCode, inserted: result.inserted },
      { status: 'dry-run', found: 3, planned: 1, exitCode: 0, inserted: 0 },
    )
  })

  it('zero listings is an error run (exit 0) by default', async () => {
    const warn = console.warn; console.warn = () => {}
    try {
      const result = await runPlannedScraper({ source: 'x', label: 'X', collect: async () => ({ found: 0, rows: [] }), dryRun: true })
      assert.equal(result.status, 'error')
      assert.equal(result.exitCode, 0)
      assert.match(result.error, /returned 0 listings/)
    } finally { console.warn = warn }
  })

  it('…unless the source says an empty calendar is normal', async () => {
    const result = await runPlannedScraper({
      source: 'x', collect: async () => ({ found: 0, rows: [] }), dryRun: true, emptyIsError: false,
    })
    assert.equal(result.status, 'dry-run')
  })

  it('a collect() that throws is an error with exit code 1', async () => {
    const error = console.error; console.error = () => {}
    try {
      const result = await runPlannedScraper({
        source: 'x', collect: async () => { throw new Error('https://example.org answered HTTP 503') }, dryRun: true,
      })
      assert.equal(result.status, 'error')
      assert.equal(result.exitCode, 1)
      assert.match(result.error, /HTTP 503/)
    } finally { console.error = error }
  })

  it('refuses a config with no source or no collect', async () => {
    await assert.rejects(() => runPlannedScraper({ collect: async () => ({}) }), /`source` is required/)
    await assert.rejects(() => runPlannedScraper({ source: 'x' }), /`collect` must be a function/)
  })
})

describe('formatSkips / describePlannedRow / isDryRun', () => {
  it('lists reasons alphabetically and drops zeros', () => {
    assert.equal(formatSkips({ past: 3, governance: 1, undatable: 0 }), '1 governance, 3 past')
    assert.equal(formatSkips({}), 'none')
  })

  it('a dry-run line carries everything a reviewer checks', () => {
    const line = describePlannedRow({ row: { ...ROW, time_inferred: true, needs_review: true }, venue: null })
    assert.match(line, /Family Story Time/)
    assert.match(line, /\(no venue\)/)
    assert.match(line, /free/)
    assert.match(line, /cats=learning/)
    assert.match(line, /\[time_inferred\] \[needs_review\]/)
    assert.match(line, /id=tpl_1/)
    assert.match(describePlannedRow({ row: { ...ROW, price_min: null }, venue: { name: 'Hall' } }), /@ Hall {2}price \?/)
    assert.match(describePlannedRow({ row: { ...ROW, price_min: 23, price_max: 25, status: 'cancelled' }, venue: null }), /\$23–\$25.*\[cancelled\]/)
  })

  it('reads the flag and the environment variable', () => {
    assert.equal(isDryRun(['node', 's.js', '--dry-run'], {}), true)
    assert.equal(isDryRun(['node', 's.js'], { DRY_RUN: '1' }), true)
    assert.equal(isDryRun(['node', 's.js'], {}), false)
  })
})
