/**
 * test-wine-mill.js — pure helpers for The Wine Mill Tribe scraper.
 * Fixtures reflect the REAL feed shape captured 2026-07-08 (all-day entries,
 * drink-special vs music categories, no venue objects).
 *
 * Run:  node --test scripts/tests/test-wine-mill.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { includeEvent, parseCategory, buildSourceId, isAllDayEvent, buildRow, SOURCE_KEY } =
  await import('../scrape-wine-mill.js')

// Captured 2026-07-08 (trimmed)
const WINE_WEDNESDAY = {
  id: 9001, title: 'House Wine Wednesday!', all_day: true,
  start_date: '2026-07-08 00:00:00',
  categories: [{ name: 'Drink Special', slug: 'drink-special' }],
}
const LIVE_MUSIC = {
  id: 9002, title: 'Live Music &#8211; Weniger &#038; Simon', all_day: true,
  start_date: '2026-07-10 00:00:00',
  categories: [{ name: 'Music', slug: 'music' }],
}

// Verbatim feed rows captured live 2026-07-27. The `timezone: 'UTC-4'` +
// 03:00Z `utc_start_date` pairing is the bug: the site emits a fixed -4 offset
// for every all-day row, so trusting utc_start_date renders the event on the
// PREVIOUS day at 11pm ET.
const ALLDAY_MUSIC_LIVE = {
  id: 6537, title: 'Live Music &#8211; Weniger &#038; Simon', all_day: true,
  start_date: '2026-07-31 00:00:00', end_date: '2026-07-31 23:59:59',
  utc_start_date: '2026-07-31 03:00:00', utc_end_date: '2026-08-01 02:59:59',
  timezone: 'UTC-4',
  categories: [{ name: 'Music', slug: 'music' }],
}
const ALLDAY_TRIVIA_EST = {
  id: 6364, title: 'Trivia Night!', all_day: true,
  start_date: '2026-11-04 00:00:00', end_date: '2026-11-04 23:59:59',
  utc_start_date: '2026-11-04 04:00:00', utc_end_date: '2026-11-05 03:59:59',
  timezone: 'UTC-4',
  categories: [{ name: 'Event', slug: 'event' }],
}
const TIMED_TRIVIA_LIVE = {
  id: 6366, title: 'Trivia Night!', all_day: false,
  start_date: '2026-12-02 08:00:00', end_date: '2026-12-02 17:00:00',
  utc_start_date: '2026-12-02 12:00:00', utc_end_date: '2026-12-02 21:00:00',
  timezone: 'UTC-4',
  categories: [{ name: 'Event', slug: 'event' }],
}

describe('includeEvent', () => {
  it('skips drink specials — pricing promos are not events', () => {
    assert.equal(includeEvent(WINE_WEDNESDAY), false)
  })
  it('keeps live music', () => {
    assert.equal(includeEvent(LIVE_MUSIC), true)
  })
})

describe('parseCategory', () => {
  it('music category maps to music', () => {
    assert.equal(parseCategory(LIVE_MUSIC.categories), 'music')
  })
  it('unknown categories defer to inference', () => {
    assert.equal(parseCategory([]), null)
  })
})

describe('buildSourceId', () => {
  it('is per-occurrence (weekly series repeat ids)', () => {
    assert.equal(buildSourceId(LIVE_MUSIC), '9002-2026-07-10')
    assert.notEqual(buildSourceId(LIVE_MUSIC), buildSourceId({ ...LIVE_MUSIC, start_date: '2026-07-17 00:00:00' }))
  })
})

describe('isAllDayEvent', () => {
  it('keys off the feed’s own all_day flag', () => {
    assert.equal(isAllDayEvent(ALLDAY_MUSIC_LIVE), true)
    assert.equal(isAllDayEvent(TIMED_TRIVIA_LIVE), false)
    assert.equal(isAllDayEvent({}), false)
  })
})

describe('buildRow: all-day rows never publish a fabricated time', () => {
  it('anchors the EDT all-day row to local midnight ET, not the feed’s 03:00Z', () => {
    const row = buildRow(ALLDAY_MUSIC_LIVE)
    // 04:00Z == 2026-07-31 00:00 EDT. 03:00Z would be Jul 30 at 11pm ET — the bug.
    assert.equal(row.start_at, '2026-07-31T04:00:00.000Z')
    assert.notEqual(row.start_at, '2026-07-31T03:00:00.000Z')
    assert.equal(row.start_at.slice(0, 10), '2026-07-31')
    assert.equal(row.needs_review, true)
    assert.equal(row.end_at, null)
    assert.equal(row.status, 'published')
    assert.equal(row.featured, false)
  })

  it('anchors the EST all-day row correctly too (feed says 04:00Z, real is 05:00Z)', () => {
    const row = buildRow(ALLDAY_TRIVIA_EST)
    assert.equal(row.start_at, '2026-11-04T05:00:00.000Z')
    assert.notEqual(row.start_at, '2026-11-04T04:00:00.000Z')
    assert.equal(row.needs_review, true)
  })

  it('keeps a timed row’s real clock time, unflagged, anchored to ET not the feed’s UTC', () => {
    const row = buildRow(TIMED_TRIVIA_LIVE)
    // 08:00 local on Dec 2 is EST, so 13:00Z. The feed's own 12:00Z reflects
    // its hardcoded "UTC-4" and is an hour early.
    assert.equal(row.start_at, '2026-12-02T13:00:00.000Z')
    assert.notEqual(row.start_at, '2026-12-02T12:00:00Z')
    assert.equal(row.end_at, '2026-12-02T22:00:00.000Z')
    assert.equal(row.needs_review, undefined)
  })

  it('never writes needs_review: false — normalize.js keeps its own default', () => {
    assert.equal(Object.hasOwn(buildRow(TIMED_TRIVIA_LIVE), 'needs_review'), true)
    assert.equal(buildRow(TIMED_TRIVIA_LIVE).needs_review, undefined)
  })

  it('carries title, source key and per-occurrence source_id', () => {
    const row = buildRow(ALLDAY_MUSIC_LIVE)
    assert.equal(row.title, 'Live Music – Weniger & Simon')
    assert.equal(row.source, 'wine_mill')
    assert.equal(row.source_id, '6537-2026-07-31')
  })
})

describe('module contract', () => {
  it('exports the manifest source key', () => {
    assert.equal(SOURCE_KEY, 'wine_mill')
  })
})
