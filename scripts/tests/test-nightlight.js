/**
 * test-nightlight.js
 *
 * Integration tests for the Nightlight Cinema scraper's data processing pipeline.
 * Tests every permutation of the Tribe API response structure to ensure proper
 * normalization, category mapping, tag parsing, and error handling.
 *
 * Nightlight Cinema is a cultural arts venue that defaults events to 'art' category.
 *
 * Run:
 *   node --test scripts/tests/test-nightlight.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Set dummy env vars before any imports ────────────────────────────────────
process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

// ── Import fixtures ──────────────────────────────────────────────────────────
import {
  COMPLETE_EVENT,
  MUSIC_EVENT,
  FOOD_EVENT,
  EDUCATION_EVENT,
  FAMILY_EVENT,
  BENEFIT_EVENT,
  MISSING_START_DATE,
  NO_DESCRIPTION_EVENT,
  DEFAULT_ART_EVENT,
  FEATURED_EVENT,
  IMAGE_IN_DESCRIPTION,
  HTML_ENTITY_EVENT,
  ALL_FIXTURES,
} from './fixtures/nightlight-events.js'

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

  if (slugs.some(s => s.includes('music') || s.includes('concert'))) return 'music'
  if (slugs.some(s => s.includes('food') || s.includes('drink'))) return 'food'
  if (slugs.some(s => s.includes('educat') || s.includes('workshop') || s.includes('class'))) return 'education'
  if (slugs.some(s => s.includes('communit') || s.includes('family'))) return 'community'
  if (t.includes('fundrais') || t.includes('benefit') || t.includes('gala')) return 'nonprofit'

  // Default: cinema is art
  return 'art'
}

function normalizeEvent(ev) {
  const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
  const category = parseCategory(ev.categories, ev.title)
  const tags = parseTagsFromTribe(ev.categories, ev.tags, ['film', 'cinema'])
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
    source:          'nightlight_cinema',
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

describe('Nightlight Cinema: Category Mapping', () => {
  it('maps music/concert to music', () => {
    assert.equal(parseCategory([{ slug: 'music' }], ''), 'music')
    assert.equal(parseCategory([{ slug: 'concert' }], ''), 'music')
  })

  it('maps food/drink to food', () => {
    assert.equal(parseCategory([{ slug: 'food' }], ''), 'food')
    assert.equal(parseCategory([{ slug: 'drink' }], ''), 'food')
  })

  it('maps education/workshop/class to education', () => {
    assert.equal(parseCategory([{ slug: 'education' }], ''), 'education')
    assert.equal(parseCategory([{ slug: 'workshop' }], ''), 'education')
    assert.equal(parseCategory([{ slug: 'class' }], ''), 'education')
  })

  it('maps community/family to community', () => {
    assert.equal(parseCategory([{ slug: 'community' }], ''), 'community')
    assert.equal(parseCategory([{ slug: 'family' }], ''), 'community')
  })

  it('maps fundraiser/benefit/gala in title to nonprofit', () => {
    assert.equal(parseCategory([], 'Benefit Gala'), 'nonprofit')
    assert.equal(parseCategory([], 'Fundraiser Event'), 'nonprofit')
    assert.equal(parseCategory([], 'Gala Dinner'), 'nonprofit')
  })

  it('defaults to art for cinema events', () => {
    assert.equal(parseCategory([], ''), 'art')
    assert.equal(parseCategory([{ slug: 'unknown' }], ''), 'art')
    assert.equal(parseCategory([{ slug: 'film' }], ''), 'art')
  })

  it('category slugs take precedence over title', () => {
    assert.equal(parseCategory([{ slug: 'music' }], 'Benefit Concert'), 'music')
    assert.equal(parseCategory([], 'Benefit Gala'), 'nonprofit')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Image Parsing with Fallback
// ════════════════════════════════════════════════════════════════════════════

describe('Nightlight Cinema: Image Parsing', () => {
  it('extracts URL from image object', () => {
    const url = parseImage({ url: 'https://example.com/film.jpg' })
    assert.equal(url, 'https://example.com/film.jpg')
  })

  it('falls back to img src in description HTML', () => {
    const desc = '<p>Info</p><img src="https://example.com/fallback.jpg">'
    const url = parseImage(null, desc)
    assert.equal(url, 'https://example.com/fallback.jpg')
  })

  it('prefers image object over description', () => {
    const desc = '<img src="https://example.com/fallback.jpg">'
    const url = parseImage({ url: 'https://example.com/primary.jpg' }, desc)
    assert.equal(url, 'https://example.com/primary.jpg')
  })

  it('returns null if no image sources available', () => {
    const url = parseImage(null, '<p>Just text</p>')
    assert.equal(url, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Tag Parsing
// ════════════════════════════════════════════════════════════════════════════

describe('Nightlight Cinema: Tag Parsing', () => {
  it('extracts category and tag names to lowercase', () => {
    const tags = parseTagsFromTribe(
      [{ name: 'Film' }],
      [{ name: 'International' }],
      []
    )
    assert.ok(tags.includes('film'))
    assert.ok(tags.includes('international'))
  })

  it('appends extra tags (film, cinema)', () => {
    const tags = parseTagsFromTribe([], [], ['film', 'cinema'])
    assert.ok(tags.includes('film'))
    assert.ok(tags.includes('cinema'))
  })

  it('deduplicates tags', () => {
    const tags = parseTagsFromTribe(
      [{ name: 'Film' }],
      [{ name: 'Film' }],
      ['film']
    )
    const filmCount = tags.filter(t => t === 'film').length
    assert.equal(filmCount, 1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Cost Parsing
// ════════════════════════════════════════════════════════════════════════════

describe('Nightlight Cinema: Cost Parsing', () => {
  it('parses single ticket price', () => {
    const { price_min, price_max } = parseCostFromTribe('$8', {})
    assert.equal(price_min, 8)
    assert.equal(price_max, null)
  })

  it('parses price range', () => {
    const { price_min, price_max } = parseCostFromTribe('$12 - $15', {})
    assert.equal(price_min, 12)
    assert.equal(price_max, 15)
  })

  it('parses cost_details.values array', () => {
    const { price_min, price_max } = parseCostFromTribe(
      'ignored',
      { values: ['25'] }
    )
    assert.equal(price_min, 25)
    assert.equal(price_max, null)
  })

  it('defaults to 0/null for free or empty cost', () => {
    const free = parseCostFromTribe('Free', {})
    assert.equal(free.price_min, 0)
    assert.equal(free.price_max, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Full Event Normalization Pipeline
// ════════════════════════════════════════════════════════════════════════════

describe('Nightlight Cinema: Event Normalization', () => {
  it('normalizes a complete event correctly', () => {
    const row = normalizeEvent(COMPLETE_EVENT)
    assert.ok(row)
    assert.equal(row.title, 'Film Screening: Independent Documentary')
    assert.equal(row.source, 'nightlight_cinema')
    assert.equal(row.source_id, '3001')
    assert.equal(row.category, 'art')
    assert.equal(row.price_min, 8)
    assert.ok(row.tags.includes('film'))
    assert.ok(row.tags.includes('cinema'))
  })

  it('maps music events correctly', () => {
    const row = normalizeEvent(MUSIC_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'music')
    assert.equal(row.price_min, 12)
    assert.equal(row.price_max, 15)
  })

  it('maps food/drink events to food category', () => {
    const row = normalizeEvent(FOOD_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'food')
    assert.equal(row.price_min, 25)
  })

  it('maps education events correctly', () => {
    const row = normalizeEvent(EDUCATION_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'education')
    assert.equal(row.price_min, 40)
  })

  it('maps family events to community', () => {
    const row = normalizeEvent(FAMILY_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'community')
    assert.equal(row.price_min, 0)
  })

  it('maps fundraiser/benefit events to nonprofit', () => {
    const row = normalizeEvent(BENEFIT_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'nonprofit')
    assert.equal(row.price_min, 100)
    assert.equal(row.featured, true)
  })

  it('skips event with missing start date', () => {
    const row = normalizeEvent(MISSING_START_DATE)
    assert.equal(row, null)
  })

  it('handles event with no description', () => {
    const row = normalizeEvent(NO_DESCRIPTION_EVENT)
    assert.ok(row)
    assert.equal(row.description, null)
    assert.equal(row.category, 'art')
  })

  it('defaults to art category for unknown events', () => {
    const row = normalizeEvent(DEFAULT_ART_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'art')
  })

  it('handles featured flag', () => {
    const row = normalizeEvent(FEATURED_EVENT)
    assert.ok(row)
    assert.equal(row.featured, true)
  })

  it('extracts image from description as fallback', () => {
    const row = normalizeEvent(IMAGE_IN_DESCRIPTION)
    assert.ok(row)
    assert.equal(row.image_url, 'https://example.com/shorts.jpg')
  })

  it('decodes HTML entities in description', () => {
    const row = normalizeEvent(HTML_ENTITY_EVENT)
    assert.ok(row)
    assert.ok(row.description)
    assert.ok(!row.description.includes('&ldquo;'))
    assert.ok(!row.description.includes('&rdquo;'))
    assert.ok(!row.description.includes('&mdash;'))
  })

  it('strips HTML tags from description', () => {
    const row = normalizeEvent(COMPLETE_EVENT)
    assert.ok(row)
    assert.ok(!row.description.includes('<p>'))
    assert.ok(!row.description.includes('<strong>'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Batch Processing Invariants
// ════════════════════════════════════════════════════════════════════════════

describe('Nightlight Cinema: Batch Processing', () => {
  it('every fixture produces a consistent source field', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (row) {
        assert.equal(row.source, 'nightlight_cinema', `source wrong for fixture id=${fixture.id}`)
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
