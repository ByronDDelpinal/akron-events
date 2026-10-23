/**
 * test-ga-us-only.js - the US-only scope every GA4 report goes through.
 *
 * All four GA scripts route their runReport bodies through usOnly(). What
 * needs pinning is that it composes rather than replaces: a report that
 * already filters on eventName or a custom dimension must keep that filter
 * AND gain the country one, or the install / embed numbers quietly become
 * site-wide numbers while still looking filtered.
 *
 * Run:  node --test scripts/tests/test-ga-us-only.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { usOnly, US_ONLY_FILTER } from '../ga-snapshot.js'

describe('usOnly', () => {
  it('adds the country filter to a body that has none', () => {
    const body = { dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }], metrics: [{ name: 'sessions' }] }
    const out = usOnly(body)
    assert.deepEqual(out.dimensionFilter, US_ONLY_FILTER)
    assert.deepEqual(out.dateRanges, body.dateRanges)
    assert.deepEqual(out.metrics, body.metrics)
  })

  it('ANDs the country filter with an existing dimensionFilter instead of replacing it', () => {
    const existing = { filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'pwa_standalone_launch', caseSensitive: true } } }
    const out = usOnly({ dimensionFilter: existing })
    assert.deepEqual(out.dimensionFilter, { andGroup: { expressions: [US_ONLY_FILTER, existing] } })
  })

  it('never mutates the input body', () => {
    const body = { dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: ['x'] } } } }
    const snapshot = JSON.stringify(body)
    usOnly(body)
    assert.equal(JSON.stringify(body), snapshot)
  })

  it('matches the exact country name GA4 reports', () => {
    assert.equal(US_ONLY_FILTER.filter.fieldName, 'country')
    assert.equal(US_ONLY_FILTER.filter.stringFilter.value, 'United States')
    assert.equal(US_ONLY_FILTER.filter.stringFilter.matchType, 'EXACT')
  })
})
