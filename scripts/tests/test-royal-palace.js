/**
 * test-royal-palace.js — category + source_id mapping for the Royal Palace
 * Tribe scraper. The Tribe REST fetch itself is covered by the shared pattern;
 * here we lock the music-leaning category hint and per-occurrence source_id.
 *
 * Run:  node --test scripts/tests/test-royal-palace.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseCategory, buildSourceId, SOURCE_KEY } = await import('../scrape-royal-palace.js')

describe('Royal Palace parseCategory', () => {
  it('music for live/concert/bailazo/banda/dance categories', () => {
    assert.equal(parseCategory([{ slug: 'live-music', name: 'Live Music' }]), 'music')
    assert.equal(parseCategory([{ name: 'Concert' }]), 'music')
    assert.equal(parseCategory([{ name: 'Gran Bailazo' }]), 'music')
    assert.equal(parseCategory([{ slug: 'banda' }]), 'music')
  })
  it('null (defer to inference) for unmapped or empty categories', () => {
    assert.equal(parseCategory([{ name: 'Private Event' }]), null)
    assert.equal(parseCategory([]), null)
  })
})

describe('Royal Palace buildSourceId', () => {
  it('appends the local start date so recurring occurrences stay distinct', () => {
    assert.equal(buildSourceId({ id: 42, start_date: '2026-07-04 20:00:00' }), '42-2026-07-04')
    assert.equal(buildSourceId({ id: 7, utc_start_date: '2026-07-05 01:00:00' }), '7-2026-07-05')
  })
  it('falls back to the bare id when no date is present', () => {
    assert.equal(buildSourceId({ id: 99 }), '99')
  })
  it('uses the right source key', () => {
    assert.equal(SOURCE_KEY, 'royal_palace')
  })
})
