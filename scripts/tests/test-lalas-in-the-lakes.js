/**
 * test-lalas-in-the-lakes.js — pure parsers + occurrence assembly for the
 * Lala's in the Lakes (Popmenu) scraper.
 *
 * The fixture is the REAL upcomingCalendarEvents array captured 2026-07-14 from
 * the live Popmenu GraphQL endpoint (POST /graphql, sectionId 2032762) over the
 * range 2026-07-01 → 2027-01-01: the standing weekly "Max" piano night, a past
 * one-off ("Ryan Parkinson Doo-Wop", 07/11) and a future one-off ("John
 * Chapman", 07/18). Edge cases beyond the live data (games/food routing,
 * missing time, series windows) are exercised with inline synthetic events.
 *
 * Run:  node --test scripts/tests/test-lalas-in-the-lakes.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  activeWeekdays, secondsToClock, mapCategory, mapTags,
  recurringOccurrences, buildEvents, apiLocation, SOURCE_KEY,
} = await import('../scrape-lalas-in-the-lakes.js')

const RAW = JSON.parse(
  readFileSync(new URL('./fixtures/lalas-in-the-lakes-events.json', import.meta.url), 'utf8'))

// Tuesday, 2026-07-14, noon-ish ET. Next 12 Fridays for "Max" run
// 2026-07-17 … 2026-10-02; the 07/11 one-off is past, 07/18 is future.
const NOW = new Date('2026-07-14T16:00:00Z')

describe('secondsToClock', () => {
  it('converts seconds-since-midnight to a 24h HH:MM:SS token', () => {
    assert.equal(secondsToClock(64800), '18:00:00') // 6 pm
    assert.equal(secondsToClock(75600), '21:00:00') // 9 pm
    assert.equal(secondsToClock(0), '00:00:00')
    assert.equal(secondsToClock(32700), '09:05:00')
  })
  it('returns null for a missing time so callers can skip rather than pin midnight', () => {
    assert.equal(secondsToClock(null), null)
    assert.equal(secondsToClock(undefined), null)
  })
})

describe('activeWeekdays', () => {
  it('maps the day-of-week booleans to JS weekday indices', () => {
    assert.deepEqual(activeWeekdays(RAW.find((e) => e.slug === 'max-4')), [5]) // Friday
  })
  it('merges multiple active days in Sun→Sat order', () => {
    assert.deepEqual(
      activeWeekdays({ isSunday: true, isWednesday: true, isSaturday: true }),
      [0, 3, 6])
  })
})

describe('mapCategory', () => {
  it('defaults an unplaceable performer name to music (this is a live-music calendar)', () => {
    assert.equal(mapCategory({ name: 'John Chapman', description: 'come support his music' }), 'music')
    assert.equal(mapCategory({ name: 'Max', description: 'Piano' }), 'music')
  })
  it('routes trivia/bingo language to games', () => {
    assert.equal(mapCategory({ name: 'Trivia Night', description: 'weekly quiz' }), 'games')
  })
  it('routes themed-dinner language to food when inference is unplaceable', () => {
    // inference returns 'other' for a bare "… Dinner Night"; the food branch catches it
    assert.equal(mapCategory({ name: 'Themed Dinner Night', description: '' }), 'food')
  })
})

describe('mapTags', () => {
  it('always carries the venue/place tags and leads with live-music for music', () => {
    const tags = mapTags({ description: 'Piano' }, 'music')
    assert.equal(tags[0], 'live-music')
    assert.ok(tags.includes('portage-lakes'))
    assert.ok(tags.includes('lalas'))
    assert.ok(tags.includes('piano'))
  })
  it('adds trivia for games and dining for food, and never duplicates', () => {
    assert.ok(mapTags({}, 'games').includes('trivia'))
    assert.ok(mapTags({}, 'food').includes('dining'))
    assert.equal(new Set(mapTags({ description: 'Piano piano' }, 'music')).size,
      mapTags({ description: 'Piano piano' }, 'music').length)
  })
})

describe('recurringOccurrences', () => {
  const max = RAW.find((e) => e.slug === 'max-4')
  it('projects the next N Fridays for the weekly series', () => {
    const dates = recurringOccurrences(max, NOW, 12)
    assert.equal(dates.length, 12)
    assert.equal(dates[0], '2026-07-17')
    assert.equal(dates[11], '2026-10-02')
    assert.ok(dates.every((d) => new Date(d + 'T12:00:00Z').getUTCDay() === 5))
  })
  it('never emits a date before the series startAt', () => {
    const future = { ...max, startAt: '2026-09-01' }
    assert.ok(recurringOccurrences(future, NOW, 12).every((d) => d >= '2026-09-01'))
  })
  it('never emits a date after the series endAt', () => {
    const ending = { ...max, endAt: '2026-08-15' }
    assert.ok(recurringOccurrences(ending, NOW, 12).every((d) => d <= '2026-08-15'))
  })
})

describe('buildEvents (deterministic now)', () => {
  const events = buildEvents(RAW, NOW)

  it('yields 12 weekly Max occurrences + 1 future one-off, past one-off dropped', () => {
    assert.equal(events.length, 13)
    assert.equal(events.filter((e) => e.kind === 'recurring').length, 12)
    assert.equal(events.filter((e) => e.kind === 'single').length, 1)
    assert.ok(!events.some((e) => /ryan-parkinson/.test(e.sourceId)))
  })
  it('uses date-keyed source_ids that stay stable across runs', () => {
    assert.ok(events.some((e) => e.sourceId === 'max-4-2026-07-17'))
    assert.ok(events.some((e) => e.sourceId === 'john-chapman-2026-07-18'))
  })
  it('starts at 6 pm Eastern and ends at 9 pm (EDT → UTC)', () => {
    const first = events[0]
    assert.equal(first.sourceId, 'max-4-2026-07-17')
    assert.equal(first.startIso, '2026-07-17T22:00:00.000Z')
    assert.equal(first.endIso,   '2026-07-18T01:00:00.000Z')
  })
  it('carries the venue image and events-page ticket url', () => {
    const max = events.find((e) => e.sourceId === 'max-4-2026-07-17')
    assert.match(max.imageUrl, /popmenucloud\.com/)
    assert.equal(max.ticketUrl, 'https://www.lalasinthelakes.com/events')
  })
  it('classifies the whole lineup as music', () => {
    assert.ok(events.every((e) => e.category === 'music'))
  })
  it('skips a timed event that has no start time rather than pinning midnight', () => {
    const noTime = [{ slug: 'no-time', name: 'Mystery Set', startAt: '2026-08-01',
      startTime: null, endTime: null, isRecurring: false, isPastEvent: false }]
    assert.deepEqual(buildEvents(noTime, NOW), [])
  })
  it('drops a server-flagged past one-off even inside the query window', () => {
    const past = RAW.filter((e) => e.slug === 'ryan-parkinson-doo-wop')
    assert.equal(past.length, 1)
    assert.equal(buildEvents(past, NOW).length, 0)
  })
  it('returns [] for an empty feed', () => {
    assert.deepEqual(buildEvents([], NOW), [])
  })
  it('drops a cancelled/postponed one-off (by title marker or status)', () => {
    const byTitle = [{ slug: 'x', name: 'John Chapman (CANCELLED)', startAt: '2026-08-01',
      startTime: 64800, endTime: null, isRecurring: false, isPastEvent: false, status: 'active' }]
    assert.deepEqual(buildEvents(byTitle, NOW), [])
    const byStatus = [{ slug: 'y', name: 'John Chapman', startAt: '2026-08-01',
      startTime: 64800, endTime: null, isRecurring: false, isPastEvent: false, status: 'cancelled' }]
    assert.deepEqual(buildEvents(byStatus, NOW), [])
  })
})

describe('apiLocation (drift guard)', () => {
  it('reads the first enabled location from the feed', () => {
    const loc = apiLocation(RAW)
    assert.equal(loc.streetAddress, '4315 Manchester Road')
    assert.equal(loc.city, 'Akron')
    assert.equal(loc.state, 'OH')
    assert.equal(loc.postalCode, '44319')
  })
  it('returns null when no location is present', () => {
    assert.equal(apiLocation([{ name: 'x', calendarEventSelectedLocations: [] }]), null)
  })
})

describe('module contract', () => {
  it('exports the manifest source key', () => {
    assert.equal(SOURCE_KEY, 'lalas_in_the_lakes')
  })
})
