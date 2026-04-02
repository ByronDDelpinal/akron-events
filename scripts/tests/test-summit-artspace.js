/**
 * test-summit-artspace.js
 *
 * Integration tests for the Summit Artspace scraper's data processing pipeline.
 * Tests every permutation of the Tribe API response structure to ensure proper
 * normalization, category mapping, tag parsing, and error handling.
 *
 * Summit Artspace is a multi-disciplinary arts center that defaults events to 'art'.
 *
 * Run:
 *   node --test scripts/tests/test-summit-artspace.js
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
  FOOD_MARKET_EVENT,
  FITNESS_EVENT,
  WORKSHOP_EVENT,
  FUNDRAISER_EVENT,
  FAMILY_EVENT,
  MISSING_START_DATE,
  NO_DESCRIPTION_EVENT,
  DEFAULT_ART_EVENT,
  FEATURED_EVENT,
  IMAGE_IN_DESCRIPTION,
  ALL_FIXTURES,
} from './fixtures/summit-artspace-events.js'

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

function parseCategory(categories = []) {
  const slugs = categories.map(c => c.slug?.toLowerCase() ?? '')

  if (slugs.some(s => s.includes('music') || s.includes('concert') || s.includes('perform'))) return 'music'
  if (slugs.some(s => s.includes('art') || s.includes('exhibit') || s.includes('gallery'))) return 'art'
  if (slugs.some(s => s.includes('food') || s.includes('market') || s.includes('culinary'))) return 'food'
  if (slugs.some(s => s.includes('sport') || s.includes('fitness') || s.includes('run'))) return 'sports'
  if (slugs.some(s => s.includes('educat') || s.includes('workshop') || s.includes('class'))) return 'education'
  if (slugs.some(s => s.includes('nonprofit') || s.includes('fundrais') || s.includes('benefit'))) return 'nonprofit'
  if (slugs.some(s => s.includes('communit') || s.includes('family'))) return 'community'

  // Summit Artspace is primarily an arts org — default to 'art'
  return 'art'
}

function normalizeEvent(ev) {
  const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
  const category = parseCategory(ev.categories)
  const tags = parseTagsFromTribe(ev.categories, ev.tags, [])
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
    source:          'summit_artspace',
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

describe('Summit Artspace: Category Mapping', () => {
  it('maps music/concert/perform to music', () => {
    assert.equal(parseCategory([{ slug: 'music' }]), 'music')
    assert.equal(parseCategory([{ slug: 'concert' }]), 'music')
    assert.equal(parseCategory([{ slug: 'performance' }]), 'music')
  })

  it('maps art/exhibit/gallery to art', () => {
    assert.equal(parseCategory([{ slug: 'art' }]), 'art')
    assert.equal(parseCategory([{ slug: 'exhibition' }]), 'art')
    assert.equal(parseCategory([{ slug: 'gallery' }]), 'art')
  })

  it('maps food/market/culinary to food', () => {
    assert.equal(parseCategory([{ slug: 'food' }]), 'food')
    assert.equal(parseCategory([{ slug: 'market' }]), 'food')
    assert.equal(parseCategory([{ slug: 'culinary' }]), 'food')
  })

  it('maps sport/fitness/run to sports', () => {
    assert.equal(parseCategory([{ slug: 'sports' }]), 'sports')
    assert.equal(parseCategory([{ slug: 'fitness' }]), 'sports')
    assert.equal(parseCategory([{ slug: 'run' }]), 'sports')
  })

  it('maps education/workshop/class to education', () => {
    assert.equal(parseCategory([{ slug: 'education' }]), 'education')
    assert.equal(parseCategory([{ slug: 'workshop' }]), 'education')
    assert.equal(parseCategory([{ slug: 'class' }]), 'education')
  })

  it('maps nonprofit/fundrais/benefit to nonprofit', () => {
    assert.equal(parseCategory([{ slug: 'nonprofit' }]), 'nonprofit')
    assert.equal(parseCategory([{ slug: 'fundraiser' }]), 'nonprofit')
    assert.equal(parseCategory([{ slug: 'benefit' }]), 'nonprofit')
  })

  it('maps community/family to community', () => {
    assert.equal(parseCategory([{ slug: 'community' }]), 'community')
    assert.equal(parseCategory([{ slug: 'family' }]), 'community')
  })

  it('defaults to art for unknown categories', () => {
    assert.equal(parseCategory([]), 'art')
    assert.equal(parseCategory([{ slug: 'unknown' }]), 'art')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Image Parsing with Fallback
// ════════════════════════════════════════════════════════════════════════════

describe('Summit Artspace: Image Parsing', () => {
  it('extracts URL from image object', () => {
    const url = parseImage({ url: 'https://example.com/art.jpg' })
    assert.equal(url, 'https://example.com/art.jpg')
  })

  it('falls back to img src in description HTML', () => {
    const desc = '<p>Info</p><img src="https://example.com/fallback.jpg">'
    const url = parseImage(null, desc)
    assert.equal(url, 'https://example.com/fallback.jpg')
  })

  it('prefers image object over description fallback', () => {
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

describe('Summit Artspace: Tag Parsing', () => {
  it('extracts category and tag names to lowercase', () => {
    const tags = parseTagsFromTribe(
      [{ name: 'Art Exhibition' }],
      [{ name: 'Contemporary' }],
      []
    )
    assert.ok(tags.includes('art exhibition'))
    assert.ok(tags.includes('contemporary'))
  })

  it('handles empty extra tags', () => {
    const tags = parseTagsFromTribe(
      [{ name: 'Exhibition' }],
      [],
      []
    )
    assert.ok(Array.isArray(tags))
    assert.ok(tags.includes('exhibition'))
  })

  it('deduplicates tags', () => {
    const tags = parseTagsFromTribe(
      [{ name: 'Art' }],
      [{ name: 'Art' }],
      []
    )
    const artCount = tags.filter(t => t === 'art').length
    assert.equal(artCount, 1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Cost Parsing
// ════════════════════════════════════════════════════════════════════════════

describe('Summit Artspace: Cost Parsing', () => {
  it('parses single price', () => {
    const { price_min, price_max } = parseCostFromTribe('$15', {})
    assert.equal(price_min, 15)
    assert.equal(price_max, null)
  })

  it('parses price range', () => {
    const { price_min, price_max } = parseCostFromTribe('$35 - $45', {})
    assert.equal(price_min, 35)
    assert.equal(price_max, 45)
  })

  it('parses cost_details.values', () => {
    const { price_min, price_max } = parseCostFromTribe(
      'ignored',
      { values: ['150'] }
    )
    assert.equal(price_min, 150)
    assert.equal(price_max, null)
  })

  it('parses Free cost', () => {
    const { price_min, price_max } = parseCostFromTribe('Free', {})
    assert.equal(price_min, 0)
    assert.equal(price_max, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Full Event Normalization Pipeline
// ════════════════════════════════════════════════════════════════════════════

describe('Summit Artspace: Event Normalization', () => {
  it('normalizes a complete event correctly', () => {
    const row = normalizeEvent(COMPLETE_EVENT)
    assert.ok(row)
    assert.equal(row.title, 'Contemporary Art Exhibition Opening')
    assert.equal(row.source, 'summit_artspace')
    assert.equal(row.source_id, '5001')
    assert.equal(row.category, 'art')
    assert.equal(row.price_min, 0)
    assert.ok(row.tags.includes('art'))
    assert.ok(row.image_url.includes('art-exhibition.jpg'))
  })

  it('maps music events correctly', () => {
    const row = normalizeEvent(MUSIC_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'music')
    assert.equal(row.price_min, 15)
    assert.equal(row.price_max, 25)
  })

  it('maps food market events to food', () => {
    const row = normalizeEvent(FOOD_MARKET_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'food')
    assert.equal(row.price_min, 0)
    assert.ok(row.tags.includes('market'))
  })

  it('maps fitness events to sports', () => {
    const row = normalizeEvent(FITNESS_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'sports')
    assert.equal(row.price_min, 12)
  })

  it('maps workshop events to education', () => {
    const row = normalizeEvent(WORKSHOP_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'education')
    assert.equal(row.price_min, 35)
    assert.equal(row.price_max, 45)
  })

  it('maps fundraiser events to nonprofit', () => {
    const row = normalizeEvent(FUNDRAISER_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'nonprofit')
    assert.equal(row.price_min, 150)
    assert.equal(row.featured, true)
  })

  it('maps family events to community', () => {
    const row = normalizeEvent(FAMILY_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'community')
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

  it('defaults to art for unknown categories', () => {
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
    assert.equal(row.image_url, 'https://example.com/artist-talk.jpg')
  })

  it('strips HTML from description', () => {
    const row = normalizeEvent(COMPLETE_EVENT)
    assert.ok(row)
    assert.ok(!row.description.includes('<p>'))
    assert.ok(!row.description.includes('<strong>'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Batch Processing Invariants
// ════════════════════════════════════════════════════════════════════════════

describe('Summit Artspace: Batch Processing', () => {
  it('every fixture produces a consistent source field', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (row) {
        assert.equal(row.source, 'summit_artspace', `source wrong for fixture id=${fixture.id}`)
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

  it('status is always published', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (!row) continue
      assert.equal(row.status, 'published', `fixture id=${fixture.id} status is not published`)
    }
  })

  it('age_restriction is always not_specified', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (!row) continue
      assert.equal(row.age_restriction, 'not_specified', `fixture id=${fixture.id} age_restriction mismatch`)
    }
  })
})
