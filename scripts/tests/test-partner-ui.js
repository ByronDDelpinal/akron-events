/**
 * test-partner-ui.js — the pure logic behind the partner side of Pulse
 * Control (src/lib/admin/partnerShared.ts).
 *
 * Pins the pieces that must not drift:
 *   - the role probe's resolution matrix, especially the two honesty rules:
 *     an empty scope is NEVER "show everything", and a failed probe is
 *     NEVER reported as "no access";
 *   - the client twin of the 061 p_patch column allowlist (a UI that grows
 *     a `featured` input fails here before it fails in review);
 *   - the all-of write twin (ADR §6.8) that gates the drawer's controls;
 *   - the friendly-error mapping that shows 061's human-readable refusals
 *     verbatim (the venue guard's reasons included).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveRole,
  PARTNER_PATCH_KEYS,
  rowToPatchBase,
  diffPartnerPatch,
  partnerCanWrite,
  coHostNamesOutsideScope,
  writeOrgId,
  predictedReviewBlocker,
  reviewOutcomeCopy,
  CANCELLED_FINAL_COPY,
  cancelConfirmCopy,
  isImportedSource,
  rpcFriendlyMessage,
  isGuardRefusal,
  isValidPartnerSlug,
} from '../../src/lib/admin/partnerShared.ts'

const ok = (data) => ({ data, error: null })
const fail = (message) => ({ data: null, error: { message } })

const ORG_A = { organization_id: 'a', name: 'North Hill CDC', slug: 'north-hill-cdc', auto_publish: true }
const ORG_B = { organization_id: 'b', name: 'Exchange House', slug: 'exchange-house', auto_publish: false }

// ── resolveRole ─────────────────────────────────────────────────────────

describe('resolveRole', () => {
  it('is_admin true wins, context ignored', () => {
    const r = resolveRole(ok(true), ok([ORG_A]))
    assert.equal(r.role, 'admin')
    assert.deepEqual(r.orgs, [])
  })

  it('context rows make a partner', () => {
    const r = resolveRole(ok(false), ok([ORG_A, ORG_B]))
    assert.equal(r.role, 'partner')
    assert.equal(r.orgs.length, 2)
  })

  it('both empty is an honest none — never a fallback to everything', () => {
    const r = resolveRole(ok(false), ok([]))
    assert.equal(r.role, 'none')
    assert.equal(r.error, null)
  })

  it('a failed probe is an error, not "no access"', () => {
    const r = resolveRole(fail('network down'), fail('network down'))
    assert.equal(r.role, null)
    assert.equal(r.error, 'network down')
  })

  it('is_admin failure with real context rows still resolves partner', () => {
    const r = resolveRole(fail('boom'), ok([ORG_A]))
    assert.equal(r.role, 'partner')
  })

  it('is_admin false but context failed is an error', () => {
    const r = resolveRole(ok(false), fail('boom'))
    assert.equal(r.role, null)
  })
})

// ── The p_patch allowlist twin ──────────────────────────────────────────

describe('PARTNER_PATCH_KEYS', () => {
  it('is exactly the 061 §3.3 column allowlist, pinned', () => {
    assert.deepEqual([...PARTNER_PATCH_KEYS], [
      'title', 'description', 'start_at', 'end_at', 'price_min', 'price_max',
      'age_restriction', 'ticket_url', 'source_url', 'image_url',
    ])
  })

  it('never contains the untouchable columns', () => {
    for (const banned of [
      'featured', 'status', 'source', 'source_id', 'needs_review',
      'reviewed_at', 'reviewed_by', 'manual_overrides', 'tags', 'slug', 'is_family',
    ]) {
      assert.ok(!PARTNER_PATCH_KEYS.includes(banned), `${banned} must never be patchable`)
    }
  })
})

describe('rowToPatchBase / diffPartnerPatch', () => {
  const row = {
    id: 'x', title: 'Night Market', description: '', start_at: '2026-09-01T22:00:00+00:00',
    end_at: null, price_min: 0, price_max: null, age_restriction: 'all_ages',
    ticket_url: null, source_url: 'https://a.example/e', image_url: null,
    featured: true, status: 'published', source: 'partner:north-hill-cdc',
  }

  it('keeps allowlisted keys only and folds empties to null', () => {
    const base = rowToPatchBase(row)
    assert.deepEqual(Object.keys(base).sort(), [...PARTNER_PATCH_KEYS].sort())
    assert.equal(base.description, null)
    assert.equal(base.price_min, 0)
    assert.ok(!('featured' in base))
  })

  it('diff returns changed keys only, {} when nothing changed', () => {
    const base = rowToPatchBase(row)
    assert.deepEqual(diffPartnerPatch(base, { ...base }), {})
    const patch = diffPartnerPatch(base, { ...base, title: 'Bigger Night Market', price_max: 10 })
    assert.deepEqual(patch, { title: 'Bigger Night Market', price_max: 10 })
  })

  it('treats null and missing symmetrically', () => {
    assert.deepEqual(diffPartnerPatch({ end_at: null }, { end_at: null }), {})
    assert.deepEqual(diffPartnerPatch({ end_at: '2026-09-02T00:00:00Z' }, { end_at: null }), { end_at: null })
  })
})

// ── The all-of write twin (ADR §6.8) ────────────────────────────────────

describe('partnerCanWrite', () => {
  const scope = ['a', 'a2']
  it('own-org event writable', () => assert.equal(partnerCanWrite(['a'], scope), true))
  it('co-host inside scope writable', () => assert.equal(partnerCanWrite(['a', 'a2'], scope), true))
  it('co-host outside scope read-only (all-of)', () => assert.equal(partnerCanWrite(['a', 'b'], scope), false))
  it('orphan rows are not writable (non-vacuity)', () => assert.equal(partnerCanWrite([], scope), false))
  it('empty scope fails closed', () => assert.equal(partnerCanWrite(['a'], []), false))
})

describe('co-host affordance helpers', () => {
  it('names exactly the orgs outside scope', () => {
    const names = coHostNamesOutsideScope(
      [{ id: 'a', name: 'North Hill CDC' }, { id: 'b', name: 'Downtown Akron' }],
      ['a'],
    )
    assert.deepEqual(names, ['Downtown Akron'])
  })
  it('writeOrgId picks the first linked org in scope, null when none', () => {
    assert.equal(writeOrgId(['b', 'a'], ['a']), 'a')
    assert.equal(writeOrgId(['b'], ['a']), null)
  })
})

// ── Review outcome copy ─────────────────────────────────────────────────

describe('review prediction and copy', () => {
  it('predicts the blocking org among the caller own context only', () => {
    assert.equal(predictedReviewBlocker(['a', 'b'], [ORG_A, ORG_B]), 'Exchange House')
    assert.equal(predictedReviewBlocker(['a'], [ORG_A, ORG_B]), null)
  })
  it('names the org the RPC named, and only then', () => {
    assert.match(reviewOutcomeCopy('Exchange House'), /^Exchange House's rules sent this to Akron Pulse for review/)
    assert.match(reviewOutcomeCopy(null), /^This went to Akron Pulse for review/)
  })
  it('has no em dashes in partner-facing copy', () => {
    assert.ok(!reviewOutcomeCopy('X').includes('—'))
    assert.ok(!reviewOutcomeCopy(null).includes('—'))
  })
})

// ── Cancelled is final (fix-pass finding 5) ─────────────────────────────

describe('cancelled-is-final copy', () => {
  it('the cancelled state names the admin-only restore, pinned', () => {
    assert.equal(CANCELLED_FINAL_COPY, 'Cancelled. Contact Akron Pulse to restore.')
  })
  it('the cancel confirm says plainly that cancelling is permanent', () => {
    const copy = cancelConfirmCopy('Night Market')
    assert.ok(copy.includes('"Night Market"'))
    assert.match(copy, /permanent/i)
    assert.match(copy, /only Akron Pulse can restore/i)
  })
  it('has no em dashes in either line', () => {
    assert.ok(!CANCELLED_FINAL_COPY.includes('—'))
    assert.ok(!cancelConfirmCopy('X').includes('—'))
  })
})

// ── Source trade note ───────────────────────────────────────────────────

describe('isImportedSource', () => {
  it('true only for feed-imported rows', () => {
    assert.equal(isImportedSource('north_hill_cdc'), true)
    assert.equal(isImportedSource('manual'), false)
    assert.equal(isImportedSource('partner:north-hill-cdc'), false)
    assert.equal(isImportedSource(null), false)
  })
})

// ── RPC error mapping ───────────────────────────────────────────────────

describe('rpcFriendlyMessage', () => {
  it('shows 061 refusals verbatim (they are written for humans)', () => {
    assert.equal(
      rpcFriendlyMessage({ code: '42501', message: 'this event is not editable as this organization' }, 'x'),
      'this event is not editable as this organization',
    )
    assert.equal(
      rpcFriendlyMessage({ code: '23514', message: 'this looks like a street address, not a venue name' }, 'x'),
      'this looks like a street address, not a venue name',
    )
  })
  it('unknown failures get the fallback with the raw message attached', () => {
    assert.equal(rpcFriendlyMessage({ message: 'fetch failed' }, 'Could not save.'), 'Could not save. (fetch failed)')
    assert.equal(rpcFriendlyMessage(null, 'Could not save.'), 'Could not save.')
  })
  it('isGuardRefusal keys on check_violation only', () => {
    assert.equal(isGuardRefusal({ code: '23514' }), true)
    assert.equal(isGuardRefusal({ code: '42501' }), false)
    assert.equal(isGuardRefusal(null), false)
  })
})

// ── Slug twin ───────────────────────────────────────────────────────────

describe('isValidPartnerSlug', () => {
  it('mirrors the 061 CHECK', () => {
    assert.equal(isValidPartnerSlug('north-hill-cdc'), true)
    assert.equal(isValidPartnerSlug('a1'), true)
    assert.equal(isValidPartnerSlug('a'), false)          // too short
    assert.equal(isValidPartnerSlug('-nope'), false)      // bad first char
    assert.equal(isValidPartnerSlug('No-Caps'), false)
    assert.equal(isValidPartnerSlug('a'.repeat(64)), false) // too long
    assert.equal(isValidPartnerSlug('a'.repeat(63)), true)
  })
})
