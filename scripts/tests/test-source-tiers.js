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
  classifyAggregatorEvent,
  aggregatorRank,
  titleKey,
  AGGREGATOR_PRIORITY,
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

describe('source-tiers: aggregatorRank', () => {
  it('every Tier-3 source is ranked, and rank order matches the list', () => {
    for (const [i, source] of AGGREGATOR_PRIORITY.entries()) {
      assert.equal(aggregatorRank(source), i)
      assert.equal(isAggregatorSource(source), true, `${source} must be Tier 3`)
    }
  })

  it('ranks unlisted sources last', () => {
    assert.equal(aggregatorRank('some_future_aggregator'), AGGREGATOR_PRIORITY.length)
  })

  it('eventbrite outranks downtown_akron', () => {
    assert.ok(aggregatorRank('eventbrite') < aggregatorRank('downtown_akron'))
  })
})

describe('source-tiers: classifyAggregatorEvent', () => {
  // The 2026-07-04 regression: eventbrite already carried "Vinyasa Yoga on
  // the Plaza" (Cascade Plaza, 2026-07-07 21:30:00Z) and a DAP copy with the
  // identical venue/second/title published anyway, surviving until the next
  // dedupe run (which then didn't happen for 3 days).
  const vinyasaEB = { source: 'eventbrite', start_at: '2026-07-07T21:30:00Z', title: 'Vinyasa Yoga on the Plaza' }
  const vinyasaDAP = { source: 'downtown_akron', startAt: '2026-07-07T21:30:00Z', title: 'Vinyasa Yoga on the Plaza' }

  it('suppresses a copy already held by a higher-priority aggregator (same venue/second/title)', () => {
    const result = classifyAggregatorEvent([vinyasaEB], vinyasaDAP)
    assert.deepEqual(result, { suppress: true, needsReview: false, reason: 'higher-priority-aggregator' })
  })

  it('does NOT suppress in the reverse direction (lower-priority copy present)', () => {
    const dapRow = { source: 'downtown_akron', start_at: '2026-07-07T21:30:00Z', title: 'Vinyasa Yoga on the Plaza' }
    const ebCandidate = { source: 'eventbrite', startAt: '2026-07-07T21:30:00Z', title: 'Vinyasa Yoga on the Plaza' }
    const result = classifyAggregatorEvent([dapRow], ebCandidate)
    assert.deepEqual(result, { suppress: false, needsReview: false, reason: null })
  })

  it('never suppresses against its own source (re-scrape of an existing row)', () => {
    const ownRow = { source: 'downtown_akron', start_at: '2026-07-07T21:30:00Z', title: 'Vinyasa Yoga on the Plaza' }
    const result = classifyAggregatorEvent([ownRow], vinyasaDAP)
    assert.deepEqual(result, { suppress: false, needsReview: false, reason: null })
  })

  it('requires an exact-second match — a 30-minute drift is left to dedupe', () => {
    const drifted = { ...vinyasaDAP, startAt: '2026-07-07T21:00:00Z' }
    const result = classifyAggregatorEvent([vinyasaEB], drifted)
    assert.deepEqual(result, { suppress: false, needsReview: false, reason: null })
  })

  it('requires a title match — same venue+second with a different title publishes', () => {
    // Parallel programs at one venue/time are real (library rooms)
    const otherProgram = { ...vinyasaDAP, title: 'Sunset Tai Chi on the Plaza' }
    const result = classifyAggregatorEvent([vinyasaEB], otherProgram)
    assert.deepEqual(result, { suppress: false, needsReview: false, reason: null })
  })

  it('title matching is punctuation/case-insensitive', () => {
    const styled = { ...vinyasaDAP, title: 'VINYASA YOGA — on the Plaza!' }
    const result = classifyAggregatorEvent([vinyasaEB], styled)
    assert.equal(result.suppress, true)
    assert.equal(result.reason, 'higher-priority-aggregator')
  })

  it('sub-second timestamps still match on the whole-second key', () => {
    const squarespaceStyle = { ...vinyasaEB, start_at: '2026-07-07T21:30:00.219Z' }
    const result = classifyAggregatorEvent([squarespaceStyle], vinyasaDAP)
    assert.equal(result.suppress, true)
  })

  it('trusted-nearby suppression still takes precedence (reason reflects it)', () => {
    const trusted = { source: 'stan_hywet', start_at: '2026-07-07T21:30:00Z', title: 'Vinyasa Yoga on the Plaza' }
    const result = classifyAggregatorEvent([trusted, vinyasaEB], vinyasaDAP)
    assert.deepEqual(result, { suppress: true, needsReview: false, reason: 'trusted-nearby' })
  })

  it('preserves the needs_review path when trusted coverage exists but nothing nearby', () => {
    const farTrusted = { source: 'akron_art_museum', start_at: '2026-07-20T16:00:00Z', title: 'Free Thursday' }
    const result = classifyAggregatorEvent([farTrusted], vinyasaDAP)
    assert.deepEqual(result, { suppress: false, needsReview: true, reason: 'trusted-not-nearby' })
  })

  it('publishes normally at an uncovered venue', () => {
    const result = classifyAggregatorEvent([], vinyasaDAP)
    assert.deepEqual(result, { suppress: false, needsReview: false, reason: null })
  })

  it('is defensive against missing titles and bad dates', () => {
    const noTitle = { source: 'downtown_akron', startAt: '2026-07-07T21:30:00Z', title: null }
    assert.equal(classifyAggregatorEvent([vinyasaEB], noTitle).suppress, false)
    const badDate = { source: 'downtown_akron', startAt: 'not-a-date', title: 'X' }
    assert.equal(classifyAggregatorEvent([vinyasaEB], badDate).suppress, false)
  })
})

describe('source-tiers: titleKey', () => {
  it('folds case, punctuation, and apostrophes like dedupe normalizeTitle', () => {
    assert.equal(titleKey("Akron's Best — Night! Out"), 'akrons best night out')
    assert.equal(titleKey(null), '')
  })
})
