/**test-northfield-park.js — pure parsers for the Northfield Park (Tribe) scraper*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { isEntertainment, parseCategory, buildSourceId, resolveVenue } =
  await import('../scrape-northfield-park.js')

describe('northfield: resolveVenue (per-room, not hardcoded Center Stage)', () => {
  it('maps Center Stage to the canonical name Ticketmaster uses', () => {
    assert.equal(resolveVenue({ venue: { venue: 'Center Stage' } }).name, 'Northfield Park Racino - Center Stage')
  })
  it('maps the Neon Room lounge to its own venue (regression: was pinned to Center Stage)', () => {
    assert.equal(resolveVenue({ venue: { venue: 'Neon Room' } }).name, 'Northfield Park Racino - Neon Room')
  })
  it('pins to the property (not Center Stage) when no room is given', () => {
    assert.equal(resolveVenue({ venue: [] }).name, 'Northfield Park Racino')
    assert.equal(resolveVenue({}).name, 'Northfield Park Racino')
  })
})

describe('northfield: isEntertainment (drops casino promotions)', () => {
  it('keeps the entertainment category', () => {
    assert.equal(isEntertainment({ categories: [{ slug: 'entertainment', name: 'Entertainment' }] }), true)
  })
  it('drops casino promotions', () => {
    assert.equal(isEntertainment({ categories: [{ slug: 'promotions', name: 'Promotions' }] }), false)
    assert.equal(isEntertainment({ categories: [] }), false)
  })
})

describe('northfield: parseCategory', () => {
  it('detects comedy, else defaults to music', () => {
    assert.equal(parseCategory({ title: 'Comedy Night ft. A Comedian', categories: [] }), 'comedy')
    assert.equal(parseCategory({ title: 'Straight No Chaser', categories: [{ name: 'Entertainment' }] }), 'music')
  })
})

describe('northfield: buildSourceId', () => {
  it('keys on id + occurrence day', () => {
    assert.equal(buildSourceId({ id: 681, start_date: '2026-07-05 19:30:00' }), '681-2026-07-05')
    assert.equal(buildSourceId({ id: 681 }), '681')
  })
})
