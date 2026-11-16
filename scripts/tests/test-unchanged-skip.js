/**
 * test-unchanged-skip.js: the per-source snapshot, the unchanged-event skip,
 * the category difference and the link short-circuits in
 * scripts/lib/normalize.js (incident 2026-11-15: every re-seen event was
 * rewritten about three times a night whether or not it had changed).
 *
 * No network and no real database: a small in-memory fake is installed
 * through the supabase-admin test seam and records every request it serves.
 *
 * Run:  node --test scripts/tests/test-unchanged-skip.js
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

const {
  upsertEventSafe, syncEventCategories, linkEventVenue, setEventVenue, linkEventOrganization,
  logUpsertResult, computeEventContentHash, EVENT_HASH_VERSION,
  _resetSourceSnapshots, _resetUpsertObservations, _resetEventOverridesCache,
} = await import('../lib/normalize.js')
const { __setClientForTests } = await import('../lib/supabase-admin.js')

const SOURCE = 'skip_test_src'
const startAt = new Date(Date.now() + 7 * 86400000).toISOString()
const scraped = (over = {}) => ({
  title: 'Jazz Night at the Hall', description: 'Live jazz quartet.', start_at: startAt,
  source: SOURCE, source_id: 'a1', ticket_url: 'https://example.org/jazz', ...over,
})

/**
 * In-memory stand-in for the service-role client. `db.events` holds the rows
 * the "database" has for SOURCE, in the shape the snapshot read asks for.
 * Every request is appended to `calls` as "<table>.<op>".
 */
function makeFake({ events = [], failSnapshot = false } = {}) {
  const calls = []
  const written = { upserts: [], catInserts: [], catDeletes: [], runs: [] }
  function builder(table) {
    const st = { table, op: 'select', cols: null, filters: {}, ranged: false }
    const settle = () => {
      calls.push(`${table}.${st.op}`)
      if (table === 'events' && st.op === 'select' && st.ranged) {
        if (failSnapshot) return { data: null, error: { message: 'boom' } }
        return { data: events.filter((e) => e.source === st.filters.source), error: null }
      }
      if (table === 'events' && st.op === 'select') {
        const row = events.find((e) =>
          (st.filters.id ? e.id === st.filters.id : e.source === st.filters.source && e.source_id === st.filters.source_id))
        return { data: row ?? null, error: null }
      }
      if (table === 'events' && st.op === 'upsert') {
        written.upserts.push(st.payload)
        const existing = events.find((e) => e.source === st.payload.source && e.source_id === st.payload.source_id)
        return { data: { id: existing?.id ?? 'new-id' }, error: null }
      }
      if (table === 'event_categories' && st.op === 'delete') written.catDeletes.push(st.filters.category ?? 'ALL')
      if (table === 'event_categories' && st.op === 'insert') written.catInserts.push(st.payload.map((r) => r.category))
      if (table === 'scraper_runs' && st.op === 'insert') written.runs.push(st.payload)
      return { data: null, error: null }
    }
    const chain = {
      select(cols) { if (st.op === 'select') st.cols = cols; return chain },
      eq(col, val) { st.filters[col] = val; return chain },
      neq() { return chain },
      in(col, vals) { st.filters[col] = vals; return chain },
      order() { return chain },
      limit() { return chain },
      range() { st.ranged = true; return chain },
      insert(payload) { st.op = 'insert'; st.payload = payload; return chain },
      update(payload) { st.op = 'update'; st.payload = payload; return chain },
      upsert(payload) { st.op = 'upsert'; st.payload = payload; return chain },
      delete() { st.op = 'delete'; return chain },
      maybeSingle() { return Promise.resolve(settle()) },
      single() { return Promise.resolve(settle()) },
      then(onF, onR) { return Promise.resolve(settle()).then(onF, onR) },
    }
    return chain
  }
  return { client: { from: builder }, calls, written }
}

/** The row the database would hold after `row` was written with `categories`. */
async function storedRowFor(row, { id = 'ev-1', categories, manual_overrides = null, venues = [], orgs = [] } = {}) {
  // Learn the exact payload/categories upsertEventSafe produces by running it
  // once against an empty database and reading back what it wrote.
  const probe = makeFake()
  __setClientForTests(probe.client)
  _resetSourceSnapshots()
  await upsertEventSafe(row)
  const payload = probe.written.upserts[0]
  return {
    id, source: row.source, source_id: row.source_id, content_hash: payload.content_hash,
    manual_overrides, title: payload.title, start_at: payload.start_at,
    image_url: null, image_width: null, image_height: null, image_file_size: null,
    event_categories: (categories ?? probe.written.catInserts.flat()).map((category) => ({ category })),
    event_venues: venues.map((venue_id) => ({ venue_id })),
    event_organizations: orgs.map((organization_id) => ({ organization_id })),
  }
}

const writes = (calls) => calls.filter((c) => !c.endsWith('.select'))

beforeEach(() => {
  _resetSourceSnapshots()
  _resetUpsertObservations()
  _resetEventOverridesCache()
  delete process.env.DISABLE_UNCHANGED_SKIP
})
afterEach(() => {
  __setClientForTests(null)
  delete process.env.DISABLE_UNCHANGED_SKIP
})

describe('computeEventContentHash', () => {
  it('carries the hash version, so a version bump can never match an old hash', () => {
    assert.match(computeEventContentHash({ title: 'x' }, ['music']), new RegExp(`^v${EVENT_HASH_VERSION}:[0-9a-f]{32}$`))
  })
  it('ignores key order, category order, undefined keys and content_hash itself', () => {
    const a = computeEventContentHash({ title: 'x', tags: ['a', 'b'], price_min: undefined }, ['music', 'family'])
    const b = computeEventContentHash({ content_hash: 'old', tags: ['a', 'b'], title: 'x' }, ['family', 'music'])
    assert.equal(a, b)
  })
  it('changes when any field, a null-vs-value, or the categories change', () => {
    const base = computeEventContentHash({ title: 'x', price_min: null }, ['music'])
    assert.notEqual(base, computeEventContentHash({ title: 'y', price_min: null }, ['music']))
    assert.notEqual(base, computeEventContentHash({ title: 'x', price_min: 5 }, ['music']))
    assert.notEqual(base, computeEventContentHash({ title: 'x', price_min: null }, ['family']))
  })
})

describe('upsertEventSafe: unchanged events', () => {
  it('writes nothing for a re-seen event whose payload and categories are identical', async () => {
    const stored = await storedRowFor(scraped())
    const fake = makeFake({ events: [stored] })
    __setClientForTests(fake.client)
    _resetSourceSnapshots(); _resetUpsertObservations()

    const res = await upsertEventSafe(scraped())
    assert.deepEqual(res, { data: { id: 'ev-1' }, error: null, isNew: false, unchanged: true })
    assert.deepEqual(writes(fake.calls), [])
    // One snapshot read for the source, and no per-event read at all.
    assert.deepEqual(fake.calls, ['events.select'])
  })

  it('reads the source once however many of its events are re-seen', async () => {
    const one = await storedRowFor(scraped({ source_id: 'a1' }), { id: 'ev-1' })
    const two = await storedRowFor(scraped({ source_id: 'a2', title: 'Blues Night at the Hall' }), { id: 'ev-2' })
    const fake = makeFake({ events: [one, two] })
    __setClientForTests(fake.client)
    _resetSourceSnapshots()
    await upsertEventSafe(scraped({ source_id: 'a1' }))
    await upsertEventSafe(scraped({ source_id: 'a2', title: 'Blues Night at the Hall' }))
    assert.deepEqual(fake.calls, ['events.select'])
  })

  it('writes a changed event once, with the new hash, and leaves matching categories alone', async () => {
    const stored = await storedRowFor(scraped())
    const fake = makeFake({ events: [stored] })
    __setClientForTests(fake.client)
    _resetSourceSnapshots()

    const res = await upsertEventSafe(scraped({ description: 'Live jazz quintet.' }))
    assert.equal(res.unchanged, undefined)
    assert.equal(res.isNew, false)
    assert.equal(fake.written.upserts.length, 1)
    assert.notEqual(fake.written.upserts[0].content_hash, stored.content_hash)
    assert.deepEqual(writes(fake.calls), ['events.upsert'])
  })

  it('does not write the same event twice when a source lists it twice in one run', async () => {
    const stored = await storedRowFor(scraped())
    const fake = makeFake({ events: [stored] })
    __setClientForTests(fake.client)
    _resetSourceSnapshots()
    await upsertEventSafe(scraped({ description: 'Live jazz quintet.' }))
    const again = await upsertEventSafe(scraped({ description: 'Live jazz quintet.' }))
    assert.equal(again.unchanged, true)
    assert.equal(fake.written.upserts.length, 1)
  })

  it('a row stored before hashes existed (null hash) is written, never skipped', async () => {
    const stored = { ...(await storedRowFor(scraped())), content_hash: null }
    const fake = makeFake({ events: [stored] })
    __setClientForTests(fake.client)
    _resetSourceSnapshots()
    const res = await upsertEventSafe(scraped())
    assert.equal(res.unchanged, undefined)
    assert.equal(fake.written.upserts.length, 1)
  })

  it('DISABLE_UNCHANGED_SKIP writes every event and reads per event, as before', async () => {
    const stored = await storedRowFor(scraped())
    const fake = makeFake({ events: [stored] })
    __setClientForTests(fake.client)
    _resetSourceSnapshots()
    process.env.DISABLE_UNCHANGED_SKIP = '1'
    const res = await upsertEventSafe(scraped())
    assert.equal(res.unchanged, undefined)
    assert.equal(res.isNew, false)
    assert.equal(fake.written.upserts.length, 1)
  })

  it('a failed snapshot read falls back to the per-event path and still writes', async () => {
    const stored = await storedRowFor(scraped())
    const fake = makeFake({ events: [stored], failSnapshot: true })
    __setClientForTests(fake.client)
    _resetSourceSnapshots()
    const res = await upsertEventSafe(scraped())
    assert.equal(res.isNew, false)          // found by the per-event read
    assert.equal(res.unchanged, undefined)  // never skipped without a snapshot
    assert.equal(fake.written.upserts.length, 1)
  })

  it('a snapshot miss is a new event only if the per-event read agrees', async () => {
    const fake = makeFake({ events: [] })
    __setClientForTests(fake.client)
    const res = await upsertEventSafe(scraped())
    assert.equal(res.isNew, true)
    assert.equal(fake.written.upserts.length, 1)
    // New row: categories are inserted with no delete and no read.
    assert.deepEqual(fake.written.catDeletes, [])
    assert.equal(fake.written.catInserts.length, 1)
  })

  it('reports unchanged rows inside updated, and separately, in scraper_runs', async () => {
    const stored = await storedRowFor(scraped())
    const fake = makeFake({ events: [stored] })
    __setClientForTests(fake.client)
    _resetSourceSnapshots(); _resetUpsertObservations()
    await upsertEventSafe(scraped())
    await logUpsertResult(SOURCE, 0, 1, 0)
    assert.equal(fake.written.runs.length, 1)
    assert.equal(fake.written.runs[0].events_updated, 1)
    assert.equal(fake.written.runs[0].events_unchanged, 1)
    assert.equal(fake.written.runs[0].events_inserted, 0)
  })
})

describe('syncEventCategories: writes only the difference', () => {
  it('no write when the stored set already matches', async () => {
    const fake = makeFake()
    __setClientForTests(fake.client)
    const ok = await syncEventCategories('ev-1', ['music', 'family'], { overrides: null, current: ['family', 'music'] })
    assert.equal(ok, true)
    assert.deepEqual(fake.calls, [])
  })
  it('inserts only the missing slug and deletes only the surplus one', async () => {
    const fake = makeFake()
    __setClientForTests(fake.client)
    await syncEventCategories('ev-1', ['music', 'family'], { overrides: null, current: ['music', 'arts'] })
    assert.deepEqual(fake.written.catDeletes, [['arts']])
    assert.deepEqual(fake.written.catInserts, [['family']])
    assert.deepEqual(fake.calls, ['event_categories.delete', 'event_categories.insert'])
  })
  it('an admin category lock leaves the join table alone', async () => {
    const fake = makeFake()
    __setClientForTests(fake.client)
    const ok = await syncEventCategories('ev-1', ['music'], { overrides: { categories: { at: 'x' } }, current: ['arts'] })
    assert.equal(ok, false)
    assert.deepEqual(fake.calls, [])
  })
  it('with no known state it reads lock and categories in one request', async () => {
    const fake = makeFake({ events: [{ id: 'ev-1', manual_overrides: null, event_categories: [{ category: 'music' }] }] })
    __setClientForTests(fake.client)
    await syncEventCategories('ev-1', ['music'])
    assert.deepEqual(fake.calls, ['events.select'])
  })
  it('replaces the set whole when the stored categories cannot be read', async () => {
    const fake = makeFake({ events: [] })
    __setClientForTests(fake.client)
    await syncEventCategories('ev-9', ['music'])
    assert.deepEqual(fake.written.catDeletes, ['ALL'])
    assert.deepEqual(fake.written.catInserts, [['music']])
  })
})

describe('link helpers: no request for a link the snapshot already shows', () => {
  async function primed(links) {
    const stored = await storedRowFor(scraped(), links)
    const fake = makeFake({ events: [stored] })
    __setClientForTests(fake.client)
    _resetSourceSnapshots()
    await upsertEventSafe(scraped()) // loads the snapshot, writes nothing
    fake.calls.length = 0
    return fake
  }
  it('linkEventVenue skips a known link and writes an unknown one', async () => {
    const fake = await primed({ venues: ['v-1'] })
    await linkEventVenue('ev-1', 'v-1')
    assert.deepEqual(writes(fake.calls), [])
    await linkEventVenue('ev-1', 'v-2')
    assert.deepEqual(writes(fake.calls), ['event_venues.upsert'])
  })
  it('setEventVenue does nothing when the venue is already the only one', async () => {
    const fake = await primed({ venues: ['v-1'] })
    await setEventVenue('ev-1', 'v-1')
    assert.deepEqual(writes(fake.calls), [])
  })
  it('setEventVenue still clears other venues when there are any', async () => {
    const fake = await primed({ venues: ['v-1', 'v-2'] })
    await setEventVenue('ev-1', 'v-1')
    assert.deepEqual(writes(fake.calls), ['event_venues.delete'])
  })
  it('linkEventOrganization skips a known link and writes an unknown one', async () => {
    const fake = await primed({ orgs: ['o-1'] })
    await linkEventOrganization('ev-1', 'o-1', { source: SOURCE })
    assert.deepEqual(writes(fake.calls), [])
    await linkEventOrganization('ev-1', 'o-2', { source: SOURCE })
    assert.deepEqual(writes(fake.calls), ['event_organizations.upsert'])
  })
})
