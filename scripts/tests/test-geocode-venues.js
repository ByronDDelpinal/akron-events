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
  isJunkClassType, passesNamesGate, buildNameVariants, evaluateNameVariantRung,
  isGeocodableVenueName, venueNameRefusalReason, buildNameQuery, cityMatches,
  isNameCandidate, venueIdsWithUpcomingEvents, summarizeNamesRun,
  createRateLimiter,
  chunkIds, narrowAndLimit, VENUE_ID_CHUNK_SIZE,
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
  it('maps theatre -> theater', () => {
    assert.deepEqual(normalizeNameTokens('Rialto Theatre'), ['rialto', 'theater'])
  })
  it('maps centre -> center', () => {
    assert.deepEqual(normalizeNameTokens('Highland Centre'), ['highland', 'center'])
  })
  it('maps st -> street', () => {
    assert.deepEqual(normalizeNameTokens('High St. Hop House'), ['high', 'street', 'hop', 'house'])
  })
  it('drops stopwords (the/a/an/of/at/in/on/and)', () => {
    assert.deepEqual(normalizeNameTokens('Concert in the Park'), ['concert', 'park'])
    assert.deepEqual(normalizeNameTokens('Friends of the Library'), ['friends', 'library'])
  })
  it('falls back to the pre-stopword (but still mapped) tokens when dropping stopwords would empty the list', () => {
    assert.deepEqual(normalizeNameTokens('The A An'), ['the', 'a', 'an'])
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
  it('is 1.0 across the theatre/theater spelling variant', () => {
    assert.equal(tokenOverlapSimilarity('Rialto Theatre', 'Rialto Theater'), 1)
  })
  it('is 1.0 across the St./Street abbreviation variant', () => {
    assert.equal(tokenOverlapSimilarity('High St. Hop House', 'High Street Hop House'), 1)
  })
  it('still computes 0.8 for the Lock 3 / Lock 3 Park boundary case (regression guard)', () => {
    assert.equal(tokenOverlapSimilarity('Lock 3', 'Lock 3 Park'), 0.8)
  })
  it('MAJOR 1 regression: a shared stopword ("of") must not lower the score below the pre-ladder value: "Hall of Fame Museum" vs "Pro Football Hall of Fame Museum" stays 0.8 and passes MIN_SIMILARITY_NAMES', () => {
    const similarity = tokenOverlapSimilarity('Hall of Fame Museum', 'Pro Football Hall of Fame Museum')
    assert.equal(similarity, 0.8)
    assert.ok(similarity >= 0.8)
  })
})

describe('names mode: buildNameVariants', () => {
  it('returns exactly the original for a short, already-clean name (request-budget guard)', () => {
    assert.deepEqual(buildNameVariants('Lock 3'), ['Lock 3'])
  })
  it('rung 0 is always the original name, verbatim, at index 0 (not just present anywhere in the ladder)', () => {
    const prose = 'Pro Football Hall of Fame Museum in Canton'
    const variants = buildNameVariants(prose)
    assert.equal(variants[0], prose)
  })
  it('includes the head-only variant for a name with " in <locality>" (never the tail)', () => {
    const variants = buildNameVariants('The Rialto Theatre in Kenmore')
    assert.ok(variants.includes('Rialto Theatre'))
    assert.ok(!variants.includes('Kenmore')) // the locality tail is never queried on its own
  })
  it('orders the "at" head before the tail (Himelright Lodge at Cascade Valley Metro Park)', () => {
    const variants = buildNameVariants('Himelright Lodge at Cascade Valley Metro Park')
    const headIdx = variants.indexOf('Himelright Lodge')
    const tailIdx = variants.indexOf('Cascade Valley Metro Park')
    assert.ok(headIdx !== -1 && tailIdx !== -1)
    assert.ok(headIdx < tailIdx)
  })
  it('orders the "at" head before the tail (Fazio Course at Firestone Country Club)', () => {
    const variants = buildNameVariants('Fazio Course at Firestone Country Club')
    const headIdx = variants.indexOf('Fazio Course')
    const tailIdx = variants.indexOf('Firestone Country Club')
    assert.ok(headIdx !== -1 && tailIdx !== -1)
    assert.ok(headIdx < tailIdx)
  })
  it('drops a head that is all generic venue words (Main Stage at Akron Civic Theatre -> no "Main Stage")', () => {
    const variants = buildNameVariants('Main Stage at Akron Civic Theatre')
    assert.ok(!variants.includes('Main Stage'))
    assert.ok(variants.includes('Akron Civic Theatre'))
  })
  it('drops a single-token "in" head below the variant floor (Concert in the Park -> length 1)', () => {
    assert.deepEqual(buildNameVariants('Concert in the Park'), ['Concert in the Park'])
  })
  it('strips a parenthetical on the cleaned-base rung', () => {
    const variants = buildNameVariants('Jan Weber Social Center (Senior Center)')
    assert.ok(variants.includes('Jan Weber Social Center'))
  })
  it('every result is deduped and capped at 4', () => {
    for (const name of [
      'Lock 3',
      'The Rialto Theatre in Kenmore',
      'Himelright Lodge at Cascade Valley Metro Park',
      'Fazio Course at Firestone Country Club',
      'Main Stage at Akron Civic Theatre',
      'Concert in the Park',
      'Jan Weber Social Center (Senior Center)',
    ]) {
      const variants = buildNameVariants(name)
      assert.ok(variants.length <= 4)
      assert.equal(new Set(variants.map((v) => v.toLowerCase())).size, variants.length)
    }
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
  it('flags place=village/city/county as junk (PLACE_ADMIN_TYPES: administrative centroids, not a visitable point)', () => {
    assert.equal(isJunkClassType('place', 'village'), true)
    assert.equal(isJunkClassType('place', 'city'), true)
    assert.equal(isJunkClassType('place', 'county'), true)
  })
  it('does not flag place=park (a named green space is still a defensible venue point)', () => {
    assert.equal(isJunkClassType('place', 'park'), false)
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
  it('passes the cleaned variant against an OSM hit across the theatre/theater spelling variant', () => {
    const r = { class: 'amenity', type: 'theatre', namedetails: { name: 'Rialto Theater' } }
    assert.equal(passesNamesGate('Rialto Theatre', r), true)
  })
  // RESOLVED by the MAJOR 1 fix (round-2 code review): this pair used to
  // compute to exactly 0.8 (a "documented discrepancy" against the design,
  // which called for it to be false) because tokenOverlapSimilarity used to
  // route through normalizeNameTokens' stopword drop. Dropping "the"/"in"
  // from ONLY the venue side (the candidate has neither) shrank that side's
  // denominator without a matching numerator gain, artificially inflating
  // the score. Now that similarity scoring keeps stopwords (mappedNameTokens),
  // this pair correctly lands at 4/7, about 0.571, below MIN_SIMILARITY_NAMES,
  // matching the design intent, the locality suffix really does dilute the
  // match, which is exactly why buildNameVariants tries the head-only rung
  // ("Rialto Theatre") rather than relying on the full name.
  it('the "in <locality>" full-name variant now correctly fails the 0.8 boundary (design discrepancy fixed by MAJOR 1)', () => {
    const r = { class: 'amenity', type: 'theatre', namedetails: { name: 'Rialto Theater' } }
    assert.equal(tokenOverlapSimilarity('The Rialto Theatre in Kenmore', resultDisplayName(r)), 4 / 7)
    assert.equal(passesNamesGate('The Rialto Theatre in Kenmore', r), false)
  })
})

// A stub isInSummit(lat, lng) => boolean is passed to every call below so
// these tests never touch the real county boundary GeoJSON.
const inSummit = () => true
const outOfSummit = () => false

describe('names mode: evaluateNameVariantRung (MAJOR 2 + MAJOR 3: the variant walk, extracted)', () => {
  it('rung 0 (verbatim original) considers ONLY the first result, exactly as the pre-ladder code did: a passing second result must not be picked up', () => {
    const results = [
      { class: 'highway', type: 'residential', lat: '41.08', lon: '-81.52', namedetails: { name: 'Lock 3' } }, // junk, rejected
      { class: 'amenity', type: 'theatre', lat: '41.08', lon: '-81.52', namedetails: { name: 'Lock 3' } }, // would pass
    ]
    const { matched, rejected } = evaluateNameVariantRung(0, 'Lock 3', results, null, inSummit)
    assert.equal(matched, null)
    assert.ok(rejected)
    assert.equal(rejected.why, 'junk class/type (highway/residential)')
  })
  it('a derived rung (rungIndex >= 1) scans past a failing first result to a passing second result', () => {
    const results = [
      { class: 'highway', type: 'residential', lat: '41.08', lon: '-81.52', namedetails: { name: 'Lock 3' } }, // junk, rejected
      { class: 'amenity', type: 'theatre', lat: '41.08', lon: '-81.52', namedetails: { name: 'Lock 3' } }, // passes
    ]
    const { matched, rejected } = evaluateNameVariantRung(1, 'Lock 3', results, null, inSummit)
    assert.ok(matched)
    assert.equal(matched.rungIndex, 1)
    assert.equal(matched.result, results[1])
    // A rejected candidate from EARLIER in the same rung's scan (results[0],
    // junk class) is still tracked even though a later result matched, the
    // caller only reads `rejected` when the whole walk comes up empty, so a
    // stray reject alongside a match is harmless, but it must be the right
    // one (results[0]'s reason), not null.
    assert.ok(rejected)
    assert.equal(rejected.result, results[0])
    assert.equal(rejected.why, 'junk class/type (highway/residential)')
  })
  it('STOPPING RULE: when the first result already clears every gate, a later also-passing result is never reached', () => {
    const results = [
      { class: 'amenity', type: 'theatre', lat: '41.08', lon: '-81.52', namedetails: { name: 'Lock 3' } },
      { class: 'amenity', type: 'theatre', lat: '41.09', lon: '-81.53', namedetails: { name: 'Lock 3' } },
    ]
    const { matched } = evaluateNameVariantRung(1, 'Lock 3', results, null, inSummit)
    assert.equal(matched.result, results[0])
  })
  it('MINOR 4: a result with non-finite coordinates is reported as rejected ("unparseable coords"), not silently skipped', () => {
    const results = [{ class: 'amenity', type: 'theatre', lat: 'not-a-number', lon: 'nope', namedetails: { name: 'Lock 3' } }]
    const { matched, rejected } = evaluateNameVariantRung(0, 'Lock 3', results, null, inSummit)
    assert.equal(matched, null)
    assert.ok(rejected)
    assert.equal(rejected.why, 'unparseable coords')
  })
  it('rejects on the Summit County polygon check via the injected isInSummit predicate', () => {
    const results = [{ class: 'amenity', type: 'theatre', lat: '41.08', lon: '-81.52', namedetails: { name: 'Lock 3' } }]
    const { matched, rejected } = evaluateNameVariantRung(0, 'Lock 3', results, null, outOfSummit)
    assert.equal(matched, null)
    assert.ok(rejected.why.startsWith('out of Summit County'))
  })
  it('rejects on city mismatch when the venue has a city on file', () => {
    const results = [{
      class: 'amenity', type: 'theatre', lat: '41.08', lon: '-81.52',
      namedetails: { name: 'Lock 3' }, address: { city: 'Barberton' },
    }]
    const { matched, rejected } = evaluateNameVariantRung(0, 'Lock 3', results, 'Akron', inSummit)
    assert.equal(matched, null)
    assert.equal(rejected.why, 'city mismatch (venue=Akron, result=Barberton)')
  })
  it('rejects on low similarity and reports the score', () => {
    const results = [{ class: 'amenity', type: 'theatre', lat: '41.08', lon: '-81.52', namedetails: { name: 'Something Unrelated' } }]
    const { matched, rejected } = evaluateNameVariantRung(0, 'Lock 3', results, null, inSummit)
    assert.equal(matched, null)
    assert.ok(rejected.why.startsWith('low similarity'))
  })
  it('an empty results array (no hits) yields no match and no rejection', () => {
    const { matched, rejected } = evaluateNameVariantRung(0, 'Lock 3', [], null, inSummit)
    assert.equal(matched, null)
    assert.equal(rejected, null)
  })
  it('across multiple rejected results on a derived rung, the highest-similarity rejection wins', () => {
    const results = [
      { class: 'amenity', type: 'theatre', lat: '41.08', lon: '-81.52', namedetails: { name: 'Totally Unrelated Name' } },
      { class: 'amenity', type: 'theatre', lat: '41.09', lon: '-81.53', namedetails: { name: 'Lock 3 Riverfront Park' } },
    ]
    const { matched, rejected } = evaluateNameVariantRung(1, 'Lock 3', results, null, inSummit)
    assert.equal(matched, null)
    assert.equal(rejected.result, results[1])
  })
})

describe('names mode: isNameCandidate', () => {
  it('accepts a venue with no lat, no lng, and no address', () => {
    assert.equal(isNameCandidate({ lat: null, lng: null, address: null }), true)
  })
  it('accepts a venue whose address is a blank string (unusable, same as null)', () => {
    assert.equal(isNameCandidate({ lat: null, lng: null, address: '' }), true)
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

describe('names mode: isGeocodableVenueName', () => {
  it('accepts ordinary venue names', () => {
    assert.equal(isGeocodableVenueName("Ingy's Piano Bar"), true)
    assert.equal(isGeocodableVenueName('Need Skateshop'), true)
    assert.equal(isGeocodableVenueName('Gazebo Green'), true)
  })
  it('refuses an email address leaking into the name field', () => {
    assert.equal(isGeocodableVenueName('For venue details reach us at info@learnerring.com'), false)
  })
  it('refuses a bare street address', () => {
    assert.equal(isGeocodableVenueName('1146 W Highland Rd'), false)
  })
  it('refuses a bare US state name', () => {
    assert.equal(isGeocodableVenueName('Ohio'), false)
  })
  it('refuses a street-fragment junk name', () => {
    assert.equal(isGeocodableVenueName('Church Street'), false)
  })
  it('refuses an empty string', () => {
    assert.equal(isGeocodableVenueName(''), false)
  })
  it('refuses prose in the name slot (more than 8 tokens)', () => {
    const prose = 'Please call the front desk to confirm your exact meeting location here'
    assert.equal(prose.split(/\s+/).length, 12)
    assert.equal(isGeocodableVenueName(prose), false)
  })
})

describe('names mode: venueNameRefusalReason (per-rule stamping)', () => {
  it('returns null for ordinary venue names', () => {
    assert.equal(venueNameRefusalReason("Ingy's Piano Bar"), null)
    assert.equal(venueNameRefusalReason('Need Skateshop'), null)
    assert.equal(venueNameRefusalReason('Gazebo Green'), null)
  })
  it('stamps "email/url" for an email address leaking into the name field', () => {
    assert.equal(
      venueNameRefusalReason('For venue details reach us at info@learnerring.com'),
      'email/url',
    )
  })
  it('stamps "email/url" for a bare URL', () => {
    assert.equal(venueNameRefusalReason('https://example.com/venue'), 'email/url')
  })
  it('stamps "street address" for a bare street address', () => {
    assert.equal(venueNameRefusalReason('1146 W Highland Rd'), 'street address')
  })
  it('stamps "state name" for a bare US state name', () => {
    assert.equal(venueNameRefusalReason('Ohio'), 'state name')
  })
  it('stamps "state name" for a street-fragment junk name (isJunkVenueName territory)', () => {
    assert.equal(venueNameRefusalReason('Church Street'), 'state name')
  })
  it('stamps "too short" for an empty string', () => {
    assert.equal(venueNameRefusalReason(''), 'too short')
  })
  it('stamps "no letters" for a digits-only name', () => {
    assert.equal(venueNameRefusalReason('12345'), 'no letters')
  })
  it('stamps "prose" for more than 8 tokens in the name slot', () => {
    const prose = 'Please call the front desk to confirm your exact meeting location here'
    assert.equal(prose.split(/\s+/).length, 12)
    assert.equal(venueNameRefusalReason(prose), 'prose')
  })
  it('isGeocodableVenueName stays boolean-compatible with venueNameRefusalReason', () => {
    for (const name of ["Ingy's Piano Bar", 'Ohio', '1146 W Highland Rd', '', 'https://x.com']) {
      assert.equal(isGeocodableVenueName(name), venueNameRefusalReason(name) === null)
    }
  })
})

describe('names mode: baseline venue pagination does not drop rows past a full page', () => {
  it('retains isNameCandidate rows across a full page + a short trailing page', () => {
    // Mirrors the PostgREST 1000-row page cap that fetchVenueIdsWithUpcomingEvents
    // already guards against: a full page (length === pageSize) must never be
    // mistaken for the last page — only a page SHORTER than pageSize terminates
    // the loop. Simulated here with a small pageSize since exercising the real
    // 1000-row cap needs a live DB.
    const pageSize = 3
    const page1 = [
      { id: 'v1', lat: null, lng: null, address: null },
      { id: 'v2', lat: null, lng: null, address: '   ' },
      { id: 'v3', lat: 41.0, lng: -81.5, address: null }, // has coords: not a candidate
    ]
    const page2 = [
      { id: 'v4', lat: null, lng: null, address: null },
    ]
    assert.equal(page1.length, pageSize) // full page: loop must keep paging
    assert.ok(page2.length < pageSize) // short page: loop terminates here

    const rawVenues = [...page1, ...page2]
    const baseline = rawVenues.filter(isNameCandidate)
    assert.deepEqual(baseline.map((v) => v.id), ['v1', 'v2', 'v4'])
  })
})

describe('names mode: refused-list scoping (only venues actually in play tonight)', () => {
  it('filters refusals down to upcomingVenueIds instead of the whole junk-named baseline', () => {
    const refused = [
      { v: { id: 'r1', name: 'Ohio' }, why: venueNameRefusalReason('Ohio') },
      { v: { id: 'r2', name: '1146 W Highland Rd' }, why: venueNameRefusalReason('1146 W Highland Rd') },
    ]
    // Only r1 has an upcoming published event tonight; r2 does not (e.g. its
    // only event already happened, or it has none at all) and must not show
    // up in the printed refusal report.
    const upcomingVenueIds = new Set(['r1'])
    const refusedInScope = refused.filter((r) => upcomingVenueIds.has(r.v.id))
    assert.deepEqual(refusedInScope.map((r) => r.v.id), ['r1'])
    assert.equal(refusedInScope[0].why, 'state name')
  })
})

describe('names mode: buildNameQuery', () => {
  it('joins name, city, and state when a city is present', () => {
    assert.equal(buildNameQuery('Lock 3', 'Akron'), 'Lock 3, Akron, OH')
  })
  it('omits the city segment when absent', () => {
    assert.equal(buildNameQuery('Lock 3', null), 'Lock 3, OH')
    assert.equal(buildNameQuery('Lock 3', undefined), 'Lock 3, OH')
    assert.equal(buildNameQuery('Lock 3', ''), 'Lock 3, OH')
  })
})

describe('names mode: cityMatches', () => {
  it('passes through when the venue has no city on file', () => {
    assert.equal(cityMatches(null, { address: { city: 'Hudson' } }), true)
    assert.equal(cityMatches('', { address: { city: 'Hudson' } }), true)
  })
  it('passes through when the result reports no city at all', () => {
    assert.equal(cityMatches('Akron', { address: {} }), true)
    assert.equal(cityMatches('Akron', {}), true)
  })
  it('matches on an exact city (case/whitespace-insensitive)', () => {
    assert.equal(cityMatches('Akron', { address: { city: 'akron' } }), true)
    assert.equal(cityMatches(' Akron ', { address: { city: 'Akron' } }), true)
  })
  it('treats "Coventry Township" on the venue as equal to a result reporting "Coventry"', () => {
    assert.equal(cityMatches('Coventry Township', { address: { city: 'Coventry' } }), true)
  })
  it('rejects a genuine mismatch (Akron venue, Hudson result)', () => {
    assert.equal(cityMatches('Akron', { address: { city: 'Hudson' } }), false)
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

// ── default mode: candidate narrowing (chunking, merging, limit order) ──

describe('default mode: chunkIds', () => {
  it('splits 683 ids into 14 chunks of at most 50, losing none', () => {
    const ids = Array.from({ length: 683 }, (_, i) => `v${i}`)
    const chunks = chunkIds(ids)
    assert.equal(VENUE_ID_CHUNK_SIZE, 50)
    assert.equal(chunks.length, 14)
    assert.ok(chunks.every((c) => c.length <= 50))
    assert.equal(chunks.at(-1).length, 683 - 13 * 50) // 33
    assert.deepEqual(chunks.flat(), ids)
  })
  it('returns no chunks at all for an empty or missing list — never one empty chunk (which would be a pointless query)', () => {
    assert.deepEqual(chunkIds([]), [])
    assert.deepEqual(chunkIds(undefined), [])
  })
  it('does not emit a trailing empty chunk when the count divides evenly', () => {
    const chunks = chunkIds(Array.from({ length: 100 }, (_, i) => i))
    assert.equal(chunks.length, 2)
  })
})

describe('default mode: merging venueIdsWithUpcomingEvents across pages and chunks', () => {
  it('unions every page/chunk without duplicating a venue that spans them', () => {
    // v1 has link rows on both pages of chunk A and again in chunk B's page:
    // the paginated loop must union, and must not double-count.
    const pages = [
      [{ venue_id: 'v1', events: { id: 'e1' } }, { venue_id: 'v2', events: { id: 'e2' } }],
      [{ venue_id: 'v1', events: { id: 'e3' } }, { venue_id: 'v3', events: { id: 'e4' } }],
      [{ venue_id: 'v1', events: { id: 'e5' } }, { venue_id: 'v4', events: { id: 'e6' } }],
    ]
    const merged = new Set()
    for (const page of pages) for (const id of venueIdsWithUpcomingEvents(page)) merged.add(id)
    assert.deepEqual([...merged].sort(), ['v1', 'v2', 'v3', 'v4'])
    assert.equal(merged.size, 4)
  })
  it('an empty final page contributes nothing (the short-page terminator case)', () => {
    const merged = new Set(['v1'])
    for (const id of venueIdsWithUpcomingEvents([])) merged.add(id)
    assert.deepEqual([...merged], ['v1'])
  })
})

describe('default mode: narrowAndLimit', () => {
  const venues = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]

  it('applies --limit AFTER narrowing, so N means "N venues actually geocoded"', () => {
    // Only c/d/e have upcoming events. Slicing FIRST with limit 2 would yield
    // [a, b] -> 0 geocodable venues: the exact wasted-lookup bug.
    const upcoming = new Set(['c', 'd', 'e'])
    const out = narrowAndLimit(venues, upcoming, 2)
    assert.deepEqual(out.map((v) => v.id), ['c', 'd'])
    assert.equal(out.length, 2)
  })
  it('narrows with no limit', () => {
    assert.deepEqual(narrowAndLimit(venues, new Set(['b', 'e']), null).map((v) => v.id), ['b', 'e'])
  })
  it('an empty upcoming set narrows to nothing — it is not treated as "no filter"', () => {
    assert.deepEqual(narrowAndLimit(venues, new Set(), null), [])
    assert.deepEqual(narrowAndLimit(venues, new Set(), 3), [])
  })
  it('null upcomingIds means --all: no narrowing, limit still honoured', () => {
    assert.equal(narrowAndLimit(venues, null, null).length, 5)
    assert.deepEqual(narrowAndLimit(venues, null, 2).map((v) => v.id), ['a', 'b'])
  })
  it('a limit larger than the narrowed set is a no-op', () => {
    assert.equal(narrowAndLimit(venues, new Set(['a']), 99).length, 1)
  })
  it('tolerates a missing venue list', () => {
    assert.deepEqual(narrowAndLimit(undefined, new Set(['a']), 2), [])
  })
})
