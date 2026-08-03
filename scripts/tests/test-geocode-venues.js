/**
 * test-geocode-venues.js — gate logic for geocode-venues.js (both the
 * default address mode and --names mode, now Nominatim-based).
 * Pure + offline; no DB, no network needed. Run:
 *   node --test scripts/tests/test-geocode-venues.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  hasAddressPrecision, zipMatches, passesAddressGate,
  inSummitBbox, normalizeNameTokens, tokenOverlapSimilarity, resultDisplayName,
  isJunkClassType, passesNamesGate,
  isNameCandidate, venueIdsWithUpcomingEvents, summarizeNamesRun,
  createRateLimiter,
} from '../geocode-venues.js'

// ── default (address) mode ─────────────────────────────────────────────

describe('address mode: hasAddressPrecision', () => {
  it('accepts an addresstype in the precision allowlist', () => {
    assert.equal(hasAddressPrecision({ addresstype: 'amenity', class: 'amenity' }), true)
    assert.equal(hasAddressPrecision({ addresstype: 'building', class: 'building' }), true)
    assert.equal(hasAddressPrecision({ addresstype: 'shop', class: 'shop' }), true)
  })
  it('falls back to class when addresstype is absent', () => {
    assert.equal(hasAddressPrecision({ class: 'leisure' }), true)
    assert.equal(hasAddressPrecision({ class: 'tourism' }), true)
  })
  it('rejects a highway result', () => {
    assert.equal(hasAddressPrecision({ addresstype: 'highway', class: 'highway', type: 'residential' }), false)
  })
  it('rejects a city/town/village/neighbourhood centroid', () => {
    assert.equal(hasAddressPrecision({ class: 'place', type: 'city', addresstype: 'city' }), false)
    assert.equal(hasAddressPrecision({ class: 'place', type: 'town' }), false)
    assert.equal(hasAddressPrecision({ class: 'place', type: 'village' }), false)
    assert.equal(hasAddressPrecision({ class: 'place', type: 'neighbourhood' }), false)
  })
  it('accepts a rooftop house-number match (class=place, type=house) — live-verified: Nominatim reports addresstype="place" here, not "house"', () => {
    assert.equal(hasAddressPrecision({ class: 'place', type: 'house', addresstype: 'place' }), true)
  })
  it('rejects an administrative boundary', () => {
    assert.equal(hasAddressPrecision({ addresstype: 'boundary', class: 'boundary', type: 'administrative' }), false)
  })
  it('rejects a class/addresstype not on the allowlist and not explicitly excluded', () => {
    assert.equal(hasAddressPrecision({ addresstype: 'natural', class: 'natural' }), false)
  })
  it('rejects a missing/null result', () => {
    assert.equal(hasAddressPrecision(null), false)
    assert.equal(hasAddressPrecision(undefined), false)
  })
})

describe('address mode: zipMatches', () => {
  it('passes through when the venue has no zip', () => {
    assert.equal(zipMatches(null, { address: { postcode: '44311' } }), true)
    assert.equal(zipMatches(undefined, { address: {} }), true)
  })
  it('matches an exact 5-digit zip', () => {
    assert.equal(zipMatches('44311', { address: { postcode: '44311' } }), true)
  })
  it('matches when the result has a zip+4 and the venue has 5 digits', () => {
    assert.equal(zipMatches('44311', { address: { postcode: '44311-1234' } }), true)
  })
  it('rejects a mismatched zip', () => {
    assert.equal(zipMatches('44311', { address: { postcode: '44240' } }), false)
  })
  it('rejects when the venue has a zip but the result has none', () => {
    assert.equal(zipMatches('44311', { address: {} }), false)
    assert.equal(zipMatches('44311', {}), false)
  })
})

describe('address mode: passesAddressGate', () => {
  const goodResult = {
    addresstype: 'amenity', class: 'amenity', type: 'theatre',
    lat: '41.081', lon: '-81.519',
    address: { postcode: '44308' },
  }
  it('passes a precise, zip-matched, in-bbox result', () => {
    assert.equal(passesAddressGate({ zip: '44308' }, goodResult), true)
  })
  it('passes when the venue has no zip on file (zip gate is a pass-through)', () => {
    assert.equal(passesAddressGate({ zip: null }, goodResult), true)
  })
  it('fails on address-precision gate (highway)', () => {
    const r = { ...goodResult, addresstype: 'highway', class: 'highway' }
    assert.equal(passesAddressGate({ zip: '44308' }, r), false)
  })
  it('fails on zip-mismatch gate', () => {
    assert.equal(passesAddressGate({ zip: '44240' }, goodResult), false)
  })
  it('fails on sanity-bbox gate (result outside NE Ohio)', () => {
    const farAway = { ...goodResult, lat: '39.9612', lon: '-82.9988', address: {} } // Columbus, no zip on result
    assert.equal(passesAddressGate({ zip: null }, farAway), false)
  })
  it('fails on missing/null result', () => {
    assert.equal(passesAddressGate({ zip: '44308' }, null), false)
  })
  it('fails when result lat/lon are not parseable numbers', () => {
    const r = { ...goodResult, lat: 'not-a-number', lon: 'nope' }
    assert.equal(passesAddressGate({ zip: '44308' }, r), false)
  })
})

// ── --names mode ─────────────────────────────────────────────────────

describe('names mode: inSummitBbox', () => {
  it('accepts a coordinate well inside Summit County (downtown Akron)', () => {
    assert.equal(inSummitBbox(-81.519, 41.081), true)
  })
  it('accepts the exact bbox corners (inclusive boundary)', () => {
    assert.equal(inSummitBbox(-81.69, 40.90), true)   // sw corner
    assert.equal(inSummitBbox(-81.36, 41.35), true)   // ne corner
  })
  it('rejects just outside each edge', () => {
    assert.equal(inSummitBbox(-81.70, 41.081), false) // west of bbox
    assert.equal(inSummitBbox(-81.35, 41.081), false) // east of bbox
    assert.equal(inSummitBbox(-81.519, 40.89), false) // south of bbox
    assert.equal(inSummitBbox(-81.519, 41.36), false) // north of bbox
  })
  it('rejects a coordinate in a neighboring county (e.g. downtown Cleveland)', () => {
    assert.equal(inSummitBbox(-81.6944, 41.4993), false)
  })
})

describe('names mode: normalizeNameTokens', () => {
  it('lowercases and splits on whitespace', () => {
    assert.deepEqual(normalizeNameTokens('Lock 3 Park'), ['lock', '3', 'park'])
  })
  it('strips punctuation', () => {
    assert.deepEqual(normalizeNameTokens("O'Neil's, Downtown!"), ['o', 'neil', 's', 'downtown'])
  })
  it('handles empty/null input', () => {
    assert.deepEqual(normalizeNameTokens(''), [])
    assert.deepEqual(normalizeNameTokens(null), [])
    assert.deepEqual(normalizeNameTokens(undefined), [])
  })
})

describe('names mode: tokenOverlapSimilarity', () => {
  it('is 1.0 for identical names', () => {
    assert.equal(tokenOverlapSimilarity('Lock 3', 'Lock 3'), 1)
  })
  it('is 1.0 regardless of case/punctuation differences', () => {
    assert.equal(tokenOverlapSimilarity('Lock 3', "lock, 3!"), 1)
  })
  it('computes Dice coefficient for a superset match (Lock 3 vs Lock 3 Park)', () => {
    // 2*|{lock,3}| / (2+3) = 4/5 = 0.8
    assert.equal(tokenOverlapSimilarity('Lock 3', 'Lock 3 Park'), 0.8)
  })
  it('is low for unrelated names', () => {
    assert.ok(tokenOverlapSimilarity('Lock 3', 'Highland Square Theatre') < 0.3)
  })
  it('is 0 when either input has no tokens', () => {
    assert.equal(tokenOverlapSimilarity('', 'Lock 3'), 0)
    assert.equal(tokenOverlapSimilarity('Lock 3', ''), 0)
    assert.equal(tokenOverlapSimilarity(null, undefined), 0)
  })
})

describe('names mode: resultDisplayName', () => {
  it('prefers namedetails.name when present', () => {
    assert.equal(
      resultDisplayName({ namedetails: { name: 'Lock 3' }, display_name: 'Something Else, Akron, OH' }),
      'Lock 3'
    )
  })
  it('falls back to the first display_name segment', () => {
    assert.equal(resultDisplayName({ display_name: 'Lock 3, Main St, Akron, OH, USA' }), 'Lock 3')
  })
  it('returns empty string when neither is present', () => {
    assert.equal(resultDisplayName({}), '')
    assert.equal(resultDisplayName(null), '')
  })
})

describe('names mode: isJunkClassType', () => {
  it('flags highway as junk', () => {
    assert.equal(isJunkClassType('highway', 'residential'), true)
  })
  it('flags boundary as junk', () => {
    assert.equal(isJunkClassType('boundary', 'administrative'), true)
  })
  it('flags place=house as junk', () => {
    assert.equal(isJunkClassType('place', 'house'), true)
  })
  it('does not flag other place types', () => {
    assert.equal(isJunkClassType('place', 'city'), false)
  })
  it('does not flag amenity/shop/etc.', () => {
    assert.equal(isJunkClassType('amenity', 'theatre'), false)
    assert.equal(isJunkClassType('shop', 'bakery'), false)
  })
  it('handles missing class', () => {
    assert.equal(isJunkClassType(null, 'house'), false)
    assert.equal(isJunkClassType(undefined, undefined), false)
  })
})

describe('names mode: passesNamesGate', () => {
  it('passes a high-similarity, non-junk hit', () => {
    const r = { class: 'amenity', type: 'theatre', namedetails: { name: 'Lock 3' } }
    assert.equal(passesNamesGate('Lock 3', r), true)
  })
  it('passes exactly at the 0.8 similarity boundary', () => {
    const r = { class: 'leisure', type: 'park', namedetails: { name: 'Lock 3 Park' } }
    assert.equal(passesNamesGate('Lock 3', r), true)
  })
  it('fails just under the 0.8 similarity boundary', () => {
    const r = { class: 'leisure', type: 'park', namedetails: { name: 'Lock 3 Riverfront Park' } }
    // 2*2/(2+4) = 0.666...
    assert.equal(passesNamesGate('Lock 3', r), false)
  })
  it('fails a high-similarity hit that is a junk class/type (highway)', () => {
    const r = { class: 'highway', type: 'residential', namedetails: { name: 'Lock 3' } }
    assert.equal(passesNamesGate('Lock 3', r), false)
  })
  it('fails on missing/null result', () => {
    assert.equal(passesNamesGate('Lock 3', null), false)
    assert.equal(passesNamesGate('Lock 3', undefined), false)
  })
  it('fails when the result has no resolvable name', () => {
    assert.equal(passesNamesGate('Lock 3', { class: 'amenity', type: 'theatre' }), false)
  })
})

describe('names mode: isNameCandidate', () => {
  it('accepts a venue with no lat, no lng, and no address', () => {
    assert.equal(isNameCandidate({ lat: null, lng: null, address: null }), true)
  })
  it('rejects a venue that already has coordinates', () => {
    assert.equal(isNameCandidate({ lat: 41.08, lng: -81.51, address: null }), false)
  })
  it('rejects a venue that has an address (belongs to the default mode instead)', () => {
    assert.equal(isNameCandidate({ lat: null, lng: null, address: '1 Main St' }), false)
  })
  it('rejects a venue with only one of lat/lng set (shouldn\'t happen, but never a candidate)', () => {
    assert.equal(isNameCandidate({ lat: 41.08, lng: null, address: null }), false)
  })
  it('treats undefined the same as null', () => {
    assert.equal(isNameCandidate({ address: null }), true)
  })
})

describe('names mode: venueIdsWithUpcomingEvents', () => {
  it('collects venue ids from event_venues rows (inner-joined to events, one row per match)', () => {
    const links = [
      { venue_id: 'v1', events: { id: 'e1', status: 'published', start_at: '2026-09-01' } },
      { venue_id: 'v2', events: { id: 'e2', status: 'published', start_at: '2026-09-01' } },
      { venue_id: 'v3', events: { id: 'e2', status: 'published', start_at: '2026-09-01' } },
    ]
    const ids = venueIdsWithUpcomingEvents(links)
    assert.deepEqual([...ids].sort(), ['v1', 'v2', 'v3'])
  })
  it('dedupes a venue appearing on multiple qualifying events', () => {
    const links = [
      { venue_id: 'v1', events: { id: 'e1', status: 'published', start_at: '2026-09-01' } },
      { venue_id: 'v1', events: { id: 'e2', status: 'published', start_at: '2026-10-01' } },
    ]
    assert.equal(venueIdsWithUpcomingEvents(links).size, 1)
  })
  it('handles rows with no venue_id and an empty/undefined input', () => {
    assert.equal(venueIdsWithUpcomingEvents([{ events: { id: 'e1' } }]).size, 0)
    assert.equal(venueIdsWithUpcomingEvents([{ venue_id: null, events: { id: 'e1' } }]).size, 0)
    assert.equal(venueIdsWithUpcomingEvents(undefined).size, 0)
    assert.equal(venueIdsWithUpcomingEvents([]).size, 0)
  })
})

// ── shared rate limiter (paces nominatimFetch — both modes, retries, and
// error paths) ─────────────────────────────────────────────────────────

describe('createRateLimiter', () => {
  it('does not wait on the first call', async () => {
    const waits = []
    const limiter = createRateLimiter(1000, { now: () => 0, wait: async (ms) => { waits.push(ms) } })
    await limiter()
    assert.deepEqual(waits, [])
  })

  it('spaces two immediate calls by the full remaining interval', async () => {
    const waits = []
    let t = 0
    const limiter = createRateLimiter(1000, {
      now: () => t,
      wait: async (ms) => { waits.push(ms); t += ms },
    })
    await limiter() // first call: no prior call, no wait
    await limiter() // second call: clock hasn't advanced, must wait the full interval
    assert.deepEqual(waits, [1000])
  })

  it('does not wait when calls are already spaced >= the interval apart', async () => {
    const waits = []
    let t = 0
    const limiter = createRateLimiter(1000, { now: () => t, wait: async (ms) => { waits.push(ms) } })
    await limiter()
    t = 2000
    await limiter()
    assert.deepEqual(waits, [])
  })

  it('waits only the remaining gap, not the full interval, on a partial elapse', async () => {
    const waits = []
    let t = 0
    const limiter = createRateLimiter(1000, { now: () => t, wait: async (ms) => { waits.push(ms) } })
    await limiter()
    t = 400
    await limiter()
    assert.deepEqual(waits, [600])
  })

  it('paces three back-to-back calls, each waiting relative to the last recorded call time', async () => {
    const waits = []
    let t = 0
    const limiter = createRateLimiter(1000, {
      now: () => t,
      wait: async (ms) => { waits.push(ms); t += ms },
    })
    await limiter() // t=0 -> last=0
    await limiter() // t=0, elapsed=0 -> wait 1000, t=1000, last=1000
    await limiter() // t=1000, elapsed=0 -> wait 1000, t=2000, last=2000
    assert.deepEqual(waits, [1000, 1000])
  })
})

describe('names mode: summarizeNamesRun (blocked-capability detection)', () => {
  it('reports no-candidates when nothing qualified', () => {
    assert.equal(summarizeNamesRun([], false), 'no-candidates')
    assert.equal(summarizeNamesRun(undefined, false), 'no-candidates')
  })
  it('reports blocked when the run was aborted on a policy block, regardless of candidate count', () => {
    const candidates = [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }]
    assert.equal(summarizeNamesRun(candidates, true), 'blocked')
  })
  it('reports ok for a normal completed run', () => {
    const candidates = [{ id: 'v1' }, { id: 'v2' }]
    assert.equal(summarizeNamesRun(candidates, false), 'ok')
  })
  it('reports ok (not blocked) even when every query came back with zero results — that is a real "no match" run, not a policy block', () => {
    const candidates = [{ id: 'v1' }, { id: 'v2' }, { id: 'v3' }]
    assert.equal(summarizeNamesRun(candidates, false), 'ok')
  })
})
