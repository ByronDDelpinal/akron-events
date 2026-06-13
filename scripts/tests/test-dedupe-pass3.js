/**
 * test-dedupe-pass3.js — exercises the REAL dedupe-cross-source.js module
 * (not inlined copies), focused on Pass 3: collapsing a re-syndicator's
 * placeholder-/wrong-time copy onto a first-party copy of the same show on the
 * same day, without ever merging two genuine same-day shows.
 *
 * Run:
 *   node --test scripts/tests/test-dedupe-pass3.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// The module constructs a Supabase client at import time — give it dummy creds.
process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  findDuplicateGroups,
  strongTitlesMatch,
  isLowConfidenceAggregatorTime,
  fuzzyTitlesMatch,
} = await import('../dedupe-cross-source.js')

// ── Builders ────────────────────────────────────────────────────────────────
const MUSICA = '51 E Market St'
const venueAt = (addr) => [{ venue_id: `v-${addr}`, venues: { name: addr, address: addr } }]
let _n = 0
function ev({ title, source, start, end = null, addr = MUSICA, img = null, desc = null }) {
  return {
    id: `e${++_n}`, title, source, start_at: start, end_at: end,
    image_url: img, description: desc, manual_overrides: {}, event_venues: venueAt(addr),
  }
}
const sources = (group) => group.map((e) => e.source).sort()

describe('Pass 3 helpers', () => {
  it('strongTitlesMatch: containment', () => {
    assert.ok(strongTitlesMatch('Mac Saturn', 'Mac Saturn w/ The Sweet Spot'))
  })
  it('strongTitlesMatch: shared headliner prefix across divergent suffixes', () => {
    assert.ok(strongTitlesMatch('Mac Saturn w/ The Sweet Spot', 'Mac Saturn Live at Musica'))
  })
  it('strongTitlesMatch: rejects different acts', () => {
    assert.ok(!strongTitlesMatch('Hamlet Matinee', 'Macbeth Evening'))
    assert.ok(!strongTitlesMatch('The Black Keys', 'The Black Crowes'))
  })
  it('isLowConfidenceAggregatorTime: CVB 9 AM placeholder is low-confidence', () => {
    assert.ok(isLowConfidenceAggregatorTime({ source: 'visit_akron_cvb', start_at: '2026-06-13T13:00:00Z', end_at: null }))
  })
  it('isLowConfidenceAggregatorTime: trusted sources never are', () => {
    assert.ok(!isLowConfidenceAggregatorTime({ source: 'musica', start_at: '2026-06-13T13:00:00Z', end_at: null }))
    assert.ok(!isLowConfidenceAggregatorTime({ source: 'ticketmaster', start_at: '2026-06-14T00:00:00Z', end_at: null }))
  })
})

describe('Pass 3 — placeholder-time collapse', () => {
  it('collapses a CVB 9 AM copy onto the first-party 8 PM copy (same venue, same ET day)', () => {
    const musica = ev({ title: 'Mac Saturn w/ The Sweet Spot', source: 'musica', start: '2026-06-14T00:00:00Z', end: '2026-06-14T04:00:00Z', img: 'x', desc: 'a real description over twenty chars' })
    const cvb    = ev({ title: 'Mac Saturn Live at Musica',     source: 'visit_akron_cvb', start: '2026-06-13T13:00:00Z', end: null, img: 'y' })
    const { groups } = findDuplicateGroups([musica, cvb])
    assert.equal(groups.length, 1)
    assert.deepEqual(sources(groups[0]), ['musica', 'visit_akron_cvb'])
  })

  it('does NOT merge two genuine same-day, same-venue first-party shows (matinee + evening)', () => {
    const matinee = ev({ title: 'Hamlet', source: 'players_guild', start: '2026-06-13T18:00:00Z' }) // 2 PM ET
    const evening = ev({ title: 'Hamlet', source: 'players_guild', start: '2026-06-14T00:00:00Z' }) // 8 PM ET
    assert.equal(findDuplicateGroups([matinee, evening]).groups.length, 0)
  })

  it('does NOT latch a placeholder copy onto an unrelated same-day show', () => {
    const real = ev({ title: 'Mac Saturn w/ The Sweet Spot', source: 'musica', start: '2026-06-14T00:00:00Z', end: '2026-06-14T04:00:00Z' })
    const cvb  = ev({ title: 'Taylor Swift Tribute Night',    source: 'visit_akron_cvb', start: '2026-06-13T13:00:00Z', end: null })
    assert.equal(findDuplicateGroups([real, cvb]).groups.length, 0)
  })

  it('does NOT merge across different venues', () => {
    const real = ev({ title: 'Mac Saturn', source: 'musica',         start: '2026-06-14T00:00:00Z', end: '2026-06-14T04:00:00Z', addr: MUSICA })
    const cvb  = ev({ title: 'Mac Saturn', source: 'visit_akron_cvb', start: '2026-06-13T13:00:00Z', end: null, addr: '999 Other Rd' })
    assert.equal(findDuplicateGroups([real, cvb]).groups.length, 0)
  })
})

describe('Passes 1 & 2 — regression (unchanged)', () => {
  it('Pass 2 still merges a 1-hour doors/show gap with fuzzy title', () => {
    const akronLife = ev({ title: 'Mac Saturn', source: 'akron_life', start: '2026-06-13T23:00:00Z' })
    const musica    = ev({ title: 'Mac Saturn w/ The Sweet Spot', source: 'musica', start: '2026-06-14T00:00:00Z', end: '2026-06-14T04:00:00Z' })
    assert.equal(findDuplicateGroups([akronLife, musica]).groups.length, 1)
  })
  it('Pass 1 merges identical start_at + matching title', () => {
    const a = ev({ title: 'River Concert', source: 'eventbrite', start: '2026-06-20T23:00:00Z' })
    const b = ev({ title: 'River Concert', source: 'downtown_akron', start: '2026-06-20T23:00:00Z' })
    assert.equal(findDuplicateGroups([a, b]).groups.length, 1)
  })
  it('fuzzyTitlesMatch unchanged', () => {
    assert.ok(fuzzyTitlesMatch('Mac Saturn', 'Mac Saturn w/ The Sweet Spot'))
  })
})
