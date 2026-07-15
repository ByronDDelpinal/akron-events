/**
 * test-lake_campground.js
 *
 * Tests for the The Lake Campground scraper (thelakepark.com) — a hand-typed
 * Weebly prose schedule. Exercises the pure parsers against a fixture captured
 * from the live page, covering: schedule-year + paragraph extraction, date
 * header parsing, activity "/"-splitting, time parsing (ranges, meridiem
 * inheritance, time-at-end, bare-time skip), day lines that wrap across <br />,
 * source_id stability, is_family, and category hints.
 *
 * Run:
 *   node --test scripts/tests/test-lake_campground.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  extractScheduleYear,
  extractScheduleParagraph,
  normalizeClock,
  parseActivity,
  isFamilyActivity,
  categoryHint,
  splitDays,
  buildEvents,
} from '../scrape-lake-campground.js'

// A realistic slice of the live page markup (one <div class="paragraph"> with
// <br />-separated lines). Includes the Aug 1 line that wraps across <br />,
// the standing volleyball note, month dividers, and the Facebook footer.
const FIXTURE = [
  '<div class="paragraph" style="text-align:center;"><br />',
  '<strong>The Lake Campground - 2026 Events Schedule</strong><br />',
  'Events are weather permitting and are subject to change.<br />',
  'Please join us on Facebook at: The Lake Campground Events for weekly updates and event details.<br />',
  '&nbsp;<br />',
  'Open sand volleyball games every Saturday at Noon.<br />',
  'May<br />',
  '<strong>Friday, May 1 - </strong>Opening Day!!<br />',
  '<strong>Saturday, May 2 - </strong>9 AM-12 PM Barnyard Brews/12 PM Kids Craft - Welcome Sign/6 PM Welcome Party with Hot Dogs &amp; Chips<br />',
  '<strong>Sunday, May 24 - </strong>2PM-4PM Kona Ice Truck<br />',
  'June<br />',
  '<strong>Saturday, June 6 - </strong>9 AM-12 PM Barnyard Brews/10:15 AM Kids Club - Around the World/7 PM Band - 100 Proof<br />',
  "<strong>Saturday, June 20 - </strong>2 PM Father's Day Surprise Delivery/4 PM Cornhole Tournament/8 PM Bourbon Tasting<br />",
  'July<br />',
  '<strong>Saturday, July 18 - </strong>10:30 AM Kids Craft/2 PM Family Games at the Lake/8 PM Wine Tasting<br />',
  '<strong>Saturday, July 25 - </strong>10:15 Kids Club - Reindeer Games/6 PM Christmas in July Camper Crawl<br />',
  'August<br />',
  '<strong>Saturday, August 1 - </strong>9 AM-12 PM Barnyard Brews/10:15 AM<br />',
  'Kids Club - Superhero Training Day/2:30 Pm Jungle Sky/ Ray Stone<br />',
  'Memorial/ Euchre Tournament 7 PM<br />',
  "<strong>Saturday, September 12 - </strong>2 PM Kid's Camper Crawl/ Eb's Soda Shop Truck 5:30 - 7:30 PM<br />",
  '<strong>Join us on Facebook: <em>The Lake Campground Events</em> for updated times.</strong>',
  '</div>',
].join('')

/** {hour24, minute, date} for an ISO instant, in America/New_York. */
function etParts(iso) {
  const d = new Date(iso)
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {})
  return { date: `${f.year}-${f.month}-${f.day}`, hour: Number(f.hour) % 24, minute: Number(f.minute) }
}

const { rows, warnings } = buildEvents(FIXTURE)
const byTitle = (t) => rows.find((r) => r.title === t)

describe('extraction helpers', () => {
  it('reads the season year from the heading', () => {
    assert.equal(extractScheduleYear(FIXTURE), 2026)
  })
  it('falls back to a provided year when the heading is absent', () => {
    assert.equal(extractScheduleYear('<p>no heading here</p>', 2031), 2031)
  })
  it('isolates the schedule paragraph and drops the Facebook footer', () => {
    const par = extractScheduleParagraph(FIXTURE)
    // The whole schedule survives — the intro "Please join us on Facebook at:"
    // line must NOT trigger the footer cut.
    assert.ok(par.includes('Barnyard Brews'))
    assert.ok(par.includes('Eb'), 'September activities survive the footer trim')
    assert.ok(!/Join us on Facebook:/i.test(par), 'the colon footer must be trimmed off')
  })
})

describe('normalizeClock', () => {
  it('normalizes explicit meridiem forms', () => {
    assert.equal(normalizeClock('6PM'), '6:00 pm')
    assert.equal(normalizeClock('10:30 am'), '10:30 am')
    assert.equal(normalizeClock('noon'), '12:00 pm')
  })
  it('inherits a passed meridiem when the token omits one', () => {
    assert.equal(normalizeClock('5:30', 'pm'), '5:30 pm')
  })
  it('rejects a bare time with no meridiem to inherit', () => {
    assert.equal(normalizeClock('10:15'), null)
  })
  it('handles the 12 o\'clock edge cases and rejects out-of-range hours', () => {
    assert.equal(normalizeClock('12 PM'), '12:00 pm')
    assert.equal(normalizeClock('12 AM'), '12:00 am')
    assert.equal(normalizeClock('midnight'), '12:00 am')
    assert.equal(normalizeClock('13 pm'), null) // hour > 12 is not a clock time
    assert.equal(normalizeClock('0 am'), null) // hour < 1 is not a clock time
  })
})

describe('parseActivity', () => {
  it('parses a leading time range and strips it from the title', () => {
    assert.deepEqual(parseActivity('9 AM-12 PM Barnyard Brews'),
      { title: 'Barnyard Brews', startClock: '9:00 am', endClock: '12:00 pm' })
  })
  it('parses a trailing time', () => {
    assert.deepEqual(parseActivity(' Euchre Tournament 7 PM'),
      { title: 'Euchre Tournament', startClock: '7:00 pm', endClock: null })
  })
  it('inherits meridiem across a range', () => {
    const p = parseActivity(" Eb's Soda Shop Truck 5:30 - 7:30 PM")
    assert.equal(p.title, "Eb's Soda Shop Truck")
    assert.equal(p.startClock, '5:30 pm')
    assert.equal(p.endClock, '7:30 pm')
  })
  it('accepts en-dash and em-dash range separators (not just hyphen)', () => {
    const en = parseActivity('5:30 – 7:30 PM Soda Shop')
    assert.deepEqual(en, { title: 'Soda Shop', startClock: '5:30 pm', endClock: '7:30 pm' })
    const em = parseActivity('5:30 — 7:30 PM Soda Shop')
    assert.deepEqual(em, { title: 'Soda Shop', startClock: '5:30 pm', endClock: '7:30 pm' })
  })
  it('returns null when no explicit time is present (no guessing)', () => {
    assert.equal(parseActivity('Opening Day!!'), null)
    assert.equal(parseActivity('Ray Stone Memorial'), null)
    assert.equal(parseActivity("Camper's Pavilion Party - Dusk"), null)
    assert.equal(parseActivity('10:15 Kids Club - Reindeer Games'), null) // bare 10:15
  })
})

describe('splitDays', () => {
  it('opens a day per header and re-joins wrapped continuation lines', () => {
    const days = splitDays(extractScheduleParagraph(FIXTURE))
    const aug1 = days.find((d) => d.month === 8 && d.day === 1)
    assert.ok(aug1, 'August 1 day present')
    // The wrapped "Ray Stone / Memorial" halves must be re-joined.
    assert.ok(aug1.text.includes('Ray Stone Memorial'))
    assert.ok(aug1.text.includes('Euchre Tournament 7 PM'))
  })
  it('ignores month-only divider lines', () => {
    const days = splitDays(extractScheduleParagraph(FIXTURE))
    assert.ok(days.every((d) => Number.isInteger(d.month) && Number.isInteger(d.day)))
  })
})

describe('buildEvents', () => {
  it('produces one row per timed activity', () => {
    const may2 = rows.filter((r) => r.start_at.startsWith('2026-05-02'))
    // easternToIso shifts UTC date; match on ET date instead.
    const may2ET = rows.filter((r) => etParts(r.start_at).date === '2026-05-02')
    assert.equal(may2ET.length, 3)
    assert.ok(may2.length >= 0) // sanity; ET grouping is the real assertion
  })

  it('skips time-less activities and records a warning', () => {
    assert.equal(byTitle('Opening Day!!'), undefined)
    assert.ok(warnings.some((w) => /Opening Day/i.test(w)))
    assert.equal(rows.find((r) => /Reindeer/i.test(r.title)), undefined)
    assert.ok(warnings.some((w) => /Reindeer/i.test(w)))
    assert.equal(rows.find((r) => /Ray Stone Memorial/i.test(r.title)), undefined)
  })

  it('keeps stable, unique source_ids', () => {
    const brews = rows.find((r) => r.source_id === '2026-05-02-barnyard-brews')
    assert.ok(brews)
    assert.equal(brews.title, 'Barnyard Brews')
    const ids = rows.map((r) => r.source_id)
    assert.equal(new Set(ids).size, ids.length, 'source_ids are unique')
  })

  it('computes Eastern start/end instants correctly', () => {
    const euchre = byTitle('Euchre Tournament')
    assert.equal(etParts(euchre.start_at).hour, 19)
    const soda = byTitle("Eb's Soda Shop Truck")
    assert.equal(etParts(soda.start_at).hour, 17)
    assert.equal(etParts(soda.start_at).minute, 30)
    assert.equal(etParts(soda.end_at).hour, 19)
    const kona = byTitle('Kona Ice Truck')
    assert.equal(etParts(kona.start_at).hour, 14) // 2PM-4PM meridiem inheritance
  })

  it('flags kid/family activities', () => {
    assert.equal(byTitle('Kids Craft - Welcome Sign').is_family, true)
    assert.equal(byTitle('Kids Club - Superhero Training Day').is_family, true)
    assert.equal(byTitle('Wine Tasting').is_family, undefined)
  })

  it('applies content-category hints', () => {
    assert.equal(byTitle('Band - 100 Proof').category, 'music')
    assert.equal(byTitle('Bourbon Tasting').category, 'food')
    assert.equal(byTitle('Cornhole Tournament').category, 'games')
    assert.equal(byTitle('Barnyard Brews').category, 'food')
  })

  it('reassembles a wrapped day into its activities', () => {
    assert.ok(byTitle('Kids Club - Superhero Training Day'))
    assert.ok(byTitle('Euchre Tournament'))
    assert.ok(byTitle('Jungle Sky'))
  })
})

describe('buildEvents edge cases', () => {
  it('returns no rows and no warnings for an empty / changed page (loud-fail signal)', () => {
    const empty = buildEvents('')
    assert.deepEqual(empty.rows, [])
    assert.deepEqual(empty.warnings, [])
    // A page missing the schedule paragraph likewise yields zero rows so main()
    // logs the "markup may have changed" error rather than silently succeeding.
    assert.equal(buildEvents('<p>site redesigned, no schedule</p>').rows.length, 0)
  })

  it('rolls a range end past midnight when it reads earlier than its start', () => {
    const html =
      '<div class="paragraph"><strong>The Lake Campground - 2026 Events Schedule</strong><br />' +
      '<strong>Saturday, August 1 - </strong>9 PM-12 AM Late Night Party<br /></div>'
    const { rows } = buildEvents(html)
    const party = rows.find((r) => r.title === 'Late Night Party')
    assert.ok(party)
    // 9 PM ET start, 12 AM end must land on the NEXT calendar day, not before start.
    assert.equal(etParts(party.start_at).hour, 21)
    assert.equal(etParts(party.end_at).date, '2026-08-02')
    assert.equal(etParts(party.end_at).hour, 0)
    assert.ok(new Date(party.end_at) > new Date(party.start_at), 'end is after start')
  })

  it('never synthesizes a midnight start for a time-less activity', () => {
    const html =
      '<div class="paragraph"><strong>The Lake Campground - 2026 Events Schedule</strong><br />' +
      '<strong>Friday, May 1 - </strong>Opening Day!!<br /></div>'
    const { rows, warnings } = buildEvents(html)
    assert.equal(rows.length, 0, 'no fabricated 00:00 row for a date-only activity')
    assert.ok(warnings.some((w) => /Opening Day/i.test(w) && /skipped/i.test(w)))
  })

  it('drops a cancelled/postponed activity while keeping the others on the day', () => {
    const html =
      '<div class="paragraph"><strong>The Lake Campground - 2026 Events Schedule</strong><br />' +
      '<strong>Saturday, August 1 - </strong>8 PM Wine Tasting CANCELED/7 PM Euchre Tournament<br /></div>'
    const { rows } = buildEvents(html)
    assert.ok(!rows.some((r) => /Wine Tasting/i.test(r.title)), 'cancelled activity dropped')
    assert.ok(rows.some((r) => r.title === 'Euchre Tournament'), 'live activity kept')
  })
})

describe('isFamilyActivity / categoryHint units', () => {
  it('detects family keywords', () => {
    assert.equal(isFamilyActivity('Kids Bike Parade'), true)
    assert.equal(isFamilyActivity('Fishing Derby'), true)
    assert.equal(isFamilyActivity('Adult Paint N Sip'), false)
  })
  it('maps obvious categories', () => {
    assert.equal(categoryHint('Karaoke at the Pavilion'), 'music')
    assert.equal(categoryHint('Yard Sales'), 'market')
    assert.equal(categoryHint('Campground Olympics'), 'sports')
    assert.equal(categoryHint('Kids Paint'), 'visual-art')
    assert.equal(categoryHint('Scavenger Hunt'), 'games')
  })
})
