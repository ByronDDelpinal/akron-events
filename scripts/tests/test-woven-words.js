/**
 * test-woven-words.js - pure helpers for the Woven Words Bookshop scraper.
 * Titles are REAL event titles captured from the live Tribe REST feed on
 * 2026-08-07 (not invented shapes - the akronym lesson).
 *
 * Run:  node --test scripts/tests/test-woven-words.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { inferCategory, buildSourceId, includeEvent, parseTicketUrl, SOURCE_KEY } =
  await import('../scrape-woven-words.js')
const { parseCostFromTribe } = await import('../lib/normalize.js')

// Trimmed real event from the 2026-08-07 feed capture.
const QUILLING = {
  id: 465,
  title: 'Paper Quilling with Upcycle Bookcycle',
  url: 'https://www.wovenwordsbookshop.com/event/paper-quilling-with-upcycle-bookcycle/',
  start_date: '2026-08-08 17:00:00',
  utc_start_date: '2026-08-08 21:00:00',
  utc_end_date: '2026-08-08 23:00:00',
  cost: '$45.00',
  cost_details: { currency_symbol: '', currency_code: 'USD', currency_position: 'prefix', values: ['45.00'] },
  categories: [],
  tags: [],
  website: 'https://square.link/u/RSPYWRpB',
  custom_fields: [],
  venue: { id: 163, venue: 'Woven Words Bookshop', address: '843 N. Cleveland Massillon Rd.', city: 'Akron', zip: '44333' },
}

describe('inferCategory (title-only - the feed has no Tribe categories)', () => {
  it('craft signals win, and win FIRST (before book-club words)', () => {
    assert.equal(inferCategory('Paper Quilling with Upcycle Bookcycle'), 'visual-art')
    assert.equal(inferCategory('Kniterary Club Knit Night'), 'visual-art')
    assert.equal(inferCategory('DIY Ghost Garlands with Amy'), 'visual-art')
    // "Crafternoon" carries a craft signal even though "Book Club" is present.
    assert.equal(inferCategory('Whatcha Reading? Book Club and Crafternoon'), 'visual-art')
  })
  it('swaps/fairs/sales are markets', () => {
    assert.equal(inferCategory('Book Lovers Day: Book Swap'), 'market')
  })
  it('author and book programming is learning', () => {
    assert.equal(inferCategory('Author Signing: Victor Simmons'), 'learning')
    assert.equal(inferCategory('Read What You Can Book Club'), 'learning')
  })
  it('trivia/game nights stay other', () => {
    assert.equal(inferCategory('Bookish Trivia Night'), 'other')
  })
  it('falls back to learning (a bookshop\'s unlabelled tail is book programming)', () => {
    assert.equal(inferCategory('An Evening with Local Zinesters'), 'learning')
  })
})

describe('buildSourceId (per-occurrence)', () => {
  it('appends the local start date to the Tribe event id', () => {
    assert.equal(buildSourceId(QUILLING), '465-2026-08-08')
  })
  it('two occurrences of the same series get distinct ids', () => {
    const nextWeek = { ...QUILLING, start_date: '2026-08-15 17:00:00' }
    assert.notEqual(buildSourceId(QUILLING), buildSourceId(nextWeek))
  })
})

describe('includeEvent (Summit gate + virtual)', () => {
  it('keeps Akron shop events', () => {
    assert.equal(includeEvent(QUILLING), true)
  })
  it('venue-less events pass (they pin to the shop record)', () => {
    assert.equal(includeEvent({ ...QUILLING, venue: undefined }), true)
  })
  it('skips is_virtual events and meeting-link venue names', () => {
    assert.equal(includeEvent({ ...QUILLING, is_virtual: true }), false)
    assert.equal(includeEvent({ is_virtual: false, venue: { venue: 'Virtual Zoom Call' } }), false)
    assert.equal(includeEvent({ is_virtual: false, venue: { venue: 'Online via Teams' } }), false)
  })
  it('gates out venues outside Summit County', () => {
    assert.equal(includeEvent({ ...QUILLING, venue: { venue: 'Some Shop', city: 'Canton' } }), false)
    assert.equal(includeEvent({ ...QUILLING, venue: { venue: 'Some Shop', city: 'Kent' } }), false)
  })
})

describe('cost handling (real feed shapes: "$45.00" / "Free" / "")', () => {
  it('"$45.00" parses to price_min 45', () => {
    assert.deepEqual(parseCostFromTribe('$45.00', {}), { price_min: 45, price_max: null })
  })
  it('"Free" parses to price_min 0', () => {
    assert.deepEqual(parseCostFromTribe('Free', {}), { price_min: 0, price_max: null })
  })
  it('empty cost stays null - never assume free', () => {
    assert.deepEqual(parseCostFromTribe('', {}), { price_min: null, price_max: null })
  })
  it('cost_details values win when present (the feed sends both)', () => {
    assert.deepEqual(parseCostFromTribe(QUILLING.cost, QUILLING.cost_details), { price_min: 45, price_max: null })
  })
})

describe('ticket url', () => {
  it('the event website (Square checkout) wins over the post URL', () => {
    assert.equal(parseTicketUrl(QUILLING), 'https://square.link/u/RSPYWRpB')
  })
  it('falls back to the post URL when website is empty', () => {
    assert.equal(parseTicketUrl({ ...QUILLING, website: '' }), QUILLING.url)
  })
})

describe('module contract', () => {
  it('exports the manifest source key', () => {
    assert.equal(SOURCE_KEY, 'woven_words')
  })
})
