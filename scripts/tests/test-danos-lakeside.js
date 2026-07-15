/**
 * test-danos-lakeside.js
 *
 * Tests for the Dano's Lakeside Pub scraper. The /events/ page is a hand-kept
 * Divi schedule of <h2> month headers + <li> "day – BAND time-range" lines with
 * NO explicit year. Fixtures below are captured verbatim from the live page
 * (2026 season) and lock in:
 *   - meridiem-on-the-END time ranges ("3:30PM-6:30PM") with START inheritance
 *   - band-name title-casing that preserves acronyms ("(CRB)", "DLP")
 *   - month-header → entry association across an htmlToText render
 *   - year inference anchored to the current Eastern year (+ stale roll-forward)
 *   - trailing "*note" stripping and source_id stability
 *
 * Run:
 *   node --test scripts/tests/test-danos-lakeside.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import { htmlToText, easternToIso } from '../lib/normalize.js'
import {
  extractTimeRange,
  normalizeClock,
  titleCaseBand,
  parseSchedule,
  inferYear,
  easternTodayYmd,
  buildRow,
} from '../scrape-danos-lakeside.js'

// A representative slice of the live markup (MAY + JUNE), including an acronym
// band, a curly apostrophe, and the "*LAST BAND FOR SUMMER" trailing note.
const FIXTURE_HTML = `
<div class="et_pb_text_inner"><h2>MAY</h2>
<ul>
<li>1ST &#8211; TYLER HAWES 6PM-9PM</li>
<li>2ND &#8211; ZIP AND ZIG 3:30PM-6:30PM</li>
<li>10TH &#8211; CLEVELAND&#8217;S ROCK BAR (CRB) 3:30PM-6:30PM</li>
<li>17TH &#8211; BECKY AND JOHN 3:30PM-6:30PM</li>
</ul></div>
<div class="et_pb_text_inner"><h2>JUNE</h2>
<ul>
<li>17TH &#8211; EAST OF SEATTLE 6PM-9PM</li>
<li>18TH &#8211; DLP 3:30PM-6:30PM</li>
<li>20TH &#8211; PRIME TRIO 3:30PM-6:30PM *LAST BAND FOR SUMMER</li>
</ul></div>
<div class="footer"><h3>Dano&#8217;s Bar Hours:</h3>
<ul><li>Mon-Wed: 11:00 AM &#8211; 11:00 PM</li></ul></div>
`

// ════════════════════════════════════════════════════════════════════════════
// normalizeClock
// ════════════════════════════════════════════════════════════════════════════

describe("Dano's: normalizeClock", () => {
  it('builds an easternToIso-friendly string', () => {
    assert.equal(normalizeClock('6', null, 'pm'), '6:00 pm')
    assert.equal(normalizeClock('3', '30', 'pm'), '3:30 pm')
  })
  it('returns null without a meridiem (never guesses am/pm)', () => {
    assert.equal(normalizeClock('6', '00', null), null)
  })
  it('rejects invalid hours', () => {
    assert.equal(normalizeClock('0', '00', 'pm'), null)
    assert.equal(normalizeClock('13', '00', 'pm'), null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// extractTimeRange — meridiem inheritance
// ════════════════════════════════════════════════════════════════════════════

describe("Dano's: extractTimeRange", () => {
  it('parses a both-meridiem range', () => {
    const r = extractTimeRange('3:30PM-6:30PM')
    assert.deepEqual({ start: r.start, end: r.end }, { start: '3:30 pm', end: '6:30 pm' })
  })
  it('parses a bare-hour range', () => {
    const r = extractTimeRange('6PM-9PM')
    assert.deepEqual({ start: r.start, end: r.end }, { start: '6:00 pm', end: '9:00 pm' })
  })
  it('inherits the end meridiem when the start omits it', () => {
    const r = extractTimeRange('6-9PM')
    assert.deepEqual({ start: r.start, end: r.end }, { start: '6:00 pm', end: '9:00 pm' })
  })
  it('returns null when no meridiem-qualified range is present', () => {
    assert.equal(extractTimeRange('TYLER HAWES'), null)
    assert.equal(extractTimeRange('Mon-Wed'), null)
    assert.equal(extractTimeRange('6-9'), null) // no meridiem anywhere
  })
  it('parses a cross-midnight range with distinct meridiems', () => {
    const r = extractTimeRange('10PM-1AM')
    assert.deepEqual({ start: r.start, end: r.end }, { start: '10:00 pm', end: '1:00 am' })
  })
  it('feeds cleanly into easternToIso (6PM EDT in June = 22:00 UTC)', () => {
    const r = extractTimeRange('6PM-9PM')
    assert.equal(easternToIso('2026-06-17', r.start), '2026-06-17T22:00:00.000Z')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// titleCaseBand
// ════════════════════════════════════════════════════════════════════════════

describe("Dano's: titleCaseBand", () => {
  const cases = [
    ['TYLER HAWES', 'Tyler Hawes'],
    ['HOT WINGS', 'Hot Wings'],
    ['ZIP AND ZIG', 'Zip and Zig'],
    ['EAST OF SEATTLE', 'East of Seattle'],
    ['THE SAINTS', 'The Saints'],
    ['TOM SULLY MUSIC', 'Tom Sully Music'],
    ["CLEVELAND'S ROCK BAR (CRB)", "Cleveland's Rock Bar (CRB)"],
    ['DLP', 'DLP'],
    ['STRUM AND STRUMMER', 'Strum and Strummer'],
    ['TRAVELIN JOHNSONS', 'Travelin Johnsons'],
  ]
  for (const [input, expected] of cases) {
    it(`"${input}" → "${expected}"`, () => {
      assert.equal(titleCaseBand(input), expected)
    })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// parseSchedule — over an htmlToText render of the live markup
// ════════════════════════════════════════════════════════════════════════════

describe("Dano's: parseSchedule", () => {
  const records = parseSchedule(htmlToText(FIXTURE_HTML))

  it('parses every music entry and ignores non-schedule content (bar hours)', () => {
    assert.equal(records.length, 7)
    // "Mon-Wed: 11:00 AM – 11:00 PM" must NOT be read as an entry.
    assert.ok(!records.some((r) => /mon-wed/i.test(r.band)))
  })

  it('associates entries with the correct month header', () => {
    const may = records.filter((r) => r.month === 5)
    const june = records.filter((r) => r.month === 6)
    assert.equal(may.length, 4)
    assert.equal(june.length, 3)
    assert.equal(may[0].day, 1)
    assert.equal(june[0].day, 17)
  })

  it('captures band + start/end times, dropping the trailing "*note"', () => {
    const primeTrio = records.find((r) => /prime trio/i.test(r.band))
    assert.ok(primeTrio)
    assert.equal(primeTrio.band, 'PRIME TRIO') // no "*LAST BAND FOR SUMMER"
    assert.equal(primeTrio.startTime, '3:30 pm')
    assert.equal(primeTrio.endTime, '6:30 pm')
  })

  it('decodes the acronym band with its curly apostrophe', () => {
    const crb = records.find((r) => r.month === 5 && r.day === 10)
    assert.ok(crb)
    assert.equal(crb.band, "CLEVELAND'S ROCK BAR (CRB)")
  })

  it('returns [] for empty input', () => {
    assert.deepEqual(parseSchedule(''), [])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// inferYear — Eastern-anchored, stale roll-forward
// ════════════════════════════════════════════════════════════════════════════

describe("Dano's: inferYear", () => {
  it('assigns the current Eastern year to an in-season future date', () => {
    // Viewed 2026-07-14: an August date stays 2026.
    assert.equal(inferYear(8, 15, '2026-07-14'), 2026)
  })

  it('keeps a recently-passed date on the current year (no roll-forward)', () => {
    // May 1 viewed mid-July is ~74 days past — must NOT roll to next year,
    // so it filters as a past event rather than resurfacing a year out.
    assert.equal(inferYear(5, 1, '2026-07-14'), 2026)
  })

  it('rolls a far-stale date forward (>200 days) for a genuine next cycle', () => {
    // A January date viewed in December belongs to next year.
    assert.equal(inferYear(1, 10, '2026-12-20'), 2027)
  })

  it('easternTodayYmd returns a YYYY-MM-DD string', () => {
    assert.match(easternTodayYmd(), /^\d{4}-\d{2}-\d{2}$/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// End-to-end: a parsed record → stable source_id + ISO start
// ════════════════════════════════════════════════════════════════════════════

describe("Dano's: source_id + ISO build", () => {
  it('produces a stable date-based source_id and valid ISO start', () => {
    const records = parseSchedule(htmlToText(FIXTURE_HTML))
    const rec = records.find((r) => r.month === 6 && r.day === 17)
    const year = inferYear(rec.month, rec.day, '2026-07-14')
    const dateStr = `${year}-06-17`
    assert.equal(dateStr, '2026-06-17')
    const startAt = easternToIso(dateStr, rec.startTime)
    assert.ok(startAt.endsWith('Z'))
    assert.ok(!Number.isNaN(new Date(startAt).getTime()))
    assert.equal(`danos-${dateStr}`, 'danos-2026-06-17')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// buildRow — no synthesized midnights (repo mandate)
// ════════════════════════════════════════════════════════════════════════════

describe("Dano's: buildRow midnight guard", () => {
  it('builds a row with the range start time (never a 00:00 fabrication)', () => {
    const rec = { month: 8, day: 7, band: 'TYLER HAWES', startTime: '6:00 pm', endTime: '9:00 pm' }
    const built = buildRow(rec, 1, 1, '2026-08-01')
    assert.ok(built)
    assert.equal(built.row.start_at, '2026-08-07T22:00:00.000Z') // 6PM EDT
    assert.equal(built.row.source_id, 'danos-2026-08-07')
    assert.equal(built.row.price_min, null)
    assert.equal(built.row.price_max, null)
  })

  it('skips a time-less record rather than publishing a synthesized midnight', () => {
    const rec = { month: 8, day: 7, band: 'MYSTERY BAND', startTime: null, endTime: null }
    assert.equal(buildRow(rec, 1, 1, '2026-08-01'), null)
  })

  it('drops a cancelled/postponed show even when it carries a time', () => {
    const canc = { month: 8, day: 7, band: 'TYLER HAWES CANCELED', startTime: '6:00 pm', endTime: '9:00 pm' }
    assert.equal(buildRow(canc, 1, 1, '2026-08-01'), null)
    const pp = { month: 8, day: 7, band: 'PRIME TRIO – POSTPONED', startTime: '6:00 pm', endTime: '9:00 pm' }
    assert.equal(buildRow(pp, 1, 1, '2026-08-01'), null)
    // British spelling ("cancelled") is caught too.
    const uk = { month: 8, day: 7, band: 'HOT WINGS (CANCELLED)', startTime: '6:00 pm', endTime: '9:00 pm' }
    assert.equal(buildRow(uk, 1, 1, '2026-08-01'), null)
  })
})
