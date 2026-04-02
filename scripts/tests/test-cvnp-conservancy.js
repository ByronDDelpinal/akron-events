/**
 * test-cvnp-conservancy.js
 *
 * Integration tests for the CVNP Conservancy scraper's data processing pipeline.
 * Tests every permutation of the Tribe API response structure to ensure proper
 * normalization, category mapping, tag parsing, and error handling.
 *
 * Run:
 *   node --test scripts/tests/test-cvnp-conservancy.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Set dummy env vars before any imports ────────────────────────────────────
process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

// ── Import fixtures ──────────────────────────────────────────────────────────
import {
  COMPLETE_EVENT,
  PAID_EVENT,
  MUSIC_EVENT,
  SPORTS_EVENT,
  NO_VENUE_EVENT,
  MINIMAL_EVENT,
  MISSING_START_DATE,
  RICH_HTML_DESCRIPTION,
  NO_IMAGE_EVENT,
  PADDLING_EVENT,
  FEATURED_EVENT,
  RUNNING_EVENT,
  ALL_FIXTURES,
} from './fixtures/cvnp-events.js'

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
  if (names.some(n => n.includes('music') || n.includes('concert') || n.includes('performance'))) return 'music'
  if (names.some(n => n.includes('art') || n.includes('photo'))) return 'art'
  if (names.some(n => n.includes('sport') || n.includes('fitness') || n.includes('run') || n.includes('bike') || n.includes('paddle') || n.includes('kayak'))) return 'sports'
  if (names.some(n => n.includes('educat') || n.includes('workshop') || n.includes('program') || n.includes('class'))) return 'education'
  return 'community'
}

function normalizeEvent(ev) {
  const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
  const category = parseCategory(ev.categories, ev.tags)
  const tags = parseTagsFromTribe(ev.categories, ev.tags, ['national-park', 'cvnp', 'outdoors'])
  const imageUrl = ev.image?.url ?? null
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
    ticket_url:      ev.website || ev.url || null,
    source:          'cvnp_conservancy',
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

describe('CVNP Conservancy: Category Mapping', () => {
  it('maps music/concert/performance to music', () => {
    assert.equal(parseCategory([{ name: 'Music' }], []), 'music')
    assert.equal(parseCategory([{ slug: 'concert' }], []), 'music')
    assert.equal(parseCategory([], [{ name: 'Performance' }]), 'music')
  })

  it('maps art/photo to art', () => {
    assert.equal(parseCategory([{ slug: 'art' }], []), 'art')
    assert.equal(parseCategory([{ name: 'Photography' }], []), 'art')
  })

  it('maps sports keywords to sports', () => {
    assert.equal(parseCategory([{ slug: 'sports-fitness' }], []), 'sports')
    assert.equal(parseCategory([{ slug: 'run' }], []), 'sports')
    assert.equal(parseCategory([{ slug: 'bike' }], []), 'sports')
    assert.equal(parseCategory([{ slug: 'paddle' }], []), 'sports')
    assert.equal(parseCategory([{ slug: 'kayak' }], []), 'sports')
  })

  it('maps education/workshop/program/class to education', () => {
    assert.equal(parseCategory([{ slug: 'education' }], []), 'education')
    assert.equal(parseCategory([], [{ name: 'Workshop' }]), 'education')
    assert.equal(parseCategory([], [{ name: 'Program' }]), 'education')
    assert.equal(parseCategory([{ slug: 'class' }], []), 'education')
  })

  it('defaults to community for unknown categories', () => {
    assert.equal(parseCategory([], []), 'community')
    assert.equal(parseCategory([{ slug: 'unknown' }], []), 'community')
  })

  it('checks both categories and tags arrays', () => {
    assert.equal(parseCategory([{ name: 'Event' }], [{ name: 'Music' }]), 'music')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Tag Parsing
// ════════════════════════════════════════════════════════════════════════════

describe('CVNP Conservancy: Tag Parsing', () => {
  it('extracts category and tag names to lowercase', () => {
    const tags = parseTagsFromTribe(
      [{ name: 'Nature Program' }],
      [{ name: 'Outdoors' }],
      []
    )
    assert.ok(tags.includes('nature program'))
    assert.ok(tags.includes('outdoors'))
  })

  it('appends extra tags', () => {
    const tags = parseTagsFromTribe(
      [{ name: 'Walking' }],
      [],
      ['national-park', 'cvnp', 'outdoors']
    )
    assert.ok(tags.includes('national-park'))
    assert.ok(tags.includes('cvnp'))
    assert.ok(tags.includes('outdoors'))
    assert.ok(tags.includes('walking'))
  })

  it('deduplicates tags', () => {
    const tags = parseTagsFromTribe(
      [{ name: 'Outdoors' }],
      [{ name: 'Outdoors' }],
      ['outdoors']
    )
    const outdoorsCount = tags.filter(t => t === 'outdoors').length
    assert.equal(outdoorsCount, 1)
  })

  it('handles empty arrays', () => {
    const tags = parseTagsFromTribe([], [], [])
    assert.ok(Array.isArray(tags))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Cost Parsing
// ════════════════════════════════════════════════════════════════════════════

describe('CVNP Conservancy: Cost Parsing', () => {
  it('parses "Free" cost string', () => {
    const { price_min, price_max } = parseCostFromTribe('Free', {})
    assert.equal(price_min, 0)
    assert.equal(price_max, null)
  })

  it('parses numeric cost string with range', () => {
    const { price_min, price_max } = parseCostFromTribe('$25 - $40', {})
    assert.equal(price_min, 25)
    assert.equal(price_max, 40)
  })

  it('parses cost_details.values array', () => {
    const { price_min, price_max } = parseCostFromTribe(
      '',
      { values: ['35', '50'] }
    )
    assert.equal(price_min, 35)
    assert.equal(price_max, 50)
  })

  it('defaults to 0/null for empty cost', () => {
    const { price_min, price_max } = parseCostFromTribe('', {})
    assert.equal(price_min, 0)
    assert.equal(price_max, null)
  })

  it('uses cost_details.values over cost string', () => {
    const { price_min, price_max } = parseCostFromTribe(
      '$10 - $20',
      { values: ['30', '40'] }
    )
    assert.equal(price_min, 30)
    assert.equal(price_max, 40)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Full Event Normalization Pipeline
// ════════════════════════════════════════════════════════════════════════════

describe('CVNP Conservancy: Event Normalization', () => {
  it('normalizes a complete event correctly', () => {
    const row = normalizeEvent(COMPLETE_EVENT)
    assert.ok(row, 'should not be null')
    assert.equal(row.title, 'Spring Wildflower Walk')
    assert.equal(row.source, 'cvnp_conservancy')
    assert.equal(row.source_id, '1001')
    assert.equal(row.category, 'education') // 'Nature Program' includes 'program'
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, null)
    assert.ok(row.start_at.includes('2026-05-15'))
    assert.ok(row.tags.includes('outdoors'))
    assert.ok(row.tags.includes('national-park'))
    assert.ok(row.tags.includes('cvnp'))
    assert.ok(row.image_url.includes('wildflower.jpg'))
  })

  it('handles paid event with cost range', () => {
    const row = normalizeEvent(PAID_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'education')
    assert.equal(row.price_min, 25)
    assert.equal(row.price_max, 40)
    assert.equal(row.title, 'Landscape Painting Workshop')
  })

  it('maps music events correctly', () => {
    const row = normalizeEvent(MUSIC_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'music')
    assert.equal(row.featured, true)
    assert.ok(row.tags.includes('concert'))
    assert.ok(row.tags.includes('performance'))
  })

  it('maps sports events with kayak/paddle keywords', () => {
    const row = normalizeEvent(SPORTS_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'sports')
    assert.ok(row.tags.includes('biking'))
    assert.ok(row.tags.includes('fitness'))
  })

  it('maps paddling event with kayak category', () => {
    const row = normalizeEvent(PADDLING_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'sports')
    assert.equal(row.price_min, 35)
    assert.ok(row.tags.includes('kayaking'))
    assert.ok(row.tags.includes('paddling'))
  })

  it('maps running event correctly', () => {
    const row = normalizeEvent(RUNNING_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'sports')
    assert.equal(row.price_min, 25)
    assert.ok(row.tags.includes('running'))
  })

  it('handles event with no venue', () => {
    const row = normalizeEvent(NO_VENUE_EVENT)
    assert.ok(row)
    assert.equal(row.title, 'Cuyahoga Valley National Park Information Session')
    assert.equal(row.category, 'education')
  })

  it('handles minimal event (no categories/tags)', () => {
    const row = normalizeEvent(MINIMAL_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'community')
    assert.ok(Array.isArray(row.tags))
    assert.ok(row.tags.includes('national-park'))
  })

  it('skips event with missing start date', () => {
    const row = normalizeEvent(MISSING_START_DATE)
    assert.equal(row, null)
  })

  it('strips HTML from description', () => {
    const row = normalizeEvent(RICH_HTML_DESCRIPTION)
    assert.ok(row)
    assert.ok(row.description.includes('Bring a book'))
    assert.ok(!row.description.includes('<h2>'))
    assert.ok(!row.description.includes('<strong>'))
    assert.ok(!row.description.includes('<li>'))
  })

  it('handles event with no image', () => {
    const row = normalizeEvent(NO_IMAGE_EVENT)
    assert.ok(row)
    assert.equal(row.image_url, null)
  })

  it('handles featured flag', () => {
    const row = normalizeEvent(FEATURED_EVENT)
    assert.ok(row)
    assert.equal(row.featured, true)
    assert.equal(row.title, 'Ledges Trail Dedication Ceremony')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Batch Processing Invariants
// ════════════════════════════════════════════════════════════════════════════

describe('CVNP Conservancy: Batch Processing', () => {
  it('every fixture produces a consistent source field', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (row) {
        assert.equal(row.source, 'cvnp_conservancy', `source wrong for fixture id=${fixture.id}`)
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

  it('no row has HTML in its title or description', () => {
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

  it('image_url is either null or a valid URL', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (!row) continue
      if (row.image_url) {
        assert.ok(row.image_url.startsWith('http'), `fixture id=${fixture.id} image_url not a valid URL: ${row.image_url}`)
      }
    }
  })

  it('ticket_url is either null or a valid URL', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (!row) continue
      if (row.ticket_url) {
        assert.ok(row.ticket_url.startsWith('http'), `fixture id=${fixture.id} ticket_url not a valid URL: ${row.ticket_url}`)
      }
    }
  })
})
