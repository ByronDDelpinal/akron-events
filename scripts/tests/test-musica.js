/**
 * test-musica.js — Musica (Squarespace) venue scraper parsing.
 *
 * Run:
 *   node --test scripts/tests/test-musica.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  normaliseSquarespaceEvent,
  parseSquarespaceLocation,
  buildSquarespaceEventUrl,
} = await import('../lib/squarespace.js')
const { mapTags, SITE_BASE_URL, SOURCE_KEY } = await import('../scrape-musica.js')

import {
  MAC_SATURN,
  COMEDY_NIGHT,
  NO_START_DATE,
  NO_LOCATION,
  ALL_FIXTURES,
} from './fixtures/musica-events.js'

const normalise = (item) => {
  const row = normaliseSquarespaceEvent(item, {
    source: SOURCE_KEY, mapCategory: () => 'music', mapTags,
    defaultPriceMin: null, defaultPriceMax: null, ageRestriction: 'not_specified',
  })
  row.ticket_url = buildSquarespaceEventUrl(SITE_BASE_URL, item) || row.ticket_url
  return row
}

describe('Musica — category + tags', () => {
  it('maps every show to music', () => {
    for (const item of ALL_FIXTURES) assert.equal(normalise(item).category, 'music')
  })
  it('includes the venue base tags', () => {
    const tags = normalise(MAC_SATURN).tags
    assert.ok(tags.includes('live-music'))
    assert.ok(tags.includes('concert'))
    assert.ok(tags.includes('musica'))
    assert.ok(tags.includes('akron'))
  })
  it('adds a comedy tag for comedy nights', () => {
    assert.ok(normalise(COMEDY_NIGHT).tags.includes('comedy'))
  })
  it('never has duplicate tags', () => {
    for (const item of ALL_FIXTURES) {
      const tags = mapTags(item)
      assert.equal(tags.length, new Set(tags).size)
    }
  })
})

describe('Musica — authoritative showtime (the whole point)', () => {
  it('stores Mac Saturn at the real 7:00 PM ET, not a 9 AM placeholder', () => {
    const row = normalise(MAC_SATURN)
    // 7:00 PM EDT = 23:00 UTC
    assert.equal(row.start_at, '2026-06-13T23:00:00.000Z')
    assert.equal(new Date(row.start_at).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }), '19:00')
  })
})

describe('Musica — venue resolution', () => {
  it('parses the Musica address', () => {
    const loc = parseSquarespaceLocation(MAC_SATURN.location)
    assert.equal(loc.name, 'Musica')
    assert.equal(loc.address, '51 E Market St')
    assert.equal(loc.city, 'Akron')
    assert.equal(loc.state, 'OH')
    assert.equal(loc.zip, '44308')
  })
  it('returns null for an item with no location', () => {
    assert.equal(parseSquarespaceLocation(NO_LOCATION.location), null)
  })
})

describe('Musica — normalization + invariants', () => {
  it('sets source, source_id, status, and a full ticket_url', () => {
    const row = normalise(MAC_SATURN)
    assert.equal(row.source, 'musica')
    assert.equal(row.source_id, '69deec5f2423950001a6212b')
    assert.equal(row.status, 'published')
    assert.equal(row.ticket_url, 'https://www.theofficialmusica.com/upcoming-events-/2026/6/13/mac-saturn')
  })
  it('strips HTML from the description', () => {
    assert.ok(!/<[a-z]/i.test(normalise(MAC_SATURN).description))
  })
  it('yields null start_at for an item with no startDate', () => {
    assert.equal(normalise(NO_START_DATE).start_at, null)
  })
  it('every fixture normalises without throwing', () => {
    for (const item of ALL_FIXTURES) assert.doesNotThrow(() => normalise(item))
  })
})
