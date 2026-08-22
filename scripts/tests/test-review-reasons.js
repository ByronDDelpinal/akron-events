/**
 * test-review-reasons.js — the review queue's membership predicate, reason
 * taxonomy, and the manual_overrides normalizer.
 *
 * The membership predicate is load-bearing: the rail pip, the overview
 * tile, and the queue page all import the SAME builder from
 * src/lib/admin/reviewReasons.ts, and this file pins its exact PostgREST
 * string so a drive-by "cleanup" that changes what the badge counts fails
 * CI instead of shipping badge != page (bug 4 from the 08-18 review).
 *
 * normalizeOverrides guards the other live bug: legacy manual_overrides
 * rows store bare `true` markers, and rendering them used to throw a
 * RangeError out of date-fns. The normalizer must accept every vintage.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  REVIEW_MEMBERSHIP_OR,
  reviewQueueScope,
  rowReason,
  isCategoryUnsure,
  isAwaitingPublish,
  isMissingEnd,
  FACET_IDS,
  REASONS,
} from '../../src/lib/admin/reviewReasons.ts'
import { normalizeOverrides } from '../../src/lib/admin/useOverrides.ts'

// ── Membership predicate ────────────────────────────────────────────────

describe('REVIEW_MEMBERSHIP_OR', () => {
  it('is the exact union of "flagged, unadjudicated" and "awaiting publish"', () => {
    assert.equal(
      REVIEW_MEMBERSHIP_OR,
      'and(needs_review.eq.true,reviewed_at.is.null),status.eq.pending_review',
    )
  })

  it('reviewQueueScope passes exactly that string to .or()', () => {
    const calls = []
    const fakeQuery = { or: (arg) => { calls.push(arg); return fakeQuery } }
    const returned = reviewQueueScope(fakeQuery)
    assert.equal(returned, fakeQuery)
    assert.deepEqual(calls, [REVIEW_MEMBERSHIP_OR])
  })
})

// ── Reason taxonomy ─────────────────────────────────────────────────────

describe('rowReason precedence and membership predicates', () => {
  const flagged = { needs_review: true, reviewed_at: null, status: 'published', end_at: null }
  const pending = { needs_review: false, reviewed_at: null, status: 'pending_review', end_at: '2026-08-23T00:00:00Z' }
  const both = { needs_review: true, reviewed_at: null, status: 'pending_review', end_at: null }
  const adjudicated = { needs_review: true, reviewed_at: '2026-08-20T12:00:00Z', status: 'published', end_at: null }

  it('flagged + unadjudicated -> cat', () => {
    assert.equal(rowReason(flagged), 'cat')
  })

  it('pending_review alone -> pend', () => {
    assert.equal(rowReason(pending), 'pend')
  })

  it('a both-reasons row shows cat (one chip per row, cat > pend)', () => {
    assert.equal(rowReason(both), 'cat')
  })

  it('an adjudicated flag is NOT cat — reviewed_at is the human decision', () => {
    assert.equal(isCategoryUnsure(adjudicated), false)
    assert.equal(rowReason(adjudicated), null)
  })

  it('missing end is an annotation, never a membership cause', () => {
    const endless = { needs_review: false, reviewed_at: null, status: 'published', end_at: null }
    assert.equal(isMissingEnd(endless), true)
    assert.equal(rowReason(endless), null)
  })

  it('pend predicate matches only status', () => {
    assert.equal(isAwaitingPublish(pending), true)
    assert.equal(isAwaitingPublish(flagged), false)
  })

  it('every facet id has a reason definition with a label', () => {
    for (const id of FACET_IDS) {
      assert.ok(REASONS[id])
      assert.equal(typeof REASONS[id].label, 'string')
    }
  })
})

// ── normalizeOverrides ──────────────────────────────────────────────────

describe('normalizeOverrides', () => {
  it('canonical { at } markers pass through', () => {
    const input = { category: { at: '2026-08-20T12:00:00Z' } }
    assert.deepEqual(normalizeOverrides(input), {
      category: { at: '2026-08-20T12:00:00Z' },
    })
  })

  it('legacy bare true becomes { at: null } — locked, date unknown', () => {
    assert.deepEqual(normalizeOverrides({ category: true }), { category: { at: null } })
  })

  it('an object marker without a usable at string becomes { at: null }', () => {
    assert.deepEqual(normalizeOverrides({ title: {} }), { title: { at: null } })
    assert.deepEqual(normalizeOverrides({ title: { at: 42 } }), { title: { at: null } })
  })

  it('other truthy scalars lock with no date; falsy values drop', () => {
    assert.deepEqual(normalizeOverrides({ a: 1, b: 'yes', c: false, d: null, e: 0 }), {
      a: { at: null },
      b: { at: null },
    })
  })

  it('garbage input normalizes to an empty object', () => {
    assert.deepEqual(normalizeOverrides(null), {})
    assert.deepEqual(normalizeOverrides(undefined), {})
    assert.deepEqual(normalizeOverrides('locked'), {})
    assert.deepEqual(normalizeOverrides(7), {})
    assert.deepEqual(normalizeOverrides([1, 2]), {})
  })

  it('mixed vintages in one row all normalize', () => {
    const input = { category: true, title: { at: '2026-01-05T00:00:00Z' }, venue: 'x' }
    assert.deepEqual(normalizeOverrides(input), {
      category: { at: null },
      title: { at: '2026-01-05T00:00:00Z' },
      venue: { at: null },
    })
  })
})
