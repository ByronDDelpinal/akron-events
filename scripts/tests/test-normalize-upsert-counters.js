/**
 * test-normalize-upsert-counters.js — the centralized honest insert/update
 * tally (Commit A of the scrape-report defect-2 fix).
 *
 * upsertEventSafe already computed an honest `isNew` per row; most
 * logUpsertResult call sites across the scrapers discard it and pass
 * hardcoded/approximate counts instead (that's Commit B, deferred — those
 * ~112 files are NOT touched here). This file exercises only the centralized
 * fix in scripts/lib/normalize.js: _observedUpserts records what
 * upsertEventSafe actually did, keyed by `row.source`, and logUpsertResult
 * prefers that observed tally over whatever the caller passed.
 *
 * The real client is stubbed via the supabase-admin test seam
 * (__setClientForTests) — no network, matches the pattern already used by
 * the event_aliases-enforcement tests in test-normalize.js.
 *
 * Run:  node --test scripts/tests/test-normalize-upsert-counters.js
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  upsertEventSafe, logUpsertResult, logScraperError,
  _resetUpsertObservations, _getUpsertObservations,
} = await import('../lib/normalize.js')
const { __setClientForTests } = await import('../lib/supabase-admin.js')
const { normaliseDiceEvent } = await import('../lib/dice.js')
const { mapTags } = await import('../scrape-musica.js') // read-only import — not edited, not invoked as main()
const { MAC_SATURN } = await import('./fixtures/musica-events.js')

// ── Mock supabase client ────────────────────────────────────────────────────
//
// `existingRef.value` is mutable so the same mock can represent the DB state
// "before" a row exists (run 1: existed=false → isNew=true) and "after"
// (run 2: existed=true → isNew=false) across two upsertEventSafe calls,
// exactly like a real re-scrape of the same fixture would see.
function makeMock({ existingRef }) {
  const scraperRunsInserts = []
  function resolve(st) {
    if (st.op === 'upsert' && st.table === 'events') return { data: { id: 'ev-1' }, error: null }
    if (st.table === 'event_aliases') return { data: null, error: null } // no alias — never suppress
    if (st.table === 'events') {
      if (st.cols === 'id, manual_overrides') return { data: existingRef.value, error: null }
      if (st.cols === 'manual_overrides')     return { data: null, error: null } // syncEventCategories: no override
    }
    return { data: null, error: null }
  }
  function builder(table) {
    const st = { table, cols: null, op: 'select' }
    const chain = {
      select(cols) { st.cols = cols; return chain },
      eq()    { return chain },
      neq()   { return chain },
      order() { return chain },
      limit() { return chain },
      insert(row) {
        if (table === 'scraper_runs') scraperRunsInserts.push(row)
        return Promise.resolve({ error: null })
      },
      delete() { st.op = 'delete'; return chain },
      upsert() { st.op = 'upsert'; return chain },
      maybeSingle() { return Promise.resolve(resolve(st)) },
      single()      { return Promise.resolve(resolve(st)) },
      then(onF, onR) { return Promise.resolve({ error: null }).then(onF, onR) },
    }
    return chain
  }
  return { client: { from: builder }, scraperRunsInserts }
}

const futureIso = () => new Date(Date.now() + 7 * 86400000).toISOString()
const rowFor = (source, sourceId) => ({ title: `Event ${sourceId}`, source, source_id: sourceId, start_at: futureIso() })

beforeEach(() => {
  _resetUpsertObservations()
})

// ── Bare counter behavior ───────────────────────────────────────────────────
describe('upsert observation tally — bare counter behavior', () => {
  it('starts empty', () => {
    assert.equal(_getUpsertObservations().size, 0)
  })

  it('observed counts are preferred over caller-passed args', async () => {
    const existingRef = { value: null } // no prior row → isNew: true
    const { client, scraperRunsInserts } = makeMock({ existingRef })
    __setClientForTests(client)
    try {
      const res = await upsertEventSafe(rowFor('acme_src', 'ev-1'))
      assert.equal(res.isNew, true)
      assert.deepEqual(_getUpsertObservations().get('acme_src'), { inserted: 1, updated: 0 })

      // Caller passes deliberately wrong args (mirrors the ~112 hardcoded-0
      // call sites) — the write must reflect the OBSERVED tally, not these.
      await logUpsertResult('acme_src', 0, 0, 0)
      assert.equal(scraperRunsInserts.length, 1)
      assert.equal(scraperRunsInserts[0].events_inserted, 1)
      assert.equal(scraperRunsInserts[0].events_updated, 0)
    } finally {
      __setClientForTests(null)
    }
  })

  it('a caller/observed disagreement prints exactly one warning naming the source and both numbers', async () => {
    const existingRef = { value: null }
    const { client } = makeMock({ existingRef })
    __setClientForTests(client)
    const warnings = []
    const origWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      await upsertEventSafe(rowFor('warn_src', 'ev-1')) // observed: 1 inserted, 0 updated
      await logUpsertResult('warn_src', 0, 5, 0) // caller disagrees on both
      const mismatchWarnings = warnings.filter((w) => w.includes('argument mismatch'))
      assert.equal(mismatchWarnings.length, 1)
      assert.match(mismatchWarnings[0], /warn_src/)
      assert.match(mismatchWarnings[0], /0 inserted \/ 5 updated/) // caller's numbers
      assert.match(mismatchWarnings[0], /1 inserted \/ 0 updated/) // observed numbers
    } finally {
      console.warn = origWarn
      __setClientForTests(null)
    }
  })

  it('no warning when caller args happen to already match the observed tally', async () => {
    const existingRef = { value: null }
    const { client } = makeMock({ existingRef })
    __setClientForTests(client)
    const warnings = []
    const origWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      await upsertEventSafe(rowFor('agree_src', 'ev-1')) // observed: 1 inserted, 0 updated
      await logUpsertResult('agree_src', 1, 0, 0) // matches exactly
      assert.equal(warnings.filter((w) => w.includes('argument mismatch')).length, 0)
    } finally {
      console.warn = origWarn
      __setClientForTests(null)
    }
  })

  it('the tally is cleared after being consumed — a second logUpsertResult for the same source cannot double-count', async () => {
    const existingRef = { value: null }
    const { client, scraperRunsInserts } = makeMock({ existingRef })
    __setClientForTests(client)
    try {
      await upsertEventSafe(rowFor('once_src', 'ev-1'))
      await logUpsertResult('once_src', 0, 0, 0) // consumes the tally → writes observed (1, 0)
      assert.equal(scraperRunsInserts[0].events_inserted, 1)

      // Second call for the same source, no new upsertEventSafe call in
      // between: no tally left, so caller args pass through untouched.
      await logUpsertResult('once_src', 9, 9, 9)
      assert.equal(scraperRunsInserts[1].events_inserted, 9)
      assert.equal(scraperRunsInserts[1].events_updated, 9)
      assert.equal(_getUpsertObservations().has('once_src'), false)
    } finally {
      __setClientForTests(null)
    }
  })

  it('two sources in one process stay independent', async () => {
    const existingRefA = { value: null }
    const existingRefB = { value: null }
    const { client: clientA } = makeMock({ existingRef: existingRefA })
    __setClientForTests(clientA)
    try {
      await upsertEventSafe(rowFor('source_a', 'a-1'))
    } finally { __setClientForTests(null) }

    const { client: clientB } = makeMock({ existingRef: existingRefB })
    __setClientForTests(clientB)
    try {
      await upsertEventSafe(rowFor('source_b', 'b-1'))
      await upsertEventSafe(rowFor('source_b', 'b-2'))
    } finally { __setClientForTests(null) }

    assert.deepEqual(_getUpsertObservations().get('source_a'), { inserted: 1, updated: 0 })
    assert.deepEqual(_getUpsertObservations().get('source_b'), { inserted: 2, updated: 0 })

    // Consuming source_a's tally must not touch source_b's.
    const { client: clientLog, scraperRunsInserts } = makeMock({ existingRef: { value: null } })
    __setClientForTests(clientLog)
    try {
      await logUpsertResult('source_a', 0, 0, 0)
      assert.equal(scraperRunsInserts[0].events_inserted, 1)
      assert.equal(_getUpsertObservations().has('source_a'), false)
      assert.deepEqual(_getUpsertObservations().get('source_b'), { inserted: 2, updated: 0 }) // untouched
    } finally {
      __setClientForTests(null)
    }
  })

  it('a source with no tally at all passes caller args through byte-identically', async () => {
    const { client, scraperRunsInserts } = makeMock({ existingRef: { value: null } })
    __setClientForTests(client)
    const warnings = []
    const origWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      // No upsertEventSafe call for 'never_touched' — no tally exists.
      await logUpsertResult('never_touched', 4, 2, 1)
      assert.equal(scraperRunsInserts[0].events_inserted, 4)
      assert.equal(scraperRunsInserts[0].events_updated, 2)
      assert.equal(scraperRunsInserts[0].events_skipped, 1)
      assert.equal(warnings.filter((w) => w.includes('argument mismatch')).length, 0)
    } finally {
      console.warn = origWarn
      __setClientForTests(null)
    }
  })

  it('logScraperError: a tally present at error time is more honest than the hardcoded 0/0/0 it passes', async () => {
    // Simulates a scraper that wrote 12 rows then threw before its own
    // logUpsertResult call — logScraperError always calls
    // logUpsertResult(source, 0, 0, 0, ...), but with an observed tally
    // present the write should reflect what actually happened.
    const { client, scraperRunsInserts } = makeMock({ existingRef: { value: null } })
    __setClientForTests(client)
    try {
      for (let i = 0; i < 12; i++) {
        await upsertEventSafe(rowFor('crashy_src', `ev-${i}`))
      }
      assert.deepEqual(_getUpsertObservations().get('crashy_src'), { inserted: 12, updated: 0 })

      await logScraperError('crashy_src', new Error('boom'))
      assert.equal(scraperRunsInserts[0].status, 'error')
      assert.equal(scraperRunsInserts[0].events_inserted, 12) // honest, not the literal 0 logScraperError passed
      assert.equal(scraperRunsInserts[0].events_found, 0)     // eventsFound is untouched — stays as passed
    } finally {
      __setClientForTests(null)
    }
  })
})

// ── The round-trip the standing rule demands ────────────────────────────────
//
// A tally-only unit test (above) doesn't prove `isNew` is actually wired
// through from a REAL scraper's parse path. This uses the real DICE
// normalizer (normaliseDiceEvent, shared by every DICE-backed venue scraper)
// against the real Musica fixture, and the real upsertEventSafe/
// logUpsertResult from normalize.js — run twice against the identical
// fixture, simulating the DB state before and after the first write.
describe('round-trip: real parse-and-upsert path, run twice against the same fixture', () => {
  it('run 1 (row does not exist yet): N inserted / 0 updated', async () => {
    const existingRef = { value: null } // (source, source_id) not found yet
    const { client, scraperRunsInserts } = makeMock({ existingRef })
    __setClientForTests(client)
    try {
      const row = normaliseDiceEvent(MAC_SATURN, { source: 'musica', category: 'music', mapTags })
      assert.ok(row, 'normaliseDiceEvent should produce a row for MAC_SATURN')

      const { error, isNew } = await upsertEventSafe(row)
      assert.equal(error, null)
      assert.equal(isNew, true)

      // Mirrors scrape-musica.js's own (buggy) call shape — literal 0 for
      // updated — to prove the centralized fix corrects it regardless.
      await logUpsertResult('musica', 0, 0, 0, { eventsFound: 1 })

      assert.equal(scraperRunsInserts.length, 1)
      assert.equal(scraperRunsInserts[0].events_inserted, 1)
      assert.equal(scraperRunsInserts[0].events_updated, 0)
    } finally {
      __setClientForTests(null)
    }
  })

  it('run 2 (same fixture, row now exists): 0 inserted / N updated', async () => {
    const existingRef = { value: { id: 'ev-1', manual_overrides: null } } // now present from "run 1"
    const { client, scraperRunsInserts } = makeMock({ existingRef })
    __setClientForTests(client)
    try {
      const row = normaliseDiceEvent(MAC_SATURN, { source: 'musica', category: 'music', mapTags })
      const { error, isNew } = await upsertEventSafe(row)
      assert.equal(error, null)
      assert.equal(isNew, false)

      await logUpsertResult('musica', 0, 0, 0, { eventsFound: 1 })

      assert.equal(scraperRunsInserts.length, 1)
      assert.equal(scraperRunsInserts[0].events_inserted, 0)
      assert.equal(scraperRunsInserts[0].events_updated, 1)
    } finally {
      __setClientForTests(null)
    }
  })
})
