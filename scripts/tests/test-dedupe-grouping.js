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

import { locationKey, fuzzyTitlesMatch } from '../dedupe-cross-source.js'
import { normalizeStreetAddress } from '../lib/normalize.js'
import { resolveVenueAlias } from '../scrape-better-kenmore.js'

// normalizeStreetAddress is the shared SSOT (lib/normalize.js); locationKey
// below consumes it for bucketing. These cases pin the folding behavior the
// dedupe pass relies on.
describe('dedupe: normalizeStreetAddress', () => {
  it('folds suffix variants and punctuation', () => {
    assert.equal(normalizeStreetAddress('1000 Kenmore Blvd.'), '1000 kenmore blvd')
    assert.equal(normalizeStreetAddress('1000 Kenmore Boulevard'), '1000 kenmore blvd')
    assert.equal(normalizeStreetAddress('  220 South Balch Street '), '220 south balch st')
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
