/**
 * test-summit-county.js
 *
 * Unit tests for the shared Summit County locality classifier
 * (scripts/lib/summit-county.js) — the primitive behind the strict Summit
 * mandate (2026-07-14: "everything inside listed, nothing outside, period"):
 *
 *   • classifySummitLocation — 3-way 'in' / 'out' / 'unknown'
 *   • isSummitCountyLocation — strict boolean wrapper (only 'in' passes)
 *   • allowlist/blocklist hygiene (no overlap; Uniontown stays allowed)
 *
 * Run:
 *   node --test scripts/tests/test-summit-county.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  preloadSummitCountyBoundary,
  classifySummitLocation,
  isSummitCountyLocation,
  SUMMIT_COUNTY_CITIES,
  NOT_SUMMIT_COUNTY_CITIES,
} from '../lib/summit-county.js'

await preloadSummitCountyBoundary()

describe('classifySummitLocation — coordinate path (polygon wins)', () => {
  it("downtown Akron coords → 'in'", () => {
    assert.equal(classifySummitLocation({ lat: 41.0814, lng: -81.5190 }), 'in')
  })

  it("Blossom Music Center coords → 'in'", () => {
    assert.equal(classifySummitLocation({ lat: 41.1858, lng: -81.5544 }), 'in')
  })

  it("Strongsville coords → 'out' (the original Akron Life leak)", () => {
    assert.equal(classifySummitLocation({ lat: 41.3141, lng: -81.8194 }), 'out')
  })

  it("Eastwood Field, Niles coords → 'out' (the Scrappers leak)", () => {
    assert.equal(classifySummitLocation({ lat: 41.1907, lng: -80.7327 }), 'out')
  })

  it('coords beat a contradictory city label', () => {
    // In-county coords + out-of-county label → coords win.
    assert.equal(classifySummitLocation({ lat: 41.0814, lng: -81.5190, city: 'Cleveland' }), 'in')
    // Out-of-county coords + in-county label → coords win.
    assert.equal(classifySummitLocation({ lat: 41.4993, lng: -81.6944, city: 'Akron' }), 'out')
  })

  it('accepts numeric-string coordinates (feeds often stringify)', () => {
    assert.equal(classifySummitLocation({ lat: '41.0814', lng: '-81.5190' }), 'in')
  })

  it('ignores the (0,0) placeholder and falls through to the city', () => {
    assert.equal(classifySummitLocation({ lat: 0, lng: 0, city: 'Akron' }), 'in')
    assert.equal(classifySummitLocation({ lat: 0, lng: 0, city: 'Canton' }), 'out')
  })
})

describe('classifySummitLocation — city fallback (no coords)', () => {
  it("allowlisted cities → 'in'", () => {
    for (const city of ['Akron', 'Cuyahoga Falls', 'Hudson', 'Barberton', 'Peninsula', 'Uniontown']) {
      assert.equal(classifySummitLocation({ city }), 'in', `Expected ${city} in`)
    }
  })

  it("blocklisted cities → 'out' (incl. Youngstown metro, added 2026-07)", () => {
    for (const city of ['Cleveland', 'Canton', 'Kent', 'Medina', 'Niles', 'Warren', 'Youngstown', 'Boardman']) {
      assert.equal(classifySummitLocation({ city }), 'out', `Expected ${city} out`)
    }
  })

  it('normalizes a trailing "Township"/"Twp." suffix', () => {
    assert.equal(classifySummitLocation({ city: 'Bath Township' }), 'in')
    assert.equal(classifySummitLocation({ city: 'Copley Twp.' }), 'in')
    assert.equal(classifySummitLocation({ city: 'Rootstown Township' }), 'out')
  })

  it('is case- and whitespace-insensitive', () => {
    assert.equal(classifySummitLocation({ city: '  AKRON  ' }), 'in')
    assert.equal(classifySummitLocation({ city: 'nILes' }), 'out')
  })

  it("missing or unrecognized city → 'unknown' (review queue, never auto-published)", () => {
    assert.equal(classifySummitLocation({}), 'unknown')
    assert.equal(classifySummitLocation({ city: '' }), 'unknown')
    assert.equal(classifySummitLocation({ city: null }), 'unknown')
    assert.equal(classifySummitLocation({ city: 'Springfield' }), 'unknown')  // ambiguous: Summit twp vs Clark Co. city
    assert.equal(classifySummitLocation(), 'unknown')
  })
})

describe('isSummitCountyLocation — strict boolean wrapper', () => {
  it("only 'in' passes; both 'out' and 'unknown' fail", () => {
    assert.equal(isSummitCountyLocation({ city: 'Akron' }), true)
    assert.equal(isSummitCountyLocation({ city: 'Canton' }), false)
    assert.equal(isSummitCountyLocation({ city: 'Springfield' }), false)
    assert.equal(isSummitCountyLocation({}), false)
  })
})

describe('allowlist / blocklist hygiene', () => {
  it('the two lists never overlap', () => {
    for (const city of SUMMIT_COUNTY_CITIES) {
      assert.equal(NOT_SUMMIT_COUNTY_CITIES.has(city), false, `${city} is on both lists`)
    }
  })

  it('Uniontown (straddles the county line) stays on the allowlist only', () => {
    assert.equal(SUMMIT_COUNTY_CITIES.has('uniontown'), true)
    assert.equal(NOT_SUMMIT_COUNTY_CITIES.has('uniontown'), false)
  })
})
