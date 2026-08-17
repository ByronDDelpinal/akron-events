/**
 * test-pageviews-api.js — pure helpers behind /api/pageviews.
 *
 * The handler itself needs GA4 credentials and network; the sustained-host
 * policy (what counts as a real embed partner on /financials) is pure logic
 * and is what actually needs pinning: one-time referral spikes must NOT
 * appear as partners, steady multi-week traffic must.
 *
 * Run:  node --test scripts/tests/test-pageviews-api.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const { aggregateSustainedHosts, isoWeekKey } = await import('../../api/pageviews.js')

describe('isoWeekKey', () => {
  it('maps GA4 date strings to ISO weeks', () => {
    assert.equal(isoWeekKey('20260105'), '2026-W02') // Mon Jan 5 2026
    assert.equal(isoWeekKey('20260111'), '2026-W02') // Sun of the same ISO week
    assert.equal(isoWeekKey('20260112'), '2026-W03') // next Monday
  })
  it('assigns year-boundary days to the ISO year of their Thursday', () => {
    assert.equal(isoWeekKey('20260101'), '2026-W01') // Thu Jan 1 2026
    assert.equal(isoWeekKey('20241231'), '2025-W01') // Tue Dec 31 2024 → ISO 2025
  })
})

describe('aggregateSustainedHosts', () => {
  const day = (host, date, views) => ({ host, date, views })

  it('includes hosts with enough views across enough weeks', () => {
    const rows = [
      day('betterkenmore.org', '20260601', 60),
      day('betterkenmore.org', '20260610', 60), // different ISO week
    ]
    assert.deepEqual(aggregateSustainedHosts(rows), [
      { host: 'betterkenmore.org', views: 120 },
    ])
  })

  it('excludes one-time referral spikes, however large', () => {
    const rows = [day('viral-blog.example', '20260601', 5000)]
    assert.deepEqual(aggregateSustainedHosts(rows), []) // one week only
  })

  it('excludes steady hosts below the view floor', () => {
    const rows = [
      day('tiny.example', '20260601', 10),
      day('tiny.example', '20260610', 10),
      day('tiny.example', '20260620', 10),
    ]
    assert.deepEqual(aggregateSustainedHosts(rows), [])
  })

  it('ignores sentinel and self hosts', () => {
    const rows = [
      day('(direct)', '20260601', 500), day('(direct)', '20260610', 500),
      day('(not set)', '20260601', 500), day('(not set)', '20260610', 500),
      day('akronpulse.com', '20260601', 500), day('akronpulse.com', '20260610', 500),
      day('localhost', '20260601', 500), day('localhost', '20260610', 500),
    ]
    assert.deepEqual(aggregateSustainedHosts(rows), [])
  })

  it('sums a host across many days and sorts partners by volume', () => {
    const rows = [
      day('a.example', '20260601', 50), day('a.example', '20260608', 50),
      day('a.example', '20260615', 50),
      day('b.example', '20260601', 300), day('b.example', '20260615', 300),
    ]
    assert.deepEqual(aggregateSustainedHosts(rows), [
      { host: 'b.example', views: 600 },
      { host: 'a.example', views: 150 },
    ])
  })

  it('honors custom thresholds', () => {
    const rows = [day('a.example', '20260601', 5), day('a.example', '20260610', 5)]
    assert.deepEqual(
      aggregateSustainedHosts(rows, { minViews: 10, minWeeks: 2 }),
      [{ host: 'a.example', views: 10 }],
    )
  })

  it('does not count a zero-view day toward the week spread', () => {
    const rows = [
      day('a.example', '20260601', 200),
      day('a.example', '20260610', 0),
    ]
    assert.deepEqual(aggregateSustainedHosts(rows), [])
  })
})
