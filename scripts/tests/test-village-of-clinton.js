/**
 * test-village-of-clinton.js
 *
 * Unit tests for the Village of Clinton scraper's pure parsers. Clinton runs a
 * WordPress + Tribe REST calendar dominated by municipal governance, so the
 * load-bearing logic is (1) the meeting/closure filter that separates genuine
 * community events from Council/zoning rows, (2) the Eastern wall-clock → UTC
 * conversion, (3) the civic-defaulting category, (4) source_id stability, and
 * (5) venue resolution (empty Tribe venue → the canonical village venue).
 *
 * Fixtures mirror real feed rows captured from the live endpoint on 2026-07-15
 * (the governance rows are verbatim; the community rows are representative of the
 * seasonal events the village adds).
 *
 * Run:
 *   node --test scripts/tests/test-village-of-clinton.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  isPublicCommunityEvent,
  toEasternIso,
  resolveCategory,
  buildSourceId,
  parseImage,
  resolveVenueSpec,
} from '../scrape-village-of-clinton.js'

// ── isPublicCommunityEvent ───────────────────────────────────────────────────

describe('isPublicCommunityEvent', () => {
  const DROP = [
    'Council Meeting',                    // verbatim from the live feed
    'Zoning Board of Appeals meeting',    // verbatim from the live feed
    'Planning Commission',
    'Board of Zoning Appeals',
    'Board of Health',
    'Park Board Meeting',
    'Regular Council Meeting',
    'Special Meeting',
    'Public Hearing on Rezoning',
    "Mayor's Court",
    'Committee of the Whole',
    'Village Offices Closed - Holiday',
    "New Year's Day",
  ]
  const KEEP = [
    'Clinton Community Days',
    'Summer Concert in the Park',
    'Tuscarawas River Cleanup',
    'Fall Festival',
    'Tree Lighting Ceremony',
    'Memorial Day Parade',
  ]

  for (const t of DROP) {
    it(`drops governance/closure row: ${t}`, () => assert.equal(isPublicCommunityEvent(t), false))
  }
  for (const t of KEEP) {
    it(`keeps community event: ${t}`, () => assert.equal(isPublicCommunityEvent(t), true))
  }

  it('rejects empty / whitespace / null titles', () => {
    assert.equal(isPublicCommunityEvent(''), false)
    assert.equal(isPublicCommunityEvent('   '), false)
    assert.equal(isPublicCommunityEvent(null), false)
  })
})

// ── toEasternIso ─────────────────────────────────────────────────────────────

describe('toEasternIso', () => {
  it('converts a summer (EDT) local wall-clock, offset 4h', () => {
    // Council Meeting 2026-07-15 18:00 → 22:00Z (matches the live utc_start_date)
    assert.equal(toEasternIso('2026-07-15 18:00:00'), '2026-07-15T22:00:00.000Z')
  })
  it('converts a winter (EST) local wall-clock, offset 5h', () => {
    assert.equal(toEasternIso('2026-12-15 19:00:00'), '2026-12-16T00:00:00.000Z')
  })
  it('tolerates a "T" separator', () => {
    assert.equal(toEasternIso('2026-07-15T18:00:00'), '2026-07-15T22:00:00.000Z')
  })
  it('returns null for empty / null input', () => {
    assert.equal(toEasternIso(''), null)
    assert.equal(toEasternIso(null), null)
  })
})

// ── resolveCategory ──────────────────────────────────────────────────────────

describe('resolveCategory', () => {
  it('defaults a generic village event to civic', () => {
    assert.equal(resolveCategory('Clinton Community Days', 'Join the village for a day of fun.'), 'civic')
  })
  it('keeps a confident inference (concert → music)', () => {
    assert.equal(resolveCategory('Summer Concert in the Park', 'Live music on the green.'), 'music')
  })
})

// ── buildSourceId ────────────────────────────────────────────────────────────

describe('buildSourceId', () => {
  it('appends the occurrence date for collision-free ids', () => {
    assert.equal(buildSourceId({ id: 4500, start_date: '2026-08-04 19:00:00' }), '4500-2026-08-04')
  })
  it('falls back to the bare id when no date is present', () => {
    assert.equal(buildSourceId({ id: 4500 }), '4500')
  })
  it('gives distinct ids to two occurrences of one recurring event', () => {
    const a = buildSourceId({ id: 900, start_date: '2026-08-01 09:00:00' })
    const b = buildSourceId({ id: 900, start_date: '2026-08-08 09:00:00' })
    assert.notEqual(a, b)
  })
})

// ── parseImage ───────────────────────────────────────────────────────────────

describe('parseImage', () => {
  it('prefers the Tribe image object url', () => {
    assert.equal(parseImage({ url: 'https://clintonoh.gov/a.jpg' }, ''), 'https://clintonoh.gov/a.jpg')
  })
  it('returns null when image is false and no inline <img>', () => {
    assert.equal(parseImage(false, 'No image here'), null)
  })
  it('falls back to an inline <img> in the description', () => {
    assert.equal(parseImage(false, '<p><img src="https://cdn.example.com/banner.png"/></p>'), 'https://cdn.example.com/banner.png')
  })
})

// ── resolveVenueSpec ─────────────────────────────────────────────────────────

describe('resolveVenueSpec', () => {
  it('falls back to the canonical village venue for an empty Tribe array', () => {
    const v = resolveVenueSpec([])
    assert.equal(v.name, 'Village of Clinton')
    assert.equal(v.city, 'Clinton')
    assert.equal(v.state, 'OH')
    assert.equal(v.zip, '44216')
  })
  it('falls back for a nameless / undefined venue', () => {
    assert.equal(resolveVenueSpec(undefined).name, 'Village of Clinton')
    assert.equal(resolveVenueSpec([{ venue: '' }]).name, 'Village of Clinton')
  })
  it('uses a populated Tribe venue object', () => {
    const v = resolveVenueSpec({ venue: 'Clinton Community Park', address: '123 Main St', city: 'Clinton', zip: '44216', geo_lat: '40.9', geo_lng: '-81.6' })
    assert.equal(v.name, 'Clinton Community Park')
    assert.equal(v.address, '123 Main St')
    assert.equal(v.city, 'Clinton')
    assert.equal(v.lat, 40.9)
    assert.equal(v.lng, -81.6)
  })
})
