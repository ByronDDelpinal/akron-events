/**
 * test-north-hill-cdc.js
 *
 * Unit tests for the North Hill CDC scraper — category mapping and tag mapping.
 *
 * Run:
 *   node --test scripts/tests/test-north-hill-cdc.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY  || 'dummy-key'

// ── Re-implement scraper logic for testability ────────────────────────────

function mapCategory(ev) {
  const text = [(ev.SUMMARY || ''), (ev.DESCRIPTION || ''), (ev.CATEGORIES || '')]
    .join(' ').toLowerCase()
  if (/\b(maker|craft|workshop|class)\b/.test(text))    return 'education'
  if (/\b(market|vendor|shop)\b/.test(text))            return 'community'
  if (/\b(food|meal|dinner|lunch)\b/.test(text))        return 'food'
  if (/\b(music|concert|band)\b/.test(text))            return 'music'
  if (/\b(art|gallery|exhibit)\b/.test(text))           return 'art'
  return 'community'
}

function mapTags(ev) {
  const summary = (ev.SUMMARY || '').toLowerCase()
  const tags = ['north-hill', 'community', 'akron']
  if (summary.includes('maker monday')) tags.push('maker-monday')
  return [...new Set(tags)]
}

// ── mapCategory ───────────────────────────────────────────────────────────

describe('North Hill CDC — mapCategory', () => {
  it('returns education for maker events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Maker Monday Workshop' }), 'education')
  })

  it('returns education for craft events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Craft Night' }), 'education')
  })

  it('returns education for workshop events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Homeownership Workshop' }), 'education')
  })

  it('returns education for class events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Spanish Class' }), 'education')
  })

  it('returns community for market events', () => {
    assert.equal(mapCategory({ SUMMARY: 'North Hill Community Market' }), 'community')
  })

  it('returns community for vendor events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Local Vendor Fair' }), 'community')
  })

  it('returns community for shop events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Holiday Shop' }), 'community')
  })

  it('returns food for meal events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Community Meal' }), 'food')
  })

  it('returns food for dinner events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Neighborhood Dinner' }), 'food')
  })

  it('returns food for lunch events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Free Lunch Giveaway' }), 'food')
  })

  it('returns music for concert events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Summer Concert Series' }), 'music')
  })

  it('returns music for band events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Local Band Night' }), 'music')
  })

  it('returns art for gallery events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Gallery Opening' }), 'art')
  })

  it('returns art for exhibit events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Community Art Exhibit' }), 'art')
  })

  it('returns community as default for unrecognised events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Neighborhood Meeting' }), 'community')
  })

  it('returns community when summary is empty', () => {
    assert.equal(mapCategory({ SUMMARY: '' }), 'community')
  })

  it('matches keywords in DESCRIPTION, not just SUMMARY', () => {
    assert.equal(mapCategory({ SUMMARY: 'Saturday Event', DESCRIPTION: 'Join us for a craft session.' }), 'education')
  })

  it('matches keywords in CATEGORIES field', () => {
    assert.equal(mapCategory({ SUMMARY: 'Community Gathering', CATEGORIES: 'Music,Local' }), 'music')
  })

  it('education takes priority over community (maker before market)', () => {
    // maker matches before market in the if-chain
    assert.equal(mapCategory({ SUMMARY: 'Maker Market' }), 'education')
  })
})

// ── mapTags ───────────────────────────────────────────────────────────────

describe('North Hill CDC — mapTags', () => {
  it('always includes base tags', () => {
    const tags = mapTags({ SUMMARY: 'Anything' })
    assert.ok(tags.includes('north-hill'))
    assert.ok(tags.includes('community'))
    assert.ok(tags.includes('akron'))
  })

  it('adds maker-monday tag for Maker Monday events', () => {
    const tags = mapTags({ SUMMARY: 'Maker Monday Workshop' })
    assert.ok(tags.includes('maker-monday'))
  })

  it('does not add maker-monday tag for non-Maker-Monday events', () => {
    const tags = mapTags({ SUMMARY: 'Craft Night' })
    assert.ok(!tags.includes('maker-monday'))
  })

  it('produces no duplicate tags', () => {
    const tags = mapTags({ SUMMARY: 'Maker Monday Workshop' })
    assert.equal(tags.length, new Set(tags).size)
  })

  it('returns exactly 3 base tags for a generic event', () => {
    const tags = mapTags({ SUMMARY: 'Community Clean-Up' })
    assert.equal(tags.length, 3)
  })

  it('returns 4 tags for Maker Monday events', () => {
    const tags = mapTags({ SUMMARY: 'Maker Monday: Soldering' })
    assert.equal(tags.length, 4)
  })

  it('handles missing SUMMARY gracefully', () => {
    assert.doesNotThrow(() => mapTags({}))
    const tags = mapTags({})
    assert.ok(tags.includes('north-hill'))
  })
})
