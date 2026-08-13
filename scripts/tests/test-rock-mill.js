/**
 * test-rock-mill.js — pure parsers + occurrence assembly for the Rock Mill
 * Climbing scraper. The fixture is the REAL "Happening Now" page of
 * rockmillclimbing.com/happening-now (2026-08 Webflow redesign: 3 CMS event
 * cards + the 6-slide "Ongoing at the Mill" slider), captured 2026-08-13 from
 * the raw source (fetch().text(), NOT the rendered DOM).
 *
 * Run:  node --test scripts/tests/test-rock-mill.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  parseItems, parseOngoingCards, parseTimeRange, parseTimesFromText,
  buildItemEvents, buildEvents, cleanTitle, slugify, SOURCE_KEY,
} = await import('../scrape-rock-mill.js')

const HTML = readFileSync(new URL('./fixtures/rock-mill.html', import.meta.url), 'utf8')

// Thursday afternoon ET. The first upcoming Wednesday is 2026-08-19.
const NOW = new Date('2026-08-13T16:00:00Z')

const itemByTitle = (t) => parseItems(HTML).find((i) => i.title.includes(t))
const cardByTitle = (t) => parseOngoingCards(HTML).find((i) => i.title.includes(t))

describe('parseItems (captured fixture, 2026-08 redesign)', () => {
  const items = parseItems(HTML)
  it('parses every Webflow CMS collection item', () => {
    assert.equal(items.length, 3)
  })
  it('joins the two text-size-tiny spans into a "date | time" tagline', () => {
    const tryouts = items[0]
    assert.equal(tryouts.tagline, 'Monday, August 17 | 5:00-7:00 PM')
    assert.equal(tryouts.title, 'Team Rock Mill Tryouts')
    assert.match(tryouts.imageUrl, /^https:\/\/cdn\.prod\.website-files\.com\//)
    assert.equal(tryouts.ctaUrl, 'https://www.rockmillclimbing.com/learn-more/team-rock-mill-tryouts')
  })
  it('keeps an ordinal date suffix in the tagline (Rock The Mill Fest)', () => {
    assert.equal(itemByTitle('Rock The Mill Fest').tagline,
      'Saturday, September 12th | 2:00-8:00 PM')
  })
  it('uses the date alone when a card has no time span (Call for Vendors)', () => {
    assert.equal(itemByTitle('Call for Vendors').tagline, 'Saturday, September 12')
  })
  it('decodes &amp; in extracted CTA links', () => {
    assert.match(itemByTitle('Call for Vendors').ctaUrl, /usp=sharing&ouid=/)
  })
  it('pulls the description out of the .w-richtext block', () => {
    assert.match(itemByTitle('Team Rock Mill Tryouts').description, /interested in competing/)
  })
})

describe('parseOngoingCards (slider region)', () => {
  const cards = parseOngoingCards(HTML)
  it('parses every event26 slide', () => {
    assert.equal(cards.length, 6)
  })
  it('extracts the Co-Work schedule chip, folding its NBSPs', () => {
    const cowork = cardByTitle('Co-Work Wednesdays')
    assert.equal(cowork.tagline, 'Wednesdays | 9 AM - Noon')
    assert.match(cowork.description, /Basecamp on Wednesday mornings/)
  })
  it('drops a "#" CTA so the upsert falls back to the page URL', () => {
    assert.equal(cardByTitle('Co-Work Wednesdays').ctaUrl, null)
  })
  it('resolves a root-relative CTA against the site origin', () => {
    assert.equal(cardByTitle('Weekly Yoga Classes').ctaUrl,
      'https://www.rockmillclimbing.com/yoga-and-fitness')
  })
  it('does not leak CMS category chips ("Youth Climbing") into slide taglines', () => {
    for (const card of cards) {
      assert.notEqual(card.tagline, 'Youth Climbing')
      assert.notEqual(card.tagline, 'Community Event')
    }
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
  it('builds a single dated occurrence with the tagline time (Team Rock Mill Tryouts)', () => {
    const [ev] = buildItemEvents(itemByTitle('Team Rock Mill Tryouts'), NOW)
    assert.equal(ev.sourceId, 'team-rock-mill-tryouts-2026-08-17')
    assert.equal(ev.startIso, '2026-08-17T21:00:00.000Z') // 5 pm EDT
    assert.equal(ev.endIso, '2026-08-17T23:00:00.000Z')   // 7 pm EDT
    assert.equal(ev.category, 'fitness')
    assert.equal(ev.isFamily, true)
  })
  it('parses an ordinal date suffix (Rock The Mill Fest, "September 12th")', () => {
    const [ev] = buildItemEvents(itemByTitle('Rock The Mill Fest'), NOW)
    assert.equal(ev.title, 'Rock The Mill Fest 2026')
    assert.equal(ev.sourceId, 'rock-the-mill-fest-2026-2026-09-12')
    assert.equal(ev.startIso, '2026-09-12T18:00:00.000Z') // 2 pm EDT
    assert.equal(ev.endIso, '2026-09-13T00:00:00.000Z')   // 8 pm EDT
    assert.equal(ev.category, 'festival')
  })
})

describe('buildItemEvents (weekly cards)', () => {
  it('generates OCCURRENCE_COUNT Wednesdays with the stated 9 AM–Noon window', () => {
    const evs = buildItemEvents(cardByTitle('Co-Work Wednesdays'), NOW)
    assert.equal(evs.length, 12)
    assert.equal(evs[0].sourceId, 'co-work-wednesdays-2026-08-19')
    assert.equal(evs[0].startIso, '2026-08-19T13:00:00.000Z') // 9 am EDT
    assert.equal(evs[0].endIso, '2026-08-19T16:00:00.000Z')   // noon EDT
  })
  it('bounds weekly expansion and keeps every occurrence a unique date-keyed id', () => {
    const evs = buildItemEvents(cardByTitle('Co-Work Wednesdays'), NOW)
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
  it('skips the bare recruitment card even though it carries a date (Call for Vendors)', () => {
    assert.deepEqual(buildItemEvents(itemByTitle('Call for Vendors'), NOW), [])
  })
  it('skips a promotional slide with no schedulable time (First Weekend Deals)', () => {
    assert.deepEqual(buildItemEvents(cardByTitle('First Weekend Deals'), NOW), [])
  })
  it('skips a monthly slide with no time (College Night)', () => {
    assert.deepEqual(buildItemEvents(cardByTitle('College Night'), NOW), [])
  })
  it('skips a strong-wrapped chip with no weekday schedule (Weekly Yoga Classes)', () => {
    assert.deepEqual(buildItemEvents(cardByTitle('Weekly Yoga Classes'), NOW), [])
  })
  it('expands the strong-wrapped "Fridays | 9 - 11 AM" chip (Youth Open Climb)', () => {
    const evs = buildItemEvents(cardByTitle('Youth Open Climb'), NOW)
    assert.equal(evs.length, 12)
    assert.equal(evs[0].sourceId, 'youth-open-climb-2026-08-14')
    assert.equal(evs[0].startIso, '2026-08-14T13:00:00.000Z') // 9 am EDT
    assert.equal(evs[0].endIso, '2026-08-14T15:00:00.000Z')   // 11 am EDT
    assert.ok(evs.every((e) => e.isFamily === true))
  })
  it('skips an undated card (Beta Blog)', () => {
    assert.deepEqual(buildItemEvents(cardByTitle('Beta Blog'), NOW), [])
  })
  it('drops a cancelled/postponed item (title or tagline)', () => {
    const base = itemByTitle('Team Rock Mill Tryouts')
    assert.deepEqual(buildItemEvents({ ...base, title: 'Team Rock Mill Tryouts — CANCELED' }, NOW), [])
    assert.deepEqual(buildItemEvents({ ...base, tagline: 'Monday, August 17 | 5:00-7:00 PM (POSTPONED)' }, NOW), [])
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
    assert.ok(ids.includes('team-rock-mill-tryouts-2026-08-17'))
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
