/**
 * test-russos.js — Russo's Restaurant (Squarespace) scraper parsing.
 *
 * Run:
 *   node --test scripts/tests/test-russos.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// normalize.js builds a Supabase client at import time — give it dummy creds.
process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseSquarespaceLocation } = await import('../lib/squarespace.js')
const {
  cleanTitle,
  mapCategory,
  mapTags,
  parsePrice,
  normaliseRussosEvent,
  SOURCE_KEY,
  VENUE,
} = await import('../scrape-russos.js')

import {
  JOSEE_MCGEE,
  VINCENT_RUBY,
  JEN_MAURER_COPY,
  NO_START_DATE,
  PAST_EVENT,
  ALL_FIXTURES,
} from './fixtures/russos-events.js'

describe("Russo's — title cleanup", () => {
  it('strips the trailing "(Copy)" CMS artifact', () => {
    assert.equal(
      normaliseRussosEvent(JEN_MAURER_COPY).title,
      'Jen Maurer Live on the Bacchus Patio'
    )
  })
  it('leaves normal titles intact (entities decoded)', () => {
    assert.equal(
      normaliseRussosEvent(JOSEE_MCGEE).title,
      'Josee McGee Live at Russo’s Bacchus Patio'
    )
  })
  it('handles repeated (Copy) suffixes and null', () => {
    assert.equal(cleanTitle('Show (Copy) (Copy)'), 'Show')
    assert.equal(cleanTitle(null), null)
  })
})

describe("Russo's — category mapping", () => {
  it('maps the live-music series to music', () => {
    assert.equal(normaliseRussosEvent(JOSEE_MCGEE).category, 'music')
    assert.equal(normaliseRussosEvent(VINCENT_RUBY).category, 'music')
  })
  it('defers non-music items to inference', () => {
    assert.equal(mapCategory({ title: 'Autumn Wine Dinner', body: '<p>Five courses paired with Italian wines.</p>' }), null)
  })
})

describe("Russo's — tag mapping", () => {
  it('always includes the venue base tags', () => {
    const tags = normaliseRussosEvent(JOSEE_MCGEE).tags
    for (const t of ['russos', 'peninsula', 'bacchus-patio', 'restaurant']) {
      assert.ok(tags.includes(t), `missing ${t}`)
    }
  })
  it('adds live-music for music events', () => {
    assert.ok(normaliseRussosEvent(VINCENT_RUBY).tags.includes('live-music'))
  })
  it('never has duplicate tags', () => {
    for (const item of ALL_FIXTURES) {
      const tags = mapTags(item)
      assert.equal(tags.length, new Set(tags).size)
    }
  })
})

describe("Russo's — price", () => {
  it('"No cover" in the body → free (price_min 0)', () => {
    const row = normaliseRussosEvent(JOSEE_MCGEE)
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, null)
  })
  it('no price statement → null (never assume free)', () => {
    assert.deepEqual(
      parsePrice({ body: '<p>An evening of music and dinner.</p>' }),
      { price_min: null, price_max: null }
    )
  })
})

describe("Russo's — venue", () => {
  it('feed location lacks state/zip, so city stays unparsed (pinned constants required)', () => {
    const loc = parseSquarespaceLocation(JOSEE_MCGEE.location)
    assert.equal(loc.address, '4895 State Rd')
    assert.equal(loc.city, null)
    assert.equal(loc.zip, null)
  })
  it('exposes the map pin from the feed', () => {
    const loc = parseSquarespaceLocation(JOSEE_MCGEE.location)
    assert.equal(loc.lat, 41.2022579)
    assert.equal(loc.lng, -81.495774)
  })
  it('pins the verified venue constants', () => {
    assert.equal(VENUE.name, "Russo's Restaurant")
    assert.equal(VENUE.address, '4895 State Rd')
    assert.equal(VENUE.city, 'Peninsula')
    assert.equal(VENUE.state, 'OH')
    assert.equal(VENUE.zip, '44264')
  })
})

describe("Russo's — normalization", () => {
  it('converts epoch-ms dates to whole-second UTC ISO (Wed 6 PM EDT → 22:00Z)', () => {
    const row = normaliseRussosEvent(JOSEE_MCGEE)
    assert.equal(row.start_at, '2026-07-15T22:00:00.000Z')
    assert.equal(row.end_at, '2026-07-16T00:00:00.000Z')
  })
  it('sets source, source_id, status, and a full ticket_url', () => {
    const row = normaliseRussosEvent(JOSEE_MCGEE)
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, '6a12219e2adf244805b6d381')
    assert.equal(row.status, 'published')
    assert.equal(row.ticket_url, 'https://russosbacchus.com/events/joseemcgee')
  })
  it('strips HTML from the description', () => {
    const row = normaliseRussosEvent(JOSEE_MCGEE)
    assert.ok(!/<[a-z]/i.test(row.description))
    assert.ok(row.description.includes('No cover'))
  })
  it('carries the image assetUrl', () => {
    assert.ok(normaliseRussosEvent(VINCENT_RUBY).image_url.includes('squarespace-cdn.com'))
  })
  it('yields null start_at for an item with no startDate (scraper skips it)', () => {
    assert.equal(normaliseRussosEvent(NO_START_DATE).start_at, null)
  })
  it('past-dated items normalise to a past start_at (scraper guard skips them)', () => {
    const row = normaliseRussosEvent(PAST_EVENT)
    assert.ok(new Date(row.start_at).getTime() < Date.now() - 24 * 60 * 60 * 1000)
  })
})

describe("Russo's — batch invariants", () => {
  it('every fixture normalises without throwing', () => {
    for (const item of ALL_FIXTURES) assert.doesNotThrow(() => normaliseRussosEvent(item))
  })
  it('rows have source=russos and >=4 tags', () => {
    for (const item of ALL_FIXTURES) {
      const row = normaliseRussosEvent(item)
      assert.equal(row.source, 'russos')
      assert.ok(row.tags.length >= 4)
    }
  })
  it('start_at is valid ISO 8601 or null', () => {
    for (const item of ALL_FIXTURES) {
      const row = normaliseRussosEvent(item)
      if (row.start_at) assert.ok(!isNaN(Date.parse(row.start_at)))
    }
  })
})
