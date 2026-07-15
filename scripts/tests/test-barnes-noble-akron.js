/**
 * test-barnes-noble-akron.js — Barnes & Noble (Akron, store #2902) parsing.
 *
 * Run:
 *   node --test scripts/tests/test-barnes-noble-akron.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// normalize.js builds a Supabase client at import time — give it dummy creds.
process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  mapEvent,
  filterStoreEvents,
  buildTags,
  isStorytime,
  eventUrl,
  easternTodayStr,
  addDaysStr,
  SOURCE,
} = await import('../scrape-barnes-noble-akron.js')

import {
  STORYTIME,
  BOOK_CLUB,
  AUTHOR_SIGNING,
  NO_TIME24,
  OTHER_STORE,
  PAST_EVENT,
  ALL_CONTENT,
} from './fixtures/barnes-noble-akron-events.js'

const TODAY = '2026-07-14' // anchor the fixture window deterministically

describe('B&N — date helpers', () => {
  it('easternTodayStr returns a YYYY-MM-DD string', () => {
    assert.match(easternTodayStr(), /^\d{4}-\d{2}-\d{2}$/)
  })
  it('easternTodayStr resolves a known UTC instant to the ET calendar day', () => {
    // 2026-07-15 02:00Z is still 2026-07-14 (22:00 EDT).
    assert.equal(easternTodayStr(new Date('2026-07-15T02:00:00Z')), '2026-07-14')
  })
  it('addDaysStr adds and subtracts days, crossing month boundaries', () => {
    assert.equal(addDaysStr('2026-07-14', -1), '2026-07-13')
    assert.equal(addDaysStr('2026-07-14', 180), '2027-01-10')
    assert.equal(addDaysStr('2026-07-31', 1), '2026-08-01')
  })
})

describe('B&N — mapEvent core fields', () => {
  it('maps a book club to a learning event with ET-correct start time', () => {
    const row = mapEvent(BOOK_CLUB)
    assert.equal(row.title, 'B&N Book Club')
    assert.equal(row.category, 'learning')
    // 7:00 PM EDT (UTC-4) → 23:00Z
    assert.equal(row.start_at, '2026-07-14T23:00:00.000Z')
    assert.equal(row.end_at, null)
    assert.equal(row.source, SOURCE)
    assert.equal(row.source_id, '9780062157887-38')
    assert.equal(row.status, 'published')
  })

  it('parses a 10 AM storytime and flags it family', () => {
    const row = mapEvent(STORYTIME)
    assert.equal(row.start_at, '2026-07-15T14:00:00.000Z') // 10:00 EDT → 14:00Z
    assert.equal(row.is_family, true)
  })

  it('leaves is_family undefined for non-storytime events', () => {
    assert.equal(mapEvent(BOOK_CLUB).is_family, undefined)
    assert.equal(mapEvent(AUTHOR_SIGNING).is_family, undefined)
  })

  it('falls back to the 12-hour `time` when time24 is missing', () => {
    const row = mapEvent(NO_TIME24)
    // 7:00 PM EDT → 23:00Z (no accidental midnight)
    assert.equal(row.start_at, '2026-07-15T23:00:00.000Z')
  })

  it('never assumes free (price stays null)', () => {
    const row = mapEvent(AUTHOR_SIGNING)
    assert.equal(row.price_min, null)
    assert.equal(row.price_max, null)
  })

  it('leaves image_url null (generic placeholders only)', () => {
    assert.equal(mapEvent(STORYTIME).image_url, null)
  })

  it('builds a stable public detail URL as ticket_url', () => {
    assert.equal(
      mapEvent(BOOK_CLUB).ticket_url,
      'https://stores.barnesandnoble.com/event/9780062157887-38'
    )
  })

  it('strips HTML/entities from the description', () => {
    const row = mapEvent({ ...BOOK_CLUB, descriptionText: 'Fiction &amp; friends <b>tonight</b>' })
    assert.equal(row.description, 'Fiction & friends tonight')
  })

  it('returns null when title is blank', () => {
    assert.equal(mapEvent({ ...BOOK_CLUB, name: '' }), null)
  })
})

describe('B&N — source_id stability', () => {
  it('gives distinct recurring occurrences distinct source_ids', () => {
    // Same series, different dates → different eventIds → no dedupe collision.
    assert.notEqual(mapEvent(BOOK_CLUB).source_id, mapEvent(PAST_EVENT).source_id)
  })
})

describe('B&N — tags & storytime detection', () => {
  it('tags every event books + its type', () => {
    assert.deepEqual(buildTags(BOOK_CLUB), ['books', 'book club'])
  })
  it('adds storytime + kids tags for storytimes', () => {
    const tags = buildTags(STORYTIME)
    assert.ok(tags.includes('storytime'))
    assert.ok(tags.includes('kids'))
    assert.ok(tags.includes('books'))
  })
  it('detects storytime via typeCode or the isStoryTime flag', () => {
    assert.equal(isStorytime(STORYTIME), true)
    assert.equal(isStorytime(BOOK_CLUB), false)
    assert.equal(isStorytime({ types: [{ typeCode: 'ST', text: 'Storytime' }] }), true)
  })
})

describe('B&N — eventUrl', () => {
  it('URL-encodes the event id', () => {
    assert.equal(eventUrl('a b/c'), 'https://stores.barnesandnoble.com/event/a%20b%2Fc')
  })
})

describe('B&N — filterStoreEvents', () => {
  it('keeps only current Akron-store events', () => {
    const kept = filterStoreEvents(ALL_CONTENT, { todayStr: TODAY })
    const ids = kept.map(e => e.eventId).sort()
    assert.deepEqual(ids, [
      AUTHOR_SIGNING.eventId, BOOK_CLUB.eventId, NO_TIME24.eventId, STORYTIME.eventId,
    ].sort())
  })

  it('drops events from other stores', () => {
    const kept = filterStoreEvents(ALL_CONTENT, { todayStr: TODAY })
    assert.ok(!kept.some(e => e.eventId === OTHER_STORE.eventId))
    assert.ok(kept.every(e => e.storeId === 2902))
  })

  it('drops events that ended before yesterday', () => {
    const kept = filterStoreEvents(ALL_CONTENT, { todayStr: TODAY })
    assert.ok(!kept.some(e => e.eventId === PAST_EVENT.eventId))
  })

  it('keeps a same-day event', () => {
    const kept = filterStoreEvents([BOOK_CLUB], { todayStr: BOOK_CLUB.date })
    assert.equal(kept.length, 1)
  })

  it('enforces the horizon window', () => {
    const kept = filterStoreEvents([AUTHOR_SIGNING], { todayStr: TODAY, horizonDays: 3 })
    assert.equal(kept.length, 0) // 7/19 is beyond today+3
  })

  it('drops national and virtual (store-agnostic) listings', () => {
    const national = { ...BOOK_CLUB, isNationalEvent: true }
    const virtual  = { ...STORYTIME, isVirtualEvent: true }
    const kept = filterStoreEvents([national, virtual], { todayStr: TODAY })
    assert.equal(kept.length, 0)
  })
})
