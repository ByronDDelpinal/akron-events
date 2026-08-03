/**
 * test-backfill-categories.js
 *
 * The category backfill only ever touches events stuck at a bare ['other'] and
 * only when inference can now do better — it must never downgrade a real
 * category or churn ['other']→['other']. These tests pin that gate and the
 * decide-wiring (text inference + per-source defaultCategory rescue) against the
 * real resolveEventCategories path.
 *
 * Run:  node --test scripts/tests/test-backfill-categories.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { decideCategories, currentCategories, shouldRecategorize } =
  await import('../backfill-categories.js')

const OTHER = () => ({ categories: ['other'], family: false, fundraiser: false })
const MUSIC = () => ({ categories: ['music'], family: false, fundraiser: false })

describe('shouldRecategorize: only improves a bare other, never downgrades', () => {
  it('improves ["other"] → real category', () => {
    assert.equal(shouldRecategorize(['other'], ['music']), true)
    assert.equal(shouldRecategorize([], ['music']), true)
  })
  it('never downgrades a real category', () => {
    assert.equal(shouldRecategorize(['music'], ['other']), false)
    assert.equal(shouldRecategorize(['music'], ['games']), false) // already real: not a candidate
  })
  it('no-ops on other→other', () => {
    assert.equal(shouldRecategorize(['other'], ['other']), false)
    assert.equal(shouldRecategorize([], ['other']), false)
  })
})

describe('currentCategories: parse the embedded join rows', () => {
  it('reads {category} rows and dedupes', () => {
    assert.deepEqual(currentCategories({ event_categories: [{ category: 'other' }] }), ['other'])
    assert.deepEqual(currentCategories({ event_categories: [] }), [])
    assert.deepEqual(currentCategories({ event_categories: [{ category: 'music' }, { category: 'music' }] }), ['music'])
    assert.deepEqual(currentCategories({}), [])
  })
})

describe('decideCategories: inference + per-source default rescue', () => {
  it('applies the source defaultCategory when inference is bare other', () => {
    // workz is registered with defaultCategory 'music'.
    assert.deepEqual(decideCategories({ title: 'DT & The Shakes', source: 'workz' }, OTHER), ['music'])
  })
  it('a confident inference wins over the default', () => {
    assert.deepEqual(decideCategories({ title: 'x', source: 'workz' }, MUSIC), ['music'])
  })
  it('an explicit source category is respected', () => {
    assert.deepEqual(decideCategories({ categories: ['games'] }, OTHER), ['games'])
  })
  it('no source default + no inference stays other', () => {
    assert.deepEqual(decideCategories({ title: 'x', source: 'no_such_source' }, OTHER), ['other'])
  })
  it('real inference smoke: an obvious music title is not left as other', () => {
    const cats = decideCategories({ title: 'Live Jazz Concert', description: 'live music all night' })
    assert.notDeepEqual(cats, ['other'])
    assert.ok(cats.includes('music'), `expected music, got ${cats.join('+')}`)
  })
})
