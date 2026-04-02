/**
 * test-squarespace.js
 *
 * Tests for the shared Squarespace Events Collection module.
 * Tests the pure functions: parseSquarespaceLocation, normaliseSquarespaceEvent,
 * buildSquarespaceEventUrl.
 *
 * Run:
 *   node --test scripts/tests/test-squarespace.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Set dummy env vars before any imports ───────────────────────────────────
process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  parseSquarespaceLocation,
  normaliseSquarespaceEvent,
  buildSquarespaceEventUrl,
} from '../lib/squarespace.js'

import {
  COMPLETE_EVENT,
  NO_BODY,
  NO_LOCATION,
  MINIMAL_LOCATION,
  NO_START_DATE,
  FEATURED_EVENT,
  HTML_ENTITIES_TITLE,
  DIFFERENT_VENUE,
  NO_ZIP_IN_ADDRESS,
  UNUSUAL_ADDRESS_FORMAT,
  ALL_FIXTURES,
} from './fixtures/leadership-akron-events.js'

// ════════════════════════════════════════════════════════════════════════════
// parseSquarespaceLocation
// ════════════════════════════════════════════════════════════════════════════

describe('parseSquarespaceLocation', () => {
  it('returns null for null input', () => {
    assert.equal(parseSquarespaceLocation(null), null)
  })

  it('returns null for undefined input', () => {
    assert.equal(parseSquarespaceLocation(undefined), null)
  })

  it('parses a full location with city, state, zip', () => {
    const loc = parseSquarespaceLocation(COMPLETE_EVENT.location)
    assert.equal(loc.name, 'The Duck Club by Firestone at 7 17 Credit Union Park')
    assert.equal(loc.address, '300 South Main Street')
    assert.equal(loc.city, 'Akron')
    assert.equal(loc.state, 'OH')
    assert.equal(loc.zip, '44308')
  })

  it('uses markerLat/markerLng for coordinates', () => {
    const loc = parseSquarespaceLocation(COMPLETE_EVENT.location)
    assert.equal(loc.lat, 40.7207559)
    assert.equal(loc.lng, -74.00076130000002)
  })

  it('falls back to mapLat/mapLng when marker coords are missing', () => {
    const loc = parseSquarespaceLocation({
      addressTitle: 'Test Venue',
      addressLine1: '123 Main St',
      addressLine2: 'Akron, OH, 44308',
      mapLat: 41.08,
      mapLng: -81.52,
    })
    assert.equal(loc.lat, 41.08)
    assert.equal(loc.lng, -81.52)
  })

  it('handles addressLine2 without zip code', () => {
    const loc = parseSquarespaceLocation(NO_ZIP_IN_ADDRESS.location)
    assert.equal(loc.city, 'Akron')
    assert.equal(loc.state, 'OH')
    assert.equal(loc.zip, null)
  })

  it('handles addressLine2 with zip but no comma before it', () => {
    const loc = parseSquarespaceLocation(UNUSUAL_ADDRESS_FORMAT.location)
    assert.equal(loc.city, 'Akron')
    assert.equal(loc.state, 'OH')
    assert.equal(loc.zip, '44326')
  })

  it('handles location with only addressTitle', () => {
    const loc = parseSquarespaceLocation({ addressTitle: 'My Venue' })
    assert.equal(loc.name, 'My Venue')
    assert.equal(loc.address, null)
    assert.equal(loc.city, null)
  })

  it('handles empty addressTitle', () => {
    const loc = parseSquarespaceLocation({ addressTitle: '', addressLine1: '123 Main' })
    assert.equal(loc.name, null)
    assert.equal(loc.address, '123 Main')
  })

  it('parses different venue location', () => {
    const loc = parseSquarespaceLocation(DIFFERENT_VENUE.location)
    assert.equal(loc.name, 'Akron Art Museum')
    assert.equal(loc.address, '1 S High St')
    assert.equal(loc.city, 'Akron')
    assert.equal(loc.state, 'OH')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// normaliseSquarespaceEvent
// ════════════════════════════════════════════════════════════════════════════

describe('normaliseSquarespaceEvent', () => {
  const defaultConfig = {
    source: 'test_source',
    mapCategory: () => 'community',
    mapTags: () => ['test-tag'],
    defaultPriceMin: 0,
    defaultPriceMax: null,
    ageRestriction: 'all_ages',
  }

  it('normalises a complete event', () => {
    const row = normaliseSquarespaceEvent(COMPLETE_EVENT, defaultConfig)
    assert.equal(row.title, 'Leadership on Main: April 2026')
    assert.equal(row.source, 'test_source')
    assert.equal(row.source_id, '693b06ed3254061779677e65')
    assert.equal(row.start_at, '2026-04-15T11:30:00.311Z')
    assert.equal(row.end_at, '2026-04-15T13:00:00.311Z')
    assert.equal(row.category, 'community')
    assert.deepEqual(row.tags, ['test-tag'])
    assert.equal(row.status, 'published')
    assert.equal(row.featured, false)
    assert.ok(row.image_url.includes('squarespace-cdn.com'))
  })

  it('strips HTML from body for description', () => {
    const row = normaliseSquarespaceEvent(COMPLETE_EVENT, defaultConfig)
    assert.ok(!row.description.includes('<p>'))
    assert.ok(!row.description.includes('<strong>'))
    assert.ok(row.description.includes('Alicia Robinson'))
  })

  it('decodes HTML entities in body', () => {
    const row = normaliseSquarespaceEvent(COMPLETE_EVENT, defaultConfig)
    // &amp; in body should become &
    assert.ok(!row.description.includes('&amp;'))
  })

  it('falls back to excerpt when body is null', () => {
    const row = normaliseSquarespaceEvent(NO_BODY, defaultConfig)
    assert.equal(row.description, 'Details TBA!')
  })

  it('returns null start_at when startDate is null', () => {
    const row = normaliseSquarespaceEvent(NO_START_DATE, defaultConfig)
    assert.equal(row.start_at, null)
    assert.equal(row.end_at, null)
  })

  it('maps starred to featured', () => {
    const row = normaliseSquarespaceEvent(FEATURED_EVENT, defaultConfig)
    assert.equal(row.featured, true)
  })

  it('uses default config values when config omitted', () => {
    const row = normaliseSquarespaceEvent(COMPLETE_EVENT)
    assert.equal(row.source, 'squarespace')
    assert.equal(row.category, 'community')
    assert.deepEqual(row.tags, [])
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, null)
    assert.equal(row.age_restriction, 'not_specified')
  })

  it('uses custom price defaults', () => {
    const row = normaliseSquarespaceEvent(COMPLETE_EVENT, {
      ...defaultConfig,
      defaultPriceMin: 10,
      defaultPriceMax: 25,
    })
    assert.equal(row.price_min, 10)
    assert.equal(row.price_max, 25)
  })

  it('sets image_url to null when assetUrl is missing', () => {
    const row = normaliseSquarespaceEvent(NO_BODY, defaultConfig)
    assert.equal(row.image_url, null)
  })

  it('uses item.id as source_id', () => {
    const row = normaliseSquarespaceEvent(COMPLETE_EVENT, defaultConfig)
    assert.equal(row.source_id, COMPLETE_EVENT.id)
  })

  it('falls back to urlId for source_id when id is missing', () => {
    const noId = { ...COMPLETE_EVENT, id: null }
    const row = normaliseSquarespaceEvent(noId, defaultConfig)
    assert.equal(row.source_id, 'apr-26')
  })

  it('sets ticket_url from fullUrl', () => {
    const row = normaliseSquarespaceEvent(COMPLETE_EVENT, defaultConfig)
    assert.equal(row.ticket_url, '/lom-2026/apr-26')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// buildSquarespaceEventUrl
// ════════════════════════════════════════════════════════════════════════════

describe('buildSquarespaceEventUrl', () => {
  it('builds full URL from base + fullUrl', () => {
    const url = buildSquarespaceEventUrl('https://www.leadershipakron.org', COMPLETE_EVENT)
    assert.equal(url, 'https://www.leadershipakron.org/lom-2026/apr-26')
  })

  it('strips trailing slash from base URL', () => {
    const url = buildSquarespaceEventUrl('https://www.leadershipakron.org/', COMPLETE_EVENT)
    assert.equal(url, 'https://www.leadershipakron.org/lom-2026/apr-26')
  })

  it('returns null when fullUrl is missing', () => {
    const url = buildSquarespaceEventUrl('https://example.com', { ...COMPLETE_EVENT, fullUrl: null })
    assert.equal(url, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Batch invariants
// ════════════════════════════════════════════════════════════════════════════

describe('Batch invariants (all fixtures)', () => {
  it('every fixture normalises without throwing', () => {
    for (const item of ALL_FIXTURES) {
      assert.doesNotThrow(() => normaliseSquarespaceEvent(item, { source: 'test' }))
    }
  })

  it('every normalised row has source and source_id', () => {
    for (const item of ALL_FIXTURES) {
      const row = normaliseSquarespaceEvent(item, { source: 'test' })
      assert.equal(row.source, 'test')
      assert.ok(row.source_id != null, `source_id missing for "${item.title}"`)
    }
  })

  it('every normalised row has a title', () => {
    for (const item of ALL_FIXTURES) {
      const row = normaliseSquarespaceEvent(item, { source: 'test' })
      assert.ok(row.title, `title missing for fixture with id ${item.id}`)
    }
  })

  it('description never contains raw HTML tags', () => {
    for (const item of ALL_FIXTURES) {
      const row = normaliseSquarespaceEvent(item, { source: 'test' })
      if (row.description) {
        assert.ok(!/<[a-z][\s\S]*>/i.test(row.description),
          `HTML tags found in description for "${item.title}"`)
      }
    }
  })

  it('start_at is valid ISO or null', () => {
    for (const item of ALL_FIXTURES) {
      const row = normaliseSquarespaceEvent(item, { source: 'test' })
      if (row.start_at) {
        assert.ok(!isNaN(Date.parse(row.start_at)),
          `Invalid start_at "${row.start_at}" for "${item.title}"`)
      }
    }
  })

  it('location parsing never throws', () => {
    for (const item of ALL_FIXTURES) {
      assert.doesNotThrow(() => parseSquarespaceLocation(item.location))
    }
  })
})
