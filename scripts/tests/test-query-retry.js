// Tests for src/lib/queryRetry.ts -- the one-retry wrapper around the public
// events queries (added after the 2026-11-12 search timeout).
//
// Run with: node --test scripts/tests/test-query-retry.js

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTransientQueryError, withOneRetry, RETRY_DELAY_MS } from '../../src/lib/queryRetry.ts'

const ok = { data: [{ id: 1 }], error: null, status: 200 }
const timeout = {
  data: null,
  status: 500,
  error: { code: '57014', message: 'canceling statement due to statement timeout' },
}

/** A `run` that returns the given outcomes in order and counts its calls. */
function scripted(...outcomes) {
  let calls = 0
  const run = () => Promise.resolve(outcomes[Math.min(calls++, outcomes.length - 1)])
  return { run, calls: () => calls }
}

const noSleep = () => Promise.resolve()

test('a successful response is not transient', () => {
  assert.equal(isTransientQueryError(ok), false)
})

test('a statement timeout (57014) is transient', () => {
  assert.equal(isTransientQueryError(timeout), true)
})

test('gateway and pool failures (502/503/504) are transient', () => {
  for (const status of [502, 503, 504]) {
    assert.equal(isTransientQueryError({ error: { message: 'upstream' }, status }), true, String(status))
  }
})

test('a real SQL error on a 500 is not transient', () => {
  const outcome = { error: { code: '42703', message: 'column does not exist' }, status: 500 }
  assert.equal(isTransientQueryError(outcome), false)
})

test('client errors are not transient', () => {
  for (const status of [400, 401, 403, 404, 416]) {
    assert.equal(isTransientQueryError({ error: { code: 'PGRST100' }, status }), false, String(status))
  }
})

test('a network failure (status 0) is left to supabase-js, not retried here', () => {
  const outcome = { error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 }
  assert.equal(isTransientQueryError(outcome), false)
})

test('success on the first attempt runs the query once', async () => {
  const q = scripted(ok)
  assert.equal(await withOneRetry(q.run, noSleep), ok)
  assert.equal(q.calls(), 1)
})

test('a timeout is retried once and the second result is returned', async () => {
  const q = scripted(timeout, ok)
  assert.equal(await withOneRetry(q.run, noSleep), ok)
  assert.equal(q.calls(), 2)
})

test('two timeouts in a row return the failure -- one retry, not a loop', async () => {
  const q = scripted(timeout, timeout, ok)
  const result = await withOneRetry(q.run, noSleep)
  assert.equal(result.error.code, '57014')
  assert.equal(q.calls(), 2)
})

test('a non-transient failure is returned without a second attempt', async () => {
  const bad = { error: { code: '42703' }, status: 400 }
  const q = scripted(bad, ok)
  assert.equal(await withOneRetry(q.run, noSleep), bad)
  assert.equal(q.calls(), 1)
})

test('the retry waits RETRY_DELAY_MS, and only when it retries', async () => {
  const waits = []
  const sleep = (ms) => { waits.push(ms); return Promise.resolve() }
  await withOneRetry(scripted(ok).run, sleep)
  assert.deepEqual(waits, [])
  await withOneRetry(scripted(timeout, ok).run, sleep)
  assert.deepEqual(waits, [RETRY_DELAY_MS])
})
