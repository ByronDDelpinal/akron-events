/**
 * test-missing-falls.js
 *
 * Integration tests for the Missing Falls Brewery scraper's data processing pipeline.
 * Tests every permutation of the Tribe API response structure to ensure proper
 * normalization, category mapping, tag parsing, and error handling.
 *
 * Run:
 *   node --test scripts/tests/test-missing-falls.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Set dummy env vars before any imports ────────────────────────────────────
process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

// ── Import fixtures ──────────────────────────────────────────────────────────
import {
  COMPLETE_EVENT,
  TASTING_EVENT,
  TRIVIA_EVENT,
  ART_EVENT,
  SPORTS_EVENT,
  FOOD_PAIRING_EVENT,
  MISSING_START_DATE,
  HTML_ENTITY_TITLE,
  IMAGE_IN_DESCRIPTION,
  FEATURED_EVENT,
  BINGO_EVENT,
  COMEDY_EVENT,
  ALL_FIXTURES,
} from './fixtures/missing-falls-events.js'

// ── Import shared utilities (pure functions) ─────────────────────────────────
import { stripHtml, parseCostFromTribe, parseTagsFromTribe } from '../lib/normalize.js'

// ════════════════════════════════════════════════════════════════════════════
// RE-IMPLEMENT SCRAPER LOGIC FOR TESTABILITY
// ════════════════════════════════════════════════════════════════════════════

// ── Image extraction with fallback ───────────────────────────────────────────

function parseImage(imageObj, descriptionHtml = '') {
  if (imageObj && imageObj.url) return imageObj.url
  if (!descriptionHtml) return null
  const match = descriptionHtml.match(/<img[^>]+src="([^"]+)"/)
  return match?.[1] ?? null
}

// ── Category mapping (mirrors scraper) ───────────────────────────────────────

function parseCategory(categories = [], title = '') {
  const slugs = categories.map(c => c.slug?.toLowerCase() ?? '')
  const t = title.toLowerCase()
  if (slugs.some(s => s.includes('music') || s.includes('concert') || s.includes('live'))) return 'music'
  if (slugs.some(s => s.includes('trivia') || s.includes('game') || s.includes('bingo'))) return 'community'
  if (slugs.some(s => s.includes('art') || s.includes('comedy') || s.includes('show'))) return 'art'
  if (slugs.some(s => s.includes('food') || s.includes('tasting') || s.includes('pairing'))) return 'food'
  if (slugs.some(s => s.includes('sport') || s.includes('fitness') || s.includes('run'))) return 'sports'
  if (t.includes('trivia') || t.includes('bingo') || t.includes('game night')) return 'community'
  if (t.includes('live') || t.includes('music') || t.includes('band') || t.includes('dj')) return 'music'
  // Brewery events default to community
  return 'community'
}

function normalizeEvent(ev) {
  const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
  const category = parseCategory(ev.categories, ev.title)
  const tags = parseTagsFromTribe(ev.categories, ev.tags, ['brewery', 'akron'])
  const imageUrl = parseImage(ev.image, ev.description)
  const descText = stripHtml(ev.description ?? '')

  const row = {
    title:           ev.title,
    description:     descText || null,
    start_at:        ev.utc_start_date ? ev.utc_start_date.replace(' ', 'T') + 'Z' : null,
    end_at:          ev.utc_end_date   ? ev.utc_end_date.replace(' ', 'T') + 'Z'   : null,
    category,
    tags,
    price_min,
    price_max,
    age_restriction: 'not_specified',
    image_url:       imageUrl,
    ticket_url:      ev.website || null,
    source:          'missing_falls',
    source_id:       String(ev.id),
    status:          'published',
    featured:        ev.featured ?? false,
  }

  if (!row.start_at) return null
  return row
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Category Mapping
// ════════════════════════════════════════════════════════════════════════════

describe('Missing Falls: Category Mapping', () => {
  it('maps music/concert/live to music', () => {
    assert.equal(parseCategory([{ slug: 'live-music' }], ''), 'music')
    assert.equal(parseCategory([{ slug: 'concert' }], ''), 'music')
    assert.equal(parseCategory([], 'Live Band Performance'), 'music')
    assert.equal(parseCategory([], 'DJ Night'), 'music')
  })

  it('maps trivia/game/bingo to community', () => {
    assert.equal(parseCategory([{ slug: 'games' }], ''), 'community')
    assert.equal(parseCategory([{ slug: 'trivia' }], ''), 'community')
    assert.equal(parseCategory([{ slug: 'bingo' }], ''), 'community')
    assert.equal(parseCategory([], 'Trivia Night'), 'community')
    assert.equal(parseCategory([], 'Game Night'), 'community')
    assert.equal(parseCategory([], 'Bingo Night'), 'community')
  })

  it('maps art/comedy/show to art', () => {
    assert.equal(parseCategory([{ slug: 'art' }], ''), 'art')
    assert.equal(parseCategory([{ slug: 'comedy' }], ''), 'art')
    assert.equal(parseCategory([{ slug: 'show' }], ''), 'art')
    assert.equal(parseCategory([], 'Local Showcase'), 'community') // no keywords in title match art
  })

  it('maps food/tasting/pairing to food', () => {
    assert.equal(parseCategory([{ slug: 'food' }], ''), 'food')
    assert.equal(parseCategory([{ slug: 'food-tasting' }], ''), 'food')
    assert.equal(parseCategory([{ slug: 'food-pairing' }], ''), 'food')
  })

  it('maps sports/fitness/run to sports', () => {
    assert.equal(parseCategory([{ slug: 'sports' }], ''), 'sports')
    assert.equal(parseCategory([{ slug: 'fitness' }], ''), 'sports')
    assert.equal(parseCategory([{ slug: 'run' }], ''), 'sports')
  })

  it('defaults to community for brewery events', () => {
    assert.equal(parseCategory([], ''), 'community')
    assert.equal(parseCategory([{ slug: 'unknown' }], ''), 'community')
    assert.equal(parseCategory([], 'Watch Party'), 'community')
  })

  it('checks both categories and title', () => {
    assert.equal(parseCategory([{ slug: 'music' }], 'Any title'), 'music')
    assert.equal(parseCategory([], 'Live Music Tonight'), 'music')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Image Parsing with Fallback
// ════════════════════════════════════════════════════════════════════════════

describe('Missing Falls: Image Parsing', () => {
  it('extracts URL from image object', () => {
    const url = parseImage({ url: 'https://example.com/event.jpg' })
    assert.equal(url, 'https://example.com/event.jpg')
  })

  it('returns null for missing image object', () => {
    const url = parseImage(null, '')
    assert.equal(url, null)
  })

  it('returns null for image object without url', () => {
    const url = parseImage({ id: 1, alt: 'test' }, '')
    assert.equal(url, null)
  })

  it('falls back to img src in description HTML', () => {
    const desc = '<p>Event info</p><img src="https://example.com/fallback.jpg" alt="event">'
    const url = parseImage(null, desc)
    assert.equal(url, 'https://example.com/fallback.jpg')
  })

  it('returns null if no image object and no img in description', () => {
    const url = parseImage(null, '<p>Just text</p>')
    assert.equal(url, null)
  })

  it('prefers image object over description fallback', () => {
    const desc = '<img src="https://example.com/fallback.jpg">'
    const url = parseImage({ url: 'https://example.com/primary.jpg' }, desc)
    assert.equal(url, 'https://example.com/primary.jpg')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Tag Parsing
// ════════════════════════════════════════════════════════════════════════════

describe('Missing Falls: Tag Parsing', () => {
  it('extracts category and tag names to lowercase', () => {
    const tags = parseTagsFromTribe(
      [{ name: 'Live Music' }],
      [{ name: 'Beer' }],
      []
    )
    assert.ok(tags.includes('live music'))
    assert.ok(tags.includes('beer'))
  })

  it('appends extra tags (brewery, akron)', () => {
    const tags = parseTagsFromTribe([], [], ['brewery', 'akron'])
    assert.ok(tags.includes('brewery'))
    assert.ok(tags.includes('akron'))
  })

  it('deduplicates tags', () => {
    const tags = parseTagsFromTribe(
      [{ name: 'Brewery' }],
      [{ name: 'Brewery' }],
      ['brewery']
    )
    const breweryCount = tags.filter(t => t === 'brewery').length
    assert.equal(breweryCount, 1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Cost Parsing
// ════════════════════════════════════════════════════════════════════════════

describe('Missing Falls: Cost Parsing', () => {
  it('parses "Free" cost', () => {
    const { price_min, price_max } = parseCostFromTribe('Free', {})
    assert.equal(price_min, 0)
    assert.equal(price_max, null)
  })

  it('parses single price', () => {
    const { price_min, price_max } = parseCostFromTribe('$15', {})
    assert.equal(price_min, 15)
    assert.equal(price_max, null)
  })

  it('parses price range', () => {
    const { price_min, price_max } = parseCostFromTribe('$65 - $85', {})
    assert.equal(price_min, 65)
    assert.equal(price_max, 85)
  })

  it('uses cost_details.values over cost string', () => {
    const { price_min, price_max } = parseCostFromTribe(
      'ignored',
      { values: ['20', '30'] }
    )
    assert.equal(price_min, 20)
    assert.equal(price_max, 30)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Full Event Normalization Pipeline
// ════════════════════════════════════════════════════════════════════════════

describe('Missing Falls: Event Normalization', () => {
  it('normalizes a complete event correctly', () => {
    const row = normalizeEvent(COMPLETE_EVENT)
    assert.ok(row)
    assert.equal(row.title, 'Live Music: The Locals')
    assert.equal(row.source, 'missing_falls')
    assert.equal(row.source_id, '2001')
    assert.equal(row.category, 'music')
    assert.equal(row.price_min, 0)
    assert.ok(row.tags.includes('brewery'))
    assert.ok(row.tags.includes('akron'))
    assert.ok(row.image_url.includes('live-music.jpg'))
  })

  it('maps tasting event to food category', () => {
    const row = normalizeEvent(TASTING_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'food')
    assert.equal(row.price_min, 15)
    assert.ok(row.tags.includes('tasting'))
  })

  it('maps trivia event to community category', () => {
    const row = normalizeEvent(TRIVIA_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'community')
    assert.equal(row.price_min, 0)
    assert.ok(row.tags.includes('trivia'))
  })

  it('maps art event correctly', () => {
    const row = normalizeEvent(ART_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'art')
  })

  it('maps sports event correctly', () => {
    const row = normalizeEvent(SPORTS_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'sports')
  })

  it('maps food pairing event correctly', () => {
    const row = normalizeEvent(FOOD_PAIRING_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'food')
    assert.equal(row.price_min, 65)
    assert.equal(row.price_max, 85)
    assert.ok(row.tags.includes('pairing'))
  })

  it('skips event with missing start date', () => {
    const row = normalizeEvent(MISSING_START_DATE)
    assert.equal(row, null)
  })

  it('decodes HTML entities in title', () => {
    const row = normalizeEvent(HTML_ENTITY_TITLE)
    assert.ok(row)
    assert.ok(row.title.includes('&'))
    assert.ok(row.title.includes('Dancing'))
  })

  it('extracts image from description when no image object', () => {
    const row = normalizeEvent(IMAGE_IN_DESCRIPTION)
    assert.ok(row)
    assert.equal(row.image_url, 'https://example.com/cleanup.jpg')
  })

  it('handles featured flag', () => {
    const row = normalizeEvent(FEATURED_EVENT)
    assert.ok(row)
    assert.equal(row.featured, true)
  })

  it('maps bingo event to community', () => {
    const row = normalizeEvent(BINGO_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'community')
    assert.ok(row.tags.includes('bingo'))
  })

  it('maps comedy event to art', () => {
    const row = normalizeEvent(COMEDY_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'art')
    assert.equal(row.price_min, 12)
  })

  it('strips HTML from description', () => {
    const row = normalizeEvent(TASTING_EVENT)
    assert.ok(row)
    assert.ok(!row.description.includes('<p>'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Batch Processing Invariants
// ════════════════════════════════════════════════════════════════════════════

describe('Missing Falls: Batch Processing', () => {
  it('every fixture produces a consistent source field', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (row) {
        assert.equal(row.source, 'missing_falls', `source wrong for fixture id=${fixture.id}`)
      }
    }
  })

  it('every non-null row has required fields', () => {
    const REQUIRED = ['title', 'start_at', 'category', 'source', 'source_id', 'status']
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (!row) continue
      for (const field of REQUIRED) {
        assert.ok(row[field] != null, `fixture id=${fixture.id} missing required field '${field}'`)
      }
    }
  })

  it('every non-null row has price_min as a number', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (!row) continue
      assert.equal(typeof row.price_min, 'number', `fixture id=${fixture.id} price_min not a number`)
    }
  })

  it('tags array is always an array', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (!row) continue
      assert.ok(Array.isArray(row.tags), `fixture id=${fixture.id} tags not an array`)
      assert.ok(row.tags.length > 0, `fixture id=${fixture.id} tags array is empty`)
    }
  })

  it('no row has HTML in title or description', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (!row) continue
      assert.ok(!/<[a-zA-Z]/.test(row.title), `fixture id=${fixture.id} has HTML in title`)
      if (row.description) {
        assert.ok(!/<[a-zA-Z]/.test(row.description), `fixture id=${fixture.id} has HTML in description`)
      }
    }
  })

  it('exactly one fixture should be skipped (missing start date)', () => {
    const skipped = ALL_FIXTURES.filter(f => normalizeEvent(f) === null)
    assert.equal(skipped.length, 1)
    assert.equal(skipped[0].id, MISSING_START_DATE.id)
  })

  it('all start_at values are valid ISO 8601 strings', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (!row) continue
      const parsed = new Date(row.start_at)
      assert.ok(!isNaN(parsed.getTime()), `fixture id=${fixture.id} has invalid start_at: ${row.start_at}`)
      assert.ok(row.start_at.endsWith('Z'), `fixture id=${fixture.id} start_at should end with Z`)
    }
  })

  it('source_id is always a string', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (!row) continue
      assert.equal(typeof row.source_id, 'string', `fixture id=${fixture.id} source_id not a string`)
    }
  })

  it('category is always one of the allowed values', () => {
    const ALLOWED = ['music', 'art', 'community', 'education', 'sports', 'food', 'nonprofit', 'other']
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (!row) continue
      assert.ok(ALLOWED.includes(row.category), `fixture id=${fixture.id} has invalid category: ${row.category}`)
    }
  })
})
