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
  buildGroupPlan, selectPlansWithinCap, hasSiblingSessionRisk, buildAliasRow,
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

  it('scans ALL venue links and prefers the address-bearing one (junk-link immunity)', () => {
    // The 2026-07-16 Hudson Bandstand escape: the city_of_hudson copy carried a
    // leftover paragraph-named junk venue (no address) as links[0] plus the real
    // Hudson Green as a later link. Keying off [0] bucketed the pair apart.
    const withJunkFirst = locationKey({ event_venues: [
      { venue_id: 'v-junk', venues: { name: 'Due to the renovation of the Gazebo, the bands will perform on Church Street', address: null } },
      { venue_id: 'v-green', venues: { name: 'Hudson Green', address: '1 Clinton St' } },
    ]})
    const partner = locationKey({ event_venues: [
      { venue_id: 'v-green', venues: { name: 'Hudson Green', address: '1 Clinton St' } },
    ]})
    assert.equal(withJunkFirst, 'addr:1 clinton st')
    assert.equal(withJunkFirst, partner)
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

  // 2026-07-03 launch-day regression: DAP listed the festival umbrella AND its
  // sub-events venue-less; intake_email carried the venue-linked sub-event.
  it('umbrella "X" never matches sub-event "X: Y"; suffix act-extraction still does', () => {
    assert.equal(venuelessTitleMatch(
      'All American Burger & BBQ Festival',
      "All American Burger & BBQ Festival: JT's Electrik Blackout"), false)
    assert.equal(venuelessTitleMatch(
      'All American Burger & BBQ Festival',
      'All American Burger & BBQ Festival - Dirty Lookz'), false)
    // suffix direction is the same act, must keep matching
    assert.equal(venuelessTitleMatch(
      'The Michael Weber Show',
      'All American Burger & BBQ Festival: The Michael Weber Show'), true)
  })

  it('exact-title pair claims the candidate before an umbrella containment can consume it', () => {
    const lock4 = (id, title, source, start, venues = []) =>
      ({ id, title, source, start_at: start, end_at: null, event_venues: venues })
    const atLock4 = [{ venue_id: 'v-l4', venues: { name: 'Lock 4', address: '200 S Main St' } }]
    const { groups } = findDuplicateGroups([
      // venue-less umbrella listed FIRST (earlier start) — old code let it grab
      // the intake copy via containment and the exact twin survived
      lock4('umbrella', 'All American Burger & BBQ Festival', 'downtown_akron', '2026-07-03T15:00:00+00:00'),
      lock4('dap-jts', "All American Burger & BBQ Festival: JT's Electrik Blackout", 'downtown_akron', '2026-07-03T22:00:00+00:00'),
      lock4('intake-jts', "All American Burger & BBQ Festival: JT's Electrik Blackout", 'intake_email', '2026-07-03T22:00:00+00:00', atLock4),
    ])
    assert.equal(groups.length, 1)
    const ids = groups[0].map(e => e.id).sort()
    assert.deepEqual(ids, ['dap-jts', 'intake-jts'])   // umbrella survives ungrouped
  })

  it('same-second venue-less pair tolerates singular/plural drift ("Burger"/"Burgers")', () => {
    const { groups } = findDuplicateGroups([
      {
        id: 'lock3', title: 'All American Burgers & BBQ Festival', source: 'city_of_akron_lock3',
        start_at: '2026-07-03T15:00:00+00:00', end_at: '2026-07-04T03:00:00+00:00',
        event_venues: [{ venue_id: 'v-l3', venues: { name: 'Lock 3', address: '200 S Main St' } }],
      },
      {
        id: 'dap', title: 'All American Burger & BBQ Festival', source: 'downtown_akron',
        start_at: '2026-07-03T15:00:00+00:00', end_at: null, event_venues: [],
      },
    ])
    assert.equal(groups.length, 1)
    assert.deepEqual(groups[0].map(e => e.id).sort(), ['dap', 'lock3'])
  })

  it('different-second typo drift does NOT match (same-second gate holds)', () => {
    const { groups } = findDuplicateGroups([
      {
        id: 'lock3', title: 'All American Burgers & BBQ Festival', source: 'city_of_akron_lock3',
        start_at: '2026-07-03T15:00:00+00:00', end_at: null,
        event_venues: [{ venue_id: 'v-l3', venues: { name: 'Lock 3', address: '200 S Main St' } }],
      },
      {
        id: 'dap', title: 'All American Burger & BBQ Festival', source: 'downtown_akron',
        start_at: '2026-07-03T16:00:00+00:00', end_at: null, event_venues: [],
      },
    ])
    assert.equal(groups.length, 0)
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

// ── 2026-07-28 incident: dedupe-cross-source.js --apply --max-deletes=207 ────
// deleted 188 events; 73 were SAME-SOURCE and largely distinct real events
// (age-banded library story times, sequential class sessions, 7:30/9:30pm
// comedy shows, 7am/8:30am yoga classes). Root cause was two-fold:
//   1. Pass 2 (fuzzy time window) had no different-source gate, unlike every
//      other pass — a single source publishing two rows at one venue within
//      the 2h window, sharing enough title tokens, would group.
//   2. Even where groupConfidenceTier correctly routed such a group to tier 2
//      (never eligible for a partial drain), that gate lives INSIDE
//      selectPlansWithinCap and is only reachable on the over-cap path — a
//      cap large enough to fit the whole plan (`--max-deletes=207` for 188
//      planned deletes) skipped it entirely, so every group ran, tier
//      included.
// These tests pin both halves of the fix using the REAL findDuplicateGroups /
// buildGroupPlan / selectPlansWithinCap (not the test-dedupe-cross-source.js
// fork, which duplicates its own drifted copies of the title-matching
// helpers and proves nothing about shipped Pass 2).

describe('dedupe: Pass 2 same-source gate — regressions (2026-07-28 incident)', () => {
  const at = (venueId, name, address) => [{ venue_id: venueId, venues: { name, address } }]
  const mk = (id, title, source, start, venues, end = null) =>
    ({ id, title, source, start_at: start, end_at: end, event_venues: venues })

  it('1. stow_library: the SAME session title repeated an hour apart (the 33-row case — actually reproduces the incident: fuzzyTitlesMatch on identical titles is trivially true, so without the source gate this groups every time)', () => {
    // NOTE: an earlier version of this test used 'Birth to 23 Months Story
    // Time' vs '4- and 5-Year-Old Story Time' — but fuzzyTitlesMatch on that
    // pair is ALREADY false (too little token overlap), so that fixture never
    // grouped even without the fix and proved nothing about the source gate.
    // This pair (identical title, same source, within the fuzzy window) is
    // the shape that actually needed the gate: reverting the different-source
    // check at Pass 2 (:683) makes this test fail.
    const venue = at('v-stow', 'Stow-Munroe Falls Public Library', '3512 Darrow Rd')
    const { groups } = findDuplicateGroups([
      mk('a', 'Toddler Story Time', 'stow_library', '2026-08-03T14:00:00+00:00', venue), // 10:00 ET
      mk('b', 'Toddler Story Time', 'stow_library', '2026-08-03T15:00:00+00:00', venue), // 11:00 ET
    ])
    assert.equal(groups.length, 0)
  })

  it('2. akron_library: sequential sessions of one program, an hour apart', () => {
    const venue = at('v-akron-lib', 'Akron-Summit County Public Library', '60 S High St')
    const { groups } = findDuplicateGroups([
      mk('a', 'Enchanted Story Land Forest Session 1', 'akron_library', '2026-08-03T19:00:00+00:00', venue), // 15:00 ET
      mk('b', 'Enchanted Story Land Forest Session 2', 'akron_library', '2026-08-03T20:00:00+00:00', venue), // 16:00 ET
    ])
    assert.equal(groups.length, 0)
  })

  it('3. hudson_library: age-banded class sessions', () => {
    const venue = at('v-hudson-lib', 'Hudson Library & Historical Society', '96 Library St')
    const { groups } = findDuplicateGroups([
      mk('a', 'Tie Dye (ages 6-10)', 'hudson_library', '2026-08-03T19:00:00+00:00', venue),  // 15:00 ET
      mk('b', 'Tie Dye (ages 11-18)', 'hudson_library', '2026-08-03T20:00:00+00:00', venue), // 16:00 ET
    ])
    assert.equal(groups.length, 0)
  })

  it('4. stewarts_caring_place: two distinct support groups within the fuzzy window', () => {
    const venue = at('v-scp', "Stewart's Caring Place", '191 Simon Blvd')
    const { groups } = findDuplicateGroups([
      mk('a', 'Lung Cancer Support Group', 'stewarts_caring_place', '2026-08-03T21:00:00+00:00', venue),                    // 17:00 ET
      mk('b', 'Prostate Cancer Support & Education Group', 'stewarts_caring_place', '2026-08-03T22:00:00+00:00', venue),    // 18:00 ET
    ])
    assert.equal(groups.length, 0)
  })

  it('5. the_grove: SAME class title, 07:00 and 08:30 — proves the fix is source-gated, not title-gated', () => {
    // Identical title, same source, 1.5h apart (inside the 2h window):
    // fuzzyTitlesMatch('Chair Yoga Class', 'Chair Yoga Class') is TRUE, so
    // without the source gate this groups on title alone every time.
    const venue = at('v-grove', 'The Grove', '123 Grove Ave')
    const { groups } = findDuplicateGroups([
      mk('a', 'Chair Yoga Class', 'the_grove', '2026-08-03T11:00:00+00:00', venue), // 07:00 ET
      mk('b', 'Chair Yoga Class', 'the_grove', '2026-08-03T12:30:00+00:00', venue), // 08:30 ET
    ])
    assert.equal(groups.length, 0)
  })

  it('6. killbox_comedy: byte-identical title, exactly 2 hours apart — pins the boundary at the fuzzy-window check (`>`, not `>=`)', () => {
    const venue = at('v-killbox', 'Killbox Comedy Club', '456 Wall St')
    const { groups } = findDuplicateGroups([
      mk('a', 'Friday Night Standup Comedy Showcase', 'killbox_comedy', '2026-08-03T23:30:00+00:00', venue), // 19:30 ET
      mk('b', 'Friday Night Standup Comedy Showcase', 'killbox_comedy', '2026-08-04T01:30:00+00:00', venue), // 21:30 ET (exactly 2h later)
    ])
    assert.equal(groups.length, 0)
  })

  it('7. akron_rec_parks: two differently-named programs sharing the 09:00 placeholder time', () => {
    // Same second (not just fuzzy-window) — this is Pass 1's different-source
    // guard, already in place before this incident. Pinned here because it's
    // the SAME root cause (scrape-akron-rec-parks.js:635 hardcodes
    // `'09:00:00'` for any program with no schedule time, so unrelated
    // programs collide on a fabricated second) — an open follow-up: the
    // right fix is a real per-program time in the scraper, not dedupe logic.
    const venue = at('v-rec', 'Akron Rec & Parks Community Center', '789 Ave')
    const { groups } = findDuplicateGroups([
      mk('a', 'Youth Basketball League', 'akron_rec_parks', '2026-08-03T13:00:00+00:00', venue), // 09:00 ET
      mk('b', 'Adult Pickleball Open Play', 'akron_rec_parks', '2026-08-03T13:00:00+00:00', venue), // 09:00 ET
    ])
    assert.equal(groups.length, 0)
  })
})

describe('dedupe: cross-source matching must NOT regress from the same-source fix', () => {
  const at = (venueId, name, address) => [{ venue_id: venueId, venues: { name, address } }]
  const mk = (id, title, source, start, venues, end = null) =>
    ({ id, title, source, start_at: start, end_at: end, event_venues: venues })

  it('8. Colin John: Jilly\'s "BRUNCH with COLIN JOHN" 11:00 / akron_life "Colin John Music: Sunday Brunch Music" 12:00 still groups — Pass 2\'s founding regression', () => {
    const venue = at('v-jillys', "Jilly's Music Room", '820 W Market St')
    const { groups } = findDuplicateGroups([
      mk('a', 'BRUNCH with COLIN JOHN', 'jillys_music_room', '2026-08-02T15:00:00+00:00', venue),         // 11:00 ET
      mk('b', 'Colin John Music: Sunday Brunch Music', 'akron_life', '2026-08-02T16:00:00+00:00', venue), // 12:00 ET
    ])
    assert.equal(groups.length, 1)
    assert.equal(groups[0].length, 2)
  })

  it('9. mixed 3-member group: two same-source siblings + one genuine cross-source copy — only the cross-source pair groups', () => {
    const venue = at('v-killbox', 'Killbox Comedy Club', '456 Wall St')
    const early = mk('early', 'Friday Night Standup Comedy Showcase', 'killbox_comedy', '2026-08-03T23:30:00+00:00', venue) // 19:30 ET
    const late  = mk('late',  'Friday Night Standup Comedy Showcase', 'killbox_comedy', '2026-08-04T01:30:00+00:00', venue) // 21:30 ET — distinct real show
    const agg   = mk('agg',   'Killbox Comedy: Friday Night Standup Comedy Showcase', 'akron_life', '2026-08-03T23:45:00+00:00', venue) // 19:45 ET — aggregator re-listing of `early`
    const { groups } = findDuplicateGroups([early, late, agg])
    assert.equal(groups.length, 1)
    assert.deepEqual(groups[0].map((e) => e.id).sort(), ['agg', 'early'])
  })
})

describe('dedupe: Change 2 — the tier gate is unconditional, not just an over-cap filter', () => {
  const singleSourceGroup = [
    { id: 'early', title: 'Friday Night Standup Comedy Showcase', source: 'killbox_comedy',
      start_at: '2026-08-03T23:30:00+00:00', end_at: null,
      event_venues: [{ venue_id: 'v-killbox', venues: { name: 'Killbox Comedy Club', address: '456 Wall St' } }] },
    { id: 'late', title: 'Friday Night Standup Comedy Showcase', source: 'killbox_comedy',
      start_at: '2026-08-04T01:30:00+00:00', end_at: null,
      event_venues: [{ venue_id: 'v-killbox', venues: { name: 'Killbox Comedy Club', address: '456 Wall St' } }] },
  ]
  const crossSourceGroup = [
    { id: 'keep-x', title: 'Foghat Reunion Concert', source: 'northfield_park',
      start_at: '2026-08-05T23:00:00+00:00', end_at: null,
      image_url: 'https://img/x.jpg', description: 'A real description, well over twenty characters.',
      event_venues: [{ venue_id: 'v-nf', venues: { name: 'Center Stage', address: '10705 Northfield Rd' } }] },
    { id: 'drop-x', title: 'Foghat Reunion Concert', source: 'ticketmaster',
      start_at: '2026-08-05T23:00:00+00:00', end_at: null,
      event_venues: [{ venue_id: 'v-nf', venues: { name: 'Center Stage', address: '10705 Northfield Rd' } }] },
  ]
  // The shape the OLD `sources.size !== 1` predicate missed entirely: a
  // cluster anchored by a THIRD source (akron_life, an aggregator, matches
  // the EarthQuaker Day incident) carrying two same-source rows at different
  // times. The old predicate saw 2 distinct sources in this 3-member group
  // and returned false — never routed to NEEDS HUMAN REVIEW, DROPPED instead.
  const anchoredSiblingGroup = [
    { id: 'anchor', title: 'Chair Yoga Class', source: 'the_grove',
      start_at: '2026-08-03T11:00:00+00:00', end_at: '2026-08-03T12:00:00+00:00',
      event_venues: [{ venue_id: 'v-grove', venues: { name: 'The Grove', address: '123 Grove Ave' } }] },
    { id: 'sib-early', title: 'Chair Yoga Class', source: 'akron_life',
      start_at: '2026-08-03T11:00:00+00:00', end_at: null,
      event_venues: [{ venue_id: 'v-grove', venues: { name: 'The Grove', address: '123 Grove Ave' } }] },
    { id: 'sib-late', title: 'Chair Yoga Class', source: 'akron_life',
      start_at: '2026-08-03T12:30:00+00:00', end_at: null,
      event_venues: [{ venue_id: 'v-grove', venues: { name: 'The Grove', address: '123 Grove Ave' } }] },
  ]

  it('hasSiblingSessionRisk: same-source + different-second is at risk; same-source + same-second and 2-member cross-source are not', () => {
    assert.equal(hasSiblingSessionRisk(singleSourceGroup), true)
    assert.equal(hasSiblingSessionRisk(crossSourceGroup), false)
    const sameSecondSameSource = [singleSourceGroup[0], { ...singleSourceGroup[1], start_at: singleSourceGroup[0].start_at }]
    assert.equal(hasSiblingSessionRisk(sameSecondSameSource), false) // cosmetic double-listing shape — genuinely safe
    assert.equal(hasSiblingSessionRisk([singleSourceGroup[0]]), false) // single row isn't a group
  })

  it('hasSiblingSessionRisk catches the anchored 3-member shape the old whole-group predicate missed (strict superset, BLOCKER 1)', () => {
    // The old `sources.size !== 1` check: this group has 2 distinct sources
    // (the_grove, akron_life), so it would have returned false — SAFE to
    // auto-delete — even though akron_life alone contributes two different
    // start seconds (11:00 and 12:30 ET), which is exactly the sibling-session
    // shape (a real, distinct second class) the check exists to catch.
    assert.equal(hasSiblingSessionRisk(anchoredSiblingGroup), true)
  })

  it('buildGroupPlan tags the at-risk groups siblingSessionRisk (and they land in tier ≥ 2, same as a real cross-source fuzzy match)', () => {
    const unsafePlan = buildGroupPlan(singleSourceGroup)
    const safePlan = buildGroupPlan(crossSourceGroup)
    const anchoredPlan = buildGroupPlan(anchoredSiblingGroup)
    assert.equal(unsafePlan.siblingSessionRisk, true)
    assert.equal(unsafePlan.tier, 2)
    assert.equal(safePlan.siblingSessionRisk, false)
    assert.equal(anchoredPlan.siblingSessionRisk, true)
  })

  it('10. THE most valuable test: under a cap that fits the WHOLE plan, an at-risk group must never be selected — fails without upstream partitioning', () => {
    const unsafePlan = buildGroupPlan(singleSourceGroup)
    const safePlan = buildGroupPlan(crossSourceGroup)
    const anchoredPlan = buildGroupPlan(anchoredSiblingGroup)
    const allPlans = [unsafePlan, safePlan, anchoredPlan]
    // Cap set to exactly fit everything — the 2026-07-28 shape
    // (--max-deletes=207 for a 188-delete plan): plannedDeletes <= cap, so
    // selectPlansWithinCap's own tier filter (only reachable on the OVER-cap
    // path) never runs, by design and unchanged.
    const cap = allPlans.reduce((n, p) => n + p.deleteIds.length, 0)

    // Sanity check FIRST: reproduce the incident. Passing the unfiltered
    // plan list straight to selectPlansWithinCap — i.e. skipping the
    // upstream partition this fix adds to main() — selects both at-risk
    // plans, because under-cap is a documented, intentional no-op.
    const withoutPartition = selectPlansWithinCap(allPlans, cap)
    assert.ok(withoutPartition.selected.includes(unsafePlan),
      'sanity check: without the upstream partition, the single-source incident reproduces exactly')
    assert.ok(withoutPartition.selected.includes(anchoredPlan),
      'sanity check: without the upstream partition, the anchored 3-member (EarthQuaker) shape reproduces exactly')

    // The actual fix, mirroring main(): filter siblingSessionRisk plans out
    // BEFORE calling selectPlansWithinCap.
    const eligiblePlans = allPlans.filter((p) => !p.siblingSessionRisk)
    const withPartition = selectPlansWithinCap(eligiblePlans, cap)
    assert.ok(!withPartition.selected.includes(unsafePlan),
      'the single-source, non-exact-second plan must never be auto-selected, at any cap')
    assert.ok(!withPartition.selected.includes(anchoredPlan),
      'the anchored 3-member sibling-session plan must never be auto-selected, at any cap')
    assert.ok(withPartition.selected.includes(safePlan))
  })

  it('11. an at-risk group is excluded from plannedDeletes, and is labelled distinctly from DEFER', () => {
    const unsafePlan = buildGroupPlan(singleSourceGroup)
    const safePlan = buildGroupPlan(crossSourceGroup)
    const eligiblePlans = [unsafePlan, safePlan].filter((p) => !p.siblingSessionRisk)

    // plannedDeletes must come ONLY from the safe plan — the unsafe plan's
    // delete never inflates the "N planned" number main() prints (and used
    // to inflate the now-removed one-shot drain command).
    const res = selectPlansWithinCap(eligiblePlans, 0) // cap 0: even the safe plan defers
    assert.equal(res.plannedDeletes, safePlan.deleteIds.length)
    assert.ok(!res.selected.includes(unsafePlan) && !res.deferred.includes(unsafePlan),
      'the unsafe plan is invisible to the selector entirely — not selected, not deferred')

    // Note on why the anchored 3-member shape CAN be reached through
    // findDuplicateGroups() (unlike the plain same-source pair above): after
    // the Change 1 fix, no pass can produce a group where EVERY member
    // shares one source (Pass 1/2/4 are different-source-gated against the
    // anchor; Pass 3's anchor/candidate split makes a same-source PAIR
    // structurally impossible as an anchor). But a cluster anchored by a
    // THIRD source, carrying two same-source candidate rows, remains fully
    // reachable — see the 'anchored 3-member shape' tests above and the
    // real main()-level regression test in test-dedupe-max-deletes.js. This
    // synthetic group is kept here as the minimal unit-level case.
    //
    // This mirrors main()'s exact status decision:
    //   plan.siblingSessionRisk ? 'unsafe' : (selectedSet.has(plan) ? 'selected' : 'deferred')
    // proving the unsafe plan resolves to a THIRD status, never 'deferred' —
    // main()'s printPlan() gives 'deferred' the DEFER tag (implying the next
    // run retries it automatically) and 'unsafe' a distinct "NEEDS HUMAN
    // REVIEW" / "HOLD (needs review)" tag (it never auto-retries).
    const selectedSet = new Set(res.selected)
    const statusOf = (plan) => (plan.siblingSessionRisk ? 'unsafe' : (selectedSet.has(plan) ? 'selected' : 'deferred'))
    assert.equal(statusOf(unsafePlan), 'unsafe')
    assert.equal(statusOf(safePlan), 'deferred') // cap 0, so even the safe cross-source plan defers
    assert.notEqual(statusOf(unsafePlan), 'deferred')
  })
})

describe('dedupe: Change 4 — alias reason is tagged with tier + same/cross-source provenance', () => {
  it('12a. buildGroupPlan wires tier + canonical source through into buildAliasRow', () => {
    const group = [
      { id: 'keep', title: 'Foghat Reunion Concert', source: 'northfield_park', source_id: 'np-1',
        start_at: '2026-08-05T23:00:00+00:00', end_at: null,
        image_url: 'https://img/x.jpg', description: 'A real description, well over twenty characters.',
        event_venues: [{ venue_id: 'v-nf', venues: { name: 'Center Stage', address: '10705 Northfield Rd' } }] },
      { id: 'drop', title: 'Foghat Reunion Concert', source: 'ticketmaster', source_id: 'tm-1',
        start_at: '2026-08-05T23:00:00+00:00', end_at: null,
        event_venues: [{ venue_id: 'v-nf', venues: { name: 'Center Stage', address: '10705 Northfield Rd' } }] },
    ]
    const plan = buildGroupPlan(group)
    assert.equal(plan.tier, 0)
    assert.equal(plan.aliasRows.length, 1)
    assert.equal(plan.aliasRows[0].reason, 'dedupe-cross-source:tier0:cross-source')
  })

  it('12b. buildAliasRow tags a same-source drop distinctly, and the (duplicate_source, duplicate_source_id) upsert key is unaffected', () => {
    const crossSource = buildAliasRow('keeper-id', { source: 'akron_life', source_id: 'a-1' }, 1, 'akron_civic')
    assert.equal(crossSource.reason, 'dedupe-cross-source:tier1:cross-source')

    const sameSource = buildAliasRow('keeper-id', { source: 'wolf_creek', source_id: 'wc-1' }, 0, 'wolf_creek')
    assert.equal(sameSource.reason, 'dedupe-cross-source:tier0:same-source')

    // `reason` is free text (src/lib/database.types.ts:102), and NOT part of
    // the unique key recordAliases() upserts on — tagging it can't fragment
    // that key. duplicate_source/duplicate_source_id are exactly what they
    // were before the tag existed.
    assert.equal(sameSource.duplicate_source, 'wolf_creek')
    assert.equal(sameSource.duplicate_source_id, 'wc-1')
    assert.deepEqual(Object.keys(sameSource).sort(),
      ['canonical_event_id', 'duplicate_source', 'duplicate_source_id', 'reason'])
  })

  it('12c. an absent tier (old test fixtures, callers with no tier) reads "tierunknown", not "tierundefined"', () => {
    const row = buildAliasRow('keeper-id', { source: 'akron_life', source_id: 'a-1' }, undefined, 'akron_civic')
    assert.equal(row.reason, 'dedupe-cross-source:tierunknown:cross-source')
  })
})
