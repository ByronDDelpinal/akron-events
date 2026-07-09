/**
 * test-main-street-barberton.js — pure hooks for the Main Street Barberton
 * ICS scraper. Fixtures are REAL VEVENT fields captured from the live iCal
 * export on 2026-07-08.
 *
 * Run:  node --test scripts/tests/test-main-street-barberton.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { includeEvent, mapCategory, parseLocation, SOURCE_KEY } =
  await import('../scrape-main-street-barberton.js')

describe('includeEvent (meeting filter)', () => {
  it('drops council and board meetings', () => {
    assert.equal(includeEvent({ SUMMARY: 'City Council Meeting' }), false)
    assert.equal(includeEvent({ SUMMARY: 'Main Street Board Meeting' }), false)
  })
  it('keeps community events', () => {
    assert.equal(includeEvent({ SUMMARY: 'Lake Anna Concert Series' }), true)
    assert.equal(includeEvent({ SUMMARY: '.5K Race' }), true)
    assert.equal(includeEvent({ SUMMARY: 'Summer Crawl- By The Christmas Walk' }), true)
  })
})

describe('mapCategory', () => {
  it('ICS CATEGORIES drive music and art', () => {
    assert.equal(mapCategory({ SUMMARY: 'Summer Concert Series GARALD HARRIS', CATEGORIES: 'Music' }), 'music')
    assert.equal(mapCategory({ SUMMARY: 'Creative Connections: Colored Pencil Still Lifes', CATEGORIES: 'art class' }), 'visual-art')
  })
  it('title keywords back up missing CATEGORIES', () => {
    assert.equal(mapCategory({ SUMMARY: 'Lake Anna Concert Series' }), 'music')
    assert.equal(mapCategory({ SUMMARY: '.5K Race' }), 'fitness')
    assert.equal(mapCategory({ SUMMARY: 'Summer Crawl- By The Christmas Walk' }), 'festival')
  })
  it('returns null when nothing matches (inference decides)', () => {
    assert.equal(mapCategory({ SUMMARY: 'Hungarian Night @GreenDiamond' }), null)
  })
})

describe('parseLocation (Tribe iCal LOCATION)', () => {
  it('splits venue name + street from the comma chain', () => {
    const p = parseLocation('Kavé Coffee Bar, 584 W. Tuscarawas, Barberton, OH, 44203, United States')
    assert.equal(p.name, 'Kavé Coffee Bar')
    assert.equal(p.details.address, '584 W. Tuscarawas')
    assert.equal(p.details.city, 'Barberton')
  })
  it('bare street addresses fall back to the default venue (no address-named venues)', () => {
    assert.equal(parseLocation('576 W Park Avenue'), null)
  })
  it('single-segment names pass through without an address', () => {
    const p = parseLocation('Barberton Public Library')
    assert.equal(p.name, 'Barberton Public Library')
    assert.equal(p.details.address, null)
  })
})

describe('module contract', () => {
  it('exports the manifest source key', () => {
    assert.equal(SOURCE_KEY, 'main_street_barberton')
  })
})

describe('Lake Anna canonicalization (live-run fix 2026-07-08)', () => {
  it('cross-street LOCATION maps to the Lake Anna Park record', () => {
    const p = parseLocation('Lake Anna W. Park Ave/6th St NW')
    assert.equal(p.name, 'Lake Anna Park')
    assert.equal(p.details.address, 'W Park Ave & 6th St NW')
  })
})
