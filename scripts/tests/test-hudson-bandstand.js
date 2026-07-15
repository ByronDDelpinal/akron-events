/**
 * test-hudson-bandstand.js
 *
 * Tests for the Hudson Bandstand scraper. The schedule is a hand-maintained
 * WordPress <ul> of "<Weekday>, <Month> <Day> | <Band> – <description>" <li>
 * lines with the year only in the section heading and one universal start time
 * stated in prose. Fixtures below are captured verbatim from the live page
 * (2026 season) and lock in:
 *   - season-year extraction from the "Hudson Bandstand YYYY Schedule" heading
 *   - the stated series start time ("All concerts begin at 6:30 p.m.")
 *   - band/description splitting on the first en-dash (incl. no-dash entries)
 *   - the "|" filter rejecting prose that merely mentions a weekday
 *   - "Sponsored by …" nested bullets never parsing as concerts
 *   - source_id stability and a valid Eastern ISO start
 *
 * Run:
 *   node --test scripts/tests/test-hudson-bandstand.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import { htmlToText, easternToIso } from '../lib/normalize.js'
import {
  parseSeasonYear,
  parseSeriesDefaultTime,
  splitBandDescription,
  parseSchedule,
  buildRow,
} from '../scrape-hudson-bandstand.js'

// A representative slice of the live markup: the heading + intro prose (which
// mentions weekdays but has no "|"), a dash entry with a curly apostrophe and
// "&amp;", a no-dash entry, and a nested "Sponsored by" bullet.
const FIXTURE_HTML = `
<h2>Hudson Bandstand 2026 Schedule</h2>
<h5><strong>All concerts begin at 6:30 p.m</strong>. and are located on the Hudson Gazebo Green in downtown Hudson, Ohio.</h5>
<h5>The summer series kicks off with a special Monday Memorial Day concert on Monday, May 25th at 6:30 p.m., then continues throughout the summer on <strong>Sundays at 6:30 p.m.</strong></h5>
<ul>
<li><strong>Monday, May 25 |  Hudson High School Jazz I &amp; II &#8211; </strong>A Memorial Day tradition, our hometown youth perform favorite jazz standards.
<ul>
<li><em><strong>Sponsored by Hudson Community Foundation</strong></em></li>
</ul>
</li>
<li><strong>Sunday, July 19  |  Blue Lunch &#8211; </strong>Performing blues, soul, New Orleans rhythm and jazz.
<ul>
<li><strong>Sponsored by: Bill and Betty Sepe</strong></li>
</ul>
</li>
<li><strong>Sunday, August 9  |  80&#8217;s Vinyl Arcade  &#8211; </strong>Blend of 70&#8217;s, 80&#8217;s, 90&#8217;s music heard on TV.
<ul>
<li><em><strong>Sponsored by: Heritage of Hudson</strong></em></li>
</ul>
</li>
<li><strong>Sunday, August 16  |  Western Reserve Community Band </strong>
<ul>
<li><em><strong>Sponsored by: The Tobin Family Fund</strong></em></li>
</ul>
</li>
</ul>
`

const TEXT = htmlToText(FIXTURE_HTML)

// ════════════════════════════════════════════════════════════════════════════
// parseSeasonYear
// ════════════════════════════════════════════════════════════════════════════

describe('Hudson Bandstand: parseSeasonYear', () => {
  it('reads the year from the schedule heading', () => {
    assert.equal(parseSeasonYear(TEXT), 2026)
  })
  it('returns null when no heading year is present', () => {
    assert.equal(parseSeasonYear('Some other page with 2026 in it'), null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// parseSeriesDefaultTime
// ════════════════════════════════════════════════════════════════════════════

describe('Hudson Bandstand: parseSeriesDefaultTime', () => {
  it('parses the stated universal start time', () => {
    assert.equal(parseSeriesDefaultTime(TEXT), '6:30 pm')
  })
  it('handles "p.m." with dots and no minutes', () => {
    assert.equal(parseSeriesDefaultTime('All concerts begin at 7 p.m. sharp'), '7:00 pm')
  })
  it('returns null when the sentence is absent (never fabricates a time)', () => {
    assert.equal(parseSeriesDefaultTime('No time stated here'), null)
  })
  it('returns null when the meridiem is missing (fail loud, no midnight)', () => {
    // Without am/pm the time is ambiguous; the caller must skip, not guess.
    assert.equal(parseSeriesDefaultTime('All concerts begin at 6:30 this summer'), null)
  })
  it('handles a stated noon start (12 p.m. = 16:00 UTC in EDT, not midnight)', () => {
    const t = parseSeriesDefaultTime('All concerts begin at 12 p.m. on the green')
    assert.equal(t, '12:00 pm')
    assert.equal(easternToIso('2026-07-19', t), '2026-07-19T16:00:00.000Z')
  })
  it('feeds cleanly into easternToIso (6:30 PM EDT in July = 22:30 UTC)', () => {
    assert.equal(easternToIso('2026-07-19', parseSeriesDefaultTime(TEXT)), '2026-07-19T22:30:00.000Z')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// splitBandDescription
// ════════════════════════════════════════════════════════════════════════════

describe('Hudson Bandstand: splitBandDescription', () => {
  it('splits on the first en-dash', () => {
    assert.deepEqual(
      splitBandDescription('Blue Lunch – Performing blues, soul, New Orleans rhythm and jazz.'),
      { band: 'Blue Lunch', description: 'Performing blues, soul, New Orleans rhythm and jazz.' },
    )
  })
  it('keeps a later en-dash inside the description', () => {
    const r = splitBandDescription('Clocktower – Rock music from the 1960’s – 2000’s.')
    assert.equal(r.band, 'Clocktower')
    assert.ok(r.description.includes('2000'))
  })
  it('treats a no-dash entry as band-only', () => {
    assert.deepEqual(
      splitBandDescription('Western Reserve Community Band'),
      { band: 'Western Reserve Community Band', description: '' },
    )
  })
  it('preserves an ampersand-decoded band name', () => {
    assert.equal(splitBandDescription('Hudson High School Jazz I & II – A tradition.').band,
      'Hudson High School Jazz I & II')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// parseSchedule — over an htmlToText render of the live markup
// ════════════════════════════════════════════════════════════════════════════

describe('Hudson Bandstand: parseSchedule', () => {
  const records = parseSchedule(TEXT)

  it('parses every concert and ignores prose + sponsor bullets', () => {
    assert.equal(records.length, 4)
    // The intro sentence mentions "Monday, May 25th" but has no "|".
    assert.ok(!records.some((r) => /kicks off/i.test(r.band)))
    // "Sponsored by …" bullets must never parse as concerts.
    assert.ok(!records.some((r) => /sponsored/i.test(r.band)))
  })

  it('maps month names to numbers and captures the day', () => {
    const aug9 = records.find((r) => r.month === 8 && r.day === 9)
    assert.ok(aug9)
    assert.equal(aug9.band, "80's Vinyl Arcade")
  })

  it('decodes an ampersand band name and its description', () => {
    const jazz = records.find((r) => r.month === 5 && r.day === 25)
    assert.ok(jazz)
    assert.equal(jazz.band, 'Hudson High School Jazz I & II')
    assert.ok(/Memorial Day/.test(jazz.description))
  })

  it('captures a no-dash entry with an empty description', () => {
    const wr = records.find((r) => r.day === 16)
    assert.ok(wr)
    assert.equal(wr.band, 'Western Reserve Community Band')
    assert.equal(wr.description, '')
  })

  it('returns [] for empty input', () => {
    assert.deepEqual(parseSchedule(''), [])
  })

  it('rejects a malformed month name and an out-of-range day', () => {
    // Bad month word maps to no MONTHS entry; day 45 is out of 1–31 range.
    assert.deepEqual(parseSchedule('• Sunday, Funday 12 | Some Band – x'), [])
    assert.deepEqual(parseSchedule('• Sunday, August 45 | Some Band – x'), [])
  })

  it('keeps the band split on the FIRST dash when a rain-relocation and a second time appear in the description', () => {
    // Verbatim shape of the live June 14 entry: the description carries a rain
    // move ("Hudson Middle School") and a restated "6:30 PM". The band must
    // still be everything before the first en-dash, and the whole relocation
    // blob stays in the description (venue is always stored as the Green).
    const line =
      '• Sunday, June 14 | Western Reserve Big Band – A community favorite. ' +
      'Due to weather forecast, concert will be at Hudson Middle School, 83 N. ' +
      'Oviatt Street. Same time 6:30 PM'
    const recs = parseSchedule(line)
    assert.equal(recs.length, 1)
    assert.equal(recs[0].band, 'Western Reserve Big Band')
    assert.equal(recs[0].month, 6)
    assert.equal(recs[0].day, 14)
    assert.ok(/Hudson Middle School/.test(recs[0].description))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// End-to-end: parsed record → stable source_id + ISO start
// ════════════════════════════════════════════════════════════════════════════

describe('Hudson Bandstand: source_id + ISO build', () => {
  it('produces a stable date-based source_id and valid ISO start', () => {
    const records = parseSchedule(TEXT)
    const rec = records.find((r) => r.month === 7 && r.day === 19)
    const dateStr = `2026-07-${String(rec.day).padStart(2, '0')}`
    assert.equal(dateStr, '2026-07-19')
    const startAt = easternToIso(dateStr, parseSeriesDefaultTime(TEXT))
    assert.ok(startAt.endsWith('Z'))
    assert.ok(!Number.isNaN(new Date(startAt).getTime()))
    assert.equal(`hudson-bandstand-${dateStr}`, 'hudson-bandstand-2026-07-19')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// buildRow — cancelled/postponed guard
// ════════════════════════════════════════════════════════════════════════════

describe('Hudson Bandstand: cancelled/postponed guard', () => {
  it('builds a normal concert row', () => {
    const rec = { month: 7, day: 19, band: 'Blue Lunch', description: 'Performing blues.' }
    const built = buildRow(rec, 2026, '6:30 pm')
    assert.ok(built)
    assert.equal(built.row.source_id, 'hudson-bandstand-2026-07-19')
  })
  it('drops a concert cancelled in the band slot or announced in the description', () => {
    assert.equal(buildRow({ month: 7, day: 19, band: 'Blue Lunch (CANCELED)', description: '' }, 2026, '6:30 pm'), null)
    assert.equal(buildRow({ month: 7, day: 19, band: 'Blue Lunch', description: 'This concert has been cancelled.' }, 2026, '6:30 pm'), null)
    assert.equal(buildRow({ month: 7, day: 19, band: 'NEO Big Band', description: 'Postponed to a later date.' }, 2026, '6:30 pm'), null)
  })
})
