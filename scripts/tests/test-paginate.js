/**
 * test-paginate.js
 *
 * Coverage for scripts/lib/paginate.js — the shared "fetch every row past
 * PostgREST's 1000-row cap" loop used by the venue sweeps.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { fetchAllRows } from '../lib/paginate.js'

/** Build a fake query builder that serves the given pages in order and records ranges. */
function fakeBuilder(pages) {
  const calls = []
  const buildQuery = (from, to) => {
    calls.push([from, to])
    const page = pages[calls.length - 1]
    return Promise.resolve(page ?? { data: [] })
  }
  return { buildQuery, calls }
}

const rows = n => Array.from({ length: n }, (_, i) => ({ id: i }))

describe('fetchAllRows', () => {
  it('walks a full page then a short page, in order, with the right ranges', async () => {
    const first = rows(1000)
    const second = Array.from({ length: 6 }, (_, i) => ({ id: 1000 + i }))
    const { buildQuery, calls } = fakeBuilder([{ data: first }, { data: second }])

    const out = await fetchAllRows(buildQuery)

    assert.equal(out.length, 1006)
    assert.deepEqual(out.map(r => r.id), Array.from({ length: 1006 }, (_, i) => i))
    assert.deepEqual(calls, [[0, 999], [1000, 1999]])
  })

  it('stops after one call when the first page is short', async () => {
    const { buildQuery, calls } = fakeBuilder([{ data: rows(6) }])
    const out = await fetchAllRows(buildQuery)
    assert.equal(out.length, 6)
    assert.deepEqual(calls, [[0, 999]])
  })

  it('returns [] for an empty first page', async () => {
    const { buildQuery, calls } = fakeBuilder([{ data: [] }])
    assert.deepEqual(await fetchAllRows(buildQuery), [])
    assert.equal(calls.length, 1)
  })

  it('treats null data as an empty page', async () => {
    const { buildQuery } = fakeBuilder([{ data: null }])
    assert.deepEqual(await fetchAllRows(buildQuery), [])
  })

  it('rejects on a PostgREST error and makes no further calls', async () => {
    const { buildQuery, calls } = fakeBuilder([
      { error: { message: 'boom' } },
      { data: rows(1) },
    ])
    await assert.rejects(() => fetchAllRows(buildQuery), /boom/)
    assert.equal(calls.length, 1)
  })

  it('honours a custom pageSize', async () => {
    const { buildQuery, calls } = fakeBuilder([{ data: rows(2) }, { data: rows(1) }])
    const out = await fetchAllRows(buildQuery, { pageSize: 2 })
    assert.equal(out.length, 3)
    assert.deepEqual(calls, [[0, 1], [2, 3]])
  })
})
