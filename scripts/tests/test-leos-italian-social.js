/**
 * test-leos-italian-social.js — Leo's Italian Social (Squarespace, multi-location) parsing.
 *
 * Focus: the per-event Summit gate. Leo's lists live music across several
 * locations in one collection; only the Cuyahoga Falls room is in Summit
 * County. The gate must read the REAL per-event pin (mapLat/mapLng), never the
 * site-wide-constant marker pin, or every event would misclassify.
 *
 * Run:
 *   node --test scripts/tests/test-leos-italian-social.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// normalize.js builds a Supabase client at import time — give it dummy creds.
process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  normaliseSquarespaceEvent,
  buildSquarespaceEventUrl,
} = await import('../lib/squarespace.js')
const {
  parseLeosLocation,
  classifyEventLocation,
  cleanTitle,
  mapCategories,
  mapTags,
  CANCELLED_RE,
  SITE_BASE_URL,
  SOURCE_KEY,
} = await import('../scrape-leos-italian-social.js')
const { preloadSummitCountyBoundary } = await import('../lib/summit-county.js')

await preloadSummitCountyBoundary()

// ── Fixtures captured from the live /music?format=json feed ──────────────────

// Cuyahoga Falls (Summit County → publish). Note markerLat/markerLng are the
// site-wide default; the real pin is in mapLat/mapLng.
const CUYAHOGA_FALLS = {
  id:        '69b2ba00a6af2469046bdf41',
  urlId:     'asheville-3-28-izzi-hughes-4lhbz-59eds-72cys-yt5pw-ckc5w',
  title:     'Danny Christian+ $8 Martinis',
  startDate: 1784235600679,
  endDate:   1784246400679,
  fullUrl:   '/music/asheville-3-28-izzi-hughes-4lhbz-59eds-72cys-yt5pw-ckc5w',
  assetUrl:  'https://static1.squarespace.com/static/x/y/z/1773320723070/',
  excerpt:   '<p>Join us in Cuyahoga Falls, Ohio for $8 Martinis all day and live tunes at 5 pm.</p>',
  starred:   false,
  body:      '<div class="sqs-layout">Live music</div>',
  location: {
    addressTitle:  'Leo&#39;s Italian Social',
    addressLine1:  '2251 Front St.',
    addressLine2:  'Cuyahoga Falls, OH',
    mapLat:        41.1375608,
    mapLng:        -81.4824462,
    markerLat:     41.4324017,   // site-wide default — must be ignored
    markerLng:     -81.3933376,
    addressCountry: 'United States',
  },
}

// Crocker Park / Westlake (Cuyahoga County → skip). addressLine2 mislabels the
// city as "Chagrin Falls", but the real pin (mapLat/mapLng) is out of county.
const CROCKER_PARK = {
  id:        '69d7ef600df84356863c055e',
  urlId:     'crocker-park-3-7-hayden-grove-8tr9m',
  title:     'Scott Stiert + $8 Martinis',
  startDate: 1784239200022,
  endDate:   1784246400022,
  fullUrl:   '/music/crocker-park-3-7-hayden-grove-8tr9m',
  assetUrl:  'https://static1.squarespace.com/static/x/y/z/1775759219108/',
  excerpt:   '<p>Join us in Westlake, Ohio at Crocker Park for $8 Martinis all day and live tunes at 6pm.</p>',
  starred:   false,
  body:      '<div class="sqs-layout">Live music</div>',
  location: {
    addressTitle:  'Leo&#39;s Italian Social',
    addressLine1:  '200 Crocker ',
    addressLine2:  'Chagrin Falls, OH, 44022',
    mapLat:        41.4598767,
    mapLng:        -81.9524161,
    markerLat:     41.4324017,
    markerLng:     -81.3933376,
    addressCountry: 'United States',
  },
}

// Synthetic: a Cuyahoga Falls entry that ships without coords (future-proofing
// the city fallback). Should still classify 'in' via SUMMIT_COUNTY_CITIES.
const CF_NO_COORDS = {
  ...CUYAHOGA_FALLS,
  id: 'cf-no-coords',
  location: { ...CUYAHOGA_FALLS.location, mapLat: null, mapLng: null },
}

// Synthetic: no coords + unrecognized city → 'unknown' (skipped, not published).
const UNKNOWN_CITY = {
  ...CUYAHOGA_FALLS,
  id: 'unknown-city',
  location: { addressTitle: 'Leo&#39;s Italian Social', addressLine1: '1 Main St', addressLine2: 'Somewhere, XX', mapLat: null, mapLng: null },
}

const normalise = (item) => {
  const row = normaliseSquarespaceEvent(item, {
    source: SOURCE_KEY, mapTags,
    defaultPriceMin: null, defaultPriceMax: null,
  })
  row.categories = mapCategories()
  row.title      = cleanTitle(row.title)
  row.ticket_url = buildSquarespaceEventUrl(SITE_BASE_URL, item) || row.ticket_url
  return row
}

// ── Location parsing ─────────────────────────────────────────────────────────

describe("Leo's — location parsing", () => {
  it('uses the real map pin, NOT the site-wide marker default', () => {
    const loc = parseLeosLocation(CUYAHOGA_FALLS.location)
    assert.equal(loc.lat, 41.1375608)
    assert.equal(loc.lng, -81.4824462)
    assert.notEqual(loc.lat, CUYAHOGA_FALLS.location.markerLat)
  })
  it('decodes the venue name and strips the trailing period from the address', () => {
    const loc = parseLeosLocation(CUYAHOGA_FALLS.location)
    assert.equal(loc.name, "Leo's Italian Social")
    assert.equal(loc.address, '2251 Front St')   // trailing "." folded off
    assert.equal(loc.city, 'Cuyahoga Falls')
    assert.equal(loc.state, 'OH')
  })
  it('parses city/state/zip from a three-part addressLine2', () => {
    const loc = parseLeosLocation(CROCKER_PARK.location)
    assert.equal(loc.city, 'Chagrin Falls')
    assert.equal(loc.state, 'OH')
    assert.equal(loc.zip, '44022')
  })
  it('returns null for a missing location', () => {
    assert.equal(parseLeosLocation(null), null)
  })
})

// ── Summit gate ──────────────────────────────────────────────────────────────

describe("Leo's — Summit County gate", () => {
  it("classifies the Cuyahoga Falls room 'in'", () => {
    assert.equal(classifyEventLocation(CUYAHOGA_FALLS), 'in')
  })
  it("classifies Crocker Park / Westlake 'out' by its real pin", () => {
    assert.equal(classifyEventLocation(CROCKER_PARK), 'out')
  })
  it("falls back to the city allowlist when coords are missing ('in')", () => {
    assert.equal(classifyEventLocation(CF_NO_COORDS), 'in')
  })
  it("returns 'unknown' for a coordless, unrecognized city", () => {
    assert.equal(classifyEventLocation(UNKNOWN_CITY), 'unknown')
  })
})

// ── Title cleanup ────────────────────────────────────────────────────────────

describe("Leo's — title cleanup", () => {
  it('strips the "+ $8 Martinis" promo (missing-space variant)', () => {
    assert.equal(cleanTitle('Danny Christian+ $8 Martinis'), 'Danny Christian')
  })
  it('strips the "+ $8 Martinis" promo (spaced variant + trailing space)', () => {
    assert.equal(cleanTitle('Hayden Grove + $8 Martinis '), 'Hayden Grove')
  })
  it('handles any dollar amount', () => {
    assert.equal(cleanTitle('Brent Kirby + $12 Martinis'), 'Brent Kirby')
  })
  it('leaves a title without the promo untouched', () => {
    assert.equal(cleanTitle('Andy Penk'), 'Andy Penk')
  })
})

// ── Cancelled/postponed guard ────────────────────────────────────────────────

describe("Leo's — cancelled/postponed guard", () => {
  it('matches a scratched show title (both spellings) but not a normal one', () => {
    assert.ok(CANCELLED_RE.test('Danny Christian - CANCELLED'))
    assert.ok(CANCELLED_RE.test('Brent Kirby (canceled)'))
    assert.ok(CANCELLED_RE.test('Scott Stiert — Postponed'))
    assert.ok(!CANCELLED_RE.test('Danny Christian'))
  })
})

// ── Category / tags ──────────────────────────────────────────────────────────

describe("Leo's — category + tags", () => {
  it('forces every entry to a clean single music category', () => {
    assert.deepEqual(mapCategories(), ['music'])
  })
  it('passes categories as an explicit array on the normalised row', () => {
    assert.deepEqual(normalise(CUYAHOGA_FALLS).categories, ['music'])
  })
  it('emits stable base tags with no duplicates', () => {
    const tags = mapTags()
    assert.ok(tags.includes('live-music'))
    assert.ok(tags.includes('cuyahoga-falls'))
    assert.equal(tags.length, new Set(tags).size)
  })
})

// ── Normalization ────────────────────────────────────────────────────────────

describe("Leo's — normalization", () => {
  it('converts the epoch-ms start (5 PM EDT) to 21:00Z, whole seconds', () => {
    const row = normalise(CUYAHOGA_FALLS)
    assert.equal(row.start_at, '2026-07-16T21:00:00.000Z')
    assert.equal(row.end_at,   '2026-07-17T00:00:00.000Z')
  })
  it('uses the Squarespace item id as a stable source_id', () => {
    assert.equal(normalise(CUYAHOGA_FALLS).source_id, '69b2ba00a6af2469046bdf41')
  })
  it('sets source, published status, and a full absolute ticket_url', () => {
    const row = normalise(CUYAHOGA_FALLS)
    assert.equal(row.source, 'leos_italian_social')
    assert.equal(row.status, 'published')
    assert.equal(
      row.ticket_url,
      'https://www.leositaliansocial.com/music/asheville-3-28-izzi-hughes-4lhbz-59eds-72cys-yt5pw-ckc5w',
    )
  })
  it('never asserts a price (martinis are a drink special, not admission)', () => {
    const row = normalise(CUYAHOGA_FALLS)
    assert.equal(row.price_min, null)
    assert.equal(row.price_max, null)
  })
  it('cleans the promo suffix out of the stored title', () => {
    assert.equal(normalise(CUYAHOGA_FALLS).title, 'Danny Christian')
  })
})
