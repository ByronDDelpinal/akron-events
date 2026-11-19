/**
 * test-richfield-historical.js — the Richfield Historical Society scraper.
 * No network, no database.
 *
 * Built in November, when the whole list was in the past, so it is tested
 * against two real years with the clock set back:
 *   richfield-historical-2026.html   the live page, captured 2026-11-19
 *   richfield-historical-2025.html   Internet Archive capture of 2025-02-08
 * Both cut by script to the calendar list, with its no-break-space columns
 * exactly as served.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const {
  SOURCE_KEY, MUSEUM, listRows, parseEntries, resolveYear, categoriesFor, buildRow, run,
} = await import('../scrape-richfield-historical.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const fx = (name) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')
const HTML_2026 = fx('richfield-historical-2026.html')
const HTML_2025 = fx('richfield-historical-2025.html')
const L26 = parseEntries(listRows(HTML_2026))
const L25 = parseEntries(listRows(HTML_2025))
const entry = (list, month, day) => list.entries.find((e) => e.month === month && e.days.includes(day))
const serve = (body) => async () => ({ ok: true, status: 200, text: async () => body })
const at = (iso) => () => Date.parse(iso)
const on = (iso) => new Date(iso)

describe('the column layout', () => {
  it('splits title, place and time on the runs of no-break spaces', () => {
    const e = entry(L26, 7, 14)
    assert.equal(e.title, 'Happy Birthday America Concert')
    assert.equal(e.location, 'Revere High School Auditorium')
    assert.equal(e.timeText, '7:00 PM')
    assert.equal(e.presenter, 'the Akron Symphonic Winds')
  })

  it('joins a talk whose title is on the line under "TakeMeBack presentation:"', () => {
    const e = entry(L26, 4, 14)
    assert.equal(e.title, 'TakeMeBack: The Underground Railroad')
    assert.equal(e.location, 'Fellowship Hall')
    assert.equal(e.timeText, '7:00 PM')
    assert.equal(e.presenter, 'Kathy Dean-Dielman')
  })

  it('joins a talk title that wraps over two lines, and drops the stray quotation marks', () => {
    assert.equal(entry(L25, 4, 27).title, 'TakeMeBack: Remembering the Importance of the D-Day Invasion & the Battle of the Bulge Over 80 Years Later')
    assert.equal(entry(L25, 5, 14).title, 'TakeMeBack: Arrgh - A History of Piracy on the Great Lakes')
    assert.equal(entry(L26, 5, 19).title, 'TakeMeBack: Traitor – The Tragic Tale of Benedict Arnold')
  })

  it('reads a list of days as one entry on several days', () => {
    const e = entry(L26, 10, 4)
    assert.deepEqual(e.days, [4, 11, 18, 25])
    assert.equal(e.title, 'Richfield History Walking Tours')
  })

  it('recovers a time typed one space after the place', () => {
    const e = entry(L26, 6, 13)
    assert.equal(e.title, 'Richfield Garden Tour and Plant Sale')
    assert.equal(e.location, 'Museum and Various Locations')
    assert.equal(e.timeText, '11 AM - 4 PM')
  })

  it('stops at the end of the list: the footer never leaks into the last entry', () => {
    assert.equal(entry(L26, 11, 15).presenter, 'Dr. Gary Domanik')
    assert.equal(entry(L25, 7, 23).presenter, 'John Burke')
  })

  it('counts a dated row with nothing on it (the stray "May 2") instead of inventing an event', () => {
    assert.equal(L26.unparsed, 1)
    assert.equal(L25.unparsed, 0)
    assert.equal(L26.entries.length, 19)
    assert.equal(L25.entries.length, 5)
  })

  it('a page without the list is null', () => {
    assert.equal(listRows('<html><body>Under construction</body></html>'), null)
  })
})

describe('the year is taken from the page, never guessed', () => {
  it('2026 list: printed in the introduction and confirmed by Memorial Day on May 25', () => {
    assert.equal(resolveYear(L26, on('2026-11-19T15:00:00Z')), 2026)
    assert.equal(resolveYear(L26, on('2026-03-01T15:00:00Z')), 2026)
  })

  it('2025 list: no printed year, Memorial Day on May 26 identifies 2025', () => {
    assert.equal(resolveYear(L25, on('2025-02-08T15:00:00Z')), 2025)
  })

  it('a stale list read the next January is still last year, so nothing rolls forward', () => {
    assert.equal(resolveYear(L26, on('2027-01-20T15:00:00Z')), 2026)
    assert.equal(resolveYear(L25, on('2026-01-20T15:00:00Z')), 2025)
  })

  it('a printed year that contradicts the Memorial Day date resolves to nothing', () => {
    assert.equal(resolveYear({ ...L26, intro: 'See the Semi Q 2027 Calendar.' }, on('2027-02-01T15:00:00Z')), null)
  })

  it('with neither signal there is no year', () => {
    const bare = { entries: L26.entries.filter((e) => !/memorial day/i.test(e.title)), intro: '' }
    assert.equal(resolveYear(bare, on('2026-03-01T15:00:00Z')), null)
  })
})

describe('rows', () => {
  it('a talk at Fellowship Hall: 7 PM, place kept in the text, no venue minted', () => {
    const { row, venue } = buildRow(entry(L26, 4, 14), 14, 2026)
    assert.equal(row.title, 'TakeMeBack: The Underground Railroad')
    assert.equal(row.start_at, '2026-04-14T23:00:00.000Z')
    assert.equal(row.description, 'Listed on the Richfield Historical Society calendar. Presented by Kathy Dean-Dielman. Location: Fellowship Hall.')
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, '2026-04-14-takemeback-the-underground-railroad')
    assert.deepEqual(row.categories, ['learning'])
    assert.equal(row.price_min, null)
    assert.equal(venue, null)
  })

  it('an event at the museum gets the museum as its venue', () => {
    const { row, venue } = buildRow(entry(L26, 7, 28), 28, 2026)
    assert.equal(venue, MUSEUM)
    assert.doesNotMatch(row.description, /Location:/)
  })

  it('a time range gives a start and an end', () => {
    const { row } = buildRow(entry(L26, 8, 9), 9, 2026)
    assert.equal(row.start_at, '2026-08-09T17:00:00.000Z')
    assert.equal(row.end_at, '2026-08-09T22:00:00.000Z')
  })

  it('each day of a multi-day entry is its own event with its own id', () => {
    const e = entry(L26, 10, 4)
    const ids = e.days.map((d) => buildRow(e, d, 2026).row.source_id)
    assert.deepEqual(ids, ['2026-10-04-richfield-history-walking-tours', '2026-10-11-richfield-history-walking-tours', '2026-10-18-richfield-history-walking-tours', '2026-10-25-richfield-history-walking-tours'])
  })

  it('two events on the same day at the same time have different ids', () => {
    const [a, b] = L26.entries.filter((e) => e.month === 8 && e.days.includes(9)).map((e) => buildRow(e, 9, 2026).row.source_id)
    assert.notEqual(a, b)
  })

  it('"All Afternoon" and "Various Locations and Times" are not times: skipped', () => {
    assert.deepEqual(buildRow(entry(L26, 3, 21), 21, 2026), { skip: 'no_time' })
    assert.deepEqual(buildRow(entry(L26, 4, 18), 18, 2026), { skip: 'no_time' })
  })

  it('the society\'s annual meeting is not listed, and no year means no event', () => {
    assert.deepEqual(buildRow(entry(L26, 6, 28), 28, 2026), { skip: 'members_meeting' })
    assert.deepEqual(buildRow(entry(L26, 4, 14), 14, null), { skip: 'year_unknown' })
  })

  it('categories', () => {
    assert.deepEqual(categoriesFor('Happy Birthday America Concert'), ['music'])
    assert.deepEqual(categoriesFor('Pickett Fence Art Show'), ['visual-art'])
    assert.deepEqual(categoriesFor('250th Anniversary Parade'), ['festival'])
    assert.deepEqual(categoriesFor('Richfield Garden Tour and Plant Sale'), ['outdoors'])
    assert.deepEqual(categoriesFor('TakeMeBack: Miracle of Richfield'), ['learning'])
  })
})

describe('run (dry), with the clock set to each year', () => {
  it('March 2026, the list just posted: every timed public event is planned', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve(HTML_2026), now: at('2026-03-01T15:00:00Z') })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.found, 25)   // 19 entries over 24 days, plus the one stray row
    assert.equal(result.planned, 19) // 24 days minus the untimed cabin tour, 3 untimed tour days and the annual meeting
  })

  it('February 2025, the 2025 list: four timed events', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve(HTML_2025), now: at('2025-02-08T15:00:00Z') })
    assert.equal(result.found, 5)
    assert.equal(result.planned, 4)
  })

  it('today, with the whole 2026 list behind us: an empty run, not an error', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve(HTML_2026), now: at('2026-11-19T15:00:00Z') })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.planned, 0)
    assert.equal(result.exitCode, 0)
  })

  it('next January, the 2026 list still up: nothing is published as 2027', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve(HTML_2026), now: at('2027-01-20T15:00:00Z') })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.planned, 0)
  })

  it('a page without the list is an error', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve('<html>Under construction</html>'), now: at('2026-11-19T15:00:00Z') })
    assert.notEqual(result.status, 'dry-run')
  })
})
