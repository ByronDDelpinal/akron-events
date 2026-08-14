/**
 * test-digest-festival-visibility.js
 *
 * The digest is IN SCOPE for the festival-child-hiding rule (maintainer
 * ruling 2026-08-14, docs/umbrella-child-hiding.md). select.ts is Deno AND a
 * plain Node import target and deliberately imports nothing, so its
 * FESTIVAL_TAGS/FESTIVAL_UMBRELLA_TAG are a DUPLICATE of the registry
 * (same reasoning as select.ts's TIME_NOTES). This test is the sync
 * guardrail: it fails the moment that duplicate drifts from
 * src/lib/festivals.js, and re-runs the same "3,479 events" false-positive
 * fixtures against the digest-side predicate.
 *
 * Run:  node --test scripts/tests/test-digest-festival-visibility.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { FESTIVALS } from '../../src/lib/festivalsData.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SELECT = join(__dirname, '..', '..', 'supabase', 'functions', 'send-digest', 'select.ts')
const { FESTIVAL_TAGS, FESTIVAL_UMBRELLA_TAG, isFestivalChildHidden } = await import(SELECT)

describe('select.ts FESTIVAL_TAGS stays in sync with the registry', () => {
  it('is byte-identical to FESTIVALS.map(f => f.tag)', () => {
    assert.deepEqual([...FESTIVAL_TAGS], FESTIVALS.map((f) => f.tag))
  })

  it('FESTIVAL_UMBRELLA_TAG matches src/lib/browseVisibility.js\'s constant', () => {
    assert.equal(FESTIVAL_UMBRELLA_TAG, 'festival-umbrella')
  })
})

describe('isFestivalChildHidden — the 3,479 test, digest side', () => {
  it('an ordinary event sharing tags with the umbrella is NOT hidden', () => {
    assert.equal(isFestivalChildHidden(['free', 'akron', 'music']), false)
  })

  it('the umbrella itself (carries every ordinary tag too) is NOT hidden', () => {
    const umbrellaTags = [
      'porchrokr-2026', FESTIVAL_UMBRELLA_TAG,
      'free', 'akron', 'music', 'outdoor', 'festival', 'community', 'downtown-akron', 'highland-square',
    ]
    assert.equal(isFestivalChildHidden(umbrellaTags), false)
  })

  it('a PorchRokr child (festival tag, no umbrella tag) IS hidden from the digest pool', () => {
    assert.equal(isFestivalChildHidden(['porchrokr-2026', 'porch-7', 'free', 'music']), true)
  })

  it('an untagged / null-tags event is not hidden', () => {
    assert.equal(isFestivalChildHidden([]), false)
    assert.equal(isFestivalChildHidden(null), false)
    assert.equal(isFestivalChildHidden(undefined), false)
  })
})
