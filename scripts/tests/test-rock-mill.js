/**
 * test-rock-mill.js — pure parsers + occurrence assembly for the Rock Mill
 * Climbing scraper. The fixture is the REAL "Happening Now" Webflow CMS list
 * region of rockmillclimbing.com/happening-now, captured 2026-07-14 from the
 * raw source (fetch().text(), NOT the rendered DOM).
 *
 * Run:  node --test scripts/tests/test-rock-mill.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  parseItems, parseTimeRange, parseTimesFromText, buildItemEvents, buildEvents,
  cleanTitle, slugify, SOURCE_KEY,
} = await import('../scrape-rock-mill.js')

const HTML = readFileSync(new URL('./fixtures/rock-mill.html', import.meta.url), 'utf8')

// Tuesday afternoon ET. The first upcoming Wednesday is 2026-07-15 and the
// first upcoming Friday is 2026-07-17.
const NOW = new Date('2026-07-14T16:00:00Z')

const itemByTitle = (t) => parseItems(HTML).find((i) => i.title.includes(t))

describe('parseItems (captured fixture)', () => {
  const items = parseItems(HTML)
  it('parses every Webflow collection item', () => {
    assert.equal(items.length, 8)
  })
  it('extracts tagline, title, image and the real (non-#) CTA link', () => {
    const boulder = items[0]
    assert.equal(boulder.tagline, 'Saturday, July 18 | 5-8 PM')
    assert.equal(boulder.title, 'Bouldering Sucks')
    assert.match(boulder.imageUrl, /^https:\/\/cdn\.prod\.website-files\.com\/.*Bouldering/)
    assert.equal(boulder.ctaUrl, 'https://www.rockmillclimbing.com/learn-more/bouldering-sucks')
  })
  it('decodes &amp; in taglines', () => {
    assert.equal(itemByTitle('Youth Climbing Club').tagline,
      'Mondays & Thursdays | September - November 2026')
  })
  it('pulls the description out of the .w-richtext block', () => {
    assert.match(itemByTitle('Bouldering Sucks').description, /annual rope competition/)
  })
})

describe('parseTimeRange', () => {
  it('inherits the end meridiem for a bare start ("5-8 PM")', () => {
    assert.deepEqual(parseTimeRange('5-8 PM'), { start: '5:00 pm', end: '8:00 pm' })
  })
  it('resolves "Noon" to 12:00 pm ("9:00 AM - Noon")', () => {
    assert.deepEqual(parseTimeRange('9:00 AM - Noon'), { start: '9:00 am', end: '12:00 pm' })
  })
  it('propagates a start meridiem forward ("9:00 - 11:00 AM")', () => {
    assert.deepEqual(parseTimeRange('9:00 - 11:00 AM'), { start: '9:00 am', end: '11:00 am' })
  })
  it('treats a start hour later than a PM end as morning ("11:30-5 PM")', () => {
    assert.deepEqual(parseTimeRange('11:30-5 PM'), { start: '11:30 am', end: '5:00 pm' })
  })
  it('morning-heuristic boundary: keeps an in-order start as PM ("1-5 PM")', () => {
    assert.deepEqual(parseTimeRange('1-5 PM'), { start: '1:00 pm', end: '5:00 pm' })
  })
  it('morning-heuristic boundary: evening range stays PM ("9-11 PM")', () => {
    assert.deepEqual(parseTimeRange('9-11 PM'), { start: '9:00 pm', end: '11:00 pm' })
  })
  it('morning-heuristic boundary: flips a late-morning start ("10-2 PM")', () => {
    assert.deepEqual(parseTimeRange('10-2 PM'), { start: '10:00 am', end: '2:00 pm' })
  })
  it('morning-heuristic boundary: noon start stays PM ("12-5 PM")', () => {
    assert.deepEqual(parseTimeRange('12-5 PM'), { start: '12:00 pm', end: '5:00 pm' })
  })
  it('morning-heuristic boundary: morning range ending at noon ("9-12 PM")', () => {
    assert.deepEqual(parseTimeRange('9-12 PM'), { start: '9:00 am', end: '12:00 pm' })
  })
  it('morning-heuristic boundary: 11 to noon is morning ("11-12 PM")', () => {
    assert.deepEqual(parseTimeRange('11-12 PM'), { start: '11:00 am', end: '12:00 pm' })
  })
  it('returns null for a month range with no clock time', () => {
    assert.equal(parseTimeRange('September - November 2026'), null)
  })
  it('parses a lone time as a start with a null end', () => {
    assert.deepEqual(parseTimeRange('7 pm'), { start: '7:00 pm', end: null })
  })
})

describe('parseTimesFromText (description fallback)', () => {
  it('spans the widest window across every range mentioned', () => {
    assert.deepEqual(
      parseTimesFromText('Vendors w/ tables: 11:30-5 PM  Live musicians: 5-8 PM'),
      { start: '11:30 am', end: '8:00 pm' })
  })
  it('returns null when the text states no time', () => {
    assert.equal(parseTimesFromText('Come hang out and climb with other college students.'), null)
  })
})

describe('cleanTitle / slugify', () => {
  it('strips a "Call for Vendors | " recruitment prefix', () => {
    assert.equal(cleanTitle('Call for Vendors | Rock the Mill Fest 2026'), 'Rock the Mill Fest 2026')
  })
  it('leaves an ordinary title untouched', () => {
    assert.equal(cleanTitle('Bouldering Sucks'), 'Bouldering Sucks')
  })
  it('slugifies for stable source_ids', () => {
    assert.equal(slugify('Co-Work Wednesdays'), 'co-work-wednesdays')
  })
})

describe('buildItemEvents (one-time cards)', () => {
  it('builds a single dated occurrence with the tagline time (Bouldering Sucks)', () => {
    const [ev] = buildItemEvents(itemByTitle('Bouldering Sucks'), NOW)
    assert.equal(ev.sourceId, 'bouldering-sucks-2026-07-18')
    assert.equal(ev.startIso, '2026-07-18T21:00:00.000Z') // 5 pm EDT
    assert.equal(ev.endIso, '2026-07-19T00:00:00.000Z')   // 8 pm EDT
    assert.equal(ev.category, 'fitness')
    assert.equal(ev.isFamily, false)
  })
  it('falls back to a description time window and cleans the title (Rock the Mill Fest)', () => {
    const [ev] = buildItemEvents(itemByTitle('Rock the Mill Fest'), NOW)
    assert.equal(ev.title, 'Rock the Mill Fest 2026')
    assert.equal(ev.sourceId, 'rock-the-mill-fest-2026-2026-09-12')
    assert.equal(ev.startIso, '2026-09-12T15:30:00.000Z') // 11:30 am EDT
    assert.equal(ev.endIso, '2026-09-13T00:00:00.000Z')   // 8 pm EDT
    assert.equal(ev.category, 'festival')
  })
})

describe('buildItemEvents (weekly cards)', () => {
  it('generates OCCURRENCE_COUNT Wednesdays with the stated 9 AM–Noon window', () => {
    const evs = buildItemEvents(itemByTitle('Co-Work Wednesdays'), NOW)
    assert.equal(evs.length, 12)
    assert.equal(evs[0].sourceId, 'co-work-wednesdays-2026-07-15')
    assert.equal(evs[0].startIso, '2026-07-15T13:00:00.000Z') // 9 am EDT
    assert.equal(evs[0].endIso, '2026-07-15T16:00:00.000Z')   // noon EDT
  })
  it('flags the youth open climb as family and generates weekly Fridays', () => {
    const evs = buildItemEvents(itemByTitle('Youth Open Climb'), NOW)
    assert.equal(evs.length, 12)
    assert.equal(evs[0].sourceId, 'youth-open-climb-2026-07-17')
    assert.ok(evs.every((e) => e.isFamily === true))
  })
  it('bounds weekly expansion and keeps every occurrence a unique date-keyed id', () => {
    const evs = buildItemEvents(itemByTitle('Co-Work Wednesdays'), NOW)
    // One weekday → exactly OCCURRENCE_COUNT (12), never unbounded.
    assert.equal(evs.length, 12)
    const ids = evs.map((e) => e.sourceId)
    assert.equal(new Set(ids).size, ids.length) // all distinct
    assert.ok(ids.every((id) => /^co-work-wednesdays-\d{4}-\d{2}-\d{2}$/.test(id)))
    // Finite horizon: last occurrence is within ~12 weeks of the first.
    const spanDays = (Date.parse(evs[11].startIso) - Date.parse(evs[0].startIso)) / 86400000
    assert.equal(Math.round(spanDays), 77) // 11 * 7
  })
})

describe('buildItemEvents (skips)', () => {
  it('skips a promotional card with no schedulable time (First Weekend Deals)', () => {
    assert.deepEqual(buildItemEvents(itemByTitle('First Weekend Deals'), NOW), [])
  })
  it('skips a monthly card with no time (College Night)', () => {
    assert.deepEqual(buildItemEvents(itemByTitle('College Night'), NOW), [])
  })
  it('skips a weekly series listed without a time (Youth Climbing Club)', () => {
    assert.deepEqual(buildItemEvents(itemByTitle('Youth Climbing Club'), NOW), [])
  })
  it('skips an undated card (Beta Blog)', () => {
    assert.deepEqual(buildItemEvents(itemByTitle('Beta Blog'), NOW), [])
  })
  it('drops a cancelled/postponed item (title or tagline)', () => {
    const base = itemByTitle('Bouldering Sucks')
    assert.deepEqual(buildItemEvents({ ...base, title: 'Bouldering Sucks — CANCELED' }, NOW), [])
    assert.deepEqual(buildItemEvents({ ...base, tagline: 'Saturday, July 18 | 5-8 PM (POSTPONED)' }, NOW), [])
    // Sanity: the unmodified card still produces its occurrence.
    assert.equal(buildItemEvents(base, NOW).length, 1)
  })
})

describe('buildEvents (full run)', () => {
  const events = buildEvents(HTML, NOW)
  it('yields 2 one-time + 24 weekly occurrences, sorted by start', () => {
    assert.equal(events.length, 26)
    const sorted = [...events].sort((a, b) => a.startIso.localeCompare(b.startIso))
    assert.deepEqual(events.map((e) => e.startIso), sorted.map((e) => e.startIso))
  })
  it('includes the two dated one-time events', () => {
    const ids = events.map((e) => e.sourceId)
    assert.ok(ids.includes('bouldering-sucks-2026-07-18'))
    assert.ok(ids.includes('rock-the-mill-fest-2026-2026-09-12'))
  })
  it('never emits a midnight-ET start (no dropped times)', () => {
    assert.ok(events.every((e) => !/T0[45]:00:00\.000Z$/.test(e.startIso)))
  })
})

describe('module contract', () => {
  it('exports the manifest source key', () => {
    assert.equal(SOURCE_KEY, 'rock_mill')
  })
})
