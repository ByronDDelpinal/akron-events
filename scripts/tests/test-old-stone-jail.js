/**
 * test-old-stone-jail.js — pure parsers + occurrence assembly for the Old
 * Stone Jail scraper. The fixture is the REAL line-split raw source of
 * theoldstonejail.com captured 2026-07-09 by running htmlToLines in-browser
 * against fetch('/').text() (raw markup, NOT the rendered DOM — the Magic
 * City lesson).
 *
 * Run:  node --test scripts/tests/test-old-stone-jail.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { htmlToLines, parseTriviaSchedule, parseAddress, buildTriviaEvents, SOURCE_KEY } =
  await import('../scrape-old-stone-jail.js')

const LINES = JSON.parse(
  readFileSync(new URL('./fixtures/old-stone-jail-lines.json', import.meta.url), 'utf8'))

// Tuesday noon UTC (Tuesday morning ET) — next Thursday is 2026-07-09.
const NOW = new Date('2026-07-07T12:00:00Z')

describe('htmlToLines', () => {
  it('splits on closing element tags and decodes basic entities', () => {
    const lines = htmlToLines(
      '<div class="x">Weekly Event</div><h3>Trivia Night</h3>' +
      '<span>Every Thursday at 8 PM</span><a href="/menu">Today&#x27;s Hours &amp; Menu</a>')
    assert.deepEqual(lines,
      ['Weekly Event', 'Trivia Night', 'Every Thursday at 8 PM', "Today's Hours & Menu"])
  })
  it('drops script/style bodies', () => {
    const lines = htmlToLines('<style>.a{color:red}</style><script>var x=1</script><div>Real</div>')
    assert.deepEqual(lines, ['Real'])
  })
})

describe('parseTriviaSchedule (captured fixture)', () => {
  const schedule = parseTriviaSchedule(LINES)
  it('finds the statement the page actually makes', () => {
    assert.equal(schedule.statement, 'Every Thursday at 8 PM')
  })
  it('resolves Thursday 8 PM', () => {
    assert.equal(schedule.weekday, 4)
    assert.equal(schedule.weekdayName, 'thursday')
    assert.equal(schedule.time, '8:00 pm')
  })
  it('picks up the page title and prose description', () => {
    assert.equal(schedule.title, 'Trivia Night')
    assert.match(schedule.description, /Bring your crew and put your smarts to the test/)
  })
  it('follows a rescheduled statement (weekday+time never hardcoded)', () => {
    const s = parseTriviaSchedule(['Trivia Night', 'Every Wednesday at 7:30 pm'])
    assert.equal(s.weekday, 3)
    assert.equal(s.time, '7:30 pm')
  })
  it('returns null when the page drops the trivia block', () => {
    assert.equal(parseTriviaSchedule(['Burgers', 'Wings', 'Full bar']), null)
  })
})

describe('parseAddress (drift guard)', () => {
  it('reads the stated street address', () => {
    assert.deepEqual(parseAddress(LINES),
      { address: '5640 Wooster Rd W', city: 'Norton', state: 'OH', zip: '44203' })
  })
  it('returns null when no address line exists', () => {
    assert.equal(parseAddress(['Call Us', '(330) 991-4058']), null)
  })
})

describe('buildTriviaEvents', () => {
  const events = buildTriviaEvents(LINES, NOW)

  it('generates 8 consecutive Thursday occurrences', () => {
    assert.equal(events.length, 8)
    assert.deepEqual(events.map((e) => e.ymd), [
      '2026-07-09', '2026-07-16', '2026-07-23', '2026-07-30',
      '2026-08-06', '2026-08-13', '2026-08-20', '2026-08-27',
    ])
  })
  it('keys source_ids by date', () => {
    assert.equal(events[0].sourceId, 'trivia-2026-07-09')
    assert.equal(new Set(events.map((e) => e.sourceId)).size, 8)
  })
  it('starts at 8 PM Eastern (EDT → UTC)', () => {
    // 8:00 PM EDT Jul 9 = 00:00 UTC Jul 10
    assert.equal(events[0].startIso, '2026-07-10T00:00:00.000Z')
  })
  it('handles EST occurrences too', () => {
    const winter = buildTriviaEvents(LINES, new Date('2026-12-01T12:00:00Z'))
    // 8:00 PM EST Dec 3 = 01:00 UTC Dec 4
    assert.equal(winter[0].ymd, '2026-12-03')
    assert.equal(winter[0].startIso, '2026-12-04T01:00:00.000Z')
  })
  it('anchors "today" to the Eastern date on a late-night Thursday run (UTC rollover)', () => {
    // Thu Jul 9 11 PM ET = Fri Jul 10 03:00 UTC; the Eastern date is still
    // Thursday, so the window starts at 2026-07-09 (past-start guard in
    // main() drops it at upsert time).
    const late = buildTriviaEvents(LINES, new Date('2026-07-10T03:00:00Z'))
    assert.equal(late[0].ymd, '2026-07-09')
  })
  it('titles and describes from page copy', () => {
    assert.equal(events[0].title, 'Trivia Night at the Old Stone Jail')
    assert.match(events[0].description, /every Thursday at 8 PM/)
    assert.match(events[0].description, /Prizes, cold drinks, and bragging rights/)
  })
  it('yields nothing when the schedule statement is absent', () => {
    assert.deepEqual(buildTriviaEvents(['Wings', 'Burgers'], NOW), [])
  })
})

describe('module contract', () => {
  it('exports the manifest source key', () => {
    assert.equal(SOURCE_KEY, 'old_stone_jail')
  })
})
