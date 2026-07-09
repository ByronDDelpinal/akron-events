/**
 * test-wine-mill.js — pure helpers for The Wine Mill Tribe scraper.
 * Fixtures reflect the REAL feed shape captured 2026-07-08 (all-day entries,
 * drink-special vs music categories, no venue objects).
 *
 * Run:  node --test scripts/tests/test-wine-mill.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { includeEvent, parseCategory, buildSourceId, SOURCE_KEY } =
  await import('../scrape-wine-mill.js')

// Captured 2026-07-08 (trimmed)
const WINE_WEDNESDAY = {
  id: 9001, title: 'House Wine Wednesday!', all_day: true,
  start_date: '2026-07-08 00:00:00',
  categories: [{ name: 'Drink Special', slug: 'drink-special' }],
}
const LIVE_MUSIC = {
  id: 9002, title: 'Live Music &#8211; Weniger &#038; Simon', all_day: true,
  start_date: '2026-07-10 00:00:00',
  categories: [{ name: 'Music', slug: 'music' }],
}

describe('includeEvent', () => {
  it('skips drink specials — pricing promos are not events', () => {
    assert.equal(includeEvent(WINE_WEDNESDAY), false)
  })
  it('keeps live music', () => {
    assert.equal(includeEvent(LIVE_MUSIC), true)
  })
})

describe('parseCategory', () => {
  it('music category maps to music', () => {
    assert.equal(parseCategory(LIVE_MUSIC.categories), 'music')
  })
  it('unknown categories defer to inference', () => {
    assert.equal(parseCategory([]), null)
  })
})

describe('buildSourceId', () => {
  it('is per-occurrence (weekly series repeat ids)', () => {
    assert.equal(buildSourceId(LIVE_MUSIC), '9002-2026-07-10')
    assert.notEqual(buildSourceId(LIVE_MUSIC), buildSourceId({ ...LIVE_MUSIC, start_date: '2026-07-17 00:00:00' }))
  })
})

describe('module contract', () => {
  it('exports the manifest source key', () => {
    assert.equal(SOURCE_KEY, 'wine_mill')
  })
})
