/**
 * test-stow-library.js — pure parsers for the Stow-Munroe Falls Library
 * (LibCal calendar/list JSON) scraper. Fixtures are trimmed from the real
 * live feed (GET /ajax/calendar/list?c=15865&date=0000-00-00). Network fetch +
 * pagination are integration concerns and aren't unit-tested here.
 *
 * Run:  node --test scripts/tests/test-stow-library.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  mapCategory, isSkippable, parseIsFamily, parseTags, parsePrice,
  resolveVenue, shouldDropForGeo, buildRow, SOURCE_KEY,
} = await import('../scrape-stow-library.js')

// A real feed object (2- to 5-Year-Old Story Time), trimmed.
const storyTime = {
  id: 15898186,
  title: '2- to 5-Year-Old Story Time',
  description: '<p>Children ages 2&nbsp;- 5&nbsp;and their families can join us for Story Time every Tuesday at 10&nbsp;AM.</p>\n',
  startdt: '2026-07-14 10:00:00',
  enddt: '2026-07-14 10:30:00',
  all_day: false,
  ymd: '20260714',
  url: 'https://events.smfpl.org/event/15898186',
  location: 'Stow-Munroe Falls Room',
  featured_image: 'https://d2jv02qf7xgjwx.cloudfront.net/accounts/302746/images/Story-Time.jpg',
  audiences: [{ id: 4858, name: 'Children - Preschool' }],
  categories_arr: [{ cat_id: 56712, name: 'Story Time' }, { cat_id: 57707, name: 'Summer Reading Event' }],
  registration_cost: '',
  online_event: false,
  recurring_event: true,
}

describe('mapCategory (controlled vocab + title)', () => {
  it('maps program-type names first-match-wins', () => {
    assert.equal(mapCategory(['Story Time', 'Summer Reading Event']), 'learning')
    assert.equal(mapCategory(["Children's Crafts"]), 'visual-art')
    assert.equal(mapCategory(['Book Sale']), 'market')
    assert.equal(mapCategory(['Movie ']), 'film')
    assert.equal(mapCategory(['Book Discussion']), 'learning')
  })
  it('falls back to the title when the category is audience-shaped', () => {
    assert.equal(mapCategory(['Adult Program'], 'Chair Yoga for Seniors'), 'fitness')
    assert.equal(mapCategory(['Adult Program'], 'Watercolor Craft Night'), 'visual-art')
  })
  it('returns null when nothing content-specific matches', () => {
    assert.equal(mapCategory(['Adult Program'], 'Trivia Night'), null)
    assert.equal(mapCategory([], ''), null)
  })
})

describe('isSkippable', () => {
  it('skips internal Board of Trustees meetings', () => {
    assert.equal(isSkippable(['Board of Trustees Meeting'], 'Board of Trustees Meeting'), true)
    assert.equal(isSkippable([], 'Story Time'), false)
  })
  it('skips canceled events (title-prefixed by LibCal)', () => {
    assert.equal(isSkippable([], '(Canceled) Job Seeker Station'), true)
    assert.equal(isSkippable([], '(Cancelled) Book Club'), true)
    assert.equal(isSkippable([], 'Cancel Culture: A Discussion'), false)
  })
  it('skips library closures (published as all-day non-events)', () => {
    assert.equal(isSkippable([], 'Library Closed'), true)
    assert.equal(isSkippable([], 'Library Closed for Staff Training'), true)
    assert.equal(isSkippable([], 'Closed for the Holiday'), true)
    assert.equal(isSkippable([], 'Story Time'), false)
    assert.equal(isSkippable([], 'Adult Craft Night'), false)
  })
})

describe('parseIsFamily (authoritative Audience field)', () => {
  it('true for youth/family/all-ages audiences', () => {
    assert.equal(parseIsFamily(['Children - Preschool']), true)
    assert.equal(parseIsFamily(['Children - School Age']), true)
    assert.equal(parseIsFamily(['Teen']), true)
    assert.equal(parseIsFamily(['All Ages']), true)
  })
  it('undefined (not false) for adult-only', () => {
    assert.equal(parseIsFamily(['Adult']), undefined)
    assert.equal(parseIsFamily([]), undefined)
  })
})

describe('parseTags', () => {
  it('always tags free/library/stow and maps audiences', () => {
    const t = parseTags(['Children - Preschool', 'Adult'])
    assert.ok(t.includes('free') && t.includes('library') && t.includes('stow'))
    assert.ok(t.includes('kids') && t.includes('adults'))
  })
  it('adds online when flagged and dedupes', () => {
    const t = parseTags(['Adult'], true)
    assert.ok(t.includes('online'))
    assert.equal(new Set(t).size, t.length)
  })
})

describe('parsePrice', () => {
  it('empty cost → free (library programs are free)', () => {
    assert.deepEqual(parsePrice(''), { price_min: 0, price_max: null })
    assert.deepEqual(parsePrice(), { price_min: 0, price_max: null })
  })
  it('parses a populated fee', () => {
    assert.deepEqual(parsePrice('$5'), { price_min: 5, price_max: null })
    assert.deepEqual(parsePrice('$5 - $10'), { price_min: 5, price_max: 10 })
  })
})

describe('resolveVenue', () => {
  it('collapses internal room names onto the one library venue', () => {
    assert.equal(resolveVenue('Community Room').name, 'Stow-Munroe Falls Public Library')
    assert.equal(resolveVenue('Pavilion, Stow-Munroe Falls Room').name, 'Stow-Munroe Falls Public Library')
    assert.equal(resolveVenue('Stow-Munroe Falls Room').details.address, '3512 Darrow Rd')
  })
  it('parses a fully-addressed off-site venue', () => {
    const v = resolveVenue('Stow Community and Senior Center, 5344 Fishcreek Rd, Stow, OH 44224')
    assert.equal(v.name, 'Stow Community and Senior Center')
    assert.equal(v.details.address, '5344 Fishcreek Rd')
    assert.equal(v.details.city, 'Stow')
    assert.equal(v.details.state, 'OH')
    assert.equal(v.details.zip, '44224')
  })
  it('parses an off-site venue with only a street address (city defaults to Stow)', () => {
    const v = resolveVenue('Adell Durbin Park, 3300 Darrow Rd')
    assert.equal(v.name, 'Adell Durbin Park')
    assert.equal(v.details.address, '3300 Darrow Rd')
    assert.equal(v.details.city, 'Stow')
  })
  it('returns null for online / empty / off-site-placeholder', () => {
    assert.equal(resolveVenue('Community Room', true), null)
    assert.equal(resolveVenue(''), null)
    assert.equal(resolveVenue('Off Site Location'), null)
  })
})

describe('shouldDropForGeo', () => {
  it('never drops the library or venue-less events', () => {
    assert.equal(shouldDropForGeo(null), false)
    assert.equal(shouldDropForGeo(resolveVenue('Community Room')), false)
  })
  it('drops an explicit known non-Summit city, keeps Summit + unknown', () => {
    assert.equal(shouldDropForGeo({ name: 'X', details: { city: 'Cleveland' } }), true)
    assert.equal(shouldDropForGeo({ name: 'Y', details: { city: 'Stow' } }), false)
    assert.equal(shouldDropForGeo({ name: 'Z', details: { city: undefined } }), false)
  })
})

describe('buildRow', () => {
  it('builds a free, dated, categorized, family row with a stable id', () => {
    const { row, venue } = buildRow(storyTime)
    assert.equal(row.title, '2- to 5-Year-Old Story Time')
    assert.ok(row.start_at.endsWith('Z'))
    // 10:00 ET in July (EDT, UTC-4) → 14:00Z
    assert.equal(row.start_at, '2026-07-14T14:00:00.000Z')
    assert.equal(row.end_at, '2026-07-14T14:30:00.000Z')
    assert.equal(row.category, 'learning')
    assert.equal(row.is_family, true)
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, null)
    assert.equal(row.image_url, 'https://d2jv02qf7xgjwx.cloudfront.net/accounts/302746/images/Story-Time.jpg')
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'smfpl_15898186_20260714')
    assert.equal(row.status, 'published')
    assert.equal(venue.name, 'Stow-Munroe Falls Public Library')
  })

  it('handles an all-day event (uses the parsed enddt, never a synthesized time)', () => {
    const { row } = buildRow({
      id: 111, title: 'City-Wide Scavenger Hunt',
      startdt: '2026-07-01 00:00:00', enddt: '2026-08-01 23:59:59',
      all_day: true, ymd: '20260701', url: 'https://events.smfpl.org/event/111',
      location: '', audiences: [{ name: 'All Ages' }], categories_arr: [{ name: 'Contest' }],
      registration_cost: '', online_event: false,
    })
    assert.ok(row.start_at.endsWith('Z'))
    assert.ok(row.end_at.endsWith('Z'))
    assert.equal(row.is_family, true)
    assert.equal(row.source_id, 'smfpl_111_20260701')
  })

  it('ingests an online author talk with no venue', () => {
    const { row, venue } = buildRow({
      id: 222, title: 'Online Author Talk: Jane Doe',
      startdt: '2026-08-05 19:00:00', enddt: '2026-08-05 20:00:00',
      all_day: false, ymd: '20260805', url: 'https://events.smfpl.org/event/222',
      location: '', audiences: [{ name: 'Adult' }], categories_arr: [{ name: 'Online Author Talk' }],
      registration_cost: '', online_event: true,
    })
    assert.equal(venue, null)
    assert.equal(row.category, 'learning')
    assert.ok(row.tags.includes('online'))
  })

  it('skips internal Board of Trustees meetings', () => {
    assert.equal(buildRow({
      id: 333, title: 'Board of Trustees Meeting', startdt: '2026-07-20 18:00:00',
      categories_arr: [{ name: 'Board of Trustees Meeting' }], audiences: [], location: 'Conference Room',
    }), null)
  })

  it('returns null when undatable', () => {
    assert.equal(buildRow({ id: 9, title: 'Mystery', startdt: '' }), null)
    assert.equal(buildRow({ id: 9, title: '', startdt: '2026-07-01 10:00:00' }), null)
  })
})
