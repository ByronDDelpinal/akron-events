/**
 * test-dilly-ds.js — pure parsers + occurrence assembly for the Dilly D's
 * Sports Grill scraper. The fixture is the REAL line-split raw source of
 * dillyds.com captured 2026-07-09 by running htmlToLines in-browser against
 * fetch('/').text() (raw markup, NOT the rendered DOM — the Magic City
 * lesson), then length-checked line-by-line against the live page.
 *
 * Run:  node --test scripts/tests/test-dilly-ds.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { htmlToLines, parseTriviaSchedule, parseThemedNights, parseAddress, buildEvents, SOURCE_KEY } =
  await import('../scrape-dilly-ds.js')

const LINES = JSON.parse(
  readFileSync(new URL('./fixtures/dilly-ds-lines.json', import.meta.url), 'utf8'))

// Thursday noon ET — the next 8 Wednesdays run 2026-07-15 … 2026-09-02,
// straddling the Decades themed night on 2026-08-12.
const NOW = new Date('2026-07-09T16:00:00Z')

describe('htmlToLines', () => {
  it('splits on closing element tags and decodes basic entities', () => {
    const lines = htmlToLines(
      '<div class="x">Dilly D&#x27;s Sports Grill</div><h2>LAST CALL TRIVIA</h2>' +
      '<span>Every Wednesday at 7PM</span><td>Martini &amp; Cocktail Menu</td>')
    assert.deepEqual(lines,
      ["Dilly D's Sports Grill", 'LAST CALL TRIVIA', 'Every Wednesday at 7PM', 'Martini & Cocktail Menu'])
  })
  it('drops script/style bodies and collapses intra-line whitespace', () => {
    assert.deepEqual(
      htmlToLines('<style>.a{color:red}</style><script>var x=1</script><div>  Real   Line </div>'),
      ['Real Line'])
  })
})

describe('parseTriviaSchedule (captured fixture)', () => {
  const schedule = parseTriviaSchedule(LINES)
  it('prefers the LAST CALL TRIVIA section statement over the banner', () => {
    assert.match(schedule.statement, /^Join us on every Wednesday at 7pm/)
  })
  it('resolves Wednesday 7 PM', () => {
    assert.equal(schedule.weekday, 3)
    assert.equal(schedule.weekdayName, 'wednesday')
    assert.equal(schedule.time, '7:00 pm')
  })
  it('captures the section detail lines, stopping before the themed list', () => {
    assert.equal(schedule.details.length, 3)
    assert.match(schedule.details[0], /Prizes for 1st, 2nd and 3rd place/)
    assert.equal(schedule.details[1], 'All ages welcome. Up to 8 players per team.')
    assert.match(schedule.details[2], /\$1 off all 16oz drafts/)
    assert.ok(!schedule.details.some((l) => /themed|decades/i.test(l)))
  })
  it('falls back to a banner-style statement when there is no section', () => {
    const s = parseTriviaSchedule(['Last Call Trivia every Wednesday at 7PM! Come play.'])
    assert.equal(s.weekday, 3)
    assert.equal(s.time, '7:00 pm')
  })
  it('follows a rescheduled statement (weekday+time never hardcoded)', () => {
    const s = parseTriviaSchedule(['LAST CALL TRIVIA', 'Join us on every Tuesday at 8:30 pm!'])
    assert.equal(s.weekday, 2)
    assert.equal(s.time, '8:30 pm')
  })
  it('returns null when the page drops the trivia block', () => {
    assert.equal(parseTriviaSchedule(['Burgers', 'Wings', 'Full bar']), null)
  })
})

describe('parseThemedNights (captured fixture)', () => {
  const themed = parseThemedNights(LINES, NOW)
  it('finds exactly the two dated themed nights (nav "Trivia Night" never opens a block)', () => {
    assert.deepEqual(themed.map((t) => t.ymd), ['2026-08-12', '2026-09-16'])
  })
  it('detail blocks win on title/description, own time line parsed ("7:00PM" and "7:00 PM")', () => {
    const [decades, friends] = themed
    assert.equal(decades.title, 'Decades Trivia Night')
    assert.match(decades.description, /best of the 70s, 80s, 90s, and 2000s/)
    assert.equal(decades.time, '7:00 pm')
    assert.equal(friends.title, 'F•R•I•E•N•D•S Trivia Night')
    assert.match(friends.description, /Grab your lobster/)
    assert.equal(friends.time, '7:00 pm')
  })
  it('keeps a compact-list-only entry (no detail block) with a null time', () => {
    const t = parseThemedNights(['Themed Trivia Nights:', 'October 21st - Halloween'], NOW)
    assert.deepEqual(t, [{ ymd: '2026-10-21', title: 'Halloween Trivia Night', description: '', time: null }])
  })
  it('rolls a far-past month/day into the next year (December-scraped January listing idiom)', () => {
    const t = parseThemedNights(['August 12th - Decades'], new Date('2026-11-01T12:00:00Z'))
    assert.deepEqual(t.map((x) => x.ymd), ['2027-08-12'])
  })
  it('returns [] when nothing is dated', () => {
    assert.deepEqual(parseThemedNights(['LAST CALL TRIVIA', 'Join us on every Wednesday at 7pm!'], NOW), [])
  })
})

describe('parseAddress (captured fixture)', () => {
  it('reads the footer address as stated on the page', () => {
    assert.deepEqual(parseAddress(LINES), {
      address: '9750 Olde Eight Road', city: 'Northfield', state: 'OH', zip: '44067',
    })
  })
  it('returns null when no address line exists', () => {
    assert.equal(parseAddress(['Hours', 'Open today']), null)
  })
})

describe('buildEvents (deterministic now)', () => {
  const events = buildEvents(LINES, NOW)

  it('yields 7 weekly occurrences + 2 themed nights (Aug 12 weekly ceded to Decades)', () => {
    assert.equal(events.length, 9)
    assert.equal(events.filter((e) => e.kind === 'weekly').length, 7)
    assert.equal(events.filter((e) => e.kind === 'themed').length, 2)
    assert.ok(!events.some((e) => e.sourceId === 'trivia-2026-08-12'))
  })
  it('generates date-keyed source_ids on the stated Wednesday cadence', () => {
    assert.deepEqual(events.map((e) => e.sourceId), [
      'trivia-2026-07-15', 'trivia-2026-07-22', 'trivia-2026-07-29', 'trivia-2026-08-05',
      'special-2026-08-12', 'trivia-2026-08-19', 'trivia-2026-08-26', 'trivia-2026-09-02',
      'special-2026-09-16',
    ])
  })
  it('starts at the stated 7:00 pm Eastern (EDT → UTC)', () => {
    assert.equal(events[0].startIso, '2026-07-15T23:00:00.000Z')
    assert.equal(events.find((e) => e.sourceId === 'special-2026-09-16').startIso,
      '2026-09-16T23:00:00.000Z')
  })
  it('weekly description is built from the page details; themed carries its block + ages line', () => {
    assert.match(events[0].description, /Prizes for 1st, 2nd and 3rd place/)
    assert.match(events[0].description, /\$1 off all 16oz drafts/)
    const decades = events.find((e) => e.sourceId === 'special-2026-08-12')
    assert.equal(decades.title, "Decades Trivia Night at Dilly D's")
    assert.match(decades.description, /Non-stop nostalgia/)
    assert.match(decades.description, /All ages welcome/)
  })
  it('marks all ages because the page states it (parsed, not assumed)', () => {
    assert.ok(events.every((e) => e.allAges === true))
  })
  it('a themed night with no time anywhere is skipped rather than pinned to midnight', () => {
    assert.deepEqual(buildEvents(['October 21st - Halloween'], NOW), [])
  })
  it('yields nothing when the page carries no trivia content', () => {
    assert.deepEqual(buildEvents(['Burgers', 'Wings', 'Full bar'], NOW), [])
  })
})

describe('module contract', () => {
  it('exports the manifest source key', () => {
    assert.equal(SOURCE_KEY, 'dilly_ds')
  })
})
