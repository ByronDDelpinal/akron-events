/**
 * test-house-three-thirty.js — House Three Thirty (VTL/LRMR JSON API) scraper.
 *
 * The live feed exposes only display-formatted date/time strings, so these
 * cover the parsing back to Eastern ISO, the recurring-safe source_id, and the
 * full row mapping against a synthetic feed entry (the live feed is often empty
 * between programming cycles).
 *
 * Run:
 *   node --test scripts/tests/test-house-three-thirty.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseDisplayDate, parseEventTimes, normaliseEvent, buildSourceId, mapTags } =
  await import('../scrape-house-three-thirty.js')

describe('House Three Thirty — parseDisplayDate', () => {
  it('parses "MMMM D" (the feed format) and infers an upcoming year', () => {
    const out = parseDisplayDate('December 31')
    assert.match(out, /^\d{4}-12-31$/)
  })
  it('honors an explicit year when present', () => {
    assert.equal(parseDisplayDate('June 14, 2027'), '2027-06-14')
  })
  it('passes through an ISO date', () => {
    assert.equal(parseDisplayDate('2026-07-04'), '2026-07-04')
  })
  it('tolerates a leading weekday', () => {
    assert.equal(parseDisplayDate('Saturday, August 9, 2026'), '2026-08-09')
  })
  it('returns null for junk', () => {
    assert.equal(parseDisplayDate(''), null)
    assert.equal(parseDisplayDate('soon'), null)
  })
})

describe('House Three Thirty — parseEventTimes', () => {
  it('combines date + start time into an Eastern ISO instant (EDT → 23:00Z)', () => {
    const { start_at, end_at } = parseEventTimes({ date: 'July 4, 2026', displayTime: '7:00 PM' })
    assert.equal(start_at, '2026-07-04T23:00:00.000Z')
    assert.equal(end_at, null)
  })
  it('captures an end time from a range when it is after the start', () => {
    const { start_at, end_at } = parseEventTimes({ date: 'July 4, 2026', displayTime: '7:00 PM – 9:00 PM' })
    assert.equal(start_at, '2026-07-04T23:00:00.000Z')
    assert.equal(end_at, '2026-07-05T01:00:00.000Z')
  })
  it('returns null start when the date is unparseable', () => {
    assert.equal(parseEventTimes({ date: 'TBD', displayTime: '7:00 PM' }).start_at, null)
  })
})

describe('House Three Thirty — buildSourceId (recurring-series safe)', () => {
  it('disambiguates occurrences that share a urlTitle slug', () => {
    const a = buildSourceId({ urlTitle: 'akron-knits' }, '2026-06-18')
    const b = buildSourceId({ urlTitle: 'akron-knits' }, '2026-06-25')
    assert.equal(a, 'akron-knits-2026-06-18')
    assert.notEqual(a, b)
  })
  it('falls back to a slug of the title when urlTitle is missing', () => {
    assert.equal(buildSourceId({ title: 'Summer Block Party!' }, '2026-08-01'), 'summer-block-party-2026-08-01')
  })
})

describe('House Three Thirty — mapTags', () => {
  it('always carries the venue base tags and slugifies the room location', () => {
    const tags = mapTags({ title: 'Akron Knits', location: 'The Commissary' })
    assert.ok(tags.includes('house-three-thirty'))
    assert.ok(tags.includes('akron'))
    assert.ok(tags.includes('the-commissary'))
    assert.ok(tags.includes('needle-arts'))
  })
})

describe('House Three Thirty — normaliseEvent (full row)', () => {
  const entry = {
    title:       'Akron Knits',
    date:        'August 9, 2026',
    displayTime: '6:00 PM – 8:00 PM',
    cost:        'Free',
    location:    'The Commissary',
    image:       '/uploads/akron-knits.jpg',
    urlTitle:    'akron-knits',
    ticketLink:  'https://www.eventbrite.com/e/akron-knits-123',
  }

  it('maps every field to the events-table shape', () => {
    const row = normaliseEvent(entry)
    assert.equal(row.title, 'Akron Knits')
    assert.equal(row.source, 'house_three_thirty')
    assert.equal(row.source_id, 'akron-knits-2026-08-09')
    assert.equal(row.start_at, '2026-08-09T22:00:00.000Z')
    assert.equal(row.end_at, '2026-08-10T00:00:00.000Z')
    assert.equal(row.price_min, 0)            // "Free" → 0
    assert.equal(row.image_url, 'https://www.housethreethirty.com/uploads/akron-knits.jpg')
    assert.equal(row.ticket_url, 'https://www.eventbrite.com/e/akron-knits-123')
    assert.equal(row.source_url, 'https://www.housethreethirty.com/event/akron-knits')
    assert.equal(row.status, 'published')
  })

  it('returns null when the start time cannot be parsed', () => {
    assert.equal(normaliseEvent({ title: 'X', date: 'someday' }), null)
  })
})
