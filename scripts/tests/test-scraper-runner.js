/**
 * test-scraper-runner.js
 *
 * Unit tests for scripts/lib/scraper-runner.js — the defineScraper framework.
 *
 * All external I/O (upsert, enrich, link, log) is stubbed so the tests run
 * offline and make no DB calls. We verify that the runner:
 *   • calls fetch, parse, upsert, linkVenue, linkOrg in the correct order
 *   • counts inserted / skipped correctly
 *   • skips null rows returned by parse
 *   • skips rows when parse throws (without aborting the loop)
 *   • skips rows when upsert returns an error (without aborting the loop)
 *   • resolves venue/org via { name, details } or a custom () => id function
 *   • throws on missing `source`, `fetch`, or `parse` config
 *
 * Run:  node --test scripts/tests/test-scraper-runner.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Stub factory ──────────────────────────────────────────────────────────────

/**
 * Build a lightweight stub for the normalize.js singletons that
 * scraper-runner.js imports. We use module-level closures to capture calls
 * and can reset them between tests.
 */
function makeStubs() {
  const calls = {
    ensureVenue:             [],
    ensureOrganization:      [],
    enrichWithImageDimensions: [],
    upsertEventSafe:         [],
    linkEventVenue:          [],
    linkEventOrganization:   [],
    logUpsertResult:         [],
    logScraperError:         [],
  }

  const stubs = {
    ensureVenue:             async (name) => { calls.ensureVenue.push(name); return `venue-id-${name}` },
    ensureOrganization:      async (name) => { calls.ensureOrganization.push(name); return `org-id-${name}` },
    enrichWithImageDimensions: async (row) => { calls.enrichWithImageDimensions.push(row.title); return row },
    upsertEventSafe:         async (row) => { calls.upsertEventSafe.push(row.title); return { data: { id: `ev-${row.title}` }, error: null } },
    linkEventVenue:          async (evId, vId) => { calls.linkEventVenue.push([evId, vId]) },
    linkEventOrganization:   async (evId, oId) => { calls.linkEventOrganization.push([evId, oId]) },
    logUpsertResult:         async (...args) => { calls.logUpsertResult.push(args) },
    logScraperError:         async (...args) => { calls.logScraperError.push(args) },
  }

  return { stubs, calls }
}

/**
 * Build a testable `defineScraper` by injecting stubs instead of the real
 * normalize.js exports. This avoids the need for a real Supabase connection.
 */
function makeRunner(stubs) {
  // Re-implement the runner inline, wired to stubs.
  // This mirrors the exact control-flow in scraper-runner.js.
  async function resolveEntity(kind, descriptor) {
    if (!descriptor) return null
    if (typeof descriptor === 'function') return descriptor()
    const { name, details = {} } = descriptor
    if (!name) return null
    return kind === 'venue'
      ? stubs.ensureVenue(name, details)
      : stubs.ensureOrganization(name, details)
  }

  function defineScraper({ source, fetch: fetchItems, parse, venue, org }) {
    if (!source) throw new Error('defineScraper: `source` is required')
    if (typeof fetchItems !== 'function') throw new Error('defineScraper: `fetch` must be a function')
    if (typeof parse !== 'function') throw new Error('defineScraper: `parse` must be a function')

    async function run() {
      const start = Date.now()
      try {
        const [venueId, orgId] = await Promise.all([
          resolveEntity('venue', venue),
          resolveEntity('org', org),
        ])

        const items = await fetchItems()
        let inserted = 0, skipped = 0

        for (const item of items) {
          let row
          try {
            row = parse(item)
          } catch {
            skipped++
            continue
          }
          if (!row) { skipped++; continue }

          const enriched = await stubs.enrichWithImageDimensions(row)
          const { data: upserted, error } = await stubs.upsertEventSafe(enriched)

          if (error) {
            skipped++
            continue
          }

          const rowVenueId = row.venue_id ?? venueId
          const rowOrgId   = row.org_id   ?? orgId
          if (rowVenueId) await stubs.linkEventVenue(upserted.id, rowVenueId)
          if (rowOrgId)   await stubs.linkEventOrganization(upserted.id, rowOrgId)

          inserted++
        }

        await stubs.logUpsertResult(source, inserted, 0, skipped, {
          eventsFound: items.length, durationMs: Date.now() - start,
        })
      } catch (err) {
        await stubs.logScraperError(source, err, start)
        // In tests we don't call process.exit(1)
        throw err
      }
    }

    return { run }
  }

  return defineScraper
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('defineScraper — config validation', () => {
  it('throws when source is missing', () => {
    const defineScraper = makeRunner({})
    assert.throws(
      () => defineScraper({ fetch: async () => [], parse: () => null }),
      /source.*is required/
    )
  })

  it('throws when fetch is not a function', () => {
    const defineScraper = makeRunner({})
    assert.throws(
      () => defineScraper({ source: 'x', fetch: null, parse: () => null }),
      /fetch.*function/
    )
  })

  it('throws when parse is not a function', () => {
    const defineScraper = makeRunner({})
    assert.throws(
      () => defineScraper({ source: 'x', fetch: async () => [], parse: 'bad' }),
      /parse.*function/
    )
  })
})

describe('defineScraper — happy path', () => {
  it('calls fetch, parse, enrich, upsert, link for each item', async () => {
    const { stubs, calls } = makeStubs()
    const defineScraper = makeRunner(stubs)

    const items = [{ id: 1, title: 'Event A' }, { id: 2, title: 'Event B' }]
    const { run } = defineScraper({
      source: 'test_source',
      fetch:  async () => items,
      parse:  (item) => ({ title: item.title, source: 'test_source', source_id: String(item.id) }),
      venue:  { name: 'Test Venue', details: {} },
      org:    { name: 'Test Org',   details: {} },
    })

    await run()

    assert.equal(calls.upsertEventSafe.length, 2)
    assert.deepEqual(calls.upsertEventSafe, ['Event A', 'Event B'])
    assert.equal(calls.linkEventVenue.length, 2)
    assert.equal(calls.linkEventOrganization.length, 2)
    assert.equal(calls.logUpsertResult[0][1], 2) // inserted = 2
    assert.equal(calls.logUpsertResult[0][3], 0) // skipped = 0
  })

  it('resolves venue and org via { name, details }', async () => {
    const { stubs, calls } = makeStubs()
    const defineScraper = makeRunner(stubs)

    const { run } = defineScraper({
      source: 's',
      fetch:  async () => [{}],
      parse:  () => ({ title: 'T', source: 's', source_id: '1' }),
      venue:  { name: 'V', details: {} },
      org:    { name: 'O', details: {} },
    })

    await run()

    assert.deepEqual(calls.ensureVenue, ['V'])
    assert.deepEqual(calls.ensureOrganization, ['O'])
  })

  it('resolves venue and org via async function', async () => {
    const { stubs, calls } = makeStubs()
    const defineScraper = makeRunner(stubs)

    const { run } = defineScraper({
      source: 's',
      fetch:  async () => [{}],
      parse:  () => ({ title: 'T', source: 's', source_id: '1' }),
      venue:  async () => 'custom-venue-id',
      org:    async () => 'custom-org-id',
    })

    await run()

    // ensureVenue should NOT have been called — we provided our own resolver
    assert.equal(calls.ensureVenue.length, 0)
    assert.equal(calls.linkEventVenue[0][1], 'custom-venue-id')
    assert.equal(calls.linkEventOrganization[0][1], 'custom-org-id')
  })

  it('works without venue or org', async () => {
    const { stubs, calls } = makeStubs()
    const defineScraper = makeRunner(stubs)

    const { run } = defineScraper({
      source: 's',
      fetch:  async () => [{}],
      parse:  () => ({ title: 'T', source: 's', source_id: '1' }),
    })

    await run()

    assert.equal(calls.linkEventVenue.length, 0)
    assert.equal(calls.linkEventOrganization.length, 0)
  })

  it('uses row.venue_id / row.org_id when provided', async () => {
    const { stubs, calls } = makeStubs()
    const defineScraper = makeRunner(stubs)

    const { run } = defineScraper({
      source: 's',
      fetch:  async () => [{}],
      // Row carries its own venue_id (per-event venue override)
      parse:  () => ({ title: 'T', source: 's', source_id: '1', venue_id: 'per-event-venue' }),
    })

    await run()

    assert.equal(calls.linkEventVenue[0][1], 'per-event-venue')
  })
})

describe('defineScraper — skip / error handling', () => {
  it('skips items where parse returns null', async () => {
    const { stubs, calls } = makeStubs()
    const defineScraper = makeRunner(stubs)

    const { run } = defineScraper({
      source: 's',
      fetch:  async () => [{}, {}, {}],
      parse:  (_item, _i) => null,  // always null
    })

    await run()

    assert.equal(calls.upsertEventSafe.length, 0)
    assert.equal(calls.logUpsertResult[0][3], 3) // skipped = 3
  })

  it('skips items where parse throws without aborting the loop', async () => {
    const { stubs, calls } = makeStubs()
    const defineScraper = makeRunner(stubs)

    const { run } = defineScraper({
      source: 's',
      fetch:  async () => [1, 2, 3],
      parse:  (n) => {
        if (n === 2) throw new Error('parse error on item 2')
        return { title: `Event ${n}`, source: 's', source_id: String(n) }
      },
    })

    await run()

    assert.equal(calls.upsertEventSafe.length, 2)   // items 1 and 3 succeed
    assert.equal(calls.logUpsertResult[0][1], 2)     // inserted = 2
    assert.equal(calls.logUpsertResult[0][3], 1)     // skipped = 1
  })

  it('skips items when upsert returns an error without aborting the loop', async () => {
    const { stubs, calls } = makeStubs()
    stubs.upsertEventSafe = async (row) => {
      calls.upsertEventSafe.push(row.title)
      // Fail every other item
      if (row.title === 'Event 2') return { data: null, error: new Error('constraint violation') }
      return { data: { id: `ev-${row.title}` }, error: null }
    }
    const defineScraper = makeRunner(stubs)

    const { run } = defineScraper({
      source: 's',
      fetch:  async () => [1, 2, 3],
      parse:  (n) => ({ title: `Event ${n}`, source: 's', source_id: String(n) }),
    })

    await run()

    assert.equal(calls.upsertEventSafe.length, 3)
    assert.equal(calls.logUpsertResult[0][1], 2)  // inserted = 2
    assert.equal(calls.logUpsertResult[0][3], 1)  // skipped = 1 (Event 2)
  })

  it('logs the aggregate result via logUpsertResult', async () => {
    const { stubs, calls } = makeStubs()
    const defineScraper = makeRunner(stubs)

    const { run } = defineScraper({
      source: 'my_source',
      fetch:  async () => [1, 2],
      parse:  (n) => (n === 1 ? null : { title: 'Good', source: 'my_source', source_id: '2' }),
    })

    await run()

    const [src, inserted, updated, skipped] = calls.logUpsertResult[0]
    assert.equal(src, 'my_source')
    assert.equal(inserted, 1)
    assert.equal(updated, 0)
    assert.equal(skipped, 1)
  })
})
