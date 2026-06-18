/**
 * test-audit-venue-duplicates.js — the nightly venue-duplicate audit planner.
 * Pure + offline; no DB. Run:  node --test scripts/tests/test-audit-venue-duplicates.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  planVenueAudit, sameVenueName, pickCanonical,
} from '../audit-venue-duplicates.js'

describe('audit: sameVenueName (conservative auto-merge gate)', () => {
  it('merges word-boundary containment, exact, entity-only, and junk-address names', () => {
    assert.equal(sameVenueName('The KillBox', 'The KillBox Comedy Club'), true)        // containment
    assert.equal(sameVenueName('Weathervane Playhouse', 'Weathervane Playhouse, Akron'), true)
    assert.equal(sameVenueName('BLU Jazz+', 'Blu Jazz+'), true)                         // case/punct only
    assert.equal(sameVenueName("Let's Grow Akron Headquarters", 'Let&#8217;s Grow Akron Headquarters'), true) // entity-only
    assert.equal(sameVenueName('1000 Kenmore Blvd', 'The Rialto Theatre'), true)        // junk address name
  })
  it('does NOT auto-merge fuzzy/partial overlaps (these go to review)', () => {
    assert.equal(sameVenueName('Guzzetta Recital Hall', 'Guzzetta Hall Lawn at Buchtel Commons'), false)
    assert.equal(sameVenueName('Firestone Library', 'Firestone Park Branch Library'), false)
    assert.equal(sameVenueName('Goodyear Theatre', 'The Bank at East End'), false)
    assert.equal(sameVenueName('Musica', "Annabell's Bar & Lounge"), false)
  })
})

describe('audit: pickCanonical', () => {
  it('prefers most upcoming, then events, then coords', () => {
    const chosen = pickCanonical([
      { id: 'a', name: 'Some Venue', upcoming: 0, events: 9, lat: 1, lng: 1 },
      { id: 'b', name: 'Another Venue', upcoming: 53, events: 65, lat: null, lng: null },
    ])
    assert.equal(chosen.id, 'b')
  })
  it('never picks a bare address-as-name row as canonical', () => {
    const chosen = pickCanonical([
      { id: 'junk', name: '133 Merriman Rd', upcoming: 5, events: 5, lat: 1, lng: 1 },
      { id: 'real', name: 'The Posh', upcoming: 1, events: 1, lat: null, lng: null },
    ])
    assert.equal(chosen.id, 'real')
  })
})

describe('audit: planVenueAudit', () => {
  const venues = [
    // KillBox — clear merge: events live on the coord-less record, coords on the dupe.
    { id: 'k1', name: 'The KillBox Comedy Club', address: '1305 E Tallmadge Ave', neighborhood_slug: 'north-hill', lat: null, lng: null, events: 65, upcoming: 53 },
    { id: 'k2', name: 'The KillBox', address: '1305 E Tallmadge Ave', neighborhood_slug: 'north-hill', lat: 41.10783, lng: -81.51039, events: 0, upcoming: 0 },
    // Royal Palace — clear, and only groups if directionals fold (East↔E).
    { id: 'r1', name: 'Royal Palace', address: '134 E Tallmadge Ave', neighborhood_slug: 'north-hill', lat: 41.102, lng: -81.51, events: 6, upcoming: 4 },
    { id: 'r2', name: 'Royal Palace Akron ( Banquet and Event Hall)', address: '134 East Tallmadge Avenue', neighborhood_slug: 'north-hill', lat: null, lng: null, events: 0, upcoming: 0 },
    // Ambiguous — same address, two distinct businesses.
    { id: 'm1', name: 'Musica', address: '51 E Market St', lat: 41.08, lng: -81.51, events: 10, upcoming: 5 },
    { id: 'm2', name: "Annabell's Bar & Lounge", address: '51 E Market St', lat: 41.08, lng: -81.51, events: 6, upcoming: 3 },
    // Lone venue — no group.
    { id: 'z1', name: 'Crown Point Ecology Center', address: '3220 Ira Rd', lat: 41.2, lng: -81.6, events: 24, upcoming: 2 },
  ]
  const plan = planVenueAudit(venues)

  it('counts groups and splits clear vs ambiguous', () => {
    assert.equal(plan.groupsFound, 3)
    assert.equal(plan.clear.length, 2)
    assert.equal(plan.ambiguous.length, 1)
  })

  it('KillBox: canonical is the events record; coords copied from the dupe', () => {
    const kb = plan.clear.find((c) => c.canonical.id === 'k1')
    assert.ok(kb, 'KillBox clear merge present')
    assert.equal(kb.dupes[0].id, 'k2')
    assert.equal(kb.copyFields.lat, 41.10783)
    assert.match(kb.sql, /update venues set lat = 41\.10783, lng = -81\.51039 where id = 'k1' and lat is null;/)
    assert.match(kb.sql, /update event_venues set venue_id = 'k1' where venue_id in \('k2'\);/)
    assert.match(kb.sql, /delete from venues where id in \('k2'\);/)
  })

  it('Royal Palace: directional folding groups "East Tallmadge Avenue" with "E Tallmadge Ave"', () => {
    const rp = plan.clear.find((c) => c.canonical.id === 'r1')
    assert.ok(rp, 'Royal Palace group formed across directional spelling')
    assert.equal(rp.dupes[0].id, 'r2')
  })

  it('Musica/Annabell\'s flagged ambiguous, not merged', () => {
    assert.equal(plan.ambiguous[0].venues.length, 2)
    const names = plan.ambiguous[0].venues.map((v) => v.name).sort()
    assert.deepEqual(names, ["Annabell's Bar & Lounge", 'Musica'])
  })
})
