/**
 * test-event-window.js — unit tests for the shared ingestion-window filter.
 *
 * These lock in the behaviour the five municipal scrapers relied on when each
 * carried its own copy of `isWithinWindow`, plus the one thing the extraction
 * could plausibly get wrong: the horizon must stay per-caller, because Village
 * of Peninsula uses 365 days where the others use 180.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { makeWindowFilter, DAY_MS } from '../lib/event-window.js'

const NOW = Date.parse('2026-07-15T12:00:00.000Z')
const within180 = makeWindowFilter({ horizonDays: 180 })
const within365 = makeWindowFilter({ horizonDays: 365 })

describe('makeWindowFilter — construction', () => {
  it('exports one day in milliseconds', () => {
    assert.equal(DAY_MS, 86_400_000)
  })

  it('rejects a missing horizon rather than guessing one', () => {
    assert.throws(() => makeWindowFilter(), TypeError)
    assert.throws(() => makeWindowFilter({}), TypeError)
  })

  it('rejects a non-positive or non-finite horizon', () => {
    assert.throws(() => makeWindowFilter({ horizonDays: 0 }), TypeError)
    assert.throws(() => makeWindowFilter({ horizonDays: -30 }), TypeError)
    assert.throws(() => makeWindowFilter({ horizonDays: Infinity }), TypeError)
    assert.throws(() => makeWindowFilter({ horizonDays: 'ninety' }), TypeError)
  })

  it('keeps the (startUtc, endUtc, nowMs) signature the scrapers export', () => {
    assert.equal(typeof within180, 'function')
    assert.equal(within180.length, 2) // third arg is defaulted
    assert.equal(within180.name, 'isWithinWindow')
  })
})

describe('makeWindowFilter — bad input', () => {
  it('rejects a missing start', () => {
    assert.equal(within180(null, null, NOW), false)
    assert.equal(within180(undefined, undefined, NOW), false)
    assert.equal(within180('', null, NOW), false)
  })

  it('rejects an unparseable start', () => {
    assert.equal(within180('not a date', null, NOW), false)
  })
})

describe('makeWindowFilter — the past edge', () => {
  it('keeps an event that ended within the grace period', () => {
    const ended = new Date(NOW - 2 * 3_600_000).toISOString()
    assert.equal(within180('2026-07-15T08:00:00.000Z', ended, NOW), true)
  })

  it('drops an event that ended before the grace period', () => {
    assert.equal(within180('2024-01-21T18:00:00.000Z', '2024-01-21T21:00:00.000Z', NOW), false)
  })

  it('falls back to the start when there is no end', () => {
    // A start inside the grace window survives even with a null end.
    const justEnded = new Date(NOW - 1_000).toISOString()
    assert.equal(within180(justEnded, null, NOW), true)
  })

  it('honours a custom grace period', () => {
    const endedLongAgo = new Date(NOW - 10 * DAY_MS).toISOString()
    assert.equal(within180(endedLongAgo, endedLongAgo, NOW), false)
    const generous = makeWindowFilter({ horizonDays: 180, pastGraceMs: 30 * DAY_MS })
    assert.equal(generous(endedLongAgo, endedLongAgo, NOW), true)
  })
})

describe('makeWindowFilter — the horizon edge', () => {
  it('keeps an event exactly on the horizon', () => {
    const onHorizon = new Date(NOW + 180 * DAY_MS).toISOString()
    assert.equal(within180(onHorizon, null, NOW), true)
  })

  it('drops an event one day past the horizon', () => {
    const pastHorizon = new Date(NOW + 181 * DAY_MS).toISOString()
    assert.equal(within180(pastHorizon, null, NOW), false)
  })

  it('keeps the horizon per-caller: 365 accepts what 180 rejects', () => {
    // This is the regression the extraction had to avoid. Peninsula publishes a
    // year out; collapsing every caller onto 180 would have silently dropped
    // nine months of its calendar.
    const tenMonthsOut = new Date(NOW + 300 * DAY_MS).toISOString()
    assert.equal(within180(tenMonthsOut, null, NOW), false)
    assert.equal(within365(tenMonthsOut, null, NOW), true)
  })

  it('two filters built from one factory do not share state', () => {
    const a = makeWindowFilter({ horizonDays: 1 })
    const b = makeWindowFilter({ horizonDays: 400 })
    const farOut = new Date(NOW + 200 * DAY_MS).toISOString()
    assert.equal(a(farOut, null, NOW), false)
    assert.equal(b(farOut, null, NOW), true)
    assert.equal(a(farOut, null, NOW), false)
  })
})

describe('makeWindowFilter — defaults', () => {
  it('defaults nowMs to the current time', () => {
    const soon = new Date(Date.now() + 3 * DAY_MS).toISOString()
    assert.equal(within180(soon, null), true)
    const ancient = '1999-01-01T00:00:00.000Z'
    assert.equal(within180(ancient, null), false)
  })

  it('defaults the grace period to one day', () => {
    const endedTwelveHoursAgo = new Date(NOW - 12 * 3_600_000).toISOString()
    const endedTwoDaysAgo = new Date(NOW - 2 * DAY_MS).toISOString()
    assert.equal(within180(endedTwelveHoursAgo, endedTwelveHoursAgo, NOW), true)
    assert.equal(within180(endedTwoDaysAgo, endedTwoDaysAgo, NOW), false)
  })
})
