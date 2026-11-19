/**
 * test-hudson-players.js — the Hudson Players scraper. No network, no database.
 *
 * Fixture (captured live 2026-11-19, reduced by script: head, script/style/svg
 * and layout attributes removed): hudson-players-now-playing.html, the
 * /now-playing page during the run of Come From Away.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const {
  SOURCE_KEY, PAGE_URL, MAIN_VENUE, parseRunLine, parseTimeRule, weekdayOf, parseNowPlaying, buildRow, run,
} = await import('../scrape-hudson-players.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(resolve(__dirname, 'fixtures', 'hudson-players-now-playing.html'), 'utf8')
const NOW = Date.parse('2026-11-19T15:00:00Z')
const fetchPage = (body, status = 200) => async () => ({ ok: status === 200, status, text: async () => body })

describe('run line', () => {
  it('reads months, day lists, matinee stars and the year', () => {
    const r = parseRunLine('October 30,31   November 6,7,8*,13,14,15*,20,21, 2026')
    assert.equal(r.year, 2026)
    assert.deepEqual(r.dates.map((d) => `${d.month}/${d.day}${d.starred ? '*' : ''}`),
      ['10/30', '10/31', '11/6', '11/7', '11/8*', '11/13', '11/14', '11/15*', '11/20', '11/21'])
    assert.ok(r.dates.every((d) => d.year === 2026))
  })

  it('a run that crosses New Year: the printed year belongs to the last month', () => {
    const r = parseRunLine('December 11, 12 January 8, 9, 10*, 2027')
    assert.deepEqual(r.dates.map((d) => `${d.year}-${d.month}-${d.day}`), ['2026-12-11', '2026-12-12', '2027-1-8', '2027-1-9', '2027-1-10'])
  })

  it('returns null for lines that are not a dated run', () => {
    for (const line of ['', 'Come From Away', 'Friday and Saturday performances @ 7:30pm', 'October 30, 31', 'Opening October 30, 2026 at the Barlow', 'October thirty, 2026', 'October 32, 2026', 'Directed by: Dawn Yamokoski']) {
      assert.equal(parseRunLine(line), null, line)
    }
  })
})

describe('time rules', () => {
  it('maps each named weekday to the time on the line', () => {
    assert.deepEqual(parseTimeRule('Friday and Saturday performances @ 7:30pm'), {
      5: { time: '7:30 pm', hhmm: '1930' }, 6: { time: '7:30 pm', hhmm: '1930' },
    })
    assert.deepEqual(parseTimeRule('*Sunday matinees @ 2pm'), { 0: { time: '2:00 pm', hhmm: '1400' } })
    assert.deepEqual(Object.keys(parseTimeRule('Thursdays at 7 p.m.')), ['4'])
  })

  it('gives no rule when a weekday or a readable time is missing', () => {
    for (const line of ['', 'Performances @ 7:30pm', 'Friday and Saturday evenings', 'Sunday @ dusk', 'Get tickets now.']) {
      assert.deepEqual(parseTimeRule(line), {}, line)
    }
  })

  it('weekdayOf', () => {
    assert.equal(weekdayOf(2026, 11, 20), 5) // Friday
    assert.equal(weekdayOf(2026, 11, 8), 0)  // Sunday
  })
})

describe('the now-playing page', () => {
  const productions = parseNowPlaying(PAGE)

  it('finds the production with its run, rules, image and ticket link', () => {
    assert.equal(productions.length, 1)
    const p = productions[0]
    assert.equal(p.title, 'Come From Away')
    assert.equal(p.slug, 'come-from-away')
    assert.equal(p.run.dates.length, 10)
    assert.deepEqual(Object.keys(p.rules).sort(), ['0', '5', '6'])
    assert.match(p.imageUrl, /^https:\/\/custom-images\.strikinglycdn\.com\//)
    assert.equal(p.ticketUrl, 'https://hudsonplayers.ludus.com/index.php?sections=events')
  })

  it('keeps the synopsis and leaves out dates, time rules, credits and the ticket prompt', () => {
    const { description } = productions[0]
    assert.match(description, /^Come From Away is the inspiring true story/)
    assert.doesNotMatch(description, /Directed by|Music & Lyrics|Produced by|@ 7:30|October 30|Get tickets/)
  })

  it('every starred date on the page is a Sunday, the day the matinee rule covers', () => {
    for (const d of productions[0].run.dates) assert.equal(d.starred, weekdayOf(d.year, d.month, d.day) === 0)
  })

  it('returns nothing without a "Now Playing" heading or without a production', () => {
    assert.deepEqual(parseNowPlaying('<h1>Season Tickets</h1><h2>Come From Away</h2>'), [])
    assert.deepEqual(parseNowPlaying('<h1><strong>Now Playing</strong></h1><p>See you next season.</p>'), [])
  })

  it('a production announced without dates has no run', () => {
    const p = parseNowPlaying('<h1>Now Playing</h1><h2>Mornings at Seven</h2><p>Coming this winter.</p>')
    assert.equal(p[0].title, 'Mornings at Seven')
    assert.equal(p[0].run, null)
  })
})

describe('rows', () => {
  const production = parseNowPlaying(PAGE)[0]
  const date = (month, day) => production.run.dates.find((d) => d.month === month && d.day === day)

  it('a Friday performance is 7:30 PM Eastern at the Barlow Community Center', () => {
    const { row, venue } = buildRow(production, date(11, 20))
    assert.equal(row.start_at, '2026-11-21T00:30:00.000Z')
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'come-from-away-2026-11-20-1930')
    assert.deepEqual(row.categories, ['theater'])
    assert.equal(row.price_min, null)
    assert.equal(venue, MAIN_VENUE)
  })

  it('a Sunday performance is the 2 PM matinee; October dates are EDT', () => {
    assert.equal(buildRow(production, date(11, 8)).row.start_at, '2026-11-08T19:00:00.000Z')
    assert.equal(buildRow(production, date(10, 30)).row.start_at, '2026-10-30T23:30:00.000Z')
  })

  it('a date on a weekday the page gives no time for is skipped, never defaulted', () => {
    assert.deepEqual(buildRow(production, { year: 2026, month: 11, day: 19 }), { skip: 'no_time_rule' }) // Thursday
    assert.deepEqual(buildRow({ ...production, rules: {} }, date(11, 20)), { skip: 'no_time_rule' })
  })

  it('falls back to the page when there is no ticket link, and refuses a nameless production', () => {
    assert.equal(buildRow({ ...production, ticketUrl: null }, date(11, 20)).row.ticket_url, PAGE_URL)
    assert.deepEqual(buildRow({ ...production, title: '' }, date(11, 20)), { skip: 'invalid' })
  })
})

describe('run (dry)', () => {
  it('plans the performances still to come and counts the past ones', async () => {
    const result = await run({ dryRun: true, fetchImpl: fetchPage(PAGE), now: () => NOW })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.found, 10)
    assert.equal(result.planned, 2)
  })

  it('between productions an empty page is not an error', async () => {
    const result = await run({ dryRun: true, fetchImpl: fetchPage('<h1>Now Playing</h1><p>See you next season.</p>'), now: () => NOW })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.found, 0)
    assert.equal(result.exitCode, 0)
  })

  it('a page that lost its "Now Playing" section is an error, not an empty season', async () => {
    const result = await run({ dryRun: true, fetchImpl: fetchPage('<h1>Welcome</h1>'), now: () => NOW })
    assert.notEqual(result.status, 'dry-run')
  })
})
