/**
 * test-artisan-coffee.js — Artisan Coffee (Squarespace) scraper parsing.
 *
 * Run:
 *   node --test scripts/tests/test-artisan-coffee.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// normalize.js builds a Supabase client at import time — give it dummy creds.
process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  normaliseSquarespaceEvent,
  parseSquarespaceLocation,
  buildSquarespaceEventUrl,
} = await import('../lib/squarespace.js')
const { mapCategory, mapTags, SITE_BASE_URL, SOURCE_KEY } = await import('../scrape-artisan-coffee.js')

import {
  LIVE_MUSIC,
  OPEN_MIC,
  AUTHOR_TALK,
  NO_START_DATE,
  NO_LOCATION,
  ALL_FIXTURES,
} from './fixtures/artisan-coffee-events.js'

const normalise = (item) => {
  const row = normaliseSquarespaceEvent(item, {
    source: SOURCE_KEY, mapCategory, mapTags,
    defaultPriceMin: null, defaultPriceMax: null, ageRestriction: 'all_ages',
  })
  row.ticket_url = buildSquarespaceEventUrl(SITE_BASE_URL, item) || row.ticket_url
  return row
}

describe('Artisan Coffee — category mapping', () => {
  it('maps live music to music', () => assert.equal(normalise(LIVE_MUSIC).category, 'music'))
  it('maps open mic to music', () => assert.equal(normalise(OPEN_MIC).category, 'music'))
  it('leaves author talks to inference (no music hint)', () => {
    assert.equal(mapCategory(AUTHOR_TALK), null)
  })
})

describe('Artisan Coffee — tag mapping', () => {
  it('always includes coffee-shop base tags', () => {
    const row = normalise(LIVE_MUSIC)
    assert.ok(row.tags.includes('coffee-shop'))
    assert.ok(row.tags.includes('artisan-coffee'))
    assert.ok(row.tags.includes('akron'))
  })
  it('adds live-music for music events', () => {
    assert.ok(normalise(LIVE_MUSIC).tags.includes('live-music'))
  })
  it('adds open-mic + live-music for open mic nights', () => {
    const tags = normalise(OPEN_MIC).tags
    assert.ok(tags.includes('open-mic'))
    assert.ok(tags.includes('live-music'))
  })
  it('adds author-talk for author events', () => {
    assert.ok(normalise(AUTHOR_TALK).tags.includes('author-talk'))
  })
  it('never has duplicate tags', () => {
    for (const item of ALL_FIXTURES) {
      const tags = mapTags(item)
      assert.equal(tags.length, new Set(tags).size)
    }
  })
})

describe('Artisan Coffee — venue resolution', () => {
  it('parses the shop address from the location object', () => {
    const loc = parseSquarespaceLocation(LIVE_MUSIC.location)
    assert.equal(loc.name, 'Artisan Coffee')
    assert.equal(loc.address, '662 Canton Rd')
    assert.equal(loc.city, 'Akron')
    assert.equal(loc.state, 'OH')
    assert.equal(loc.zip, '44312')
  })
  it('returns null location for an item with no location', () => {
    assert.equal(parseSquarespaceLocation(NO_LOCATION.location), null)
  })
})

describe('Artisan Coffee — normalization', () => {
  it('converts epoch-ms dates to correct UTC (6 PM EDT → 22:00Z)', () => {
    const row = normalise(LIVE_MUSIC)
    assert.equal(row.start_at, '2026-06-13T22:00:00.000Z')
    assert.equal(row.end_at, '2026-06-13T23:30:00.000Z')
  })
  it('sets source, source_id, status, and a full ticket_url', () => {
    const row = normalise(LIVE_MUSIC)
    assert.equal(row.source, 'artisan_coffee')
    assert.equal(row.source_id, '59a5d32c4c0dbf3c03f71f6a')
    assert.equal(row.status, 'published')
    assert.equal(row.ticket_url, 'https://artisancoffee.us/events/2025/8/29/live-music-ed-amann-2tblw-xawx3-bs6jy')
  })
  it('strips HTML from the description', () => {
    const row = normalise(LIVE_MUSIC)
    assert.ok(!/<[a-z]/i.test(row.description))
    assert.ok(!row.description.includes('&amp;'))
  })
  it('carries the featured (starred) flag', () => {
    assert.equal(normalise(AUTHOR_TALK).featured, true)
    assert.equal(normalise(LIVE_MUSIC).featured, false)
  })
  it('yields null start_at for an item with no startDate (scraper skips it)', () => {
    assert.equal(normalise(NO_START_DATE).start_at, null)
  })
})

describe('Artisan Coffee — batch invariants', () => {
  it('every fixture normalises without throwing', () => {
    for (const item of ALL_FIXTURES) assert.doesNotThrow(() => normalise(item))
  })
  it('rows have source=artisan_coffee and >=3 tags', () => {
    for (const item of ALL_FIXTURES) {
      const row = normalise(item)
      assert.equal(row.source, 'artisan_coffee')
      assert.ok(row.tags.length >= 3)
    }
  })
  it('start_at is valid ISO 8601 or null', () => {
    for (const item of ALL_FIXTURES) {
      const row = normalise(item)
      if (row.start_at) assert.ok(!isNaN(Date.parse(row.start_at)))
    }
  })
})
