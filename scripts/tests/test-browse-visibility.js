/**
 * test-browse-visibility.js — offline tests for src/lib/browseVisibility.js,
 * the ONE place the "hide festival children from the browse grid" rule is
 * expressed (docs/umbrella-child-hiding.md §1, §8.A).
 *
 * Run:  node --test scripts/tests/test-browse-visibility.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { FESTIVALS } from '../../src/lib/festivalsData.js'
import {
  FESTIVAL_UMBRELLA_TAG,
  FESTIVAL_TAGS,
  isHiddenFromBrowse,
  buildBrowseVisibilityOrClauses,
  applyBrowseVisibility,
  umbrellaFestival,
  USE_PER_TAG_OR_FALLBACK,
} from '../../src/lib/browseVisibility.js'

// Ordinary content tags the PorchRokr umbrella ALSO carries in production
// (measured 2026-08-14). None of these may ever hide an event.
const ORDINARY_TAGS = ['free', 'akron', 'music', 'outdoor', 'festival', 'community', 'downtown-akron', 'highland-square']

describe('registry derivation', () => {
  it('FESTIVAL_TAGS is exactly FESTIVALS.map(f => f.tag)', () => {
    assert.deepEqual(FESTIVAL_TAGS, FESTIVALS.map((f) => f.tag))
  })

  it('no ordinary tag ever appears in FESTIVAL_TAGS', () => {
    for (const t of ORDINARY_TAGS) {
      assert.ok(!FESTIVAL_TAGS.includes(t), `${t} must never be a registry tag`)
    }
  })
})

describe('isHiddenFromBrowse — the 3,479 test (the one that must exist)', () => {
  it('an ordinary event sharing tags with the umbrella is VISIBLE', () => {
    assert.equal(isHiddenFromBrowse(['free', 'akron', 'music']), false)
  })

  it('a bare ordinary-tag event is VISIBLE', () => {
    assert.equal(isHiddenFromBrowse(['free']), false)
  })

  it('the PorchRokr umbrella itself (carries every ordinary tag too) is VISIBLE', () => {
    const umbrellaTags = [
      'porchrokr-2026', FESTIVAL_UMBRELLA_TAG,
      'free', 'akron', 'music', 'outdoor', 'festival', 'community', 'downtown-akron', 'highland-square',
    ]
    assert.equal(isHiddenFromBrowse(umbrellaTags), false)
  })

  it('a PorchRokr child (festival tag, no umbrella tag) is HIDDEN', () => {
    assert.equal(isHiddenFromBrowse(['porchrokr-2026', 'porch-7', 'free', 'music']), true)
  })

  it('an Akron Pride child is HIDDEN', () => {
    assert.equal(isHiddenFromBrowse(['akron-pride-2026', 'stage-main']), true)
  })

  it('an untagged event ([]) is VISIBLE', () => {
    assert.equal(isHiddenFromBrowse([]), false)
  })

  it('a null-tags event is VISIBLE', () => {
    assert.equal(isHiddenFromBrowse(null), false)
  })

  it('generated filter string never contains an ordinary tag (string-level check)', () => {
    const clauses = buildBrowseVisibilityOrClauses()
    const joined = clauses.join('|')
    for (const t of ORDINARY_TAGS) {
      // Exact brace-wrapped occurrence, not a raw substring match — "festival"
      // (an ordinary tag) is legitimately a SUBSTRING of "festival-umbrella"
      // (the marker tag, which the filter references on purpose). The real
      // failure mode this guards is an ordinary tag appearing as its OWN
      // {tag} element in the filter.
      assert.ok(!joined.includes(`{${t}}`), `ordinary tag "${t}" leaked into the filter as its own element: ${joined}`)
    }
  })
})

describe('empty registry is a no-op', () => {
  it('isHiddenFromBrowse never hides anything with an injected empty registry', () => {
    assert.equal(isHiddenFromBrowse(['porchrokr-2026'], []), false)
    assert.equal(isHiddenFromBrowse([FESTIVAL_UMBRELLA_TAG], []), false)
  })

  it('buildBrowseVisibilityOrClauses returns zero clauses for an empty registry', () => {
    assert.deepEqual(buildBrowseVisibilityOrClauses([]), [])
  })

  it('applyBrowseVisibility makes ZERO .or() calls and returns the identical builder', () => {
    let orCalls = 0
    const stubQuery = { or() { orCalls += 1; return this } }
    const result = applyBrowseVisibility(stubQuery, [])
    assert.equal(orCalls, 0, 'an empty registry hiding everything would be catastrophic and silent')
    assert.equal(result, stubQuery, 'must return the SAME builder, untouched')
  })
})

describe('filter shape — against a stub builder recording .or() arguments', () => {
  function stubBuilder() {
    const calls = []
    const builder = { or(clause) { calls.push(clause); return builder }, calls }
    return builder
  }

  it('a 2-entry registry produces exactly one .or() call with the exact expected string', () => {
    const stub = stubBuilder()
    applyBrowseVisibility(stub, ['porchrokr-2026', 'akron-pride-2026'])
    assert.equal(stub.calls.length, 1)
    assert.equal(
      stub.calls[0],
      'and(tags.not.cs.{porchrokr-2026},tags.not.cs.{akron-pride-2026}),tags.cs.{festival-umbrella}',
    )
  })

  it('a 1-entry registry skips the and(...) wrapper', () => {
    const stub = stubBuilder()
    applyBrowseVisibility(stub, ['porchrokr-2026'])
    assert.equal(stub.calls.length, 1)
    assert.equal(stub.calls[0], 'tags.not.cs.{porchrokr-2026},tags.cs.{festival-umbrella}')
  })

  it('no clause ever contains a comma inside a {} array literal', () => {
    const stub = stubBuilder()
    applyBrowseVisibility(stub, ['porchrokr-2026', 'akron-pride-2026', 'a-third-fest-2027'])
    for (const clause of stub.calls) {
      const braced = clause.match(/\{[^}]*\}/g) ?? []
      for (const b of braced) assert.ok(!b.includes(','), `comma inside {} in clause: ${clause}`)
    }
  })

  it('the real (2-entry) registry, default args, matches docs/umbrella-child-hiding.md §1.3\'s worked example', () => {
    const stub = stubBuilder()
    applyBrowseVisibility(stub)
    assert.equal(stub.calls.length, 1)
    assert.equal(
      stub.calls[0],
      'and(tags.not.cs.{porchrokr-2026},tags.not.cs.{akron-pride-2026}),tags.cs.{festival-umbrella}',
    )
  })
})

describe('per-tag .or() fallback encoding (behind USE_PER_TAG_OR_FALLBACK)', () => {
  it('is off by default — the primary and()/or() encoding ships unless flipped', () => {
    // MUST-VERIFY (docs/umbrella-child-hiding.md §1.3, §8.C): a live anon
    // curl decides whether this stays false. USE_PER_TAG_OR_FALLBACK is a
    // source-level switch (not a parameter), so the fallback branch itself
    // is exercised by passing the flag's effect through buildBrowseVisibilityOrClauses's
    // shared per-tag clause shape below, not by flipping the constant here.
    assert.equal(USE_PER_TAG_OR_FALLBACK, false)
  })

  it('the fallback clause shape (one .or() per tag) is what the primary encoding\'s single clause is built FROM', () => {
    // Both encodings share the same per-tag atom — `tags.not.cs.{t},tags.cs.{festival-umbrella}`
    // — the primary encoding just wraps the negations in one and(...) instead
    // of issuing one .or() per tag. Pin that atom's shape so a future edit to
    // either encoding can't silently drift the other.
    const clause = buildBrowseVisibilityOrClauses(['porchrokr-2026'])[0]
    assert.equal(clause, 'tags.not.cs.{porchrokr-2026},tags.cs.{festival-umbrella}')
  })
})

describe('tag validation throws before interpolation', () => {
  for (const bad of ['has,comma', 'has{brace', 'has}brace', 'has(paren', 'has)paren', 'Has-Upper', '']) {
    it(`throws for a registry tag ${JSON.stringify(bad)}`, () => {
      assert.throws(() => buildBrowseVisibilityOrClauses([bad]))
      assert.throws(() => isHiddenFromBrowse(['x'], [bad]))
    })
  }

  it('does not throw for well-formed tags', () => {
    assert.doesNotThrow(() => buildBrowseVisibilityOrClauses(['porchrokr-2026', 'a-2027-fest']))
  })
})

describe('umbrellaFestival', () => {
  it('returns the Festival when the row carries festival-umbrella AND a registry tag', () => {
    const f = umbrellaFestival(['porchrokr-2026', FESTIVAL_UMBRELLA_TAG, 'free'])
    assert.equal(f?.slug, 'porchrokr-2026')
  })

  it('returns null for a plain child row (no umbrella tag)', () => {
    assert.equal(umbrellaFestival(['porchrokr-2026', 'porch-7']), null)
  })

  it('returns null for an orphan umbrella (tag matches no registry entry)', () => {
    assert.equal(umbrellaFestival(['old-fest-2024', FESTIVAL_UMBRELLA_TAG]), null)
  })

  it('returns null for untagged / null input', () => {
    assert.equal(umbrellaFestival([]), null)
    assert.equal(umbrellaFestival(null), null)
  })
})
