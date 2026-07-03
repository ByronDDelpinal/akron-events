/**
 * Dedupe location-bucketing + better_kenmore covered-venue regressions.
 *
 * 2026-06-11: an EMB Presents show appeared twice on the site — once from
 * the rialto scraper (venue "The Rialto Theatre", address 1000 Kenmore Blvd)
 * and once from better_kenmore, which minted a junk venue literally NAMED
 * "1000 Kenmore Blvd" with no address. Dedupe bucketed strictly by venue_id,
 * so the pair could never group. These tests pin both halves of the fix.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  locationKey, fuzzyTitlesMatch,
  sharedNamePrefixMatch, toSecondKey, findDuplicateGroups, priority,
  venuelessTitleMatch, typoTolerantTitlesMatch, withinOneEdit,
  collectLinkDonations,
} from '../dedupe-cross-source.js'
import { normalizeStreetAddress } from '../lib/normalize.js'
import { resolveVenueAlias } from '../scrape-better-kenmore.js'

// normalizeStreetAddress is the shared SSOT (lib/normalize.js); locationKey
// below consumes it for bucketing. These cases pin the folding behavior the
// dedupe pass relies on.
describe('dedupe: normalizeStreetAddress', () => {
  it('folds suffix variants, directionals, and punctuation', () => {
    assert.equal(normalizeStreetAddress('1000 Kenmore Blvd.'), '1000 kenmore blvd')
    assert.equal(normalizeStreetAddress('1000 Kenmore Boulevard'), '1000 kenmore blvd')
    // Directionals fold to their abbreviation, so "South"/"S" compare equal.
    assert.equal(normalizeStreetAddress('  220 South Balch Street '), '220 s balch st')
    assert.equal(normalizeStreetAddress('220 S Balch St'), '220 s balch st')
  })

  it('returns null for empty/non-string input', () => {
    assert.equal(normalizeStreetAddress(''), null)
    assert.equal(normalizeStreetAddress(null), null)
  })
})

describe('dedupe: locationKey', () => {
  const ev = (venue) => ({ event_venues: [{ venue_id: 'v-123', venues: venue }] })

  it('groups a junk address-named venue with the real venue at that address', () => {
    const junk = locationKey(ev({ name: '1000 Kenmore Blvd', address: '' }))
    const real = locationKey(ev({ name: 'The Rialto Theatre', address: '1000 Kenmore Blvd' }))
    assert.equal(junk, 'addr:1000 kenmore blvd')
    assert.equal(junk, real)
  })

  it('falls back to venue_id when there is no address and the name is not an address', () => {
    assert.equal(locationKey(ev({ name: 'BLU Jazz+', address: null })), 'venue:v-123')
  })

  it('returns null without a linked venue', () => {
    assert.equal(locationKey({ event_venues: [] }), null)
    assert.equal(locationKey({}), null)
  })
})

describe('dedupe: the EMB pair groups end-to-end', () => {
  it('fuzzy titles match across reordered band lineups', () => {
    assert.equal(fuzzyTitlesMatch(
      'EMB Presents Afloat / Pro Skater / Twin Division / Baja Thunder',
      'EMB Presents Baja Thunder / The Office Drones / Afloat / Pro Skater',
    ), true)
  })

  it('unrelated shows at the same venue do not match', () => {
    assert.equal(fuzzyTitlesMatch(
      'EMB Presents Afloat / Pro Skater / Twin Division / Baja Thunder',
      'Open Mic Comedy Night with Dave Smith',
    ), false)
  })
})

describe('dedupe: shared series-name prefix (Crown Point / Eventbrite)', () => {
  it('matches titles that share a 3+ meaningful-token leading name', () => {
    assert.equal(sharedNamePrefixMatch(
      'Meadow Music Concert Series at Crown Point',     // Eventbrite
      'Meadow Music Concert Series - Alex Bevan',        // Crown Point's own site
    ), true)
  })
  it('does not match titles that diverge before 3 shared tokens', () => {
    assert.equal(sharedNamePrefixMatch('Toddler Storytime', 'Teen Coding Club'), false)
    // shares only [summer, concert] before the act diverges — below the 3-token floor
    assert.equal(sharedNamePrefixMatch('Summer Concert: Wilco', 'Summer Concert: Phish'), false)
    // a 2-word series name can't reach the floor either
    assert.equal(sharedNamePrefixMatch('Yoga Class - Beginner', 'Yoga Class - Advanced'), false)
  })
})

describe('dedupe: whole-second bucketing', () => {
  it('toSecondKey floors a sub-second fraction', () => {
    assert.equal(toSecondKey('2026-06-19T22:00:00.219Z'), '2026-06-19T22:00:00')
    assert.equal(toSecondKey('2026-06-19 22:00:00+00'), '2026-06-19T22:00:00')
  })

  it('groups a Squarespace (.219) copy with an Eventbrite whole-second copy', () => {
    const venue = { name: 'Crown Point Ecology Center', address: '3220 Ira Rd' }
    const mk = (id, title, source, start) => ({
      id, title, source, start_at: start, end_at: null,
      event_venues: [{ venue_id: 'cp-1', venues: venue }],
    })
    const { groups } = findDuplicateGroups([
      mk('a', 'Meadow Music Concert Series at Crown Point', 'eventbrite', '2026-06-19T22:00:00+00:00'),
      mk('b', 'Meadow Music Concert Series - Alex Bevan', 'crown_point_ecology', '2026-06-19T22:00:00.219+00:00'),
    ])
    assert.equal(groups.length, 1)
    assert.equal(groups[0].length, 2)
  })

  it('does NOT group two genuinely different programs at the same venue + second', () => {
    const venue = { name: 'Akron-Summit County Public Library', address: '60 S High St' }
    const mk = (id, title) => ({
      id, title, source: 'akron_library', start_at: '2026-06-20T18:00:00+00:00', end_at: null,
      event_venues: [{ venue_id: 'lib-1', venues: venue }],
    })
    const { groups } = findDuplicateGroups([mk('a', 'Toddler Storytime'), mk('b', 'Teen Coding Club')])
    assert.equal(groups.length, 0)
  })
})

describe('dedupe: cross-source headliner match (Pass 1, different sources only)', () => {
  const venue = { name: 'Akron Civic Theatre', address: '182 S Main St' }
  const mk = (id, title, source) => ({
    id, title, source, start_at: '2026-09-19T23:00:00+00:00', end_at: null,
    event_venues: [{ venue_id: 'civic-1', venues: venue }],
  })

  it('merges an aggregator re-listing that only shares the headliner (tagline drift)', () => {
    const { groups } = findDuplicateGroups([
      mk('a', 'Ray LaMontagne: Trouble 20th Anniversary Tour', 'akron_civic'),
      mk('b', 'Ray LaMontagne at Akron Civic Theatre', 'visit_akron_cvb'),
    ])
    assert.equal(groups.length, 1)
    assert.equal(groups[0].length, 2)
  })

  it('does NOT merge two different SAME-source programs sharing a series prefix at the same second', () => {
    const lib = { name: 'Akron-Summit County Public Library', address: '60 S High St' }
    const mkLib = (id, title) => ({
      id, title, source: 'akron_library', start_at: '2026-07-09T14:30:00+00:00', end_at: null,
      event_venues: [{ venue_id: 'lib-1', venues: lib }],
    })
    const { groups } = findDuplicateGroups([
      mkLib('a', 'Job Readiness - Ace Your Next Interview'),
      mkLib('b', 'Job Readiness - Learn How to Find Unadvertised Jobs'),
    ])
    assert.equal(groups.length, 0)
  })
})

describe('dedupe: venue-less aggregator copies (Pass 4)', () => {
  const venued = (id, title, source, venueId = 'v-fest') => ({
    id, title, source, start_at: '2026-08-15T18:00:00+00:00', end_at: null,
    event_venues: [{ venue_id: venueId, venues: { name: 'Boettler Park', address: '5300 Massillon Rd' } }],
  })
  const venueless = (id, title, source) => ({
    id, title, source, start_at: '2026-08-15T16:00:00+00:00', end_at: null,
    event_venues: [],
  })

  it('groups a venue-less ohio_festivals copy with the venue-linked first-party row (same day, strict title)', () => {
    const { groups } = findDuplicateGroups([
      venued('a', 'Art-A-Palooza', 'city_of_green'),
      venueless('b', 'Art-A-Palooza', 'ohio_festivals'),
    ])
    assert.equal(groups.length, 1)
    assert.equal(groups[0].length, 2)
  })

  it('does NOT group a venue-less row with a different-title event on the same day', () => {
    const { groups } = findDuplicateGroups([
      venued('a', 'Summer Concert: Wilco', 'city_of_green'),
      venueless('b', 'Twisted Wilderfest', 'ohio_festivals'),
    ])
    assert.equal(groups.length, 0)
  })

  it('venuelessTitleMatch: exact/containment yes, generic-headliner drift no', () => {
    assert.equal(venuelessTitleMatch('Akron Oatmeal Festival', 'Akron Oatmeal Festival'), true)
    assert.equal(venuelessTitleMatch('Twisted Wilderfest', 'Twisted Wilderfest 2026'), true) // containment
    // shares only a 2-token headliner then diverges — allowed by strongTitlesMatch, NOT here
    assert.equal(venuelessTitleMatch('Summer Concert: Wilco', 'Summer Concert: Phish'), false)
  })
})

// 2026-07-01: seven live cross-source dupes evaded dedupe. Three exposed real
// matching gaps, pinned here with the actual production titles; the other four
// were already matchable and survived only because no dedupe pass had
// completed (see the pagination-stability fix in main's fetch loop).
describe('dedupe: 2026-07 evasion regressions', () => {
  const at = (venueId, name, address) => [{ venue_id: venueId, venues: { name, address } }]
  const mk = (id, title, source, start, venues, end = null) =>
    ({ id, title, source, start_at: start, end_at: end, event_venues: venues })

  it('compound-word split: "Preschool Storytime" groups with "Preschool Story Time" (distinct venue records, same address)', () => {
    const { groups } = findDuplicateGroups([
      mk('lib', 'Preschool Storytime', 'akron_library', '2026-07-02T14:30:00+00:00',
        at('v1', 'Akron Summit Library (Main Branch)', '60 S. High Street')),
      mk('dt', 'Preschool Story Time', 'downtown_akron', '2026-07-02T14:30:00+00:00',
        at('v2', 'Akron-Summit County Public Library', '60 South High Street')),
    ])
    assert.equal(groups.length, 1)
  })

  it('one-character typo in an act name: "Ridanym" vs "Ridanyn" groups at same venue+second', () => {
    const lock3 = at('v3', 'Lock 3', '200 S Main St')
    const { groups } = findDuplicateGroups([
      mk('cvb', 'Gospel Sunday - Ridanym', 'visit_akron_cvb', '2026-07-12T20:00:00+00:00', lock3, '2026-07-12T22:00:00+00:00'),
      mk('l3', 'Gospel Sunday w Ridanyn', 'city_of_akron_lock3', '2026-07-12T20:00:00+00:00', lock3, '2026-07-12T22:00:00+00:00'),
    ])
    assert.equal(groups.length, 1)
  })

  it('ordinal edition marker is noise: "41st Annual Juried Exhibition" groups with "CVAC: Juried Exhibition"', () => {
    const cvac = at('v4', 'Cuyahoga Valley Art Center', '2131 Front St')
    const { groups } = findDuplicateGroups([
      mk('eb', '41st Annual Juried Exhibition', 'eventbrite', '2026-07-28T14:00:00+00:00', cvac),
      mk('al', 'CVAC: Juried Exhibition', 'akron_life', '2026-07-28T14:00:00+00:00', cvac),
    ])
    assert.equal(groups.length, 1)
  })

  it('reordered lineup + word split: Orleans/Firefall bill groups in Pass 1', () => {
    const lock3 = at('v3', 'Lock 3', '200 S Main St')
    const { groups } = findDuplicateGroups([
      mk('tm', 'Orleans, Firefall, Pure Prairie League, Atlanta Rhythm Section', 'ticketmaster', '2026-08-02T23:00:00+00:00', lock3),
      mk('l3', 'Pure Prairie League, Orleans, Fire Fall and Atlanta Rhythm Section', 'city_of_akron_lock3', '2026-08-02T23:00:00+00:00', lock3),
    ])
    assert.equal(groups.length, 1)
  })

  it('typo tolerance does NOT merge genuinely different acts at the same venue+second', () => {
    const lock3 = at('v3', 'Lock 3', '200 S Main St')
    const { groups } = findDuplicateGroups([
      mk('a', 'Wilco and Special Guests Tour', 'ticketmaster', '2026-08-09T23:00:00+00:00', lock3),
      mk('b', 'Phish and Special Guests Tour', 'city_of_akron_lock3', '2026-08-09T23:00:00+00:00', lock3),
    ])
    assert.equal(groups.length, 0)
    // and the helper itself: short/different tokens never fuzzy-match
    assert.equal(typoTolerantTitlesMatch('Summer Jam: Wilco', 'Summer Jam: Phish'), false)
  })

  it('withinOneEdit: substitution/insertion yes, two edits no, short words guarded by caller', () => {
    assert.equal(withinOneEdit('ridanym', 'ridanyn'), true)   // substitution
    assert.equal(withinOneEdit('storytime', 'storytimes'), true) // insertion
    assert.equal(withinOneEdit('ridanym', 'ridann'), false)   // two edits
  })
})

describe('dedupe: first-party beats aggregators in priority', () => {
  it('an unlisted first-party source outranks Eventbrite/CVB/Akron Life', () => {
    assert.ok(priority('crown_point_ecology') < priority('eventbrite'))
    assert.ok(priority('royal_palace') < priority('visit_akron_cvb'))
    assert.ok(priority('release_yoga') < priority('akron_life'))
  })
  it('explicitly-ranked first-party still beats aggregators, and aggregators keep their order', () => {
    assert.ok(priority('akron_civic') < priority('ticketmaster'))
    assert.ok(priority('ticketmaster') < priority('eventbrite'))
    assert.ok(priority('eventbrite') < priority('akron_life'))
  })
  it('newly ranked first-party venue/municipal sources beat aggregator copies', () => {
    assert.ok(priority('ejthomas_hall') < priority('ticketmaster'))
    assert.ok(priority('city_of_hudson') < priority('eventbrite'))
  })
})

// 2026-07-01: three festival groups (Fairlawn Fest, Akron Pride, Nightmare on
// Front Street) each kept a venue-LESS ohio_festivals copy — its trusted time
// beat the CVB copy's placeholder time — and deleting the CVB copy destroyed
// the group's only venue link. Junction links now get donated like
// image/description. These tests pin that behavior.
describe('dedupe: junction-link donation (collectLinkDonations)', () => {
  const ev = (venueIds = [], orgIds = []) => ({
    event_venues:        venueIds.map(venue_id => ({ venue_id })),
    event_organizations: orgIds.map(organization_id => ({ organization_id })),
  })

  it('donates venue and org links when the canonical has none', () => {
    const { venueIds, orgIds } = collectLinkDonations(ev(), [ev(['v1'], ['o1'])])
    assert.deepEqual(venueIds, ['v1'])
    assert.deepEqual(orgIds, ['o1'])
  })

  it('donates NOTHING of a link type the canonical already has (split-venue safety)', () => {
    const { venueIds, orgIds } = collectLinkDonations(ev(['vKeep']), [ev(['vSplitTwin'], ['o1'])])
    assert.deepEqual(venueIds, [])           // never union a possible venue-split twin
    assert.deepEqual(orgIds, ['o1'])         // org donation is independent
  })

  it('dedupes across multiple donors and ignores empty/malformed link rows', () => {
    const donors = [ev(['v1']), ev(['v1', 'v2']), { event_venues: [{}] }]
    const { venueIds } = collectLinkDonations(ev(), donors)
    assert.deepEqual(venueIds.sort(), ['v1', 'v2'])
  })

  it('handles rows with no junction arrays at all', () => {
    const { venueIds, orgIds } = collectLinkDonations({}, [{}])
    assert.deepEqual(venueIds, [])
    assert.deepEqual(orgIds, [])
  })
})

describe('better_kenmore: venue aliasing', () => {
  it('resolves the Rialto\'s bare address and name variants to the canonical venue', () => {
    assert.equal(resolveVenueAlias('1000 Kenmore Blvd')?.name, 'The Rialto Theatre')
    assert.equal(resolveVenueAlias('1000 Kenmore Blvd.')?.name, 'The Rialto Theatre')
    assert.equal(resolveVenueAlias('The Rialto Theatre')?.name, 'The Rialto Theatre')
    assert.equal(resolveVenueAlias('Rialto Theatre')?.name, 'The Rialto Theatre')
  })

  it('leaves the CDC\'s own locations alone (aliasing, not skipping — unique events like the Cowbell 7K must survive)', () => {
    assert.equal(resolveVenueAlias('916 Kenmore Blvd'), null)
    assert.equal(resolveVenueAlias('Kenmore Senior Community Center'), null)
    assert.equal(resolveVenueAlias(''), null)
  })
})
