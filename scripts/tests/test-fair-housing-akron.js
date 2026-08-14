/**
 * test-fair-housing-akron.js
 *
 * Unit tests for the Fair Housing Contact Service scraper's pure parsers. The
 * load-bearing logic is the per-event Summit gate: Akron workshops (real Ohio
 * pin) publish, the Kent workshop (empty location, "Kent" in the text) is
 * dropped as out-of-county, and a location-less event with no recognizable city
 * (the "save the date" annual event) goes to pending_review.
 *
 * Fixture: verbatim Squarespace event items captured from the live
 * ?format=json&view=upcoming feed on 2026-08-12.
 *
 * Run:  node --test scripts/tests/test-fair-housing-akron.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  parseFairHousingLocation,
  classifyEventLocation,
  isFreeEvent,
  mapCategory,
  mapTags,
  SOURCE_KEY,
} from '../scrape-fair-housing-akron.js'
import { normaliseSquarespaceEvent } from '../lib/squarespace.js'
import { preloadSummitCountyBoundary } from '../lib/summit-county.js'

await preloadSummitCountyBoundary() // coord-based gating needs the polygon loaded

const __dirname = dirname(fileURLToPath(import.meta.url))
const ITEMS = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/fair-housing-akron.json'), 'utf8'))
const byTitle = (t) => ITEMS.find((i) => i.title === t)
const wellCdc = ITEMS[0]
const kent = byTitle("Kent Renter's Rights Workshop")
const annual = byTitle('FHCS Annual Event')

describe('SOURCE_KEY', () => {
  it('is fair_housing_akron', () => assert.equal(SOURCE_KEY, 'fair_housing_akron'))
})

describe('parseFairHousingLocation', () => {
  it('parses a real Akron location and keeps the Ohio pin', () => {
    const loc = parseFairHousingLocation(wellCdc.location)
    assert.equal(loc.name, 'The Well CDC')
    assert.equal(loc.address, '647 East Market Street')
    assert.equal(loc.city, 'Akron')
    assert.equal(loc.state, 'OH')
    assert.equal(loc.zip, '44304')
    assert.equal(loc.lat, 41.077516)
  })

  it('rejects the bogus NY default pin and treats an empty location as null', () => {
    assert.equal(parseFairHousingLocation(kent.location), null)
    assert.equal(parseFairHousingLocation(null), null)
  })

  it('never trusts markerLat (the NY site-wide default) for coords', () => {
    const loc = parseFairHousingLocation(wellCdc.location)
    assert.notEqual(loc.lat, 40.7207559)
  })
})

describe('classifyEventLocation', () => {
  it('classes an Akron workshop as in-county (real Ohio pin + city)', () => {
    assert.equal(classifyEventLocation(wellCdc), 'in')
  })
  it('classes the Kent workshop as out-of-county from its text (empty location)', () => {
    assert.equal(classifyEventLocation(kent), 'out')
  })
  it('classes a location-less, city-less event as unknown (→ pending_review)', () => {
    assert.equal(classifyEventLocation(annual), 'unknown')
  })
})

describe('isFreeEvent', () => {
  it('detects the FREE workshops', () => {
    assert.equal(isFreeEvent(wellCdc), true)
  })
  it('does not assume the save-the-date annual event is free', () => {
    assert.equal(isFreeEvent(annual), false)
  })
})

describe('mapCategory / mapTags', () => {
  it('categorizes as civic', () => assert.equal(mapCategory(wellCdc), 'civic'))
  it('tags workshops with the workshop tag', () => {
    assert.ok(mapTags(wellCdc).includes('workshop'))
    assert.ok(mapTags(wellCdc).includes('fair-housing'))
    assert.ok(!mapTags(annual).includes('workshop'))
  })
})

describe('row building (normalise + gate, over the fixture)', () => {
  it('builds an Akron workshop row with whole-second UTC times and free pricing', () => {
    const row = normaliseSquarespaceEvent(wellCdc, { source: SOURCE_KEY, mapTags })
    // 1787691600745 ms → floor to whole second → 2026-08-25T21:00:00Z (5pm EDT)
    assert.equal(row.start_at, '2026-08-25T21:00:00.000Z')
    assert.equal(row.end_at, '2026-08-25T23:00:00.000Z')
    assert.equal(row.source, 'fair_housing_akron')
    assert.equal(row.source_id, '69cd528f062b5c7b600000c4')
    assert.equal(row.featured, false)
  })

  it('the fixture yields 3 in-county, 1 out, 1 unknown', () => {
    const geos = ITEMS.map(classifyEventLocation)
    assert.equal(geos.filter((g) => g === 'in').length, 3)
    assert.equal(geos.filter((g) => g === 'out').length, 1)
    assert.equal(geos.filter((g) => g === 'unknown').length, 1)
  })
})
