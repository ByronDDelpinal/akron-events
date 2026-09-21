/**
 * test-check-venue-duplicates.js — the venue duplicate REPORT's pairing and
 * clustering. Pure + offline; no DB.
 * Run:  node --test scripts/tests/test-check-venue-duplicates.js
 *
 * The regression this suite exists for: GEO proximity used to be a standalone
 * union-find edge, so dense downtown blocks chained A~B~C into one 145-member
 * "cluster" spanning 99 distinct addresses. Proximity now only corroborates an
 * edge that a name or address already made.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildVenueClusters } from '../check-venue-duplicates.js'
import { sameVenueName, venueNameContains } from '../audit-venue-duplicates.js'

const OPTS = { minSim: 0.65, geoThreshold: 150 }
const run = (venues, opts = {}) => buildVenueClusters(venues, { ...OPTS, ...opts })
const highTally = (clusters) => clusters.filter((c) => !c.suspect && c.confidence === 'HIGH').length

describe('check: proximity alone never links (the mega-cluster regression)', () => {
  // Ten real, distinct downtown businesses inside a 50 m radius: ten names,
  // ten addresses, ten pins. The old code unioned all 45 pairs.
  const DOWNTOWN = [
    'Musica', 'Blu Jazz', 'The Rialto', 'Annabells Lounge', 'Goodyear Theatre',
    'Lock 3 Park', 'Akron Civic', 'Nightlight Cinema', 'Uncorked Wine Bar', 'Jilly Music Room',
  ].map((name, i) => ({
    id: `d${i}`,
    name,
    address: `${100 + i * 7} S Main St`,   // ten different street numbers
    lat: 41.08 + i * 0.00004,              // ~4.4 m apart each, ~40 m end to end
    lng: -81.519,
    events: i,
  }))

  it('ten venues within 50 m at ten addresses with ten names → 0 clusters', () => {
    const { clusters, edges } = run(DOWNTOWN)
    assert.equal(clusters.length, 0)
    assert.equal(edges.length, 0, 'GEO must not create an edge on its own')
  })

  it('venues with coordinates but no address produce zero clusters', () => {
    const coordOnly = DOWNTOWN.map((v) => ({ ...v, address: null }))
    const { clusters } = run(coordOnly)
    assert.equal(clusters.length, 0)
  })
})

describe('check: linking signals and confidence', () => {
  it('identical name + identical address → one HIGH cluster', () => {
    const { clusters } = run([
      { id: 'a', name: 'The KillBox Comedy Club', address: '1305 E Tallmadge Ave', lat: 41.107, lng: -81.51, events: 65 },
      { id: 'b', name: 'The KillBox Comedy Club', address: '1305 East Tallmadge Avenue', lat: null, lng: null, events: 0 },
    ])
    assert.equal(clusters.length, 1)
    assert.equal(clusters[0].confidence, 'HIGH')
    assert.equal(clusters[0].venues.length, 2)
    // SSOT address normalisation: "East Tallmadge Avenue" folds onto "E Tallmadge Ave".
    assert.ok(clusters[0].signalTypes.includes('ADDRESS'))
    assert.ok(clusters[0].signalTypes.includes('EXACT'))
  })

  it('identical name at different addresses → MEDIUM, not HIGH (could be a chain)', () => {
    const { clusters } = run([
      { id: 'a', name: 'Summit County Library', address: '60 S High St', lat: null, lng: null, events: 4 },
      { id: 'b', name: 'Summit County Library', address: '1224 Kenmore Blvd', lat: null, lng: null, events: 2 },
    ])
    assert.equal(clusters.length, 1)
    assert.equal(clusters[0].confidence, 'MEDIUM')
    assert.equal(highTally(clusters), 0)
  })

  it('same address, different names → LOW, never flagged as a safe merge', () => {
    const { clusters } = run([
      { id: 'm1', name: 'Musica', address: '51 E Market St', lat: 41.08, lng: -81.51, events: 10 },
      { id: 'm2', name: "Annabell's Bar & Lounge", address: '51 E Market St', lat: 41.08, lng: -81.51, events: 6 },
    ])
    assert.equal(clusters.length, 1)
    assert.equal(clusters[0].confidence, 'LOW', 'two businesses in one building')
    assert.equal(highTally(clusters), 0)
    // GEO/COORD corroborate the shared address but must not promote it.
    assert.ok(clusters[0].signalTypes.includes('GEO'))
    assert.ok(!clusters[0].signalTypes.includes('EXACT'))
  })

  it('COORD (identical lat/lng to 4dp) corroborates but still never links', () => {
    const { clusters } = run([
      { id: 'x', name: 'Goodyear Theatre', address: '1201 E Market St', lat: 41.0812, lng: -81.4921, events: 3 },
      { id: 'y', name: 'The Bank at East End', address: '1201 E Market Street', lat: 41.08121, lng: -81.49212, events: 1 },
      { id: 'z', name: 'Curated Storefront', address: '39 S Main St', lat: 41.0812, lng: -81.4921, events: 1 },
    ])
    // x+y link by ADDRESS; z shares the pin but neither name nor address.
    assert.equal(clusters.length, 1)
    assert.deepEqual(clusters[0].ids.sort(), ['x', 'y'])
    assert.ok(clusters[0].signalTypes.includes('COORD'))
  })
})

describe('check: fuzzy names corroborate, never link', () => {
  // Token overlap 2/3 but NEITHER name contains the other on word boundaries,
  // so CONTAIN must not fire — these are two different buildings.
  const FUZZY_PAIR = [
    { id: 'f1', name: 'Firestone Library', lat: 41.08, lng: -81.519, events: 40 },
    { id: 'f2', name: 'Firestone Park Library', lat: 41.3, lng: -81.9, events: 1 },
  ]

  it('fuzzy-only pair (far apart, no shared address) → 0 clusters', () => {
    const { clusters } = run(FUZZY_PAIR.map((v) => ({ ...v, address: null })))
    assert.equal(clusters.length, 0)
  })

  it('fuzzy on top of an ADDRESS link lifts LOW → MEDIUM', () => {
    const shared = FUZZY_PAIR.map((v) => ({ ...v, address: '182 S Main St' }))
    const { clusters } = run(shared)
    assert.equal(clusters.length, 1)
    assert.ok(clusters[0].signalTypes.includes('FUZZY'))
    assert.equal(clusters[0].confidence, 'MEDIUM')

    // Raise the bar past the pair's similarity and the lift disappears —
    // --min-similarity is a confidence knob now, not a recall knob.
    const strict = run(shared, { minSim: 0.95 })
    assert.equal(strict.clusters.length, 1, 'the ADDRESS link itself is unaffected')
    assert.equal(strict.clusters[0].confidence, 'LOW')
  })
})


describe('check: CONTAIN links (SSOT with audit-venue-duplicates.js)', () => {
  it('one name containing the other at one address → HIGH, audit\'s "clear" case', () => {
    const { clusters } = run([
      { id: 'a', name: 'Akron Civic Theatre', address: '182 S Main St', lat: 41.08, lng: -81.519, events: 40 },
      { id: 'b', name: 'Akron Civic Theatre Annex', address: '182 S Main Street', lat: null, lng: null, events: 1 },
    ])
    assert.equal(clusters.length, 1)
    assert.ok(clusters[0].signalTypes.includes('CONTAIN'))
    assert.ok(clusters[0].signalTypes.includes('ADDRESS'))
    // Was MEDIUM before: check used strict name equality while audit used
    // containment, so audit auto-merged pairs this report capped at MEDIUM.
    assert.equal(clusters[0].confidence, 'HIGH')
    assert.equal(clusters[0].nameAgreement, 'all')
    assert.equal(highTally(clusters), 1)
  })

  it('the same containment rule audit uses — shared predicate, not a copy', () => {
    assert.equal(venueNameContains('The KillBox', 'The KillBox Comedy Club'), true)
    assert.equal(venueNameContains('The KillBox Comedy Club', 'The KillBox'), true, 'order-independent')
    assert.equal(venueNameContains('Firestone Library', 'Firestone Park Library'), false, 'not fuzzy')
    assert.equal(sameVenueName('The KillBox', 'The KillBox Comedy Club'), true)
  })

  it('containment at DIFFERENT addresses does not link — scope is load-bearing', () => {
    const { clusters, edges } = run([
      { id: 'a', name: 'Summit Artspace', address: '140 E Market St', events: 9 },
      { id: 'b', name: 'Summit Artspace on Tusc', address: '140 Tuscarawas Ave', events: 2 },
    ])
    assert.equal(edges.length, 0)
    assert.equal(clusters.length, 0, 'CONTAIN is evaluated only inside an address group')
  })

  it('a substring that is not a whole-word prefix/suffix does not link', () => {
    const { clusters } = run([
      { id: 'a', name: 'Lock 3', address: '200 S Main St', events: 5 },
      { id: 'b', name: 'Blockhouse', address: '200 S Main St', events: 5 },
    ])
    assert.equal(clusters.length, 1)
    assert.ok(!clusters[0].signalTypes.includes('CONTAIN'))
    assert.equal(clusters[0].confidence, 'LOW')
  })

  // Containment is transitive. Run globally against the live database a row
  // literally named "Akron" linked to every name containing that whole word and
  // built an 85-member cluster across 61 addresses — the GEO mega-cluster over
  // again with names instead of pins. The address scope is what prevents it.
  it('a generic one-word name cannot bridge unrelated venues', () => {
    const { clusters } = run([
      { id: 'g',  name: 'Akron',                 address: '1 Cascade Plz',     events: 0 },
      { id: 'v1', name: 'Akron Art Museum',      address: '1 S High St',       events: 30 },
      { id: 'v2', name: 'Akron Zoo',             address: '505 Euclid Ave',    events: 12 },
      { id: 'v3', name: 'Akron Civic Theatre',   address: '182 S Main St',     events: 40 },
      { id: 'v4', name: 'Greater Akron Chamber', address: '388 S Main St',     events: 3 },
    ])
    assert.equal(clusters.length, 0, 'five distinct venues, five addresses, no bridge')
  })
})

describe('check: address-named venues must never link to each other', () => {
  // sameVenueName short-circuits to TRUE when EITHER name looks like a street
  // address. That is only safe inside an address group that already exists.
  // Adopted as a standalone linker it would union every address-named row in
  // the database into one mega-cluster — the exact regression this file
  // guards. check must adopt the containment branch and nothing else.
  const ADDRESS_NAMED = [
    { id: 'j0', name: '1305 E Tallmadge Ave', address: '1305 E Tallmadge Ave', lat: 41.107, lng: -81.51, events: 0 },
    { id: 'j1', name: '51 E Market St',       address: '51 E Market St',       lat: 41.080, lng: -81.519, events: 0 },
    { id: 'j2', name: '182 S Main Street',    address: '182 S Main St',        lat: 41.081, lng: -81.519, events: 0 },
    { id: 'j3', name: '1000 Kenmore Blvd',    address: '1000 Kenmore Blvd',    lat: 41.041, lng: -81.560, events: 0 },
  ]

  it('two different address-named venues do NOT link', () => {
    const { clusters, edges } = run(ADDRESS_NAMED.slice(0, 2))
    assert.equal(edges.length, 0, 'looksLikeStreetAddress must not be a standalone linker')
    assert.equal(clusters.length, 0)
  })

  it('four address-named venues stay four rows, not one mega-cluster', () => {
    const { clusters } = run(ADDRESS_NAMED)
    assert.equal(clusters.length, 0)
  })

  it('an address-named row still links to the real venue sharing its address', () => {
    const { clusters } = run([
      ADDRESS_NAMED[0],
      { id: 'real', name: 'The KillBox Comedy Club', address: '1305 East Tallmadge Avenue', lat: null, lng: null, events: 65 },
    ])
    assert.equal(clusters.length, 1, 'ADDRESS still links it — only the name short-circuit is rejected')
    assert.deepEqual(clusters[0].ids.sort(), ['j0', 'real'])
    assert.equal(clusters[0].nameAgreement, 'none', 'audit resolves this one by its own address-name rule')
  })
})

describe('check: name agreement mirrors audit clear vs ambiguous', () => {
  it('shared address with agreeing names is separable from shared address alone', () => {
    const { clusters } = run([
      { id: 'c1', name: 'Weathervane Playhouse', address: '1301 Weathervane Ln', events: 12 },
      { id: 'c2', name: 'Weathervane Playhouse, Akron', address: '1301 Weathervane Lane', events: 0 },
      { id: 'x1', name: 'Musica', address: '51 E Market St', events: 10 },
      { id: 'x2', name: "Annabell's Bar & Lounge", address: '51 E Market St', events: 6 },
    ])
    assert.equal(clusters.length, 2)
    const byAgreement = Object.fromEntries(clusters.map((c) => [c.nameAgreement, c.ids.sort().join(',')]))
    assert.equal(byAgreement.all, 'c1,c2', 'audit would auto-merge this one')
    assert.equal(byAgreement.none, 'x1,x2', 'audit flags this one ambiguous')
  })
})

describe('check: already-aliased venues are excluded', () => {
  const rows = [
    { id: 'keep',  name: 'The KillBox Comedy Club', address: '1305 E Tallmadge Ave', lat: 41.107, lng: -81.51, events: 65 },
    { id: 'merged', name: 'The KillBox Comedy Club', address: '1305 E Tallmadge Ave', lat: 41.107, lng: -81.51, events: 0 },
  ]

  it('a venue in aliasIds is absent from every cluster', () => {
    const { clusters } = run(rows, { aliasIds: new Set(['merged']) })
    assert.equal(clusters.length, 0, 'the merge was already recorded — do not re-propose it')
    for (const c of clusters) assert.ok(!c.ids.includes('merged'))
  })

  it('without the ledger the same pair is re-proposed (what the exclusion prevents)', () => {
    const { clusters } = run(rows)
    assert.equal(clusters.length, 1)
  })

  it('an alias row whose canonical is gone still filters — never resurrect it', () => {
    const { clusters } = run(
      [...rows, { id: 'orphan', name: 'The KillBox Comedy Club', address: '1305 E Tallmadge Ave', lat: null, lng: null, events: 0 }],
      { aliasIds: new Set(['orphan']) },
    )
    assert.equal(clusters.length, 1)
    assert.deepEqual(clusters[0].ids.sort(), ['keep', 'merged'])
  })
})

describe('check: mega-cluster tripwire', () => {
  const makeChain = (n) => Array.from({ length: n }, (_, i) => ({
    id: `c${i}`, name: 'Akron Public Library', address: '60 S High St', lat: null, lng: null, events: i,
  }))

  it('maxClusterSize is threaded through opts, like minSim and geoThreshold', () => {
    const three = makeChain(3)
    assert.equal(run(three).clusters[0].suspect, false, 'default limit is 8')
    assert.equal(run(three, { maxClusterSize: 2 }).clusters[0].suspect, true)
  })

  it('8 members is still a normal cluster', () => {
    const { clusters } = run(makeChain(8))
    assert.equal(clusters.length, 1)
    assert.equal(clusters[0].suspect, false)
    assert.equal(clusters[0].confidence, 'HIGH')
    assert.equal(highTally(clusters), 1)
  })

  it('9 members trips the wire and drops out of the HIGH tally', () => {
    const { clusters } = run(makeChain(9))
    assert.equal(clusters.length, 1)
    assert.equal(clusters[0].suspect, true)
    assert.equal(clusters[0].venues.length, 9)
    assert.equal(clusters[0].distinctAddresses, 1)
    assert.equal(highTally(clusters), 0, 'a suspect cluster is a bug report, not 9 duplicates')
  })
})

describe('check: cluster ordering', () => {
  it('a suspect cluster sorts LAST even though it is HIGH and the largest', () => {
    const { clusters } = run([
      // A big same-name/same-address pile: HIGH signals, most members. Under
      // confidence-then-size it printed as Cluster 1 and buried the rest.
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `s${i}`, name: 'Akron Public Library', address: '60 S High St', events: i,
      })),
      // A genuine two-row duplicate.
      { id: 'h1', name: 'The Rialto Theatre', address: '1000 Kenmore Blvd', events: 5 },
      { id: 'h2', name: 'The Rialto Theatre', address: '1000 Kenmore Boulevard', events: 0 },
    ], { maxClusterSize: 3 })

    assert.equal(clusters.length, 2)
    assert.equal(clusters[0].suspect, false)
    assert.deepEqual(clusters[0].ids.sort(), ['h1', 'h2'], 'the real duplicate prints first')
    assert.equal(clusters[1].suspect, true)
    assert.equal(clusters[1].venues.length, 4)
    assert.equal(highTally(clusters), 1, 'the suspect is out of the HIGH tally too')
  })

  it('sorts by confidence (HIGH first) then size', () => {
    const { clusters } = run([
      // LOW: shared address, different names
      { id: 'l1', name: 'Musica', address: '51 E Market St', events: 1 },
      { id: 'l2', name: "Annabell's", address: '51 E Market St', events: 1 },
      // MEDIUM: same name, different addresses
      { id: 'm1', name: 'Branch Library', address: '60 S High St', events: 1 },
      { id: 'm2', name: 'Branch Library', address: '1224 Kenmore Blvd', events: 1 },
      // HIGH: same name, same address
      { id: 'h1', name: 'The Rialto Theatre', address: '1000 Kenmore Blvd', events: 5 },
      { id: 'h2', name: 'The Rialto Theatre', address: '1000 Kenmore Boulevard', events: 0 },
    ])
    assert.deepEqual(clusters.map((c) => c.confidence), ['HIGH', 'MEDIUM', 'LOW'])
  })
})
