/**
 * test-check-festivals.js - offline tests for the pure invariant logic in
 * scripts/check-festivals.js (evaluateFestivalInvariants). No DB, no clock:
 * rows, registry, and "today" are all injected fixtures, including the
 * 2026-08-10 Pride 5K header-hijack scenario (two umbrella-tagged rows, the
 * earlier one not on the registry dateKey).
 *
 * Run:  node --test scripts/tests/test-check-festivals.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { evaluateFestivalInvariants, UMBRELLA_TAG } from '../check-festivals.js'

const PORCHROKR = {
  slug: 'porchrokr-2026',
  name: 'PorchRokr Music & Arts Festival',
  dateKey: '2026-08-15',
  tag: 'porchrokr-2026',
  mapBounds: [-81.56, 41.08, -81.51, 41.11],
  landmarks: [],
}

const PRIDE = {
  slug: 'akron-pride-2026',
  name: 'Akron Pride Festival',
  dateKey: '2026-08-22',
  tag: 'akron-pride-2026',
  mapBounds: [-81.532, 41.072, -81.51, 41.09],
  landmarks: [],
}

/** A healthy PorchRokr umbrella row; override what the case needs.
 *  2026-08-15T15:00:00Z is 11:00 EDT on the festival day. */
function umbrellaRow(overrides) {
  return {
    id: 'umb-1',
    title: 'PorchRokr Music & Arts Festival 2026',
    status: 'published',
    start_at: '2026-08-15T15:00:00+00:00',
    tags: ['porchrokr-2026', UMBRELLA_TAG],
    manual_overrides: { tags: { at: '2026-08-09T12:00:00Z', by: 'porchrokr-2026-import' } },
    ...overrides,
  }
}

/** A per-set row (non-umbrella) carrying the festival tag. */
function setRow(overrides) {
  return {
    id: 'set-1',
    title: 'Some Band - PorchRokr Porch 7',
    status: 'published',
    start_at: '2026-08-15T17:00:00+00:00',
    tags: ['porchrokr-2026', 'porch-7'],
    manual_overrides: {},
    ...overrides,
  }
}

/** Today far outside every banner window, so WARN e never fires unless a
 *  case opts in. */
const QUIET_TODAY = '2026-06-01'

describe('healthy state: one pinned umbrella on dateKey, sets present', () => {
  it('produces no findings', () => {
    const findings = evaluateFestivalInvariants(
      [umbrellaRow(), setRow()], [PORCHROKR], QUIET_TODAY,
    )
    assert.deepEqual(findings, [])
  })

  it('inside the banner window with sets present: still no findings', () => {
    const findings = evaluateFestivalInvariants(
      [umbrellaRow(), setRow()], [PORCHROKR], '2026-08-10',
    )
    assert.deepEqual(findings, [])
  })
})

describe('check a: exactly one umbrella per festival tag', () => {
  it('zero umbrellas is a FAIL (umbrella lost, e.g. scrape stripped tags)', () => {
    const findings = evaluateFestivalInvariants([setRow()], [PORCHROKR], QUIET_TODAY)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].level, 'FAIL')
    assert.equal(findings[0].check, 'one-umbrella')
    assert.equal(findings[0].festival, 'porchrokr-2026')
  })

  it('the 5K scenario: two umbrella rows, earlier one off dateKey, FAILs count AND date', () => {
    // The real festival umbrella, on the registry dateKey (2026-08-22).
    const festival = umbrellaRow({
      id: 'pride-umb',
      title: 'Akron Pride Festival and Equity March 2026',
      start_at: '2026-08-22T15:00:00+00:00',
      tags: ['akron-pride-2026', UMBRELLA_TAG],
      manual_overrides: { tags: { at: '2026-08-09T12:00:00Z', by: 'akron-pride-2026-import' } },
    })
    // The 5K: hand-tagged with both tags, starts the evening BEFORE
    // (2026-08-21 Eastern), so the hub's earliest-start pick renders 5K
    // copy and imagery as the festival header. Incident date: 2026-08-10.
    const fiveK = umbrellaRow({
      id: 'pride-5k',
      title: 'Pride 5K Rainbow Run',
      start_at: '2026-08-21T22:00:00+00:00',
      tags: ['akron-pride-2026', UMBRELLA_TAG],
      manual_overrides: { tags: { at: '2026-08-10T08:00:00Z', by: 'admin' } },
    })
    const findings = evaluateFestivalInvariants([festival, fiveK], [PRIDE], QUIET_TODAY)

    const count = findings.find((f) => f.check === 'one-umbrella')
    assert.ok(count, 'expected a one-umbrella finding')
    assert.equal(count.level, 'FAIL')
    assert.deepEqual(count.eventIds, ['pride-5k', 'pride-umb'], 'earliest start first')
    assert.match(count.message, /Pride 5K Rainbow Run/, 'names the hijacking row')

    // Date check runs against the row the hub would pick (the 5K), which
    // falls on Eastern 2026-08-21, not the registry dateKey 2026-08-22.
    const date = findings.find((f) => f.check === 'umbrella-date')
    assert.ok(date, 'expected an umbrella-date finding')
    assert.equal(date.level, 'FAIL')
    assert.deepEqual(date.eventIds, ['pride-5k'])
    assert.match(date.message, /2026-08-21/)
  })

  it('a non-published second umbrella does not trigger the count FAIL', () => {
    const cancelled = umbrellaRow({ id: 'umb-2', status: 'cancelled' })
    const findings = evaluateFestivalInvariants(
      [umbrellaRow(), cancelled, setRow()], [PORCHROKR], QUIET_TODAY,
    )
    assert.deepEqual(findings, [])
  })
})

describe('check b: umbrella Eastern date must equal the registry dateKey', () => {
  it('flags an umbrella whose Eastern date drifts off dateKey', () => {
    // 2026-08-15T02:00:00Z is 22:00 EDT on 2026-08-14: the UTC date matches
    // the dateKey but the Eastern date does not. toISOString would pass
    // this row; easternDateKey must fail it.
    const findings = evaluateFestivalInvariants(
      [umbrellaRow({ start_at: '2026-08-15T02:00:00+00:00' }), setRow()],
      [PORCHROKR], QUIET_TODAY,
    )
    assert.equal(findings.length, 1)
    assert.equal(findings[0].check, 'umbrella-date')
    assert.equal(findings[0].level, 'FAIL')
    assert.match(findings[0].message, /2026-08-14/)
  })
})

describe('check c: the manual_overrides.tags pin must exist', () => {
  it('missing pin is a FAIL (owning scraper would strip the hub tags)', () => {
    for (const manual_overrides of [null, undefined, {}, { categories: { at: 'x', by: 'y' } }]) {
      const findings = evaluateFestivalInvariants(
        [umbrellaRow({ manual_overrides }), setRow()], [PORCHROKR], QUIET_TODAY,
      )
      assert.equal(findings.length, 1, `overrides=${JSON.stringify(manual_overrides)}`)
      assert.equal(findings[0].check, 'umbrella-pin')
      assert.equal(findings[0].level, 'FAIL')
    }
  })

  it('any by value satisfies the pin check (not just the importer stamp)', () => {
    const findings = evaluateFestivalInvariants(
      [umbrellaRow({ manual_overrides: { tags: { at: '2026-08-01T00:00:00Z', by: 'byron' } } }), setRow()],
      [PORCHROKR], QUIET_TODAY,
    )
    assert.deepEqual(findings, [])
  })
})

describe('check d: orphan umbrellas from retired registry entries', () => {
  it('flags a festival-umbrella row matching no registry tag', () => {
    const orphan = umbrellaRow({
      id: 'orphan-1',
      title: 'Old Fest 2024',
      tags: ['old-fest-2024', UMBRELLA_TAG],
    })
    const findings = evaluateFestivalInvariants(
      [umbrellaRow(), setRow(), orphan], [PORCHROKR], QUIET_TODAY,
    )
    assert.equal(findings.length, 1)
    assert.equal(findings[0].check, 'orphan-umbrella')
    assert.equal(findings[0].level, 'FAIL')
    assert.equal(findings[0].festival, null)
    assert.deepEqual(findings[0].eventIds, ['orphan-1'])
  })

  it('a bare festival-umbrella row with no other tags is also an orphan', () => {
    const orphan = umbrellaRow({ id: 'orphan-2', tags: [UMBRELLA_TAG] })
    const findings = evaluateFestivalInvariants([umbrellaRow(), orphan], [PORCHROKR], QUIET_TODAY)
    assert.equal(findings.length, 1)
    assert.equal(findings[0].check, 'orphan-umbrella')
  })
})

describe('check e: banner-window emptiness is a WARN, never a FAIL', () => {
  it('inside the [0, 7] window with zero non-umbrella rows: WARN', () => {
    for (const today of ['2026-08-15', '2026-08-08']) { // diff 0 and 7, both bounds
      const findings = evaluateFestivalInvariants([umbrellaRow()], [PORCHROKR], today)
      assert.equal(findings.length, 1, `today=${today}`)
      assert.equal(findings[0].level, 'WARN')
      assert.equal(findings[0].check, 'empty-window')
      assert.equal(findings[0].festival, 'porchrokr-2026')
    }
  })

  it('outside the window (8 days out, or festival passed): no WARN', () => {
    for (const today of ['2026-08-07', '2026-08-16']) {
      const findings = evaluateFestivalInvariants([umbrellaRow()], [PORCHROKR], today)
      assert.deepEqual(findings, [], `today=${today}`)
    }
  })
})

describe('multi-festival registries evaluate independently', () => {
  it('a Pride failure never bleeds into a healthy PorchRokr', () => {
    const findings = evaluateFestivalInvariants(
      [umbrellaRow(), setRow()], [PORCHROKR, PRIDE], QUIET_TODAY,
    )
    assert.equal(findings.length, 1)
    assert.equal(findings[0].check, 'one-umbrella')
    assert.equal(findings[0].festival, 'akron-pride-2026')
  })
})
