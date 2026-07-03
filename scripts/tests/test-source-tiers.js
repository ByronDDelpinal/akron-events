/**test-source-tiers.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import {
  sourceTier,
  isAggregatorSource,
  isTrustedSource,
  classifyAgainstTrusted,
  TIER_VENUE_OFFICIAL,
  TIER_PLATFORM,
  TIER_AGGREGATOR,
} from '../lib/source-tiers.js'

describe('source-tiers: sourceTier', () => {
  it('classifies known aggregators as Tier 3', () => {
    assert.equal(sourceTier('downtown_akron'), TIER_AGGREGATOR)
    assert.equal(sourceTier('ticketmaster'), TIER_AGGREGATOR)
    assert.equal(sourceTier('eventbrite'), TIER_AGGREGATOR)
  })

  it('classifies known platforms as Tier 2', () => {
    assert.equal(sourceTier('akron_library'), TIER_PLATFORM)
    assert.equal(sourceTier('akron_rec_parks'), TIER_PLATFORM)
  })

  it('defaults unlisted sources to Tier 1', () => {
    assert.equal(sourceTier('painting_twist'), TIER_VENUE_OFFICIAL)
    assert.equal(sourceTier('some_new_scraper'), TIER_VENUE_OFFICIAL)
  })

  it('isAggregatorSource / isTrustedSource agree with tier', () => {
    assert.equal(isAggregatorSource('downtown_akron'), true)
    assert.equal(isTrustedSource('downtown_akron'), false)
    assert.equal(isAggregatorSource('stan_hywet'), false)
    assert.equal(isTrustedSource('stan_hywet'), true)
  })
})

describe('source-tiers: classifyAgainstTrusted', () => {
  it('publishes normally when the venue has no trusted coverage', () => {
    const result = classifyAgainstTrusted([], '2026-07-02T18:30:00Z')
    assert.deepEqual(result, { suppress: false, needsReview: false })
  })

  it('suppresses when a trusted event is within the window at the same venue', () => {
    // Riftbound TCG Nexus Nights (DAP: Thu 7/2) vs full_grip_games' actual
    // weekly Friday slot (7/3) — 1 day apart, within the 3-day window.
    const trusted = [{ source: 'full_grip_games', start_at: '2026-07-03T22:30:00Z' }]
    const result = classifyAgainstTrusted(trusted, '2026-07-02T22:30:00Z')
    assert.deepEqual(result, { suppress: true, needsReview: false })
  })

  it('flags needs_review when trusted coverage exists but nothing is nearby', () => {
    // Free Thursday at Akron Art Museum — akron_art_museum is scraped, but
    // its nearest trusted event is 10 days away, not the same recurring program.
    const trusted = [{ source: 'akron_art_museum', start_at: '2026-07-12T16:00:00Z' }]
    const result = classifyAgainstTrusted(trusted, '2026-07-02T16:00:00Z')
    assert.deepEqual(result, { suppress: false, needsReview: true })
  })

  it('respects a custom window size', () => {
    const trusted = [{ source: 'stan_hywet', start_at: '2026-07-10T12:00:00Z' }]
    const near = classifyAgainstTrusted(trusted, '2026-07-02T12:00:00Z', { windowDays: 10 })
    assert.equal(near.suppress, true)
    const far = classifyAgainstTrusted(trusted, '2026-07-02T12:00:00Z', { windowDays: 3 })
    assert.equal(far.suppress, false)
    assert.equal(far.needsReview, true)
  })

  it('is defensive against a bad start_at', () => {
    const result = classifyAgainstTrusted([{ source: 'x', start_at: 'not-a-date' }], 'also-not-a-date')
    assert.deepEqual(result, { suppress: false, needsReview: false })
  })
})
