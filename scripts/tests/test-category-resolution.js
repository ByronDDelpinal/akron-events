/**
 * Tests for resolveEventCategories — the single seam where a scraper's
 * category input meets text inference before event_categories is written.
 *
 * Guards the June 2026 audit's Bug 1 (docs/tagging-audit-2026-06.md):
 * 'other' must never persist alongside a real category, in either order.
 * Import-safe: normalize.js touches no env/DB at import time.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { resolveEventCategories, inferCategories } from '../lib/normalize.js'

describe('resolveEventCategories', () => {
  // ── Bug 1 regressions ──────────────────────────────────────────────────
  it('drops inferred other when the scraper passes a real v2 hint', () => {
    assert.deepEqual(resolveEventCategories({ category: 'film' }, ['other']), ['film'])
  })

  it('drops a legacy hint that maps to other when inference found a real category', () => {
    // v1 'community' → 'other' (the Ticketmaster Miscellaneous path). The
    // real inferred category must win the primary slot, not 'other'.
    assert.deepEqual(resolveEventCategories({ category: 'community' }, ['music']), ['music'])
  })

  it('strips other from an explicit categories array', () => {
    assert.deepEqual(resolveEventCategories({ categories: ['music', 'other'] }, ['other']), ['music'])
  })

  // ── Fallback behavior ──────────────────────────────────────────────────
  it('keeps other when it is the only candidate', () => {
    assert.deepEqual(resolveEventCategories({}, ['other']), ['other'])
    assert.deepEqual(resolveEventCategories({ category: 'community' }, ['other']), ['other'])
  })

  it('falls back to other when every input slug is invalid', () => {
    assert.deepEqual(resolveEventCategories({ categories: ['bogus'] }, ['nonsense']), ['other'])
  })

  // ── Hint mapping & merge ───────────────────────────────────────────────
  it('maps legacy v1 hints to their v2 slug', () => {
    assert.deepEqual(resolveEventCategories({ category: 'art' }, ['other']), ['visual-art'])
    assert.deepEqual(resolveEventCategories({ category: 'nature' }, ['other']), ['outdoors'])
    assert.deepEqual(resolveEventCategories({ category: 'education' }, ['other']), ['learning'])
  })

  it('puts the source hint first and keeps one inferred secondary', () => {
    assert.deepEqual(resolveEventCategories({ category: 'theater' }, ['music', 'food']), ['theater', 'music'])
  })

  it('does not duplicate a hint already present in inference', () => {
    assert.deepEqual(resolveEventCategories({ category: 'music' }, ['music', 'food']), ['music', 'food'])
  })

  it('caps the result at two categories', () => {
    const out = resolveEventCategories({ categories: ['music', 'food', 'theater'] }, ['other'])
    assert.equal(out.length, 2)
  })

  it('prefers an explicit categories array over hint and inference', () => {
    assert.deepEqual(
      resolveEventCategories({ categories: ['outdoors'], category: 'music' }, ['food']),
      ['outdoors'],
    )
  })

  // ── End-to-end with real inference ─────────────────────────────────────
  it('hardcoded venue hint + unclassifiable artist-name title → hint only', () => {
    // The Kent Stage / Nightlight shape: title gives inference nothing.
    const inferred = inferCategories('Paula Cole', '').categories
    assert.deepEqual(inferred, ['other'])
    assert.deepEqual(resolveEventCategories({ category: 'music' }, inferred), ['music'])
  })

  it('strong text signal still enriches a hardcoded hint', () => {
    const inferred = inferCategories('Wine Tasting Night', 'An evening wine tasting.').categories
    const out = resolveEventCategories({ category: 'music' }, inferred)
    assert.deepEqual(out, ['music', 'food'])
  })
})
