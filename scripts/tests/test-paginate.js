/**
 * test-paginate.js
 *
 * Coverage for scripts/lib/paginate.js — the shared "fetch every row past
 * PostgREST's 1000-row cap" loop used by the venue sweeps.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { fetchAllRows, fetchAllRowsKeyset, isStatementTimeout } from '../lib/paginate.js'

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

/**
 * Fake keyset builder over a sorted table: honours (lastKey, n) like
 * `.gt('id', lastKey).order('id').limit(n)`. `failures` maps a call index
 * (0-based) to the error that call returns instead of data.
 */
function keysetBuilder(table, failures = {}) {
  const calls = []
  const buildQuery = (lastKey, n) => {
    const i = calls.length
    calls.push(lastKey)
    if (failures[i]) return Promise.resolve({ data: null, error: failures[i] })
    const rest = lastKey == null ? table : table.filter(r => r.id > lastKey)
    return Promise.resolve({ data: rest.slice(0, n), error: null })
  }
  return { buildQuery, calls }
}

const TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' }
const noSleep = () => Promise.resolve()

describe('isStatementTimeout', () => {
  it('matches SQLSTATE 57014 or the message, nothing else', () => {
    assert.equal(isStatementTimeout(TIMEOUT), true)
    assert.equal(isStatementTimeout({ message: 'Statement timeout hit' }), true)
    assert.equal(isStatementTimeout({ code: '42703', message: 'column does not exist' }), false)
    assert.equal(isStatementTimeout(null), false)
  })
})

describe('fetchAllRowsKeyset', () => {
  it('walks multiple pages with no dupes or gaps, cursor = previous last id', async () => {
    const table = rows(7)
    const { buildQuery, calls } = keysetBuilder(table)
    const out = await fetchAllRowsKeyset(buildQuery, { pageSize: 3, sleep: noSleep })
    assert.deepEqual(out.map(r => r.id), [0, 1, 2, 3, 4, 5, 6])
    assert.deepEqual(calls, [null, 2, 5])
  })

  it('handles an exact multiple of pageSize with one trailing empty page', async () => {
    const { buildQuery, calls } = keysetBuilder(rows(6))
    const out = await fetchAllRowsKeyset(buildQuery, { pageSize: 3, sleep: noSleep })
    assert.equal(out.length, 6)
    assert.deepEqual(calls, [null, 2, 5])
  })

  it('returns [] for an empty table after one call', async () => {
    const { buildQuery, calls } = keysetBuilder([])
    assert.deepEqual(await fetchAllRowsKeyset(buildQuery, { sleep: noSleep }), [])
    assert.equal(calls.length, 1)
  })

  it('honours a custom key column', async () => {
    const table = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }]
    const calls = []
    const buildQuery = (after, n) => {
      calls.push(after)
      const rest = after == null ? table : table.filter(r => r.slug > after)
      return Promise.resolve({ data: rest.slice(0, n), error: null })
    }
    const out = await fetchAllRowsKeyset(buildQuery, { pageSize: 2, key: 'slug', sleep: noSleep })
    assert.deepEqual(out.map(r => r.slug), ['a', 'b', 'c'])
    assert.deepEqual(calls, [null, 'b'])
  })

  it('retries a statement timeout on page 2 and then succeeds', async () => {
    const { buildQuery, calls } = keysetBuilder(rows(5), { 1: TIMEOUT })
    const waits = []
    const out = await fetchAllRowsKeyset(buildQuery, {
      pageSize: 3, sleep: ms => { waits.push(ms); return Promise.resolve() },
    })
    assert.deepEqual(out.map(r => r.id), [0, 1, 2, 3, 4])
    assert.deepEqual(calls, [null, 2, 2]) // page 2 re-requested with the same cursor
    assert.equal(waits.length, 1)
    assert.ok(waits[0] >= 1000 && waits[0] < 1250)
  })

  it('throws the last error once retries are exhausted', async () => {
    const { buildQuery, calls } = keysetBuilder(rows(5), { 0: TIMEOUT, 1: TIMEOUT, 2: TIMEOUT })
    const waits = []
    await assert.rejects(
      () => fetchAllRowsKeyset(buildQuery, {
        retries: 2, sleep: ms => { waits.push(ms); return Promise.resolve() },
      }),
      (err) => err.code === '57014' && /statement timeout/.test(err.message),
    )
    assert.equal(calls.length, 3) // 1 try + 2 retries
    assert.deepEqual(waits.map(ms => Math.floor(ms / 1000)), [1, 2])
  })

  it('throws a non-retryable error immediately without sleeping', async () => {
    const { buildQuery, calls } = keysetBuilder(rows(5), { 0: { code: '42703', message: 'column x does not exist' } })
    let slept = 0
    await assert.rejects(
      () => fetchAllRowsKeyset(buildQuery, { sleep: () => { slept++; return Promise.resolve() } }),
      /column x does not exist/,
    )
    assert.equal(calls.length, 1)
    assert.equal(slept, 0)
  })
})
