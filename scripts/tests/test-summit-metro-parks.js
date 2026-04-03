/**
 * test-summit-metro-parks.js
 *
 * Comprehensive tests for the Summit Metro Parks (Tribe Events Calendar) scraper.
 * Tests every permutation of the API response structure to ensure proper
 * normalization, category mapping, tag parsing, cost parsing, and batch invariants.
 *
 * Run:
 *   node --test scripts/tests/test-summit-metro-parks.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Set dummy env vars before any imports ────────────────────────────────────
process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

// ── Import fixtures ──────────────────────────────────────────────────────────
import {
  COMPLETE_EVENT,
  FREE_EVENT,
  PAID_EVENT_RANGE,
  PAID_EVENT_SINGLE,
  NO_VENUE,
  EMPTY_VENUE_NAME,
  NO_CATEGORIES_OR_TAGS,
  NO_IMAGE,
  MISSING_START_DATE,
  FEATURED_EVENT,
  HTML_IN_DESCRIPTION,
  MULTIPLE_CATEGORIES,
  SPORTS_EVENT,
  EDUCATION_EVENT,
  ALL_FIXTURES,
} from './fixtures/summit-metro-parks-events.js'

// ── Import shared utilities (pure functions) ─────────────────────────────────
import { stripHtml, parseCostFromTribe, parseTagsFromTribe } from '../lib/normalize.js'

// ════════════════════════════════════════════════════════════════════════════
// RE-IMPLEMENT SCRAPER LOGIC FOR TESTABILITY
// ════════════════════════════════════════════════════════════════════════════

// ── Category mapping (mirrors scraper) ───────────────────────────────────────
function parseCategory(categories = [], tags = []) {
  const names = [
    ...categories.map(c => (c.name ?? c.slug ?? '').toLowerCase()),
    ...tags.map(t => (t.name ?? t.slug ?? '').toLowerCase()),
  ]
  if (names.some(n => n.includes('music') || n.includes('concert'))) return 'music'
  if (names.some(n => n.includes('sport') || n.includes('fitness') || n.includes('run') || n.includes('bike') || n.includes('paddle'))) return 'sports'
  if (names.some(n => n.includes('educat') || n.includes('program') || n.includes('class') || n.includes('workshop') || n.includes('learn'))) return 'education'
  return 'community'
}

/**
 * Simulate the event normalization pipeline for one raw Tribe API event.
 * Returns the normalized row that would be upserted, or null if skipped.
 */
function normalizeTribalEvent(ev) {
  const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
  const category = parseCategory(ev.categories, ev.tags)
  const tags = parseTagsFromTribe(ev.categories, ev.tags, ['parks', 'outdoors', 'nature'])
  const imageUrl = ev.image?.url ?? null
  const descText = stripHtml(ev.description ?? '')

  // Parse start_at from utc_start_date format: "2026-05-15 14:00:00" → ISO
  const start_at = ev.utc_start_date
    ? ev.utc_start_date.replace(' ', 'T') + 'Z'
    : null
  const end_at = ev.utc_end_date
    ? ev.utc_end_date.replace(' ', 'T') + 'Z'
    : null

  if (!start_at) return null

  return {
    title:           ev.title,
    description:     descText || null,
    start_at,
    end_at,
    category,
    tags,
    price_min,
    price_max,
    age_restriction: 'not_specified',
    image_url:       imageUrl,
    ticket_url:      ev.website || ev.url || null,
    source:          'summit_metro_parks',
    source_id:       String(ev.id),
    status:          'published',
    featured:        ev.featured ?? false,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Category Mapping
// ════════════════════════════════════════════════════════════════════════════

describe('Summit Metro Parks: Category Mapping', () => {
  it('maps music/concert tags to music', () => {
    assert.equal(parseCategory([{ name: 'Music', slug: 'music' }], []), 'music')
    assert.equal(parseCategory([{ name: 'Concert', slug: 'concert' }], []), 'music')
  })

  it('maps sport/fitness/run/bike to sports', () => {
    assert.equal(parseCategory([{ name: 'Sports', slug: 'sports' }], []), 'sports')
    assert.equal(parseCategory([{ name: 'Fitness', slug: 'fitness' }], []), 'sports')
    assert.equal(parseCategory([{ name: 'Running', slug: 'running' }], []), 'sports')
    // Note: keyword is 'bike' not 'biking', so 'Bike' or 'Biking' works via slug
    assert.equal(parseCategory([{ name: 'Bike', slug: 'bike' }], []), 'sports')
    // Note: keyword is 'paddle' not 'paddling', so 'Paddle' or 'Paddling' works via slug
    assert.equal(parseCategory([{ name: 'Paddle', slug: 'paddle' }], []), 'sports')
  })

  it('maps education/program/class/workshop/learn to education', () => {
    assert.equal(parseCategory([{ name: 'Education', slug: 'education' }], []), 'education')
    assert.equal(parseCategory([{ name: 'Program', slug: 'program' }], []), 'education')
    assert.equal(parseCategory([{ name: 'Class', slug: 'class' }], []), 'education')
    assert.equal(parseCategory([{ name: 'Workshop', slug: 'workshop' }], []), 'education')
  })

  it('defaults to community for unknown categories', () => {
    assert.equal(parseCategory([], []), 'community')
    assert.equal(parseCategory([{ name: 'Outdoor Activities', slug: 'outdoor-activities' }], []), 'community')
    assert.equal(parseCategory([{ name: 'Community Event', slug: 'community-event' }], []), 'community')
  })

  it('prioritizes music when multiple categories include music', () => {
    const cats = [
      { name: 'Music', slug: 'music' },
      { name: 'Community', slug: 'community' }
    ]
    assert.equal(parseCategory(cats, []), 'music')
  })

  it('checks tag names too for category mapping', () => {
    const cats = []
    const tags = [{ name: 'Music', slug: 'music' }]
    assert.equal(parseCategory(cats, tags), 'music')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Cost Parsing (Tribe-specific)
// ════════════════════════════════════════════════════════════════════════════

describe('Summit Metro Parks: Cost Parsing', () => {
  it('parses "Free" cost string as (0, null)', () => {
    const { price_min, price_max } = parseCostFromTribe('Free', { values: [] })
    assert.equal(price_min, 0)
    assert.equal(price_max, null)
  })

  it('parses cost_details.values array correctly', () => {
    const { price_min, price_max } = parseCostFromTribe('$15 - $25', { values: [15, 25] })
    assert.equal(price_min, 15)
    assert.equal(price_max, 25)
  })

  it('handles single price value', () => {
    const { price_min, price_max } = parseCostFromTribe('$20', { values: [20] })
    assert.equal(price_min, 20)
    assert.equal(price_max, null)
  })

  it('extracts numbers from cost string when no cost_details', () => {
    const { price_min, price_max } = parseCostFromTribe('$10 - $30', {})
    assert.equal(price_min, 10)
    assert.equal(price_max, 30)
  })

  it('returns (null, null) for empty or falsy cost (unknown price)', () => {
    assert.deepEqual(parseCostFromTribe('', {}), { price_min: null, price_max: null })
    assert.deepEqual(parseCostFromTribe(null, {}), { price_min: null, price_max: null })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Tag Parsing (Tribe-specific)
// ════════════════════════════════════════════════════════════════════════════

describe('Summit Metro Parks: Tag Parsing', () => {
  it('extracts category and tag names', () => {
    const cats = [{ name: 'Outdoor Activities', slug: 'outdoor-activities' }]
    const tags = [{ name: 'Parks', slug: 'parks' }]
    const result = parseTagsFromTribe(cats, tags, [])
    assert.ok(result.includes('outdoor activities'))
    assert.ok(result.includes('parks'))
  })

  it('deduplicates tags', () => {
    const cats = [{ name: 'Parks', slug: 'parks' }]
    const tags = [{ name: 'Parks', slug: 'parks' }]
    const result = parseTagsFromTribe(cats, tags, [])
    const parksCount = result.filter(t => t === 'parks').length
    assert.equal(parksCount, 1)
  })

  it('appends extra static tags', () => {
    const cats = []
    const tags = []
    const result = parseTagsFromTribe(cats, tags, ['parks', 'outdoors', 'nature'])
    assert.ok(result.includes('parks'))
    assert.ok(result.includes('outdoors'))
    assert.ok(result.includes('nature'))
  })

  it('lowercases all tag names', () => {
    const cats = [{ name: 'OUTDOOR ACTIVITIES', slug: 'outdoor-activities' }]
    const result = parseTagsFromTribe(cats, [], [])
    assert.ok(result.includes('outdoor activities'))
    assert.ok(!result.includes('OUTDOOR ACTIVITIES'))
  })

  it('filters out empty/null tag names', () => {
    const cats = [{ name: null, slug: 'slug' }, { name: '', slug: 'slug2' }]
    const result = parseTagsFromTribe(cats, [], [])
    assert.equal(result.length, 0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Full Event Normalization Pipeline
// ════════════════════════════════════════════════════════════════════════════

describe('Summit Metro Parks: Event Normalization', () => {
  it('normalizes a complete event correctly', () => {
    const row = normalizeTribalEvent(COMPLETE_EVENT)
    assert.ok(row, 'should not be null')
    assert.equal(row.title, 'Spring Trail Cleanup')
    assert.equal(row.source, 'summit_metro_parks')
    assert.equal(row.source_id, '1001')
    assert.equal(row.category, 'community')
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, null)
    assert.ok(row.start_at.includes('2026-05-15'))
    assert.ok(row.end_at.includes('2026-05-15'))
    assert.ok(row.tags.includes('parks'), 'should include parks tag')
    assert.ok(row.tags.includes('outdoors'), 'should include outdoors tag')
    assert.ok(row.tags.includes('nature'), 'should include nature tag')
    assert.ok(!row.description.includes('<strong>'), 'should not have HTML tags')
    assert.equal(row.image_url, 'https://www.summitmetroparks.org/images/trail-cleanup.jpg')
    assert.equal(row.featured, false)
  })

  it('handles free event correctly', () => {
    const row = normalizeTribalEvent(FREE_EVENT)
    assert.ok(row)
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, null)
    assert.equal(row.category, 'education')
  })

  it('handles paid event with range', () => {
    const row = normalizeTribalEvent(PAID_EVENT_RANGE)
    assert.ok(row)
    assert.equal(row.price_min, 15)
    assert.equal(row.price_max, 25)
    assert.equal(row.category, 'sports')
  })

  it('handles paid event with single price', () => {
    const row = normalizeTribalEvent(PAID_EVENT_SINGLE)
    assert.ok(row)
    assert.equal(row.price_min, 10)
    assert.equal(row.price_max, null)
  })

  it('handles event with no venue', () => {
    const row = normalizeTribalEvent(NO_VENUE)
    assert.ok(row)
    // The normalization uses website || url, so website ('https://www.summitmetroparks.org') is used
    assert.equal(row.ticket_url, 'https://www.summitmetroparks.org')
    assert.equal(row.category, 'community')
  })

  it('skips event with missing start date', () => {
    const row = normalizeTribalEvent(MISSING_START_DATE)
    assert.equal(row, null, 'event without start_at should be skipped')
  })

  it('handles empty venue name (falls back to org venue)', () => {
    const row = normalizeTribalEvent(EMPTY_VENUE_NAME)
    assert.ok(row)
    // The event itself normalizes — venue resolution is done separately
    assert.equal(row.start_at, '2026-04-25T08:00:00Z')
  })

  it('handles event with no categories or tags', () => {
    const row = normalizeTribalEvent(NO_CATEGORIES_OR_TAGS)
    assert.ok(row)
    assert.equal(row.category, 'community') // defaults to community
    assert.ok(row.tags.includes('parks'))
    assert.ok(row.tags.includes('outdoors'))
    assert.ok(row.tags.includes('nature'))
  })

  it('handles event with no image', () => {
    const row = normalizeTribalEvent(NO_IMAGE)
    assert.ok(row)
    assert.equal(row.image_url, null)
  })

  it('strips HTML from description', () => {
    const row = normalizeTribalEvent(HTML_IN_DESCRIPTION)
    assert.ok(row)
    assert.ok(row.description.includes('Discover Our Local Ecosystems'))
    assert.ok(!row.description.includes('<h3>'))
    assert.ok(!row.description.includes('<em>'))
    assert.ok(!row.description.includes('<ul>'))
    assert.ok(!row.description.includes('<li>'))
    // HTML entities should be decoded
    assert.ok(!row.description.includes('&amp;'))
  })

  it('marks featured events with featured flag', () => {
    const row = normalizeTribalEvent(FEATURED_EVENT)
    assert.ok(row)
    assert.equal(row.featured, true)
  })

  it('maps multiple categories with music priority', () => {
    const row = normalizeTribalEvent(MULTIPLE_CATEGORIES)
    assert.ok(row)
    assert.equal(row.category, 'music')
  })

  it('maps sports categories correctly', () => {
    const row = normalizeTribalEvent(SPORTS_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'sports')
    assert.equal(row.price_min, 20)
    assert.equal(row.price_max, null)
  })

  it('maps education categories correctly', () => {
    const row = normalizeTribalEvent(EDUCATION_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'education')
  })

  it('converts UTC start/end dates to ISO 8601 format', () => {
    const row = normalizeTribalEvent(COMPLETE_EVENT)
    assert.ok(row)
    assert.equal(row.start_at, '2026-05-15T14:00:00Z')
    assert.equal(row.end_at, '2026-05-15T16:00:00Z')
  })

  it('handles end_at when utc_end_date is null', () => {
    const ev = { ...COMPLETE_EVENT, utc_end_date: null }
    const row = normalizeTribalEvent(ev)
    assert.ok(row)
    assert.equal(row.end_at, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Batch Processing Invariants
// ════════════════════════════════════════════════════════════════════════════

describe('Summit Metro Parks: Batch Processing', () => {
  it('every fixture produces consistent source field', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeTribalEvent(fixture)
      if (row) {
        assert.equal(row.source, 'summit_metro_parks', `source wrong for fixture id=${fixture.id}`)
      }
    }
  })

  it('every non-null row has required fields', () => {
    const REQUIRED = ['title', 'start_at', 'category', 'source', 'source_id', 'status']
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeTribalEvent(fixture)
      if (!row) continue
      for (const field of REQUIRED) {
        assert.ok(row[field] != null, `fixture id=${fixture.id} missing required field '${field}'`)
      }
    }
  })

  it('every non-null row has price_min as a number', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeTribalEvent(fixture)
      if (!row) continue
      assert.equal(typeof row.price_min, 'number', `fixture id=${fixture.id} price_min not a number`)
    }
  })

  it('no row has HTML in its title or description', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeTribalEvent(fixture)
      if (!row) continue
      assert.ok(!/<[a-zA-Z]/.test(row.title), `fixture id=${fixture.id} has HTML in title`)
      if (row.description) {
        assert.ok(!/<[a-zA-Z]/.test(row.description), `fixture id=${fixture.id} has HTML in description`)
      }
    }
  })

  it('category is always one of the allowed values', () => {
    const ALLOWED = ['music', 'art', 'community', 'education', 'sports', 'food', 'nonprofit', 'other']
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeTribalEvent(fixture)
      if (!row) continue
      assert.ok(ALLOWED.includes(row.category), `fixture id=${fixture.id} has invalid category: ${row.category}`)
    }
  })

  it('all start_at values are valid ISO 8601 strings', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeTribalEvent(fixture)
      if (!row) continue
      const parsed = new Date(row.start_at)
      assert.ok(!isNaN(parsed.getTime()), `fixture id=${fixture.id} has invalid start_at: ${row.start_at}`)
      assert.ok(row.start_at.endsWith('Z'), `fixture id=${fixture.id} start_at should end with Z`)
    }
  })

  it('source_id is always a string', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeTribalEvent(fixture)
      if (!row) continue
      assert.equal(typeof row.source_id, 'string', `fixture id=${fixture.id} source_id not a string`)
    }
  })

  it('featured flag is always a boolean', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeTribalEvent(fixture)
      if (!row) continue
      assert.equal(typeof row.featured, 'boolean', `fixture id=${fixture.id} featured not a boolean`)
    }
  })

  it('tags array always includes parks, outdoors, nature defaults', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeTribalEvent(fixture)
      if (!row) continue
      assert.ok(Array.isArray(row.tags), `fixture id=${fixture.id} tags not an array`)
      assert.ok(row.tags.includes('parks'), `fixture id=${fixture.id} missing 'parks' tag`)
      assert.ok(row.tags.includes('outdoors'), `fixture id=${fixture.id} missing 'outdoors' tag`)
      assert.ok(row.tags.includes('nature'), `fixture id=${fixture.id} missing 'nature' tag`)
    }
  })

  it('exactly one fixture should be skipped (missing start date)', () => {
    const skipped = ALL_FIXTURES.filter(f => normalizeTribalEvent(f) === null)
    assert.equal(skipped.length, 1, `should have exactly 1 skipped fixture, got ${skipped.length}`)
    assert.equal(skipped[0].id, MISSING_START_DATE.id)
  })

  it('all processed events have valid ticket_url (or null)', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeTribalEvent(fixture)
      if (!row) continue
      assert.ok(row.ticket_url === null || /^https?:\/\//.test(row.ticket_url),
        `fixture id=${fixture.id} has invalid ticket_url: ${row.ticket_url}`)
    }
  })
})
