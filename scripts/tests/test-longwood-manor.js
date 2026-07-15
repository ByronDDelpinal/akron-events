/**
 * test-longwood-manor.js
 *
 * Pins the pure parsers of the Longwood Manor Historical Society scraper against
 * a fixture captured from longwoodmanor.org/events:
 *   • extractUpcomingSection / extractEventBlocks — scope strictly to the
 *     "Upcoming Events" About section (excluding the "…Meetings" section),
 *     dedupe the desktop/mobile render duplicates, and pull clean prose + image.
 *   • cleanTitle — de-shout short all-caps headlines.
 *   • parseTimeFromProse — meridiem-anchored single times and ranges.
 *   • parseDatesFromProse / parseMonthlyRecurrence / nthWeekdayDate — explicit
 *     dates plus the "last Sunday of the month, April–October" expansion.
 *   • blockToOccurrences / buildEventRow — ET timestamps (no accidental
 *     midnights for timed events), needs_review on the timeless Ladies Tea,
 *     stable source_ids, price left null.
 *
 * Run:  node --test scripts/tests/test-longwood-manor.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  SOURCE_KEY, cleanTitle, to24h, parseTimeFromProse, parseDatesFromProse,
  parseMonthlyRecurrence, nthWeekdayDate, extractUpcomingSection,
  extractEventBlocks, blockToOccurrences, buildEventRow, slugify,
} = await import('../scrape-longwood-manor.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const HTML = readFileSync(join(__dirname, 'fixtures/longwood-manor-events.html'), 'utf8')
const BLOCKS = extractEventBlocks(HTML)
const byTitle = Object.fromEntries(BLOCKS.map((b) => [cleanTitle(b.title), b]))

describe('longwood_manor: source key', () => {
  it('is longwood_manor', () => assert.equal(SOURCE_KEY, 'longwood_manor'))
})

describe('cleanTitle', () => {
  it('de-shouts short all-caps multi-word headlines', () => {
    assert.equal(cleanTitle('OPEN HOUSES'), 'Open Houses')
    assert.equal(cleanTitle('BAND CONCERT'), 'Band Concert')
  })
  it('leaves already-cased titles alone', () => {
    assert.equal(cleanTitle('Ladies Tea'), 'Ladies Tea')
  })
  it('leaves a single all-caps word alone (may be an acronym)', () => {
    assert.equal(cleanTitle('AGM'), 'AGM')
  })
  it('trims surrounding whitespace', () => {
    assert.equal(cleanTitle('  Ladies Tea  '), 'Ladies Tea')
  })
})

describe('to24h', () => {
  it('applies pm/am', () => {
    assert.equal(to24h('7', null, 'PM'), '19:00')
    assert.equal(to24h('12', null, 'AM'), '00:00')
    assert.equal(to24h('12', '30', 'PM'), '12:30')
  })
  it('rejects out-of-range hours', () => {
    assert.equal(to24h('26', null, null), null)
  })
  it('maps the noon/midnight 12-hour edge cases', () => {
    assert.equal(to24h('12', null, 'PM'), '12:00')  // noon
    assert.equal(to24h('12', null, 'AM'), '00:00')   // midnight
  })
})

describe('parseTimeFromProse', () => {
  it('parses a single meridiem time', () => {
    assert.deepEqual(parseTimeFromProse('Thursday, July 15, 2026 at 7PM'), { start: '19:00', end: null })
  })
  it('parses a range and inherits the meridiem across it', () => {
    assert.deepEqual(parseTimeFromProse('from 1-4 PM'), { start: '13:00', end: '16:00' })
  })
  it('parses a two-meridiem range', () => {
    assert.deepEqual(parseTimeFromProse('11 AM - 1 PM'), { start: '11:00', end: '13:00' })
  })
  it('returns null when no meridiem-anchored time is present', () => {
    assert.equal(parseTimeFromProse('Saturday, May 2, 2026'), null)
    assert.equal(parseTimeFromProse('Watch for more information'), null)
    assert.equal(parseTimeFromProse('starts at noon'), null) // word "noon" is not a clock token
  })
  it('handles the noon/midnight 12 AM / 12 PM boundary', () => {
    assert.deepEqual(parseTimeFromProse('doors at 12 PM'), { start: '12:00', end: null })
    assert.deepEqual(parseTimeFromProse('show 12 AM'), { start: '00:00', end: null })
  })
  it('does not read a date or year as a time', () => {
    assert.equal(parseTimeFromProse('April 26, 2026'), null)
  })
})

describe('parseDatesFromProse', () => {
  it('extracts written-out dates, sorted and unique', () => {
    assert.deepEqual(
      parseDatesFromProse('Open on April 26, 2026 and again April 26, 2026; also Thursday, July 15, 2026'),
      ['2026-04-26', '2026-07-15'],
    )
  })
  it('handles ordinal suffixes and no comma', () => {
    assert.deepEqual(parseDatesFromProse('May 2nd 2026'), ['2026-05-02'])
  })
})

describe('nthWeekdayDate', () => {
  it('finds the last Sunday of a month', () => {
    assert.equal(nthWeekdayDate(2026, 4, 0, -1), 26)  // 2026-04-26 is a Sunday
    assert.equal(nthWeekdayDate(2026, 10, 0, -1), 25)
  })
  it('finds an nth weekday', () => {
    assert.equal(nthWeekdayDate(2026, 5, 6, 1), 2)    // first Saturday of May 2026
  })
  it('returns the last day itself when it is the target weekday', () => {
    assert.equal(nthWeekdayDate(2026, 5, 0, -1), 31)  // May 31, 2026 is a Sunday (last day)
  })
  it('computes the last Sunday of February in leap and non-leap years', () => {
    assert.equal(nthWeekdayDate(2024, 2, 0, -1), 25)  // 2024 leap, Feb 29 Thu → last Sun 25
    assert.equal(nthWeekdayDate(2026, 2, 0, -1), 22)  // 2026 non-leap, Feb 28 Sat → last Sun 22
  })
  it('returns null for an nth weekday that does not exist that month', () => {
    assert.equal(nthWeekdayDate(2026, 2, 0, 5), null) // no 5th Sunday in Feb 2026
    assert.equal(nthWeekdayDate(2026, 3, 0, 5), 29)   // but March 2026 has one
  })
})

describe('parseMonthlyRecurrence', () => {
  const text = 'Open houses will start on April 26, 2026 from 1-4 PM ' +
    'Open houses are on the last Sunday of the month from April to October.'
  it('expands the stated last-Sunday series across the month range', () => {
    assert.deepEqual(parseMonthlyRecurrence(text), [
      '2026-04-26', '2026-05-31', '2026-06-28', '2026-07-26',
      '2026-08-30', '2026-09-27', '2026-10-25',
    ])
  })
  it('returns null when there is no recurrence rule', () => {
    assert.equal(parseMonthlyRecurrence('Saturday, May 2, 2026'), null)
  })
  it('bounds the expansion to the stated month range within one year', () => {
    // A full Jan–Dec range yields exactly 12 occurrences — never an unbounded loop.
    const all = parseMonthlyRecurrence('last Sunday of the month from January to December in 2026')
    assert.equal(all.length, 12)
    assert.ok(all.every((d) => d.startsWith('2026-')))
    assert.deepEqual(all, [...all].sort())
  })
  it('degrades to null on a year-crossing range instead of looping', () => {
    // "December to January" (endMonth < startMonth) is not expanded; caller falls
    // back to explicit dates rather than wrapping across the year boundary.
    assert.equal(parseMonthlyRecurrence('last Sunday of the month from December to January 2026'), null)
  })
})

describe('extractUpcomingSection / extractEventBlocks', () => {
  it('finds the Upcoming Events section only', () => {
    const section = extractUpcomingSection(HTML)
    assert.ok(section && /Upcoming Events/i.test(section))
  })
  it('parses exactly the three public events, excluding the Meetings section', () => {
    const titles = BLOCKS.map((b) => cleanTitle(b.title))
    assert.deepEqual(titles, ['Open Houses', 'Ladies Tea', 'Band Concert'])
    assert.ok(!titles.some((t) => /meeting|workday/i.test(t)))
  })
  it('captures clean prose without leaking image/gallery markup', () => {
    for (const b of BLOCKS) assert.ok(!/<|data-aid|data-ux/.test(b.descText), b.descText)
    assert.match(byTitle['Band Concert'].descText, /and enjoy the music\s*$/)
  })
  it('resolves the event photo url (https, not a data: placeholder)', () => {
    assert.match(byTitle['Ladies Tea'].imageUrl, /^https:\/\/img1\.wsimg\.com\//)
  })
})

describe('blockToOccurrences', () => {
  it('expands the recurring open house into 7 dated slots at 1-4 PM', () => {
    const occ = blockToOccurrences(byTitle['Open Houses'])
    assert.equal(occ.length, 7)
    assert.deepEqual(occ[0].time, { start: '13:00', end: '16:00' })
    assert.equal(occ.at(-1).date, '2026-10-25')
  })
  it('keeps a single dated, timeless occurrence for the Ladies Tea', () => {
    const occ = blockToOccurrences(byTitle['Ladies Tea'])
    assert.equal(occ.length, 1)
    assert.equal(occ[0].date, '2026-05-02')
    assert.equal(occ[0].time, null)
  })
  it('categorises the band concert as music', () => {
    assert.equal(blockToOccurrences(byTitle['Band Concert'])[0].category, 'music')
  })
  it('drops a cancelled/postponed block (title or prose)', () => {
    // A real dated block, but marked cancelled/postponed → no occurrences.
    const base = byTitle['Band Concert']
    assert.deepEqual(blockToOccurrences({ ...base, title: 'Band Concert - CANCELED' }), [])
    assert.deepEqual(
      blockToOccurrences({ ...base, descText: `${base.descText} This event has been postponed.` }),
      [],
    )
    // Sanity: the untouched block still yields its occurrence.
    assert.equal(blockToOccurrences(base).length, 1)
  })
})

describe('buildEventRow', () => {
  it('builds a timed ET row for the band concert (no midnight)', () => {
    const occ = blockToOccurrences(byTitle['Band Concert'])[0]
    const row = buildEventRow(occ)
    assert.equal(row.start_at, '2026-07-15T23:00:00.000Z')   // 7 PM EDT
    assert.equal(row.end_at, null)
    assert.equal(row.needs_review, undefined)
    assert.equal(row.source, 'longwood_manor')
    assert.equal(row.source_id, 'longwood_manor-band-concert-2026-07-15')
    assert.equal(row.category, 'music')
    assert.equal(row.price_min, null)
    assert.equal(row.price_max, null)
    assert.equal(row.status, 'published')
  })
  it('flags the timeless Ladies Tea date-only row needs_review (midnight ET)', () => {
    const occ = blockToOccurrences(byTitle['Ladies Tea'])[0]
    const row = buildEventRow(occ)
    assert.equal(row.start_at, '2026-05-02T04:00:00.000Z')   // midnight EDT
    assert.equal(row.needs_review, true)
  })
  it('gives each open-house occurrence a stable, date-keyed source_id', () => {
    const rows = blockToOccurrences(byTitle['Open Houses']).map(buildEventRow)
    const ids = rows.map((r) => r.source_id)
    assert.equal(new Set(ids).size, ids.length)
    assert.ok(ids.includes(`longwood_manor-${slugify('Open Houses')}-2026-07-26`))
    assert.equal(rows[0].end_at, '2026-04-26T20:00:00.000Z')  // 4 PM EDT
  })
})
