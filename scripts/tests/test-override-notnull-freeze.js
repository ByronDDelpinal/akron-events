/**
 * test-override-notnull-freeze.js — a manual override on a NOT-NULL column
 * must never hollow out the upsert payload.
 *
 * The freeze: `_stripOverriddenFields` used to DELETE every overridden key from
 * the outgoing row. Postgres runs ExecConstraints on the tuple proposed by
 * `INSERT ... ON CONFLICT` BEFORE it resolves the conflict, so a payload missing
 * a NOT-NULL-no-default column raises 23502 on every run — the whole row fails
 * and no field ever updates again, silently, forever. `public.events` has 18
 * NOT NULL columns but only `title` and `start_at` lack a database default
 * (PostgREST omits absent columns from the INSERT column list, so the other 16
 * get their defaults), so those two are the only triggers.
 *
 * The fix backfills the human's CURRENT value (read back through a widened
 * lookup select) instead of deleting the key — `manual_overrides` entries are
 * provenance markers ({at, by, reason}), not values, so the human's value lives
 * only in the column. Every other overridden key still gets deleted.
 *
 * The real function runs offline through the supabase-admin `__setClientForTests`
 * seam — same mock shape as test-normalize-upsert-counters.js.
 *
 * Run:  node --test scripts/tests/test-override-notnull-freeze.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { upsertEventSafe, REQUIRED_EVENT_COLUMNS } = await import('../lib/normalize.js')
const { __setClientForTests } = await import('../lib/supabase-admin.js')

const LOOKUP_COLS = 'id, manual_overrides, title, start_at'

// ── Mock supabase client ────────────────────────────────────────────────────
// `existing` is the events row the (source, source_id) lookup finds — i.e. the
// live row carrying the human's edits and their manual_overrides markers.
function makeMock(existing) {
  const calls = { upsert: 0, upsertRow: null, lookups: 0 }
  function resolve(st) {
    if (st.op === 'upsert') return { data: { id: existing?.id ?? 'new-ev' }, error: null }
    if (st.table === 'event_aliases') return { data: null, error: null } // no alias — never suppress
    if (st.table === 'events') {
      if (st.cols === LOOKUP_COLS) { calls.lookups++; return { data: existing ?? null, error: null } }
      if (st.cols === 'manual_overrides') return { data: null, error: null } // syncEventCategories
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
      insert() { return Promise.resolve({ error: null }) },
      delete() { st.op = 'delete'; return chain },
      upsert(row) {
        if (table === 'events') { calls.upsert++; calls.upsertRow = row }
        st.op = 'upsert'
        return chain
      },
      maybeSingle() { return Promise.resolve(resolve(st)) },
      single()      { return Promise.resolve(resolve(st)) },
      then(onF, onR) { return Promise.resolve({ error: null }).then(onF, onR) },
    }
    return chain
  }
  return { client: { from: builder }, calls }
}

const marker = (by = 'byron') => ({ at: '2026-09-01T12:00:00Z', by, reason: 'hand-edited' })

const HUMAN_TITLE    = 'Wine Mill — Fall Tasting (curated)'
const HUMAN_START_AT = '2026-11-14T23:00:00.000Z'
const SCRAPER_TITLE  = 'FALL TASTING!!!'
const scraperStart   = () => new Date(Date.now() + 14 * 86400000).toISOString()

const existingRow = (manual_overrides) => ({
  id: 'ev-wine-1',
  manual_overrides,
  title: HUMAN_TITLE,
  start_at: HUMAN_START_AT,
})

const scraperRow = (extra = {}) => ({
  title: SCRAPER_TITLE,
  start_at: scraperStart(),
  source: 'wine_mill',
  source_id: 'fall-tasting-2026',
  description: 'Scraped description',
  status: 'published',
  ...extra,
})

// Runs upsertEventSafe against the mock and always restores the seam.
async function run(existing, row = scraperRow()) {
  const { client, calls } = makeMock(existing)
  __setClientForTests(client)
  try {
    const res = await upsertEventSafe(row)
    return { res, calls }
  } finally {
    __setClientForTests(null)
  }
}

describe('manual override on a NOT NULL column — payload must stay complete', () => {
  it('exposes exactly the two NOT-NULL-no-default columns', () => {
    assert.deepEqual([...REQUIRED_EVENT_COLUMNS].sort(), ['start_at', 'title'])
  })

  it('(a) start_at overridden → payload CONTAINS start_at, set to the existing row value', async () => {
    const { res, calls } = await run(existingRow({ start_at: marker() }))
    assert.equal(res.error, null)
    assert.equal(calls.upsert, 1)
    assert.ok('start_at' in calls.upsertRow, 'start_at must not be stripped from the payload')
    assert.equal(calls.upsertRow.start_at, HUMAN_START_AT)          // the human's value
    assert.notEqual(calls.upsertRow.start_at, undefined)
    assert.equal(calls.upsertRow.title, SCRAPER_TITLE)              // untouched key still scraped
  })

  it('(b) title overridden → payload CONTAINS title, set to the existing row value', async () => {
    const { res, calls } = await run(existingRow({ title: marker() }))
    assert.equal(res.error, null)
    assert.equal(calls.upsert, 1)
    assert.ok('title' in calls.upsertRow, 'title must not be stripped from the payload')
    assert.equal(calls.upsertRow.title, HUMAN_TITLE)
  })

  it('(c) both overridden at once → both present and both from the existing row', async () => {
    const row = scraperRow()
    const { res, calls } = await run(existingRow({ title: marker(), start_at: marker() }), row)
    assert.equal(res.error, null)
    assert.equal(calls.upsert, 1)
    assert.equal(calls.upsertRow.title, HUMAN_TITLE)
    assert.equal(calls.upsertRow.start_at, HUMAN_START_AT)
    assert.notEqual(calls.upsertRow.start_at, row.start_at)
  })

  it('(d) a non-required overridden key (description, status) is STILL ABSENT — the change stayed narrow', async () => {
    const { calls } = await run(existingRow({
      description: marker(), status: marker(), title: marker(),
    }))
    assert.equal(calls.upsert, 1)
    assert.ok(!('description' in calls.upsertRow), 'description must still be deleted')
    assert.ok(!('status' in calls.upsertRow), 'status must still be deleted')
    assert.equal(calls.upsertRow.title, HUMAN_TITLE) // required key still backfilled
  })

  it('(e) source/source_id survive even when overridden — they are the conflict target', async () => {
    const { calls } = await run(existingRow({
      source: marker(), source_id: marker(), title: marker(), start_at: marker(),
    }))
    assert.equal(calls.upsert, 1)
    assert.equal(calls.upsertRow.source, 'wine_mill')
    assert.equal(calls.upsertRow.source_id, 'fall-tasting-2026')
  })

  it('(f) no overrides → the scraped values go through untouched', async () => {
    const row = scraperRow()
    const { res, calls } = await run(existingRow(null), row)
    assert.equal(res.error, null)
    assert.equal(calls.upsert, 1)
    assert.equal(calls.upsertRow.title, SCRAPER_TITLE)
    assert.equal(calls.upsertRow.start_at, row.start_at)
    assert.equal(calls.upsertRow.description, 'Scraped description')
  })

  it('(f2) overrides on a key the scraper did not send change nothing', async () => {
    const row = scraperRow()
    const { calls } = await run(existingRow({ image_url: marker() }), row)
    assert.equal(calls.upsert, 1)
    assert.equal(calls.upsertRow.title, SCRAPER_TITLE)
    assert.equal(calls.upsertRow.start_at, row.start_at)
  })

  it('never constructs a null payload: an empty stored value keeps the scraped value and warns', async () => {
    const warnings = []
    const realWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      const row = scraperRow()
      const existing = { id: 'ev-wine-1', manual_overrides: { start_at: marker() }, title: HUMAN_TITLE, start_at: null }
      const { res, calls } = await run(existing, row)
      assert.equal(res.error, null)
      assert.equal(calls.upsert, 1)
      assert.equal(calls.upsertRow.start_at, row.start_at) // scraper value retained, never null
      assert.ok(
        warnings.some((w) => w.includes('start_at') && w.includes('wine_mill')),
        `expected a warning naming start_at, got: ${JSON.stringify(warnings)}`
      )
    } finally {
      console.warn = realWarn
    }
  })

  it('(g) a whitespace-only stored value is EMPTY, not missing — scraped value kept, row still writes', async () => {
    // Blankness is handled in the strip, not in the post-strip guard. Treating
    // a blank stored value as "missing" would skip the row on every run, which
    // is the same never-updates-again symptom as the 23502 freeze this fix
    // removes — just louder. So: warn, keep the scraped value, write the row.
    const warnings = []
    const realWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      const row = scraperRow()
      const existing = { id: 'ev-wine-1', manual_overrides: { title: marker() }, title: '   ', start_at: HUMAN_START_AT }
      const { res, calls } = await run(existing, row)
      assert.equal(res.error, null)
      assert.equal(calls.upsert, 1, 'a blank override must never become a permanent per-row skip')
      assert.equal(calls.upsertRow.title, SCRAPER_TITLE)
      assert.ok(
        warnings.some((w) => w.includes('title') && w.includes('wine_mill')),
        `expected a warning naming title, got: ${JSON.stringify(warnings)}`
      )
    } finally {
      console.warn = realWarn
    }
  })

  it('(h) genuinely new row (no existing row at all) — scraper values intact, isNew, no warning', async () => {
    // The lookup returns null: nothing to strip, nothing to back-fill. This is
    // the common case on a first scrape and must be completely untouched by the
    // required-column handling — no backfill, no guard trip, no warning noise.
    const warnings = []
    const realWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    let out
    try {
      const row = scraperRow()
      out = await run(null, row)
      assert.equal(out.res.error, null)
      assert.equal(out.calls.upsert, 1)
      assert.equal(out.calls.upsertRow.title, SCRAPER_TITLE)
      assert.equal(out.calls.upsertRow.start_at, row.start_at)
      assert.equal(out.calls.upsertRow.description, 'Scraped description')
      assert.equal(out.res.isNew, true, 'a row with no prior lookup hit is an insert')
    } finally {
      console.warn = realWarn
    }
    assert.ok(
      !warnings.some((w) => w.includes('stored value is empty')),
      `a brand-new row must not warn about empty overrides, got: ${JSON.stringify(warnings)}`
    )
  })
})

// ── Note on the two defence-in-depth branches ───────────────────────────────
// `upsertEventSafe` runs `validateEvent` BEFORE the override strip, and that
// rejects a row whose title is absent/blank or whose start_at is absent, so
// two branches added by this fix are unreachable through the public seam and
// are therefore not asserted above:
//
//   * the post-strip `safeRow[col] == null` guard — with the strip always
//     leaving both required columns present, nothing can reach it;
//   * the un-gated backfill (`filtered[field] = stored` even when the scraper
//     never sent the column) — the scraper cannot get past validateEvent
//     without sending it.
//
// Both are kept as cheap backstops against a future regression in the strip or
// in validateEvent. Exporting `_stripOverriddenFields` purely to reach them
// would widen the module's API for test convenience, so it was not done.
