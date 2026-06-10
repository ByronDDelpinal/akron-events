/**
 * Tests for the ingestion data contract (validateEvent in lib/normalize.js).
 *
 * The contract is the single gate between all scrapers and the events table;
 * these tests pin down exactly what it rejects (returns a reason string) and
 * what it lets through (returns null). Pure function — no env, no network.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { validateEvent } from '../lib/normalize.js'

/** A minimal valid row, one week out. */
function validRow(overrides = {}) {
  const start = new Date(Date.now() + 7 * 86_400_000)
  return {
    title: 'Concert on the Lawn',
    source: 'test_source',
    source_id: 'evt-123',
    start_at: start.toISOString(),
    ...overrides,
  }
}

describe('validateEvent — accepts valid rows', () => {
  it('passes a minimal valid row', () => {
    assert.equal(validateEvent(validRow()), null)
  })

  it('passes a row with a valid end_at after start_at', () => {
    const row = validRow()
    row.end_at = new Date(Date.parse(row.start_at) + 2 * 3_600_000).toISOString()
    assert.equal(validateEvent(row), null)
  })

  it('passes end_at equal to start_at (zero-duration)', () => {
    const row = validRow()
    row.end_at = row.start_at
    assert.equal(validateEvent(row), null)
  })

  it('passes a midnight all-day event (advisory only, not a rejection)', () => {
    const row = validRow({ start_at: '2026-07-04T04:00:00.000Z' }) // midnight EDT
    assert.equal(validateEvent(row), null)
  })

  it('passes a recent past event (yesterday)', () => {
    const row = validRow({ start_at: new Date(Date.now() - 86_400_000).toISOString() })
    assert.equal(validateEvent(row), null)
  })

  it('passes a row without source_id (warn-only today)', () => {
    const row = validRow({ source_id: null })
    assert.equal(validateEvent(row), null)
  })
})

describe('validateEvent — rejects malformed rows', () => {
  it('rejects non-objects', () => {
    assert.match(validateEvent(null), /not an object/)
    assert.match(validateEvent('row'), /not an object/)
    assert.match(validateEvent([validRow()]), /not an object/)
  })

  it('rejects missing or blank titles', () => {
    assert.match(validateEvent(validRow({ title: undefined })), /title/)
    assert.match(validateEvent(validRow({ title: '' })), /title/)
    assert.match(validateEvent(validRow({ title: '   ' })), /title/)
    assert.match(validateEvent(validRow({ title: 42 })), /title/)
  })

  it('rejects absurdly long titles', () => {
    assert.match(validateEvent(validRow({ title: 'x'.repeat(501) })), /500 chars/)
  })

  it('rejects a missing source key', () => {
    assert.match(validateEvent(validRow({ source: undefined })), /source/)
    assert.match(validateEvent(validRow({ source: '' })), /source/)
  })

  it('rejects missing start_at', () => {
    assert.match(validateEvent(validRow({ start_at: undefined })), /missing start_at/)
    assert.match(validateEvent(validRow({ start_at: null })), /missing start_at/)
  })

  it('rejects unparseable start_at', () => {
    assert.match(validateEvent(validRow({ start_at: 'next Tuesday-ish' })), /unparseable start_at/)
  })

  it('rejects year-artifact dates (the parser-bug class)', () => {
    assert.match(validateEvent(validRow({ start_at: '1970-01-01T00:00:00Z' })), /implausibly old/)
    assert.match(validateEvent(validRow({ start_at: '2126-06-13T00:00:00Z' })), /implausibly far out/)
  })

  it('rejects unparseable end_at', () => {
    assert.match(validateEvent(validRow({ end_at: 'whenever' })), /unparseable end_at/)
  })

  it('rejects end_at before start_at (swapped/mis-parsed range)', () => {
    const row = validRow()
    row.end_at = new Date(Date.parse(row.start_at) - 3_600_000).toISOString()
    assert.match(validateEvent(row), /precedes start_at/)
  })
})
