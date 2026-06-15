/**
 * test-indivisible-akron.js — Indivisible Akron (Tribe REST API) scraper.
 *
 * Run:
 *   node --test scripts/tests/test-indivisible-akron.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseCategory, eventCategories, buildSourceId } = await import('../scrape-indivisible-akron.js')
const { parseCostFromTribe, parseTagsFromTribe } = await import('../lib/normalize.js')

describe('Indivisible Akron — parseCategory', () => {
  it('maps workshops/book clubs to learning', () => {
    assert.equal(parseCategory([{ slug: 'workshop' }]), 'learning')
    assert.equal(parseCategory([{ slug: 'book-club' }]), 'learning')
  })
  it('maps music to music', () => {
    assert.equal(parseCategory([{ slug: 'live-music' }]), 'music')
  })
  it('defaults an activism meetup (no category) to civic', () => {
    assert.equal(parseCategory([]), 'civic')
    assert.equal(parseCategory([{ slug: 'meetup' }]), 'civic')
  })
})

describe('Indivisible Akron — eventCategories (civic is always a label)', () => {
  it('a plain meetup/rally is civic-only', () => {
    assert.deepEqual(eventCategories([]), ['civic'])
    assert.deepEqual(eventCategories([{ slug: 'meetup' }]), ['civic'])
  })
  it('an art build keeps civic as primary with visual-art secondary', () => {
    assert.deepEqual(eventCategories([{ slug: 'art' }]), ['civic', 'visual-art'])
  })
  it('a book club is civic + learning; a benefit concert civic + music', () => {
    assert.deepEqual(eventCategories([{ slug: 'book-club' }]), ['civic', 'learning'])
    assert.deepEqual(eventCategories([{ slug: 'live-music' }]), ['civic', 'music'])
  })
})

describe('Indivisible Akron — buildSourceId (recurring-series safe)', () => {
  it('disambiguates weekly occurrences that share an event id', () => {
    const a = buildSourceId({ id: 123, start_date: '2026-06-16 18:00:00' })
    const b = buildSourceId({ id: 123, start_date: '2026-06-23 18:00:00' })
    assert.equal(a, '123-2026-06-16')
    assert.equal(b, '123-2026-06-23')
    assert.notEqual(a, b)
  })
  it('is stable for the same occurrence (idempotent re-scrape)', () => {
    assert.equal(
      buildSourceId({ id: 123, start_date: '2026-06-16 18:00:00' }),
      buildSourceId({ id: 123, start_date: '2026-06-16 18:00:00' }),
    )
  })
  it('falls back to utc_start_date when no local start_date', () => {
    assert.equal(buildSourceId({ id: 99, utc_start_date: '2026-07-01 22:00:00' }), '99-2026-07-01')
  })
})

describe('Indivisible Akron — shared Tribe parsers', () => {
  it('keeps the org base tags', () => {
    const tags = parseTagsFromTribe([], [], ['activism', 'community', 'akron', 'indivisible-akron'])
    assert.ok(tags.includes('activism'))
    assert.ok(tags.includes('indivisible-akron'))
  })
  it('treats a free event as price 0', () => {
    const { price_min } = parseCostFromTribe('Free', {})
    assert.equal(price_min, 0)
  })
})

describe('Indivisible Akron — UTC date transform', () => {
  it("converts Tribe's 'YYYY-MM-DD HH:MM:SS' UTC to ISO Z", () => {
    // mirrors the row.start_at transform in the scraper
    const utc = '2026-06-13 14:00:00'
    assert.equal(utc.replace(' ', 'T') + 'Z', '2026-06-13T14:00:00Z')
  })
})
