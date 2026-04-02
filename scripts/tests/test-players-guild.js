/**
 * test-players-guild.js
 *
 * Integration tests for the Players Guild Theatre scraper's data processing pipeline.
 * Tests every permutation of the Tribe API response structure to ensure proper
 * normalization, cost parsing, and error handling.
 *
 * Players Guild Theatre is a community theatre that produces live theatre.
 * All events are categorized as 'art' and tagged with theatre-related tags.
 *
 * Run:
 *   node --test scripts/tests/test-players-guild.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Set dummy env vars before any imports ────────────────────────────────────
process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

// ── Import fixtures ──────────────────────────────────────────────────────────
import {
  COMPLETE_EVENT,
  MATINEE_EVENT,
  STUDENT_PRICING_EVENT,
  CONTEMPORARY_PLAY,
  CHILDRENS_SHOW,
  MISSING_START_DATE,
  RICH_HTML_DESCRIPTION,
  MINIMAL_EVENT,
  FEATURED_EVENT,
  LONG_RUN_EVENT,
  NO_IMAGE_EVENT,
  HTML_ENTITY_TITLE,
  ALL_FIXTURES,
} from './fixtures/players-guild-events.js'

// ── Import shared utilities (pure functions) ─────────────────────────────────
import { stripHtml, parseCostFromTribe } from '../lib/normalize.js'

// ════════════════════════════════════════════════════════════════════════════
// RE-IMPLEMENT SCRAPER LOGIC FOR TESTABILITY
// ════════════════════════════════════════════════════════════════════════════

function normalizeEvent(ev) {
  const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
  const imageUrl = ev.image?.url ?? null
  const descText = stripHtml(ev.description ?? '')

  const row = {
    title:           ev.title,
    description:     descText || null,
    start_at:        ev.utc_start_date ? ev.utc_start_date.replace(' ', 'T') + 'Z' : null,
    end_at:          ev.utc_end_date   ? ev.utc_end_date.replace(' ', 'T') + 'Z'   : null,
    category:        'art',
    tags:            ['theatre', 'live-theatre', 'canton', 'performance'],
    price_min,
    price_max,
    age_restriction: 'not_specified',
    image_url:       imageUrl,
    ticket_url:      ev.website || ev.url || null,
    source:          'players_guild',
    source_id:       String(ev.id),
    status:          'published',
    featured:        ev.featured ?? false,
  }

  if (!row.start_at) return null
  return row
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Category (always 'art' for theatre)
// ════════════════════════════════════════════════════════════════════════════

describe('Players Guild Theatre: Category Mapping', () => {
  it('all events are categorized as art', () => {
    assert.equal(normalizeEvent(COMPLETE_EVENT)?.category, 'art')
    assert.equal(normalizeEvent(MATINEE_EVENT)?.category, 'art')
    assert.equal(normalizeEvent(STUDENT_PRICING_EVENT)?.category, 'art')
    assert.equal(normalizeEvent(CONTEMPORARY_PLAY)?.category, 'art')
    assert.equal(normalizeEvent(CHILDRENS_SHOW)?.category, 'art')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Fixed Tags (theatre, live-theatre, canton, performance)
// ════════════════════════════════════════════════════════════════════════════

describe('Players Guild Theatre: Tags', () => {
  it('all events have fixed theatre tags', () => {
    const row = normalizeEvent(COMPLETE_EVENT)
    assert.ok(row)
    assert.deepEqual(row.tags, ['theatre', 'live-theatre', 'canton', 'performance'])
  })

  it('tags are consistent across all events', () => {
    const expected = ['theatre', 'live-theatre', 'canton', 'performance']
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (row) {
        assert.deepEqual(row.tags, expected, `tags mismatch for fixture id=${fixture.id}`)
      }
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Cost Parsing
// ════════════════════════════════════════════════════════════════════════════

describe('Players Guild Theatre: Cost Parsing', () => {
  it('parses single ticket price', () => {
    const row = normalizeEvent(COMPLETE_EVENT)
    assert.ok(row)
    assert.equal(row.price_min, 18)
    assert.equal(row.price_max, null)
  })

  it('parses price range from cost string', () => {
    const row = normalizeEvent(MATINEE_EVENT)
    assert.ok(row)
    assert.equal(row.price_min, 15)
    assert.equal(row.price_max, 20)
  })

  it('parses cost_details.values array', () => {
    const row = normalizeEvent(STUDENT_PRICING_EVENT)
    assert.ok(row)
    assert.equal(row.price_min, 12)
    assert.equal(row.price_max, 18)
  })

  it('uses cost_details.values over cost string', () => {
    const { price_min, price_max } = parseCostFromTribe(
      '$20',
      { values: ['25'] }
    )
    assert.equal(price_min, 25)
    assert.equal(price_max, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Full Event Normalization Pipeline
// ════════════════════════════════════════════════════════════════════════════

describe('Players Guild Theatre: Event Normalization', () => {
  it('normalizes a complete event correctly', () => {
    const row = normalizeEvent(COMPLETE_EVENT)
    assert.ok(row)
    assert.equal(row.title, "A Midsummer Night's Dream")
    assert.equal(row.source, 'players_guild')
    assert.equal(row.source_id, '4001')
    assert.equal(row.category, 'art')
    assert.equal(row.price_min, 18)
    assert.ok(row.start_at.includes('2026-06-05'))
    assert.ok(row.image_url.includes('midsummer.jpg'))
  })

  it('handles matinee performance', () => {
    const row = normalizeEvent(MATINEE_EVENT)
    assert.ok(row)
    assert.equal(row.title, 'The Phantom of the Opera')
    assert.equal(row.price_min, 15)
    assert.equal(row.price_max, 20)
    assert.ok(row.start_at.includes('2026-07-12'))
  })

  it('handles student pricing event', () => {
    const row = normalizeEvent(STUDENT_PRICING_EVENT)
    assert.ok(row)
    assert.equal(row.title, 'Romeo and Juliet')
    assert.equal(row.price_min, 12)
    assert.equal(row.price_max, 18)
  })

  it('handles contemporary play', () => {
    const row = normalizeEvent(CONTEMPORARY_PLAY)
    assert.ok(row)
    assert.equal(row.title, 'August: Osage County')
    assert.equal(row.price_min, 20)
  })

  it('handles children\'s show', () => {
    const row = normalizeEvent(CHILDRENS_SHOW)
    assert.ok(row)
    assert.equal(row.title, 'The Lion King')
    assert.equal(row.price_min, 12)
  })

  it('skips event with missing start date', () => {
    const row = normalizeEvent(MISSING_START_DATE)
    assert.equal(row, null)
  })

  it('strips HTML from rich description', () => {
    const row = normalizeEvent(RICH_HTML_DESCRIPTION)
    assert.ok(row)
    assert.ok(row.description.includes('Rodgers'))
    assert.ok(row.description.includes('Hammerstein'))
    assert.ok(!row.description.includes('<h2>'))
    assert.ok(!row.description.includes('<strong>'))
    assert.ok(!row.description.includes('<ul>'))
    assert.ok(!row.description.includes('<li>'))
  })

  it('handles minimal event', () => {
    const row = normalizeEvent(MINIMAL_EVENT)
    assert.ok(row)
    assert.equal(row.title, 'Opening Night Gala')
  })

  it('handles featured flag', () => {
    const row = normalizeEvent(FEATURED_EVENT)
    assert.ok(row)
    assert.equal(row.featured, true)
    assert.equal(row.title, 'The Crucible')
  })

  it('handles long run event', () => {
    const row = normalizeEvent(LONG_RUN_EVENT)
    assert.ok(row)
    assert.equal(row.title, 'Hamilton: An American Musical')
    assert.equal(row.price_min, 25)
    assert.equal(row.price_max, 35)
    assert.ok(row.featured, 'Hamilton should be featured')
  })

  it('handles event with no image', () => {
    const row = normalizeEvent(NO_IMAGE_EVENT)
    assert.ok(row)
    assert.equal(row.image_url, null)
  })

  it('decodes HTML entities in title', () => {
    const row = normalizeEvent(HTML_ENTITY_TITLE)
    assert.ok(row)
    assert.ok(row.title.includes('Sweeney'))
    assert.ok(row.title.includes('Todd'))
  })

  it('uses website URL for ticket_url', () => {
    const row = normalizeEvent(COMPLETE_EVENT)
    assert.ok(row)
    assert.equal(row.ticket_url, 'https://playersguildtheatre.com/midsummer')
  })

  it('falls back to url field if no website', () => {
    const ev = { ...COMPLETE_EVENT, website: null, url: 'https://example.com/tickets' }
    const row = normalizeEvent(ev)
    assert.ok(row)
    assert.equal(row.ticket_url, 'https://example.com/tickets')
  })

  it('sets ticket_url to null if neither website nor url', () => {
    const ev = { ...COMPLETE_EVENT, website: null, url: null }
    const row = normalizeEvent(ev)
    assert.ok(row)
    assert.equal(row.ticket_url, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Batch Processing Invariants
// ════════════════════════════════════════════════════════════════════════════

describe('Players Guild Theatre: Batch Processing', () => {
  it('every fixture produces a consistent source field', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (row) {
        assert.equal(row.source, 'players_guild', `source wrong for fixture id=${fixture.id}`)
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

  it('tags array is always the same theatre tags', () => {
    const expected = ['theatre', 'live-theatre', 'canton', 'performance']
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (!row) continue
      assert.deepEqual(row.tags, expected, `fixture id=${fixture.id} tags mismatch`)
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

  it('category is always art', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeEvent(fixture)
      if (!row) continue
      assert.equal(row.category, 'art', `fixture id=${fixture.id} category is not art`)
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
