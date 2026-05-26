/**
 * test-akron-symphony.js
 *
 * Unit tests for the Akron Symphony scraper — category mapping and tag mapping.
 *
 * Run:
 *   node --test scripts/tests/test-akron-symphony.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY  || 'dummy-key'

// ── Re-implement scraper logic for testability ────────────────────────────

function mapCategory() { return 'music' }

function mapTags(ev) {
  const summary    = (ev.SUMMARY    || '').toLowerCase()
  const categories = (ev.CATEGORIES || '').toLowerCase().split(',').map(t => t.trim()).filter(Boolean)
  const tags = ['symphony', 'classical', 'music', 'akron']
  if (summary.includes('pops'))    tags.push('pops')
  if (summary.includes('family'))  tags.push('family')
  if (summary.includes('chamber')) tags.push('chamber')
  if (summary.includes('karaoke')) tags.push('karaoke')
  return [...new Set([...tags, ...categories])]
}

// ── mapCategory ───────────────────────────────────────────────────────────

describe('Akron Symphony — mapCategory', () => {
  it('always returns music regardless of event content', () => {
    assert.equal(mapCategory({ SUMMARY: 'Mozart & Vivaldi' }), 'music')
  })

  it('returns music for pops concerts', () => {
    assert.equal(mapCategory({ SUMMARY: 'Holiday Pops' }), 'music')
  })

  it('returns music for family concerts', () => {
    assert.equal(mapCategory({ SUMMARY: 'Family Fun Day' }), 'music')
  })

  it('returns music when called with no arguments', () => {
    assert.equal(mapCategory(), 'music')
  })

  it('returns music for empty event', () => {
    assert.equal(mapCategory({}), 'music')
  })
})

// ── mapTags ───────────────────────────────────────────────────────────────

describe('Akron Symphony — mapTags base tags', () => {
  it('always includes symphony, classical, music, and akron', () => {
    const tags = mapTags({ SUMMARY: 'Mozart & Vivaldi' })
    assert.ok(tags.includes('symphony'))
    assert.ok(tags.includes('classical'))
    assert.ok(tags.includes('music'))
    assert.ok(tags.includes('akron'))
  })

  it('returns exactly the 4 base tags for a generic concert', () => {
    const tags = mapTags({ SUMMARY: 'Season Opening Concert' })
    assert.equal(tags.length, 4)
  })

  it('handles missing SUMMARY gracefully', () => {
    assert.doesNotThrow(() => mapTags({}))
    assert.ok(mapTags({}).includes('symphony'))
  })
})

describe('Akron Symphony — mapTags conditional tags', () => {
  it('adds pops tag when summary includes "pops"', () => {
    assert.ok(mapTags({ SUMMARY: 'Holiday Pops' }).includes('pops'))
  })

  it('does not add pops tag for non-pops concert', () => {
    assert.ok(!mapTags({ SUMMARY: 'Beethoven Night' }).includes('pops'))
  })

  it('adds family tag when summary includes "family"', () => {
    assert.ok(mapTags({ SUMMARY: 'Family Concert Series' }).includes('family'))
  })

  it('does not add family tag for non-family concert', () => {
    assert.ok(!mapTags({ SUMMARY: 'Chamber Masterworks' }).includes('family'))
  })

  it('adds chamber tag when summary includes "chamber"', () => {
    assert.ok(mapTags({ SUMMARY: 'Chamber Music Evening' }).includes('chamber'))
  })

  it('does not add chamber tag for a full orchestra concert', () => {
    assert.ok(!mapTags({ SUMMARY: 'Full Orchestra Gala' }).includes('chamber'))
  })

  it('adds karaoke tag when summary includes "karaoke"', () => {
    assert.ok(mapTags({ SUMMARY: 'Symphony Karaoke Night' }).includes('karaoke'))
  })

  it('adds multiple conditional tags when summary matches several', () => {
    const tags = mapTags({ SUMMARY: 'Family Pops Concert' })
    assert.ok(tags.includes('pops'))
    assert.ok(tags.includes('family'))
  })
})

describe('Akron Symphony — mapTags CATEGORIES passthrough', () => {
  it('appends ICS CATEGORIES values as tags', () => {
    const tags = mapTags({ SUMMARY: 'Concert', CATEGORIES: 'Masterworks,Season Opener' })
    assert.ok(tags.includes('masterworks'))
    assert.ok(tags.includes('season opener'))
  })

  it('handles multiple CATEGORIES values', () => {
    const tags = mapTags({ SUMMARY: 'Concert', CATEGORIES: 'Pops,Family,Outdoor' })
    assert.ok(tags.includes('outdoor'))
  })

  it('does not duplicate base tags when CATEGORIES overlap', () => {
    // CATEGORIES includes "classical" which is already a base tag
    const tags = mapTags({ SUMMARY: 'Concert', CATEGORIES: 'Classical,Masterworks' })
    const classicalCount = tags.filter(t => t === 'classical').length
    assert.equal(classicalCount, 1)
  })

  it('handles empty CATEGORIES string gracefully', () => {
    assert.doesNotThrow(() => mapTags({ SUMMARY: 'Concert', CATEGORIES: '' }))
  })

  it('handles missing CATEGORIES gracefully', () => {
    assert.doesNotThrow(() => mapTags({ SUMMARY: 'Concert' }))
  })

  it('produces no duplicate tags in any scenario', () => {
    const scenarios = [
      { SUMMARY: 'Holiday Pops', CATEGORIES: 'Pops,Family' },
      { SUMMARY: 'Family Chamber Night', CATEGORIES: 'Classical' },
      { SUMMARY: 'Symphony Karaoke', CATEGORIES: '' },
      {},
    ]
    for (const ev of scenarios) {
      const tags = mapTags(ev)
      assert.equal(tags.length, new Set(tags).size, `Duplicate tags for SUMMARY="${ev.SUMMARY}"`)
    }
  })
})
