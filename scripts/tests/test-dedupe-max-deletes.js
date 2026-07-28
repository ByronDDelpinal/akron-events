/**
 * test-dedupe-max-deletes.js — exercises the REAL dedupe-cross-source.js
 * module (not an inlined copy), focused on the delete-count safety cap that
 * stops an unattended `--apply` run (run-all.js, the nightly Actions
 * workflow) from deleting an unexpectedly large number of rows if a matching
 * bug ever over-groups events.
 *
 * Two halves:
 *
 *   1. `resolveMaxDeletesCap` — where the number comes from. An explicit
 *      `--max-deletes=<n>` flag wins over the `DEDUPE_MAX_DELETES` env var,
 *      which wins over the default of max(50, 2% of the events loaded).
 *
 *   2. `groupConfidenceTier` / `buildGroupPlan` / `selectPlansWithinCap` /
 *      `flattenPlans` — what the cap DOES. It used to be all-or-nothing: a
 *      plan over the cap deleted nothing and exited 1, so with a cap of 40
 *      and a 231-delete backlog the nightly dedupe did zero work every night
 *      forever. It now drains the highest-confidence groups up to the cap and
 *      defers the rest. These tests pin the properties that make a partial
 *      drain safe: never over the cap, never a split group, and a deferred
 *      group contributes NO alias, NO field merge and NO link donation.
 *
 *   3. `capRunOutcome` + a real end-to-end run of `main()` — a partial drain
 *      is green, but the state it CONVERGES on is not: once the tier-0/1
 *      backlog is gone, a capped run selects zero groups and would otherwise
 *      report success while doing nothing, forever. That case exits 1.
 *
 *   4. Source-order assertions that the cap invariant is checked before the
 *      run's first write (see the last describe for why that's a static test).
 *
 * Run:  node --test scripts/tests/test-dedupe-max-deletes.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// The module constructs a Supabase client at import time — give it dummy creds.
process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  resolveMaxDeletesCap, groupConfidenceTier, buildGroupPlan,
  selectPlansWithinCap, flattenPlans, buildAliasRow, capRunOutcome,
} = await import('../dedupe-cross-source.js')

describe('resolveMaxDeletesCap — default (no explicit override)', () => {
  it('is max(50, 2% of unique events) for a large event set', () => {
    // 2% of 10,000 = 200, which beats the 50 floor.
    assert.equal(
      resolveMaxDeletesCap({ argValue: undefined, envValue: undefined, uniqueLength: 10000 }),
      200,
    )
  })
  it('floors at 50 for a small event set', () => {
    // 2% of 500 = 10, below the 50 floor.
    assert.equal(
      resolveMaxDeletesCap({ argValue: undefined, envValue: undefined, uniqueLength: 500 }),
      50,
    )
  })
  it('rounds up (ceil) so a fractional 2% never under-caps', () => {
    // 2% of 501 = 10.02 -> ceil 11, still below the 50 floor.
    assert.equal(
      resolveMaxDeletesCap({ argValue: undefined, envValue: undefined, uniqueLength: 501 }),
      50,
    )
    // 2% of 5001 = 100.02 -> ceil 101
    assert.equal(
      resolveMaxDeletesCap({ argValue: undefined, envValue: undefined, uniqueLength: 5001 }),
      101,
    )
  })
})

describe('resolveMaxDeletesCap — explicit overrides', () => {
  it('--max-deletes=<n> (argValue) wins over the default', () => {
    assert.equal(
      resolveMaxDeletesCap({ argValue: '5', envValue: undefined, uniqueLength: 10000 }),
      5,
    )
  })
  it('DEDUPE_MAX_DELETES (envValue) wins over the default when no arg is given', () => {
    assert.equal(
      resolveMaxDeletesCap({ argValue: undefined, envValue: '25', uniqueLength: 10000 }),
      25,
    )
  })
  it('argValue wins over envValue when both are present', () => {
    assert.equal(
      resolveMaxDeletesCap({ argValue: '5', envValue: '25', uniqueLength: 10000 }),
      5,
    )
  })
  it('a cap of 0 is honored (not treated as falsy/absent)', () => {
    assert.equal(
      resolveMaxDeletesCap({ argValue: '0', envValue: undefined, uniqueLength: 10000 }),
      0,
    )
  })
  it('falls back to the default on a non-numeric or negative override', () => {
    assert.equal(
      resolveMaxDeletesCap({ argValue: 'not-a-number', envValue: undefined, uniqueLength: 10000 }),
      200,
    )
    assert.equal(
      resolveMaxDeletesCap({ argValue: '-5', envValue: undefined, uniqueLength: 10000 }),
      200,
    )
  })
})

// ── Partial drain: confidence tiers + capped selection ───────────────────────

/** A realistic event row. `venue: null` makes it venue-less (Pass 4 shape). */
function ev(over = {}) {
  const { venue, ...rest } = over
  const links = venue === null
    ? []
    : [{ venue_id: venue?.venue_id ?? 'v-northfield',
         venues: venue?.venues ?? { name: 'Center Stage', address: '10705 Northfield Rd' } }]
  return {
    id: 'e-1',
    title: 'Foghat',
    description: null,
    image_url: null,
    start_at: '2026-08-01T23:00:00+00:00',
    end_at:   '2026-08-02T01:00:00+00:00',
    source: 'northfield_park',
    source_id: 'np-1',
    manual_overrides: null,
    event_venues: links,
    event_organizations: [],
    ...rest,
  }
}

describe('groupConfidenceTier', () => {
  it('tier 0 — the northfield_park/ticketmaster shape (same title + second + venue, 2 sources)', () => {
    const group = [
      ev({ id: 'a', source: 'northfield_park', source_id: 'np-1' }),
      ev({ id: 'b', source: 'ticketmaster',    source_id: 'tm-1' }),
    ]
    assert.equal(groupConfidenceTier(group), 0)
  })

  it('tier 0 survives a sub-second fraction and a different venue ROW at the same address', () => {
    const group = [
      ev({ id: 'a', source: 'northfield_park', start_at: '2026-08-01T23:00:00.000Z' }),
      ev({ id: 'b', source: 'ticketmaster',    start_at: '2026-08-01T23:00:00.219Z',
           venue: { venue_id: 'v-other', venues: { name: 'MGM Northfield', address: '10705 Northfield Road' } } }),
    ]
    assert.equal(groupConfidenceTier(group), 0)
  })

  it('tier 1 — same venue + second + 2 sources, but the titles only match flexibly', () => {
    const group = [
      ev({ id: 'a', source: 'akron_civic',  title: 'HARDY: THE COUNTRY! COUNTRY! TOUR!' }),
      ev({ id: 'b', source: 'ticketmaster', title: 'Hardy' }),
    ]
    assert.equal(groupConfidenceTier(group), 1)
  })

  it('tier 2 — same venue, times inside the 2h fuzzy window (doors vs. showtime)', () => {
    const group = [
      ev({ id: 'a', source: 'jillys_music_room', start_at: '2026-08-01T15:00:00+00:00' }),
      ev({ id: 'b', source: 'akron_life',        start_at: '2026-08-01T16:30:00+00:00' }),
    ]
    assert.equal(groupConfidenceTier(group), 2)
  })

  it('tier 2 (never 0/1) for a SAME-source pair — a cross-source script must not spend budget on it', () => {
    const group = [
      ev({ id: 'a', source: 'akron_library', source_id: 'al-1', title: 'Story Time' }),
      ev({ id: 'b', source: 'akron_library', source_id: 'al-2', title: 'Story Time' }),
    ]
    assert.equal(groupConfidenceTier(group), 2)
  })

  it('tier 3 — a venue-less Pass 4 pair', () => {
    const group = [
      ev({ id: 'a', source: 'downtown_akron', venue: null }),
      ev({ id: 'b', source: 'ticketmaster' }),
    ]
    assert.equal(groupConfidenceTier(group), 3)
  })

  it('tier 3 — a day-level Pass 3 match (same venue, hours apart)', () => {
    const group = [
      ev({ id: 'a', source: 'akron_civic', start_at: '2026-08-01T23:00:00+00:00' }),
      ev({ id: 'b', source: 'akron_life',  start_at: '2026-08-01T13:00:00+00:00', end_at: null }),
    ]
    assert.equal(groupConfidenceTier(group), 3)
  })
})

/** A tier-0 two-row group: first-party keeper + aggregator dupe. */
function tier0Group(n) {
  return [
    ev({ id: `keep-${n}`, source: 'northfield_park', source_id: `np-${n}`,
         image_url: 'https://img/x.jpg', description: 'A real description, well over twenty characters.',
         start_at: `2026-08-01T${String(n % 24).padStart(2, '0')}:00:00+00:00`,
         venue: { venue_id: `v-${n}` } }),
    ev({ id: `drop-${n}`, source: 'ticketmaster', source_id: `tm-${n}`,
         start_at: `2026-08-01T${String(n % 24).padStart(2, '0')}:00:00+00:00`,
         venue: { venue_id: `v-${n}` } }),
  ]
}

describe('selectPlansWithinCap — the 231-vs-40 backlog', () => {
  it('deletes exactly the cap and defers the rest instead of aborting', () => {
    const plans = Array.from({ length: 231 }, (_, i) => buildGroupPlan(tier0Group(i)))
    assert.equal(plans.reduce((n, p) => n + p.deleteIds.length, 0), 231)

    let res
    assert.doesNotThrow(() => { res = selectPlansWithinCap(plans, 40) })

    assert.equal(res.capped, true)
    assert.equal(res.plannedDeletes, 231)
    assert.equal(res.selectedDeletes, 40)
    assert.equal(res.deferredDeletes, 191)
    assert.equal(res.selected.length, 40)
    assert.equal(res.deferred.length, 191)

    const { deletes } = flattenPlans(res.selected)
    assert.equal(deletes.length, 40)
    assert.equal(new Set(deletes).size, 40)
  })

  it('skips a group that would overflow the budget instead of splitting it', () => {
    // Two big groups (3 deletes each) then singles: cap 4 takes one big + one single.
    const big = (n) => buildGroupPlan([
      ev({ id: `k${n}`, source: 'northfield_park', source_id: `np-${n}`, start_at: `2026-08-0${n}T20:00:00+00:00`, venue: { venue_id: `v-${n}` } }),
      ev({ id: `d${n}a`, source: 'ticketmaster', source_id: `tm-${n}a`, start_at: `2026-08-0${n}T20:00:00+00:00`, venue: { venue_id: `v-${n}` } }),
      ev({ id: `d${n}b`, source: 'akron_life',   source_id: `al-${n}b`, start_at: `2026-08-0${n}T20:00:00+00:00`, venue: { venue_id: `v-${n}` } }),
      ev({ id: `d${n}c`, source: 'downtown_akron', source_id: `da-${n}c`, start_at: `2026-08-0${n}T20:00:00+00:00`, venue: { venue_id: `v-${n}` } }),
    ])
    const plans = [big(1), big(2), buildGroupPlan(tier0Group(9))]
    const res = selectPlansWithinCap(plans, 4)
    assert.equal(res.selectedDeletes, 4)
    // The second 3-delete group did not fit and was NOT truncated.
    assert.equal(res.selected.length, 2)
    for (const p of res.selected) {
      const original = plans.find((q) => q === p)
      assert.ok(original, 'selected plans are the input objects, never rebuilt/split')
      assert.deepEqual(p.deleteIds, original.deleteIds)
    }
  })

  it('never selects a tier ≥ 2 group when capped', () => {
    const fuzzy = buildGroupPlan([
      ev({ id: 'f1', source: 'jillys_music_room', source_id: 'j-1', start_at: '2026-08-01T15:00:00+00:00', venue: { venue_id: 'v-j' } }),
      ev({ id: 'f2', source: 'akron_life',        source_id: 'a-1', start_at: '2026-08-01T16:30:00+00:00', venue: { venue_id: 'v-j' } }),
    ])
    assert.equal(fuzzy.tier, 2)
    const plans = [fuzzy, ...Array.from({ length: 5 }, (_, i) => buildGroupPlan(tier0Group(i)))]
    const res = selectPlansWithinCap(plans, 3)
    assert.ok(res.selected.every((p) => p.tier <= 1))
    assert.ok(res.deferred.includes(fuzzy))
  })

  it('is deterministic — same input, same selection', () => {
    const plans = Array.from({ length: 60 }, (_, i) => buildGroupPlan(tier0Group(i)))
    const a = selectPlansWithinCap(plans, 17).selected.map((p) => p.canonical.id)
    const b = selectPlansWithinCap(plans, 17).selected.map((p) => p.canonical.id)
    assert.deepEqual(a, b)
  })

  it('a cap of 0 selects nothing rather than throwing', () => {
    const plans = Array.from({ length: 3 }, (_, i) => buildGroupPlan(tier0Group(i)))
    const res = selectPlansWithinCap(plans, 0)
    assert.equal(res.selectedDeletes, 0)
    assert.equal(flattenPlans(res.selected).deletes.length, 0)
  })
})

describe('selectPlansWithinCap — under the cap is byte-for-byte today’s behavior', () => {
  it('returns the input array itself: no reordering, no drops, nothing deferred', () => {
    const plans = Array.from({ length: 12 }, (_, i) => buildGroupPlan(tier0Group(i)))
    const res = selectPlansWithinCap(plans, 40)
    assert.equal(res.selected, plans)          // same reference — literally unchanged
    assert.deepEqual(res.deferred, [])
    assert.equal(res.capped, false)
    assert.equal(res.selectedDeletes, 12)
    assert.equal(res.deferredDeletes, 0)
  })

  it('exactly at the cap is still uncapped (<=, not <)', () => {
    const plans = Array.from({ length: 40 }, (_, i) => buildGroupPlan(tier0Group(i)))
    const res = selectPlansWithinCap(plans, 40)
    assert.equal(res.capped, false)
    assert.equal(res.selected, plans)
  })
})

describe('selectPlansWithinCap — properties over random plans', () => {
  // Deterministic PRNG so a failure is reproducible.
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('selected total ≤ cap and no group is ever partially selected', () => {
    for (let seed = 0; seed < 300; seed++) {
      const rand = mulberry32(seed)
      const planCount = Math.floor(rand() * 40)
      const plans = Array.from({ length: planCount }, (_, i) => ({
        canonical: { id: `c-${i}`, start_at: `2026-08-${String(1 + (i % 28)).padStart(2, '0')}T20:00:00+00:00` },
        tier: Math.floor(rand() * 4),
        deleteIds: Array.from({ length: Math.floor(rand() * 5) }, (_, j) => `d-${i}-${j}`),
        deletedRows: [],
        aliasRows: [],
        mergeFields: {},
        donatedVenueIds: [],
        donatedOrgIds: [],
        preservedCount: 0,
      }))
      const planned = plans.reduce((n, p) => n + p.deleteIds.length, 0)
      const cap = Math.floor(rand() * 30)
      const res = selectPlansWithinCap(plans, cap)

      const selectedIds = res.selected.flatMap((p) => p.deleteIds)
      assert.ok(selectedIds.length <= cap || planned <= cap,
        `seed ${seed}: selected ${selectedIds.length} > cap ${cap}`)
      if (planned > cap) {
        assert.ok(selectedIds.length <= cap, `seed ${seed}: over cap`)
        assert.ok(res.selected.every((p) => p.tier <= 1), `seed ${seed}: low-confidence group selected`)
      }

      // No group half-in: every selected plan is an INPUT object whose whole
      // deleteIds list made it through.
      for (const p of res.selected) {
        assert.ok(plans.includes(p), `seed ${seed}: selection invented a plan`)
        for (const id of p.deleteIds) assert.ok(selectedIds.includes(id))
      }
      // Partition: selected ∪ deferred == plans, disjoint, nothing lost.
      assert.equal(res.selected.length + res.deferred.length, plans.length, `seed ${seed}: partition`)
      for (const p of res.deferred) {
        assert.ok(!res.selected.includes(p), `seed ${seed}: plan both selected and deferred`)
        for (const id of p.deleteIds) assert.ok(!selectedIds.includes(id), `seed ${seed}: deferred delete leaked`)
      }
      assert.equal(res.selectedDeletes, selectedIds.length, `seed ${seed}: selectedDeletes`)
      assert.equal(res.selectedDeletes + res.deferredDeletes, res.plannedDeletes, `seed ${seed}: accounting`)
    }
  })
})

describe('deferred groups contribute nothing; selected groups keep their aliases', () => {
  it('every selected plan’s aliasRows are exactly buildAliasRow output', () => {
    const plans = Array.from({ length: 50 }, (_, i) => buildGroupPlan(tier0Group(i)))
    const res = selectPlansWithinCap(plans, 10)
    assert.equal(res.capped, true)
    const { aliasRows, deletes } = flattenPlans(res.selected)
    assert.equal(aliasRows.length, deletes.length)   // every delete carries an alias
    for (const p of res.selected) {
      assert.deepEqual(
        p.aliasRows,
        p.deletedRows.map((d) => buildAliasRow(p.canonical.id, d, p.tier, p.canonical.source)),
      )
      // Provenance-tagged (2026-07-28 incident follow-up): tier + same/cross-source,
      // so the dropped-alias set for a bad run can be found with a query, not stdout.
      for (const a of p.aliasRows) assert.match(a.reason, /^dedupe-cross-source:tier\d+:(same-source|cross-source)$/)
    }
  })

  it('a deferred group contributes zero aliases, zero merges and zero link donations', () => {
    // Selected: a plain tier-0 pair whose canonical is missing an image, so it
    // has a real field merge. Deferred: a tier-3 venue-less pair whose
    // canonical would otherwise borrow the dupe's venue link.
    const selectedGroup = [
      ev({ id: 'sel-keep', source: 'northfield_park', source_id: 'np-s', description: 'A real description, well over twenty characters.', venue: { venue_id: 'v-s' } }),
      ev({ id: 'sel-drop', source: 'ticketmaster',    source_id: 'tm-s', image_url: 'https://img/tm.jpg', venue: { venue_id: 'v-s' } }),
    ]
    // ohio_festivals row has no venue; the CVB copy sits at the 09:00 ET
    // placeholder, so it loses canonical and would donate its venue link.
    const deferredGroup = [
      ev({ id: 'def-keep', source: 'ohio_festivals',  source_id: 'of-d', title: 'Twins Days Festival', venue: null, start_at: '2026-08-01T16:00:00+00:00' }),
      ev({ id: 'def-drop', source: 'visit_akron_cvb', source_id: 'cvb-d', title: 'Twins Days Festival', start_at: '2026-08-01T13:00:00+00:00', end_at: null,
           image_url: 'https://img/cvb.jpg',
           event_organizations: [{ organization_id: 'org-1', organizations: { name: 'Twins Days Inc.' } }] }),
    ]
    const selPlan = buildGroupPlan(selectedGroup)
    const defPlan = buildGroupPlan(deferredGroup)
    assert.equal(selPlan.tier, 0)
    assert.equal(defPlan.tier, 3)
    assert.equal(defPlan.canonical.id, 'def-keep')
    assert.deepEqual(defPlan.donatedVenueIds, ['v-northfield'])   // it WOULD donate if selected
    assert.ok(defPlan.aliasRows.length > 0)

    const res = selectPlansWithinCap([selPlan, defPlan], 1)
    assert.equal(res.capped, true)
    assert.deepEqual(res.selected, [selPlan])
    assert.deepEqual(res.deferred, [defPlan])

    const flat = flattenPlans(res.selected)
    assert.deepEqual(flat.deletes, ['sel-drop'])
    assert.equal(flat.aliasRows.length, 1)
    assert.equal(flat.aliasRows[0].duplicate_source, 'ticketmaster')
    // The deferred canonical appears in NO merge and NO link donation.
    assert.ok(!flat.merges.some((m) => m.id === 'def-keep'))
    assert.ok(!flat.linkMerges.some((m) => m.id === 'def-keep'))
    assert.ok(!flat.deletes.includes('def-drop'))
    assert.ok(!flat.aliasRows.some((a) => a.duplicate_source === 'visit_akron_cvb'))
    // The selected group still gets its enrichment.
    assert.deepEqual(flat.merges, [{ id: 'sel-keep', fields: { image_url: 'https://img/tm.jpg' } }])
  })
})

describe('manual_overrides rows are preserved, selected or deferred', () => {
  const shieldedGroup = (n) => [
    ev({ id: `keep-${n}`, source: 'northfield_park', source_id: `np-${n}`,
         image_url: 'https://img/x.jpg', description: 'A real description, well over twenty characters.',
         venue: { venue_id: `v-${n}` } }),
    ev({ id: `shield-${n}`, source: 'ticketmaster', source_id: `tm-${n}`,
         manual_overrides: { title: 'hand-edited' }, venue: { venue_id: `v-${n}` } }),
    ev({ id: `drop-${n}`, source: 'akron_life', source_id: `al-${n}`,
         venue: { venue_id: `v-${n}` } }),
  ]

  it('a shielded dupe counts as preserved and never reaches deleteIds', () => {
    const plan = buildGroupPlan(shieldedGroup(1))
    assert.equal(plan.preservedCount, 1)
    assert.deepEqual(plan.deleteIds, ['drop-1'])
    assert.ok(!plan.deleteIds.includes('shield-1'))
    assert.ok(!plan.aliasRows.some((a) => a.duplicate_source_id === 'tm-1'))
    assert.ok(!plan.deletedRows.some((r) => r.id === 'shield-1'))
  })

  it('stays out of the delete list whether its group is selected or deferred', () => {
    const plans = Array.from({ length: 6 }, (_, i) => buildGroupPlan(shieldedGroup(i)))
    for (const cap of [0, 1, 3, 6, 100]) {
      const res = selectPlansWithinCap(plans, cap)
      const { deletes, deletedRows } = flattenPlans(res.selected)
      assert.ok(deletes.every((id) => !id.startsWith('shield-')), `cap ${cap}`)
      assert.equal(deletedRows.filter((r) => r.manual_overrides && Object.keys(r.manual_overrides).length).length, 0)
      assert.ok(deletes.length <= cap, `cap ${cap}: over cap`)
    }
  })
})

// ── Blocker 1: the terminal state a partial drain converges on ───────────────
//
// The partial drain fixed "over the cap ⇒ delete nothing, exit 1". It created a
// new way to do nothing: at cap 40, tonight's 133 tier-0/1 deletes drain in ~4
// nights, and from night 5 on the plan is 98 tier-2/3 deletes with ZERO
// eligible groups. selectPlansWithinCap returns selected = [] and capped =
// true — 0 deletes, exit 0, every night, forever, reported green. These pin
// that "capped AND drained nothing" is a failure while "capped AND drained
// something" stays a success.

describe('capRunOutcome', () => {
  it('an uncapped run is not a cap state at all', () => {
    assert.equal(capRunOutcome({ capped: false, selectedDeletes: 12 }), 'uncapped')
    assert.equal(capRunOutcome({ capped: false, selectedDeletes: 0 }), 'uncapped')
  })

  it('capped with ≥ 1 delete selected is a healthy partial drain (stays green)', () => {
    assert.equal(capRunOutcome({ capped: true, selectedDeletes: 40 }), 'partial-drain')
    assert.equal(capRunOutcome({ capped: true, selectedDeletes: 1 }), 'partial-drain')
  })

  it('capped with ZERO deletes selected is stalled (must go red)', () => {
    assert.equal(capRunOutcome({ capped: true, selectedDeletes: 0 }), 'stalled')
  })
})

describe('capRunOutcome — tonight’s numbers, night 1 vs. night 5', () => {
  /** A tier-2 pair: same venue, doors-vs-showtime inside the fuzzy window. */
  const fuzzyGroup = (n) => [
    ev({ id: `fk-${n}`, source: 'jillys_music_room', source_id: `j-${n}`,
         start_at: '2026-09-01T15:00:00+00:00', venue: { venue_id: `fv-${n}` } }),
    ev({ id: `fd-${n}`, source: 'akron_life', source_id: `al-${n}`,
         start_at: '2026-09-01T16:30:00+00:00', venue: { venue_id: `fv-${n}` } }),
  ]

  it('night 1 — 133 tier-0/1 + 98 tier-2/3 at cap 40 drains 40 and stays green', () => {
    const plans = [
      ...Array.from({ length: 133 }, (_, i) => buildGroupPlan(tier0Group(i))),
      ...Array.from({ length: 98 }, (_, i) => buildGroupPlan(fuzzyGroup(i))),
    ]
    const res = selectPlansWithinCap(plans, 40)
    assert.equal(res.plannedDeletes, 231)
    assert.equal(res.selectedDeletes, 40)
    assert.equal(capRunOutcome(res), 'partial-drain')
  })

  it('night 5 — the tier-0/1 backlog is gone, 98 tier-2/3 remain: stalled, not green', () => {
    const plans = Array.from({ length: 98 }, (_, i) => buildGroupPlan(fuzzyGroup(i)))
    assert.ok(plans.every((p) => p.tier >= 2))
    const res = selectPlansWithinCap(plans, 40)
    assert.equal(res.capped, true)
    assert.equal(res.selectedDeletes, 0)
    assert.equal(flattenPlans(res.selected).deletes.length, 0)
    assert.equal(capRunOutcome(res), 'stalled')
  })

  it('one eligible group bigger than the whole cap is also stalled — it can never fit', () => {
    const wide = buildGroupPlan([
      ev({ id: 'wk', source: 'northfield_park', source_id: 'np-w', venue: { venue_id: 'v-w' } }),
      ev({ id: 'wd1', source: 'ticketmaster',   source_id: 'tm-w', venue: { venue_id: 'v-w' } }),
      ev({ id: 'wd2', source: 'akron_life',     source_id: 'al-w', venue: { venue_id: 'v-w' } }),
      ev({ id: 'wd3', source: 'downtown_akron', source_id: 'da-w', venue: { venue_id: 'v-w' } }),
    ])
    assert.equal(wide.tier, 0)
    assert.equal(wide.deleteIds.length, 3)
    const res = selectPlansWithinCap([wide], 2)   // never splits a group
    assert.equal(res.selectedDeletes, 0)
    assert.equal(capRunOutcome(res), 'stalled')
  })

  it('--max-deletes=0 with work planned is stalled — a run that drains nothing is never green', () => {
    // Deliberate choice, not an accident: exit code answers "did the backlog
    // shrink?", and a cap of 0 with a non-empty plan means it never will.
    const plans = Array.from({ length: 3 }, (_, i) => buildGroupPlan(tier0Group(i)))
    assert.equal(capRunOutcome(selectPlansWithinCap(plans, 0)), 'stalled')
  })

  it('an empty plan is uncapped, not stalled — nothing to do is a clean night', () => {
    assert.equal(capRunOutcome(selectPlansWithinCap([], 40)), 'uncapped')
  })
})

// ── Blocker 1, end to end: the REAL main(), the REAL exit code ───────────────
//
// capRunOutcome is pure, but the thing that actually reddens the nightly is
// main()'s exit code, and only a real run proves it is wired up. main() is not
// exported (and calls process.exit), so run it as a subprocess: inject a fake
// client through supabase-admin's `__setClientForTests` seam, spoof
// process.argv[1] so the module's entry guard fires, and let the real query →
// group → plan → cap → exit path run offline.
//
// The fake client makes every mutating verb ABORT the process, so these tests
// also prove a dry run writes nothing. `--apply` is refused outright.

const SCRIPTS_URL = new URL('../', import.meta.url).href

const HARNESS = `
const ROOT = process.env.HARNESS_ROOT
if (JSON.parse(process.env.HARNESS_ARGS).includes('--apply')) {
  console.error('HARNESS_REFUSES_APPLY'); process.exit(9)
}
const { fileURLToPath } = await import('node:url')
const { __setClientForTests } = await import(ROOT + 'lib/supabase-admin.js')
const rows = JSON.parse(process.env.HARNESS_ROWS)
let page = 0
const boom = (op) => { console.error('HARNESS_MUTATION_ATTEMPTED:' + op); process.exit(9) }
__setClientForTests({
  from() {
    const q = {
      select: () => q, order: () => q, eq: () => q, in: () => q,
      range: () => Promise.resolve({ data: page++ === 0 ? rows : [], error: null }),
      update: () => boom('update'), insert: () => boom('insert'),
      upsert: () => boom('upsert'), delete: () => boom('delete'),
      then: (resolve) => resolve({ data: [], error: null, count: 0 }),
    }
    return q
  },
})
// A PATH, not a URL: the module's entry guard runs pathToFileURL() on it.
process.argv[1] = fileURLToPath(ROOT + 'dedupe-cross-source.js')
process.argv.push(...JSON.parse(process.env.HARNESS_ARGS))
await import(ROOT + 'dedupe-cross-source.js')
`

/** Run the real dedupe main() offline against `rows`. Never passes --apply. */
function runDedupe(rows, args) {
  assert.ok(!args.includes('--apply'), 'these tests must never run --apply')
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', HARNESS], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HARNESS_ROOT: SCRIPTS_URL,
      HARNESS_ROWS: JSON.stringify(rows),
      HARNESS_ARGS: JSON.stringify(args),
    },
  })
  const out = `${r.stdout}${r.stderr}`
  // Proof main() actually ran: the entry guard is easy to miss-spoof, and a
  // silent no-run would make every exit-code assertion below vacuously pass.
  assert.match(out, /Loaded \d+ unique events/, `main() never ran:\n${out}`)
  return { status: r.status, out }
}

/** Rows shaped exactly like the script's own `.select()` (note: no end_at). */
function row(over = {}) {
  const full = ev(over)
  delete full.end_at
  return full
}
const venue    = (n) => ({ venue_id: `v-${n}`,  venues: { name: `Venue ${n}`, address: `${100 + n} Main St` } })
const fzVenue  = (n) => ({ venue_id: `fv-${n}`, venues: { name: `Fuzzy Venue ${n}`, address: `${900 + n} Market St` } })
/** tier 0: first-party + Ticketmaster, same venue, same second, same title. */
const liveRows = (n) => [
  row({ id: `keep-${n}`, source: 'northfield_park', source_id: `np-${n}`, title: `Foghat Reunion Concert ${n}`,
        image_url: 'https://img/x.jpg', description: 'A real description, well over twenty characters.',
        start_at: '2026-08-01T20:00:00+00:00', venue: venue(n) }),
  row({ id: `drop-${n}`, source: 'ticketmaster', source_id: `tm-${n}`, title: `Foghat Reunion Concert ${n}`,
        start_at: '2026-08-01T20:00:00+00:00', venue: venue(n) }),
]
/** tier 2: doors-vs-showtime pair, never eligible under a cap. */
const fuzzyRows = (n) => [
  row({ id: `fk-${n}`, source: 'jillys_music_room', source_id: `j-${n}`, title: `Moonlight Jazz Quartet ${n}`,
        start_at: '2026-09-01T15:00:00+00:00', venue: fzVenue(n) }),
  row({ id: `fd-${n}`, source: 'akron_life', source_id: `al-${n}`, title: `Moonlight Jazz Quartet ${n}`,
        start_at: '2026-09-01T16:30:00+00:00', venue: fzVenue(n) }),
]

describe('main() exit code — real module, real path, dry run only', () => {
  it('a capped run that drains ZERO groups exits 1 and says STALLED', () => {
    const rows = [...fuzzyRows(1), ...fuzzyRows(2), ...fuzzyRows(3)]
    const { status, out } = runDedupe(rows, ['--max-deletes=1'])
    assert.equal(status, 1, out)
    assert.match(out, /DEDUPE STALLED/)
    assert.match(out, /deleted 0 of 3 planned \(cap 1\)/)
    assert.match(out, /Summary: 0 to delete/)
    assert.ok(!out.includes('PARTIAL DRAIN'), 'a stall must not be dressed up as a partial drain')
    assert.ok(!out.includes('HARNESS_MUTATION_ATTEMPTED'), out)
  })

  it('a capped run that drains ≥ 1 group exits 0 and says PARTIAL DRAIN', () => {
    const rows = [...liveRows(1), ...liveRows(2), ...fuzzyRows(1)]
    const { status, out } = runDedupe(rows, ['--max-deletes=1'])
    assert.equal(status, 0, out)
    assert.match(out, /PARTIAL DRAIN \(healthy\): deleting 1 of 3 planned \(cap 1\)/)
    assert.ok(!out.includes('DEDUPE STALLED'))
    assert.ok(!out.includes('HARNESS_MUTATION_ATTEMPTED'), out)
  })

  it('an uncapped run exits 0 with no cap banner at all', () => {
    const rows = [...liveRows(1), ...liveRows(2)]
    const { status, out } = runDedupe(rows, ['--max-deletes=40'])
    assert.equal(status, 0, out)
    assert.match(out, /Summary: 2 to delete/)
    assert.ok(!out.includes('DEDUPE STALLED'))
    assert.ok(!out.includes('PARTIAL DRAIN'))
  })

  it('a run with nothing to dedupe at all exits 0 (empty ≠ stalled)', () => {
    const { status, out } = runDedupe([row({ id: 'lonely' })], ['--max-deletes=40'])
    assert.equal(status, 0, out)
    assert.match(out, /Found 0 duplicate group/)
    assert.ok(!out.includes('DEDUPE STALLED'))
  })

  it('the dry run performs no writes — the fake client aborts on any mutation', () => {
    const rows = [...liveRows(1), ...liveRows(2), ...fuzzyRows(1)]
    for (const args of [['--max-deletes=1'], ['--max-deletes=40']]) {
      const { out } = runDedupe(rows, args)
      assert.ok(!out.includes('HARNESS_MUTATION_ATTEMPTED'), `${args}: ${out}`)
    }
  })
})

// ── MAJOR: hasSiblingSessionRisk's wiring in main() must be pinned ───────────
//
// The unit tests in test-dedupe-grouping.js (Change 2 describe block) do the
// `.filter((p) => !p.siblingSessionRisk)` partition INSIDE the test body —
// they prove the helper and the field are correct, but not that main() ever
// calls the filter before selectPlansWithinCap. Deleting main()'s partition
// (dedupe-cross-source.js's `siblingRiskPlans`/`eligiblePlans` split) and
// reverting its `selectPlansWithinCap(eligiblePlans, ...)` call back to
// `selectPlansWithinCap(plans, ...)` would leave every one of those unit
// tests green. Only a real end-to-end run of main() can catch that class of
// regression, so this exercises the exact anchored 3-member shape from
// Blocker 1 (third-source anchor absorbing two same-source siblings at
// different times — the_grove/akron_life Chair Yoga shape, reachable via
// Pass 2's fuzzy-window match since Pass 2 only gates each candidate against
// the anchor, never against its cluster-mates) through the real subprocess
// harness, at a cap generous enough that selectPlansWithinCap's own
// (unrelated) tier filter never gets a chance to run either.
describe('main() — Blocker 1 wiring: the anchored sibling-session shape must never reach DROP', () => {
  it('third-source anchor + two same-source siblings at different times: held for NEEDS HUMAN REVIEW, not deleted, at a cap that fits the whole plan', () => {
    const siblingVenue = { venue_id: 'v-grove', venues: { name: 'The Grove', address: '123 Grove Ave' } }
    const rows = [
      row({ id: 'anchor', source: 'the_grove', source_id: 'tg-1', title: 'Chair Yoga Class',
            start_at: '2026-08-03T15:00:00+00:00', venue: siblingVenue }),   // 11:00 ET
      row({ id: 'sib-early', source: 'akron_life', source_id: 'al-1', title: 'Chair Yoga Class',
            start_at: '2026-08-03T15:15:00+00:00', venue: siblingVenue }),  // 11:15 ET — real, distinct class
      row({ id: 'sib-late', source: 'akron_life', source_id: 'al-2', title: 'Chair Yoga Class',
            start_at: '2026-08-03T16:30:00+00:00', venue: siblingVenue }),  // 12:30 ET — real, distinct class
    ]
    const { status, out } = runDedupe(rows, ['--max-deletes=40'])
    assert.equal(status, 0, out)
    assert.match(out, /Summary: 0 to delete/, out)
    assert.match(out, /NEEDS HUMAN REVIEW/, out)
    assert.ok(!out.includes('DROP'), `no row of this group may be dropped:\n${out}`)
    assert.ok(!out.includes('HARNESS_MUTATION_ATTEMPTED'), out)
  })
})

// ── Blocker 2: the cap invariant must precede every mutation ─────────────────
//
// The check used to sit with the other runtime invariants, AFTER the audit
// write, the field merges, the link donations and the alias upsert. A breach
// there aborts only the deletes and leaves canonicals enriched and holding
// links donated by dupes that then survive — which re-buckets both rows on the
// next run.
//
// This is a source-ORDER test, not a behavioural one, and deliberately so: a
// breach is unreachable from outside (selectPlansWithinCap is correct — the
// 300-seed property test above pins `selected ≤ cap`), so no input can trip
// the assert to observe what did or didn't get written. What CAN regress is
// someone moving the check back down among its siblings, and that is exactly
// what these assertions catch.

describe('the cap invariant fires before any mutation', () => {
  const SOURCE = readFileSync(new URL('../dedupe-cross-source.js', import.meta.url), 'utf8')
  const MAIN = SOURCE.slice(SOURCE.indexOf('async function main()'))
  const at = (marker) => {
    const i = MAIN.indexOf(marker)
    assert.notEqual(i, -1, `marker vanished from main(): ${marker}`)
    return i
  }

  const CAP_CHECK = 'deletes.length > maxDeletes'
  // Every write main() performs, in the order it performs them.
  const MUTATIONS = [
    ['audit artifact write',   'writeFileSync(deletionsPath'],
    ['canonical field merge',  ".from('events').update(fields)"],
    ['venue-link donation',    ".from('event_venues')"],
    ['org-link donation',      ".from('event_organizations')"],
    ['alias upsert',           'recordAliases(aliasRows)'],
    ['delete loop',            ".delete({ count: 'exact' })"],
  ]

  it('is checked exactly once, immediately after flattenPlans', () => {
    assert.equal(SOURCE.split(CAP_CHECK).length - 1, 1, 'expected a single cap check')
    assert.ok(at(CAP_CHECK) > at('flattenPlans(selected)'))
  })

  it('precedes every write main() performs', () => {
    const cap = at(CAP_CHECK)
    for (const [label, marker] of MUTATIONS) {
      assert.ok(cap < at(marker), `cap check must precede the ${label}`)
    }
  })

  it('precedes the dry-run early return, so a dry run is gated by it too', () => {
    assert.ok(at(CAP_CHECK) < at('if (!APPLY)'))
  })

  it('the stall exit is also decided before the dry-run return and before any write', () => {
    const stall = at('capRunOutcome(')
    assert.ok(stall < at('if (!APPLY)'))
    for (const [label, marker] of MUTATIONS) {
      assert.ok(stall < at(marker), `stall check must precede the ${label}`)
    }
  })

  it('the other runtime invariants still sit immediately before the delete loop', () => {
    // Unchanged by this fix — they depend on the audit rows and alias rows the
    // apply phase produces, so they can't move earlier.
    assert.ok(at('deletes.length !== deletedRows.length') < at(".delete({ count: 'exact' })"))
    assert.ok(at('deletedRows.filter(hasManualOverrides)') < at(".delete({ count: 'exact' })"))
    assert.ok(at('aliasRows.length < deletes.length') < at(".delete({ count: 'exact' })"))
  })
})
