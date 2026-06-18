/**
 * test-datetime-local.js — tests for src/lib/datetimeLocal.js, the
 * UTC-instant ↔ <input type="datetime-local"> bridge used by the admin
 * event editor and the public submit form.
 *
 * TZ is pinned to America/New_York up front so the offset math is
 * deterministic regardless of the machine running the suite, and so we
 * can assert both EDT (UTC-4, summer) and EST (UTC-5, winter) behavior —
 * the exact bug this module fixes was a UTC clock leaking into the form.
 */
process.env.TZ = 'America/New_York'

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
} from '../../src/lib/datetimeLocal.js'

describe('toDatetimeLocalValue: UTC instant → local input value', () => {
  it('renders a summer (EDT, UTC-4) instant in local wall-clock', () => {
    // 21:00 UTC = 5:00 PM EDT — the Data Center Ban Petition Signing case.
    assert.equal(toDatetimeLocalValue('2026-06-18T21:00:00+00:00'), '2026-06-18T17:00')
  })

  it('renders a winter (EST, UTC-5) instant in local wall-clock', () => {
    // 21:00 UTC = 4:00 PM EST.
    assert.equal(toDatetimeLocalValue('2026-01-18T21:00:00+00:00'), '2026-01-18T16:00')
  })

  it('rolls back across the day boundary when local time is the prior day', () => {
    // 02:00 UTC on the 18th = 10:00 PM EDT on the 17th.
    assert.equal(toDatetimeLocalValue('2026-06-18T02:00:00+00:00'), '2026-06-17T22:00')
  })

  it('accepts a Z-suffixed instant', () => {
    assert.equal(toDatetimeLocalValue('2026-06-18T21:00:00.000Z'), '2026-06-18T17:00')
  })

  it('returns empty string for null / undefined / empty / garbage', () => {
    assert.equal(toDatetimeLocalValue(null), '')
    assert.equal(toDatetimeLocalValue(undefined), '')
    assert.equal(toDatetimeLocalValue(''), '')
    assert.equal(toDatetimeLocalValue('not-a-date'), '')
  })
})

describe('fromDatetimeLocalValue: local input value → UTC instant', () => {
  it('interprets a summer (EDT) wall-clock as local and returns UTC', () => {
    assert.equal(fromDatetimeLocalValue('2026-06-18T17:00'), '2026-06-18T21:00:00.000Z')
  })

  it('interprets a winter (EST) wall-clock as local and returns UTC', () => {
    assert.equal(fromDatetimeLocalValue('2026-01-18T16:00'), '2026-01-18T21:00:00.000Z')
  })

  it('returns null for empty / null / undefined / garbage', () => {
    assert.equal(fromDatetimeLocalValue(''), null)
    assert.equal(fromDatetimeLocalValue(null), null)
    assert.equal(fromDatetimeLocalValue(undefined), null)
    assert.equal(fromDatetimeLocalValue('not-a-date'), null)
  })
})

describe('round-trip stability', () => {
  for (const iso of [
    '2026-06-18T21:00:00.000Z', // EDT
    '2026-01-18T21:00:00.000Z', // EST
    '2026-06-18T02:00:00.000Z', // day-boundary
    '2026-03-08T07:30:00.000Z', // morning, near the spring-forward weekend
  ]) {
    it(`instant → input → instant is lossless for ${iso}`, () => {
      assert.equal(fromDatetimeLocalValue(toDatetimeLocalValue(iso)), iso)
    })
  }
})
