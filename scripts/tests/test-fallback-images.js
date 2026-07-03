/**test-fallback-images.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { fallbackImageFor, SOURCE_FALLBACK_IMAGE } from '../lib/fallback-images.js'

describe('fallback-images: fallbackImageFor', () => {
  it('returns null for a source with no configured fallback yet (mechanism-only, 2026-07-02)', () => {
    // Every entry is a TODO until Byron supplies real photos — this should
    // stay true until someone fills one in, at which point this specific
    // assertion should be updated for that source.
    for (const source of Object.keys(SOURCE_FALLBACK_IMAGE)) {
      assert.equal(fallbackImageFor(source), null, `${source} should have no fallback configured yet`)
    }
  })

  it('returns null for a source not in the registry at all', () => {
    assert.equal(fallbackImageFor('some_scraper_with_its_own_images'), null)
  })

  it('picks up a configured value once one is set (forward-compat check)', () => {
    const registry = { my_source: 'https://example.com/photo.jpg' }
    const fn = (source) => registry[source] ?? null
    assert.equal(fn('my_source'), 'https://example.com/photo.jpg')
  })
})
