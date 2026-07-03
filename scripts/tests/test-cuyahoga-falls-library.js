/**
 * test-cuyahoga-falls-library.js — pure parsers for the Cuyahoga Falls Library
 * (Communico Anywhere) scraper. Puppeteer render + DOM extraction are
 * integration concerns and aren't unit-tested here.
 *
 * Run:  node --test scripts/tests/test-cuyahoga-falls-library.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { to24h, parseListDateTime, mapCategory, parseIsFamily, venueFor, buildRow, eventToCard, SOURCE_KEY } =
  await import('../scrape-cuyahoga-falls-library.js')

describe('CFL to24h', () => {
  it('converts am/pm incl. noon and midnight', () => {
    assert.equal(to24h('10:30am'), '10:30:00')
    assert.equal(to24h('12:00pm'), '12:00:00')
    assert.equal(to24h('12:00am'), '00:00:00')
    assert.equal(to24h('1:00pm'), '13:00:00')
    assert.equal(to24h('nope'), null)
  })
})

describe('CFL parseListDateTime', () => {
  const jun10 = new Date('2026-06-10T12:00:00Z')
  it('parses "Weekday, Month Day: start - end" (year inferred)', () => {
    assert.deepEqual(parseListDateTime('Tuesday, June 16: 10:30am - 12:00pm', jun10),
      { dateYmd: '2026-06-16', start: '10:30:00', end: '12:00:00' })
  })
  it('rolls a past month into next year', () => {
    const dec15 = new Date('2026-12-15T12:00:00Z')
    assert.equal(parseListDateTime('Friday, January 9: 6:00pm - 7:00pm', dec15).dateYmd, '2027-01-09')
  })
  it('handles a single (no-end) time', () => {
    const r = parseListDateTime('Monday, July 6: 2:00pm', jun10)
    assert.equal(r.dateYmd, '2026-07-06'); assert.equal(r.start, '14:00:00'); assert.equal(r.end, null)
  })
  it('returns null when no month/day present', () => {
    assert.equal(parseListDateTime('Ongoing'), null)
    assert.equal(parseListDateTime(''), null)
  })
})

describe('CFL mapCategory', () => {
  it('maps the Communico event-type vocabulary', () => {
    assert.equal(mapCategory('Storytime'), 'learning')
    assert.equal(mapCategory('Arts/Crafts'), 'visual-art')
    assert.equal(mapCategory('Board of Trustees Meeting'), 'civic')
    assert.equal(mapCategory('Concert'), 'music')
    assert.equal(mapCategory('', 'Family Movie Night'), 'film')
    assert.equal(mapCategory('Social Event'), null)
  })
})

describe('CFL parseIsFamily', () => {
  it('true for youth/family age groups, undefined otherwise', () => {
    assert.equal(parseIsFamily('Toddler Preschool'), true)
    assert.equal(parseIsFamily('Tween Teen'), true)
    assert.equal(parseIsFamily('Senior Adult'), undefined)
  })
})

describe('CFL venueFor', () => {
  it('collapses main-library rooms to one venue', () => {
    const v = venueFor('Cuyahoga Falls Library - Graefe Room')
    assert.equal(v.name, 'Cuyahoga Falls Library')
    assert.equal(v.details.address, '2015 Third St')
  })
  it('parses an external venue + parenthetical address', () => {
    const v = venueFor('Silver Lake Village Hall (2961 Kent Rd, Silver Lake, OH 44224) - Community Room')
    assert.equal(v.name, 'Silver Lake Village Hall')
    assert.equal(v.details.address, '2961 Kent Rd')
    assert.equal(v.details.city, 'Silver Lake')
    assert.equal(v.details.zip, '44224')
  })
  it('returns null for "In the Community"/empty', () => {
    assert.equal(venueFor('In the Community'), null)
    assert.equal(venueFor(''), null)
  })
})

describe('CFL buildRow', () => {
  const card = {
    title: 'Storytime at LIONS PARK', subtitle: '- with special guest Little Diggers',
    datetimeText: 'Tuesday, June 16: 10:30am - 12:00pm', location: 'In the Community',
    ageGroup: 'Toddler Preschool', eventType: 'Storytime',
    description: 'Songs, stories, and sand at Lions Park!',
    detailUrl: 'https://events.fallslibrary.org/event/16049653', eventId: '16049653',
  }
  it('builds a free, dated, categorized row with a stable id', () => {
    const { row, venue } = buildRow(card, new Date('2026-06-10T12:00:00Z'))
    assert.match(row.title, /^Storytime at LIONS PARK/)
    assert.ok(row.start_at.endsWith('Z'))
    assert.equal(row.price_min, 0)
    assert.equal(row.category, 'learning')
    assert.equal(row.is_family, true)
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'cfl_16049653')
    assert.equal(venue, null) // "In the Community"
  })
  it('returns null when undatable', () => {
    assert.equal(buildRow({ title: 'Mystery', datetimeText: 'Ongoing' }), null)
  })
})

// 2026-07-02 data-quality plan (task 6): the feed's `image`/`event_image`
// fields are empty in practice, so image_url had been hardcoded null. Read
// them defensively in case that ever changes — but only trust an already-
// absolute URL, since we don't know this platform's asset base path. A
// source-level static fallback (lib/fallback-images.js) covers the rest.
describe('CFL image field (defensive, 2026-07-02)', () => {
  it('leaves imageUrl null when the feed field is empty (current reality)', () => {
    const card = eventToCard({ title: 'Play Cafe', image: '', event_image: '' })
    assert.equal(card.imageUrl, null)
  })

  it('picks up an absolute image URL if the feed ever populates one', () => {
    const card = eventToCard({ title: 'Play Cafe', image: 'https://fallslibrary.libnet.info/img/x.jpg' })
    assert.equal(card.imageUrl, 'https://fallslibrary.libnet.info/img/x.jpg')
  })

  it('ignores a bare filename (unknown asset base path) rather than guessing', () => {
    const card = eventToCard({ title: 'Play Cafe', image: 'x.jpg' })
    assert.equal(card.imageUrl, null)
  })

  it('carries the image through eventToCard into buildRow', () => {
    const card = eventToCard({
      title: 'Play Cafe',
      datestring: 'Thursday, July 02',
      time_string: '10:00am - 11:30am',
      location: 'Cuyahoga Falls Library',
      image: 'https://fallslibrary.libnet.info/img/x.jpg',
    })
    const built = buildRow(card, new Date('2026-06-01T12:00:00Z'))
    assert.ok(built, 'row built')
    assert.equal(built.row.image_url, 'https://fallslibrary.libnet.info/img/x.jpg')
  })
})
