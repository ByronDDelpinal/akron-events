/**
 * test-peninsula-foundation.js — pure-parser coverage for the Peninsula
 * Foundation Tribe scraper: text-based category mapping (concert → music,
 * history/poetry → learning), genre tagging, per-occurrence source_id, and
 * venue normalization (name reuse + array form + missing venue).
 *
 * The Tribe REST fetch + Summit gate write path is exercised by the live run;
 * here we lock the pure logic against realistic snippets captured from
 * thepeninsulafoundation.org.
 *
 * Run:  node --test scripts/tests/test-peninsula-foundation.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseCategory, mapTags, buildSourceId, parseVenue, toEasternIso, SOURCE_KEY } =
  await import('../scrape-peninsula-foundation.js')

describe('Peninsula Foundation toEasternIso — local start_date treated as Eastern', () => {
  it('an 8:00 PM EDT show → 00:00Z next day (robust vs a "UTC+0" misconfig)', () => {
    // Live payload: start_date "2026-07-15 20:00:00" (America/New_York now, but the
    // conversion must stay correct even if the tz is ever broken to UTC+0). Going
    // through start_date never appends 'Z' to a mislabelled utc field.
    assert.equal(toEasternIso('2026-07-15 20:00:00'), '2026-07-16T00:00:00.000Z')
  })
  it('honors EST for a winter show (8:00 PM EST → 01:00Z)', () => {
    assert.equal(toEasternIso('2026-02-21 20:00:00'), '2026-02-22T01:00:00.000Z')
  })
  it('tolerates a "T" separator and returns null for missing input', () => {
    assert.equal(toEasternIso('2026-07-15T20:00:00'), '2026-07-16T00:00:00.000Z')
    assert.equal(toEasternIso(undefined), null)
  })
})

describe('Peninsula Foundation parseCategory', () => {
  it('music for concert titles (performer names)', () => {
    assert.equal(parseCategory('Charlie Parr'), 'music')
    assert.equal(parseCategory('Crooked River Quintet'), 'music')
    assert.equal(parseCategory('East Nash Grass'), 'music')
    assert.equal(parseCategory('G.A.R Grass Jam'), 'music')
  })

  it('learning for history-talk, tour, and poetry-reading titles', () => {
    assert.equal(parseCategory('Poetry in the Valley'), 'learning')
    assert.equal(parseCategory('A Talk on Peninsula History'), 'learning')
    assert.equal(parseCategory('Guided Walking Tour of the Village'), 'learning')
  })

  it('does NOT let an incidental bio word in the title pass; keys off title only', () => {
    // A performer bio mentioning "poetry" lives in the description, never the
    // title, so a plain performer-name title stays 'music'.
    assert.equal(parseCategory('Darrell Scott'), 'music')
  })
})

describe('Peninsula Foundation mapTags', () => {
  it('always includes the venue + place tags', () => {
    const tags = mapTags('Charlie Parr', 'guitarist and songwriter')
    assert.ok(tags.includes('peninsula'))
    assert.ok(tags.includes('g-a-r-hall'))
    assert.ok(tags.includes('live-music'))
  })
  it('detects genre tags from text', () => {
    assert.ok(mapTags('G.A.R Grass Jam', 'a fun night of grass jammin with banjo and fiddle').includes('bluegrass'))
    assert.ok(mapTags('Darrell Scott', 'deep roots in country, bluegrass, folk, and Americana').includes('americana'))
  })
  it('poetry readings tag poetry, not live-music', () => {
    const tags = mapTags('Poetry in the Valley', 'open mic poetry')
    assert.ok(tags.includes('poetry'))
    assert.ok(!tags.includes('live-music'))
  })
})

describe('Peninsula Foundation buildSourceId', () => {
  it('appends the local start date so recurring occurrences stay distinct', () => {
    assert.equal(buildSourceId({ id: 21351, start_date: '2026-07-14 19:00:00' }), '21351-2026-07-14')
    assert.equal(buildSourceId({ id: 7, utc_start_date: '2026-07-15 01:00:00' }), '7-2026-07-15')
  })
  it('falls back to the bare id when no date is present', () => {
    assert.equal(buildSourceId({ id: 99 }), '99')
  })
})

describe('Peninsula Foundation parseVenue', () => {
  it('reuses the exact "G.A.R. Hall" name so ensureVenue dedupes', () => {
    const v = parseVenue({
      venue: {
        venue: 'G.A.R. Hall', address: '1785 Main St', city: 'Peninsula',
        state: 'OH', zip: '44264',
      },
    })
    assert.equal(v.name, 'G.A.R. Hall')
    assert.equal(v.city, 'Peninsula')
    assert.equal(v.details.address, '1785 Main St')
    assert.equal(v.details.state, 'OH')
    assert.equal(v.details.zip, '44264')
    assert.equal(v.details.lat, null)
    assert.equal(v.details.lng, null)
  })
  it('accepts the array form Tribe sometimes returns', () => {
    const v = parseVenue({ venue: [{ venue: 'G.A.R. Hall', city: 'Peninsula', stateprovince: 'OH' }] })
    assert.equal(v.name, 'G.A.R. Hall')
    assert.equal(v.details.state, 'OH')
  })
  it('returns null when no venue is attached', () => {
    assert.equal(parseVenue({}), null)
    assert.equal(parseVenue({ venue: [] }), null)
    assert.equal(parseVenue({ venue: { venue: '' } }), null)
  })
  it('parses numeric geo coordinates when present', () => {
    const v = parseVenue({ venue: { venue: 'X', geo_lat: '41.24', geo_lng: '-81.55' } })
    assert.equal(v.details.lat, 41.24)
    assert.equal(v.details.lng, -81.55)
  })
})

describe('Peninsula Foundation source key', () => {
  it('uses the right source key', () => {
    assert.equal(SOURCE_KEY, 'peninsula_foundation')
  })
})
