/**
 * test-attribution-lock.js — the per-event admin attribution lock on
 * linkEventOrganization (visitor report #53, 2026-09-14).
 *
 * THE BUG: event_organizations is add-only on the scraper path. Deleting a
 * wrong "Presented by" link in the DB fixes the page until the next nightly
 * run of the source that minted it, which re-adds the link — so the event then
 * shows BOTH the real presenter and the wrong one. Reported case:
 * indivisible_akron blanket-credits itself on a League of Women Voters event
 * it merely republishes.
 *
 * THE POLICY: an `organizations` (or `organization`) key in the event's
 * manual_overrides freezes that event's org links against every scraper write.
 * Same key-presence shape as the category lock in syncEventCategories.
 *
 * Run:  node --test scripts/tests/test-attribution-lock.js
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { linkEventOrganization, _resetEventOverridesCache } = await import('../lib/normalize.js')
const { __setClientForTests } = await import('../lib/supabase-admin.js')

const EVENT = 'c514219c-c1b9-4794-ac2d-977aad1dbfd9'

// normalize.js caches orgId → name for the run and exposes no reset, so every
// case gets its own org id. Reusing one id would leak the first case's name
// into the rest and silently disarm the self-credit assertions below.
let _n = 0
const nextOrg = () => `870f8c01-0391-4e3b-99b3-a91b45f9${String(++_n).padStart(4, '0')}`

/**
 * @param {object} overrides  — manual_overrides the event row reports
 * @param {string} orgName    — name the org id resolves to (drives the
 *                              pre-existing self-credit guard)
 */
function makeMock({ overrides, orgName = 'Indivisible Akron' }) {
  const orgLinkUpserts = []
  const reads = []

  function resolve(st) {
    if (st.table === 'events' && st.cols === 'manual_overrides') {
      reads.push('overrides')
      return { data: { manual_overrides: overrides }, error: null }
    }
    if (st.table === 'events' && st.cols === 'source') {
      return { data: { source: 'indivisible_akron' }, error: null }
    }
    if (st.table === 'organizations' && st.cols === 'name') {
      return { data: { name: orgName }, error: null }
    }
    return { data: null, error: null }
  }

  function builder(table) {
    const st = { table, cols: null }
    const chain = {
      select(cols) { st.cols = cols; return chain },
      eq() { return chain },
      upsert(row) {
        if (table === 'event_organizations') orgLinkUpserts.push(row)
        return Promise.resolve({ error: null })
      },
      maybeSingle() { return Promise.resolve(resolve(st)) },
      single()      { return Promise.resolve(resolve(st)) },
      then(onF, onR) { return Promise.resolve({ error: null }).then(onF, onR) },
    }
    return chain
  }

  return { client: { from: builder }, orgLinkUpserts, reads }
}

describe('attribution lock: linkEventOrganization', () => {
  beforeEach(() => { _resetEventOverridesCache() })

  it('refuses to re-add an org link on an event the admin pinned', () => {
    // The production case: the nightly indivisible_akron run calls this for
    // every row it ingests. Without the lock the deleted link comes back.
    const mock = makeMock({
      overrides: { organizations: { at: '2026-09-14T00:00:00.000Z', by: 'feedback-53', reason: 'presenter is LWV' } },
    })
    const org = nextOrg()
    __setClientForTests(mock.client)
    return linkEventOrganization(EVENT, org).then(() => {
      assert.deepEqual(mock.orgLinkUpserts, [], 'locked event must take no org link write')
    })
  })

  it('accepts the singular `organization` key too', () => {
    const mock = makeMock({ overrides: { organization: { at: 'x' } } })
    const org = nextOrg()
    __setClientForTests(mock.client)
    return linkEventOrganization(EVENT, org).then(() => {
      assert.deepEqual(mock.orgLinkUpserts, [])
    })
  })

  it('links normally when the event carries no org lock', () => {
    // The lock must be inert by default — ~5,000 nightly links depend on it.
    const mock = makeMock({ overrides: {}, orgName: 'League of Women Voters of the Akron Area' })
    const org = nextOrg()
    __setClientForTests(mock.client)
    return linkEventOrganization(EVENT, org).then(() => {
      assert.deepEqual(mock.orgLinkUpserts, [{ event_id: EVENT, organization_id: org }])
    })
  })

  it('links normally when manual_overrides is null', () => {
    const mock = makeMock({ overrides: null, orgName: 'League of Women Voters of the Akron Area' })
    const org = nextOrg()
    __setClientForTests(mock.client)
    return linkEventOrganization(EVENT, org).then(() => {
      assert.equal(mock.orgLinkUpserts.length, 1)
    })
  })

  it('an UNRELATED override key does not lock attribution', () => {
    // A `start_at` or `title` pin must not quietly freeze org links as well —
    // that would strand every time-corrected event without a presenter.
    const mock = makeMock({ overrides: { start_at: { at: 'x' }, title: { at: 'x' } },
                            orgName: 'League of Women Voters of the Akron Area' })
    const org = nextOrg()
    __setClientForTests(mock.client)
    return linkEventOrganization(EVENT, org).then(() => {
      assert.equal(mock.orgLinkUpserts.length, 1)
    })
  })

  it('reads manual_overrides at most once per event per run (cache)', () => {
    // Nightly cost guard: a per-link read would add one query per row.
    const mock = makeMock({ overrides: { organizations: { at: 'x' } } })
    const org = nextOrg()
    __setClientForTests(mock.client)
    return linkEventOrganization(EVENT, org)
      .then(() => linkEventOrganization(EVENT, org))
      .then(() => { assert.equal(mock.reads.length, 1) })
  })

  it('still blocks an aggregator self-credit on an unlocked event', () => {
    // The lock is additive — it must not displace the existing guard.
    const mock = makeMock({ overrides: {}, orgName: 'Downtown Akron Partnership' })
    const org = nextOrg()
    __setClientForTests(mock.client)
    return linkEventOrganization(EVENT, org, { source: 'downtown_akron' }).then(() => {
      assert.deepEqual(mock.orgLinkUpserts, [])
    })
  })
})
