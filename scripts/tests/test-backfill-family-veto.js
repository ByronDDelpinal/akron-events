/**
 * test-backfill-family-veto.js
 *
 * The family-veto backfill must never touch a manual_overrides.is_family
 * lock, and must only propose rows the real veto actually fires on. These
 * tests pin the eligibility gate and the candidate-selection wiring; the
 * script's dry-run/--write/--max-updates CLI behavior is exercised by hand
 * (this script is never run automatically — see the file header).
 *
 * Run:  node --test scripts/tests/test-backfill-family-veto.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { isEligible, findVetoCandidates } = await import('../backfill-family-veto.js')

describe('isEligible: never touch a manual_overrides.is_family lock', () => {
  it('eligible when there is no manual_overrides at all', () => {
    assert.equal(isEligible({}), true)
    assert.equal(isEligible({ manual_overrides: null }), true)
    assert.equal(isEligible({ manual_overrides: {} }), true)
  })

  it('eligible when manual_overrides locks an unrelated field', () => {
    assert.equal(isEligible({ manual_overrides: { title: { at: '2026-01-01T00:00:00Z' } } }), true)
  })

  it('ineligible when is_family is locked, either marker shape', () => {
    assert.equal(isEligible({ manual_overrides: { is_family: { at: '2026-01-01T00:00:00Z' } } }), false)
    assert.equal(isEligible({ manual_overrides: { is_family: true } }), false)
  })
})

describe('findVetoCandidates: pure selection over already-scoped rows', () => {
  const vetoAlways = () => ({ rule: 'child-harm', terms: ['x'] })
  const vetoNever = () => null

  it('proposes a row the veto fires on', () => {
    const events = [{ id: '1', title: 'a', description: 'b' }]
    const plan = findVetoCandidates(events, vetoAlways)
    assert.equal(plan.length, 1)
    assert.equal(plan[0].event.id, '1')
    assert.deepEqual(plan[0].verdict, { rule: 'child-harm', terms: ['x'] })
  })

  it('proposes nothing when the veto never fires', () => {
    const events = [{ id: '1', title: 'a', description: 'b' }]
    assert.deepEqual(findVetoCandidates(events, vetoNever), [])
  })

  it('skips a manual_overrides.is_family-locked row even when the veto would fire', () => {
    const events = [
      { id: '1', title: 'a', manual_overrides: { is_family: { at: '2026-01-01T00:00:00Z' } } },
      { id: '2', title: 'b' },
    ]
    const plan = findVetoCandidates(events, vetoAlways)
    assert.equal(plan.length, 1)
    assert.equal(plan[0].event.id, '2')
  })

  it('handles an empty/undefined input list', () => {
    assert.deepEqual(findVetoCandidates([], vetoAlways), [])
    assert.deepEqual(findVetoCandidates(undefined, vetoAlways), [])
  })

  it('real lexicon smoke test: fires on the "Baby Doe" incident text, not on a benign row', () => {
    const events = [
      {
        id: 'incident',
        title: 'Baby Doe',
        description: "At 22, Gail gave birth alone and left her newborn in the woods. Decades later, she's arrested for murder, despite claiming the baby was stillborn.",
      },
      { id: 'benign', title: 'Kids Storytime', description: 'weekly storytime for toddlers' },
    ]
    const plan = findVetoCandidates(events)
    assert.equal(plan.length, 1)
    assert.equal(plan[0].event.id, 'incident')
    assert.equal(plan[0].verdict.rule, 'child-harm')
  })
})
