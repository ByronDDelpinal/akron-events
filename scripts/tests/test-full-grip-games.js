/**
 * test-full-grip-games.js — category/tag mapping + config for the Full Grip
 * Games iCal scraper. Feed parsing and RRULE expansion are covered by the
 * shared lib tests in test-ics.js; here we lock the scraper's own config and
 * the title → game-system tag mapping.
 *
 * Run:  node --test scripts/tests/test-full-grip-games.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { mapCategory, mapTags, config, SOURCE_KEY } = await import('../scrape-full-grip-games.js')

describe('Full Grip Games mapCategory', () => {
  it('always games (the whole calendar is game programming)', () => {
    assert.equal(mapCategory({ SUMMARY: 'Friday Night Magic' }), 'games')
    assert.equal(mapCategory({ SUMMARY: 'Pokémon League' }), 'games')
    assert.equal(mapCategory({ SUMMARY: 'Anything at all' }), 'games')
  })
})

describe('Full Grip Games mapTags', () => {
  it('always tags games + tabletop + akron', () => {
    const t = mapTags({ SUMMARY: 'Open Play' })
    assert.ok(t.includes('games') && t.includes('tabletop') && t.includes('akron'))
  })

  it('detects Pokémon (accented and PTCG)', () => {
    assert.ok(mapTags({ SUMMARY: 'Pokémon TCG Standard' }).includes('pokemon'))
    assert.ok(mapTags({ SUMMARY: 'PTCG Cup' }).includes('pokemon'))
  })

  it('detects Magic / Commander / FNM', () => {
    assert.ok(mapTags({ SUMMARY: 'MTG Commander Night' }).includes('magic-the-gathering'))
    assert.ok(mapTags({ SUMMARY: 'MTG Commander Night' }).includes('commander'))
    assert.ok(mapTags({ SUMMARY: 'Friday Night Magic' }).includes('friday-night-magic'))
  })

  it('detects drafts, leagues, and tournaments', () => {
    assert.ok(mapTags({ SUMMARY: 'Set Booster Draft' }).includes('draft'))
    assert.ok(mapTags({ SUMMARY: 'Weekly League' }).includes('league'))
    assert.ok(mapTags({ SUMMARY: 'Regional Tournament' }).includes('tournament'))
  })

  it('returns a de-duplicated list', () => {
    const t = mapTags({ SUMMARY: 'Commander Commander EDH' })
    assert.equal(new Set(t).size, t.length)
  })
})

describe('Full Grip Games config', () => {
  it('uses the right source key', () => {
    assert.equal(SOURCE_KEY, 'full_grip_games')
    assert.equal(config.source, 'full_grip_games')
  })

  it('expands recurring masters and skips past events', () => {
    assert.equal(config.expandRecurring, true)
    assert.equal(config.skipPast, true)
  })

  it('never assumes free (price stays null)', () => {
    assert.equal(config.defaultPriceMin, null)
    assert.equal(config.defaultPriceMax, null)
  })

  it('pins the downtown Akron store venue', () => {
    assert.equal(config.defaultVenueName, 'Full Grip Games')
    assert.equal(config.defaultVenueDetails.address, '121 E Market St')
    assert.equal(config.defaultVenueDetails.neighborhood_slug, 'downtown-akron')
  })
})
