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
import { defaultCategoryFor, SOURCE_DEFAULT_CATEGORY } from '../manifest.js'

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

  // ── Source-default fallback (3rd arg) ───────────────────────────────────
  it('applies the source default only when the result is a bare other', () => {
    // Bare band name on a music-default feed → music, on every scrape.
    assert.deepEqual(resolveEventCategories({}, ['other'], 'music'), ['music'])
  })

  it('never lets the source default override a real classification', () => {
    // "Mean Girls" text-infers theater; a music-default feed must keep theater.
    assert.deepEqual(resolveEventCategories({}, ['theater'], 'music'), ['theater'])
    // An explicit per-event hint also wins over the default.
    assert.deepEqual(resolveEventCategories({ category: 'comedy' }, ['other'], 'music'), ['comedy'])
  })

  it('ignores an invalid or other source default', () => {
    assert.deepEqual(resolveEventCategories({}, ['other'], 'bogus'), ['other'])
    assert.deepEqual(resolveEventCategories({}, ['other'], 'other'), ['other'])
    assert.deepEqual(resolveEventCategories({}, ['other'], null), ['other'])
  })

  it('end-to-end: unclassifiable title + civic-default source → civic', () => {
    const inferred = inferCategories('Quarterly Co-Chair Meeting', '').categories
    assert.deepEqual(inferred, ['other'])
    assert.deepEqual(resolveEventCategories({}, inferred, defaultCategoryFor('torchbearers')), ['civic'])
  })

  it('sources without a default leave an unclassifiable title as other (goes to review)', () => {
    // Removing blunt defaults is deliberate: a bare band name on akron_life /
    // ticketmaster falls to review rather than being mislabeled 'music'.
    const inferred = inferCategories('Mac Saturn', '').categories
    assert.deepEqual(inferred, ['other'])
    assert.equal(defaultCategoryFor('akron_life'), null)
    assert.equal(defaultCategoryFor('ticketmaster'), null)
    assert.deepEqual(resolveEventCategories({}, inferred, defaultCategoryFor('akron_life')), ['other'])
  })
})

describe('manifest source defaults', () => {
  it('exposes only valid, non-other default categories', () => {
    for (const [key, cat] of Object.entries(SOURCE_DEFAULT_CATEGORY)) {
      assert.notEqual(cat, 'other', `${key} default must not be 'other'`)
      assert.deepEqual(resolveEventCategories({}, ['other'], cat), [cat],
        `${key} default '${cat}' is not a resolvable category`)
    }
  })

  it('returns null for sources without a default', () => {
    assert.equal(defaultCategoryFor('eventbrite'), null)
    assert.equal(defaultCategoryFor('nonexistent_source'), null)
  })
})
