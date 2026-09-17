/**
 * test-venue-mint-review.js
 *
 * Pins the sev-2 fix (2026-09-17, thread 2): ensureVenue mints a venue from
 * whatever `details` a caller supplies, and ~15 of ~70 callers deliberately
 * mint name-only ({ city: 'Akron', state: 'OH' }) with no address/lat/lng.
 * Nothing downstream could place those rows, and nothing flagged them —
 * measured at 109 of 5,010 published upcoming events with no usable venue at
 * all, zero of them in the review queue.
 *
 * The fix lives in the ONE choke point every scraper already calls once it
 * has an eventId: `linkEventVenue` / `setEventVenue`
 * (scripts/lib/normalize.js). After linking, it reads the just-linked
 * venue's address/lat/lng; if all three are null, it flags the event
 * `needs_review = true`. The mint still succeeds and the event still
 * publishes — this only makes it visible in the review queue.
 *
 * These tests exercise the REAL exported `linkEventVenue` / `setEventVenue`
 * against a fake supabase client (not a pure helper in isolation), so they
 * pin the behaviour at the actual call site scrapers use.
 *
 * Run:
 *   node --test scripts/tests/test-venue-mint-review.js
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Dummy env so supabase-admin.js doesn't throw on import (getClient() is
// lazy; these are never actually used because every test injects a fake
// client via __setClientForTests before calling into normalize.js).
process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { linkEventVenue, setEventVenue, _resetVenueGeoCache } = await import('../lib/normalize.js')
const { __setClientForTests } = await import('../lib/supabase-admin.js')

/**
 * Fake supabase client covering exactly the three tables the fix touches:
 *   - event_venues: upsert (linkEventVenue) / delete (setEventVenue cleanup)
 *   - venues:       select('address, lat, lng') keyed by id
 *   - events:       select('needs_review, reviewed_at, manual_overrides') +
 *                    a targeted update({ needs_review: true }), both keyed by id
 *
 * `venues[id]` may be the string 'error' to simulate a failed read.
 * `events[id]` is mutated in place by a successful update, so assertions can
 * inspect the "row" after the call the same way a real re-select would.
 */
function makeMock({ venues = {}, events = {}, linkError = null, deleteError = null } = {}) {
  const calls = {
    venuesQueries: 0,
    eventsRead: 0,
    eventsUpdate: 0,
    eventVenuesUpsert: 0,
    eventVenuesDelete: 0,
    updatePayloads: [],
    upsertRows: [],
  }

  function builder(table) {
    const st = { table, cols: null, op: null, filters: {}, updateRow: null }
    const chain = {
      select(cols) { st.cols = cols; return chain },
      eq(col, val) { st.filters[col] = val; return chain },
      neq() { return chain },
      upsert(row) {
        st.op = 'upsert'
        st.upsertRow = row
        return chain
      },
      update(row) {
        st.op = 'update'
        st.updateRow = row
        return chain
      },
      delete() {
        st.op = 'delete'
        return chain
      },
      maybeSingle() {
        if (table === 'venues') {
          calls.venuesQueries++
          const v = venues[st.filters.id]
          if (v === 'error') return Promise.resolve({ data: null, error: { message: 'venue read boom' } })
          return Promise.resolve({ data: v ?? null, error: null })
        }
        if (table === 'events') {
          calls.eventsRead++
          const e = events[st.filters.id]
          if (e === 'error') return Promise.resolve({ data: null, error: { message: 'event read boom' } })
          return Promise.resolve({ data: e ?? null, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      },
      then(onF, onR) {
        let result = { data: null, error: null }
        if (table === 'event_venues' && st.op === 'upsert') {
          calls.eventVenuesUpsert++
          calls.upsertRows.push(st.upsertRow)
          result = { data: null, error: linkError }
        } else if (table === 'event_venues' && st.op === 'delete') {
          calls.eventVenuesDelete++
          result = { data: null, error: deleteError }
        } else if (table === 'events' && st.op === 'update') {
          calls.eventsUpdate++
          calls.updatePayloads.push({ id: st.filters.id, row: st.updateRow })
          const row = events[st.filters.id]
          if (row && row !== 'error') Object.assign(row, st.updateRow)
        }
        return Promise.resolve(result).then(onF, onR)
      },
    }
    return chain
  }

  return { client: { from: builder }, calls, venues, events }
}

beforeEach(() => {
  _resetVenueGeoCache()
})

describe('linkEventVenue — venue-mint review flag', () => {
  it('mint-without-geo: flags needs_review = true, touching ONLY that column', async () => {
    const { client, calls, events } = makeMock({
      venues: { 'v-nogeo-1': { address: null, lat: null, lng: null } },
      events: { 'e-nogeo-1': { needs_review: false, reviewed_at: null, manual_overrides: null } },
    })
    __setClientForTests(client)
    try {
      await linkEventVenue('e-nogeo-1', 'v-nogeo-1')
      assert.equal(calls.eventVenuesUpsert, 1)
      assert.equal(calls.venuesQueries, 1)
      assert.equal(calls.eventsUpdate, 1)
      assert.deepEqual(calls.updatePayloads[0], { id: 'e-nogeo-1', row: { needs_review: true } })
      assert.equal(events['e-nogeo-1'].needs_review, true)
      assert.equal(events['e-nogeo-1'].reviewed_at, null) // never touched
    } finally {
      __setClientForTests(null)
    }
  })

  it('mint-with-geo: venue has an address → event left untouched, no events write at all', async () => {
    const { client, calls, events } = makeMock({
      venues: { 'v-geo-1': { address: '123 Main St', lat: 41.08, lng: -81.51 } },
      events: { 'e-geo-1': { needs_review: false, reviewed_at: null, manual_overrides: null } },
    })
    __setClientForTests(client)
    try {
      await linkEventVenue('e-geo-1', 'v-geo-1')
      assert.equal(calls.eventVenuesUpsert, 1)
      assert.equal(calls.venuesQueries, 1)
      assert.equal(calls.eventsRead, 0, 'no reason to even read the event when the venue has geo')
      assert.equal(calls.eventsUpdate, 0)
      assert.equal(events['e-geo-1'].needs_review, false)
    } finally {
      __setClientForTests(null)
    }
  })

  it('mint-with-geo via lat/lng only (no street address) also counts as located', async () => {
    const { client, calls } = makeMock({
      venues: { 'v-geo-2': { address: null, lat: 41.08, lng: -81.51 } },
      events: { 'e-geo-2': { needs_review: false, reviewed_at: null, manual_overrides: null } },
    })
    __setClientForTests(client)
    try {
      await linkEventVenue('e-geo-2', 'v-geo-2')
      assert.equal(calls.eventsUpdate, 0)
    } finally {
      __setClientForTests(null)
    }
  })

  it('admin lock: reviewed_at already set → never re-flips a human decision', async () => {
    const { client, calls, events } = makeMock({
      venues: { 'v-nogeo-locked': { address: null, lat: null, lng: null } },
      events: {
        'e-locked-1': {
          needs_review: false,
          reviewed_at: '2026-09-01T00:00:00Z',
          manual_overrides: null,
        },
      },
    })
    __setClientForTests(client)
    try {
      await linkEventVenue('e-locked-1', 'v-nogeo-locked')
      assert.equal(calls.eventsRead, 1) // still checks
      assert.equal(calls.eventsUpdate, 0) // but never writes over a human's call
      assert.equal(events['e-locked-1'].needs_review, false)
    } finally {
      __setClientForTests(null)
    }
  })

  it('admin lock: legacy manual_overrides.needs_review pin → never re-flips', async () => {
    const { client, calls, events } = makeMock({
      venues: { 'v-nogeo-locked2': { address: null, lat: null, lng: null } },
      events: {
        'e-locked-2': {
          needs_review: false,
          reviewed_at: null,
          manual_overrides: { needs_review: { at: '2026-08-01T00:00:00Z' } },
        },
      },
    })
    __setClientForTests(client)
    try {
      await linkEventVenue('e-locked-2', 'v-nogeo-locked2')
      assert.equal(calls.eventsUpdate, 0)
      assert.equal(events['e-locked-2'].needs_review, false)
    } finally {
      __setClientForTests(null)
    }
  })

  it('idempotent: re-running the same event+venue does not churn the row or the venue read', async () => {
    const { client, calls, events } = makeMock({
      venues: { 'v-nogeo-repeat': { address: null, lat: null, lng: null } },
      events: { 'e-repeat-1': { needs_review: false, reviewed_at: null, manual_overrides: null } },
    })
    __setClientForTests(client)
    try {
      await linkEventVenue('e-repeat-1', 'v-nogeo-repeat')
      assert.equal(calls.eventsUpdate, 1)
      assert.equal(calls.venuesQueries, 1)

      // Simulate a re-scrape of the same event/venue pair within the same run.
      await linkEventVenue('e-repeat-1', 'v-nogeo-repeat')
      assert.equal(calls.eventsUpdate, 1, 'needs_review already true — no second write')
      assert.equal(calls.venuesQueries, 1, 'venue geo is cached per run — no N+1 across repeats')
      assert.equal(events['e-repeat-1'].needs_review, true)
    } finally {
      __setClientForTests(null)
    }
  })

  it('N+1 guard: many events sharing one geo-less venue cost ONE venue query, not one per event', async () => {
    const { client, calls } = makeMock({
      venues: { 'v-shared': { address: null, lat: null, lng: null } },
      events: {
        'e-a': { needs_review: false, reviewed_at: null, manual_overrides: null },
        'e-b': { needs_review: false, reviewed_at: null, manual_overrides: null },
        'e-c': { needs_review: false, reviewed_at: null, manual_overrides: null },
      },
    })
    __setClientForTests(client)
    try {
      await linkEventVenue('e-a', 'v-shared')
      await linkEventVenue('e-b', 'v-shared')
      await linkEventVenue('e-c', 'v-shared')
      assert.equal(calls.venuesQueries, 1)
      assert.equal(calls.eventsUpdate, 3) // each distinct event still gets flagged
    } finally {
      __setClientForTests(null)
    }
  })

  it('link failure isolation: event_venues upsert error skips the geo check entirely, never throws', async () => {
    const { client, calls } = makeMock({
      venues: { 'v-linkfail': { address: null, lat: null, lng: null } },
      events: { 'e-linkfail': { needs_review: false, reviewed_at: null, manual_overrides: null } },
      linkError: { message: 'simulated link failure' },
    })
    __setClientForTests(client)
    try {
      await assert.doesNotReject(linkEventVenue('e-linkfail', 'v-linkfail'))
      assert.equal(calls.venuesQueries, 0)
      assert.equal(calls.eventsRead, 0)
      assert.equal(calls.eventsUpdate, 0)
    } finally {
      __setClientForTests(null)
    }
  })

  it('venue-read failure is fail-safe: link still succeeds, event is never flagged off a read error', async () => {
    const { client, calls } = makeMock({
      venues: { 'v-readfail': 'error' },
      events: { 'e-readfail': { needs_review: false, reviewed_at: null, manual_overrides: null } },
    })
    __setClientForTests(client)
    try {
      await assert.doesNotReject(linkEventVenue('e-readfail', 'v-readfail'))
      assert.equal(calls.eventVenuesUpsert, 1)
      assert.equal(calls.eventsUpdate, 0)
    } finally {
      __setClientForTests(null)
    }
  })

  it('missing eventId/venueId: no-op, no queries at all', async () => {
    const { client, calls } = makeMock()
    __setClientForTests(client)
    try {
      await linkEventVenue(null, 'v-x')
      await linkEventVenue('e-x', null)
      assert.equal(calls.eventVenuesUpsert, 0)
      assert.equal(calls.venuesQueries, 0)
    } finally {
      __setClientForTests(null)
    }
  })
})

describe('setEventVenue — delegates to linkEventVenue, so the review flag applies here too', () => {
  it('mint-without-geo via setEventVenue also flags needs_review', async () => {
    const { client, calls, events } = makeMock({
      venues: { 'v-set-nogeo': { address: null, lat: null, lng: null } },
      events: { 'e-set-1': { needs_review: false, reviewed_at: null, manual_overrides: null } },
    })
    __setClientForTests(client)
    try {
      await setEventVenue('e-set-1', 'v-set-nogeo')
      assert.equal(calls.eventVenuesDelete, 1)
      assert.equal(calls.eventVenuesUpsert, 1)
      assert.equal(calls.eventsUpdate, 1)
      assert.equal(events['e-set-1'].needs_review, true)
    } finally {
      __setClientForTests(null)
    }
  })

  it('an admin-locked event corrected to a geo-less venue via setEventVenue is still never re-flipped', async () => {
    const { client, calls, events } = makeMock({
      venues: { 'v-set-locked': { address: null, lat: null, lng: null } },
      events: {
        'e-set-locked': {
          needs_review: false,
          reviewed_at: '2026-09-10T00:00:00Z',
          manual_overrides: null,
        },
      },
    })
    __setClientForTests(client)
    try {
      await setEventVenue('e-set-locked', 'v-set-locked')
      assert.equal(calls.eventsUpdate, 0)
      assert.equal(events['e-set-locked'].needs_review, false)
    } finally {
      __setClientForTests(null)
    }
  })
})
