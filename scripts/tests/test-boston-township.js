/**
 * test-boston-township.js — the Boston Township scraper. No network, no database.
 *
 * Fixtures (captured live 2026-11-19, the webmaster address replaced):
 *   boston-township-2026-11.html   four meetings
 *   boston-township-2026-12.html   two meetings
 *   boston-township-2027-01.html   an empty month
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const {
  SOURCE_KEY, TOWNSHIP_HALL, monthUrl, monthsToRead, parseMonth, fullTitle, buildRow, run,
} = await import('../scrape-boston-township.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const fx = (name) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')
const NOV = fx('boston-township-2026-11.html')
const DEC = fx('boston-township-2026-12.html')
const JAN = fx('boston-township-2027-01.html')
const NOW = Date.parse('2026-11-19T15:00:00Z')
const pages = { [monthUrl(2026, 11)]: NOV, [monthUrl(2026, 12)]: DEC, [monthUrl(2027, 1)]: JAN }
const serve = (map) => async (url) => {
  const body = map[String(url)]
  return body ? { ok: true, status: 200, text: async () => body } : { ok: false, status: 404, text: async () => '' }
}

describe('which months are read', () => {
  it('this month and the next two, across New Year', () => {
    assert.deepEqual(monthsToRead(new Date(NOW)), [{ year: 2026, month: 11 }, { year: 2026, month: 12 }, { year: 2027, month: 1 }])
  })
  it('uses the Eastern date, not UTC, at a month boundary', () => {
    // 03:00 UTC on Dec 1 is still Nov 30 in Akron.
    assert.deepEqual(monthsToRead(new Date('2026-12-01T03:00:00Z'))[0], { year: 2026, month: 11 })
  })
})

describe('the month grid', () => {
  it('reads the heading and every entry with its day, time, title and place', () => {
    const m = parseMonth(NOV)
    assert.equal(m.year, 2026)
    assert.equal(m.month, 11)
    assert.deepEqual(m.entries, [
      { noteId: '1748', day: 10, timeText: '6:30 pm', title: 'Zoning Commission', place: 'Township Offices, 1775 Main Street' },
      { noteId: '1723', day: 11, timeText: '6:00 pm', title: 'Trustees Meeting', place: 'Township Offices, 1775 Main Street' },
      { noteId: '1749', day: 24, timeText: '6:30 pm', title: 'Board of Zoning Appeals', place: 'Township Offices, 1775 Main Street' },
      { noteId: '1724', day: 25, timeText: '6:00 pm', title: 'Trustees Meeting', place: 'Township Offices, 1775 Main Street' },
    ])
  })

  it('an empty month still has its heading', () => {
    assert.deepEqual(parseMonth(JAN), { year: 2027, month: 1, entries: [] })
  })

  it('a page without the grid is null', () => {
    assert.equal(parseMonth('<html><body><h1>Site maintenance</h1></body></html>'), null)
  })
})

describe('rows', () => {
  const nov = parseMonth(NOV)

  it('a 6:30 PM meeting at the township hall, titled with the township', () => {
    const { row, venue } = buildRow(nov.entries[2], nov)
    assert.equal(row.title, 'Boston Township Board of Zoning Appeals')
    assert.equal(row.start_at, '2026-11-24T23:30:00.000Z')
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'note-1749')
    assert.deepEqual(row.categories, ['civic'])
    assert.equal(row.description, 'Listed on the Boston Township calendar. Held at Township Offices, 1775 Main Street.')
    assert.equal(row.ticket_url, monthUrl(2026, 11))
    assert.equal(venue, TOWNSHIP_HALL)
  })

  it('a title that already names the township is not prefixed twice', () => {
    assert.equal(fullTitle('Boston Township Cleanup Day'), 'Boston Township Cleanup Day')
    assert.equal(fullTitle('Trustees Meeting'), 'Boston Township Trustees Meeting')
  })

  it('an entry somewhere else keeps the place in the description and mints no venue', () => {
    const { row, venue } = buildRow({ noteId: '9', day: 5, timeText: '10:00 am', title: 'Cleanup Day', place: 'Riverview Road trailhead' }, nov)
    assert.equal(venue, null)
    assert.match(row.description, /Held at Riverview Road trailhead\.$/)
  })

  it('an entry without a clock time is skipped, never defaulted', () => {
    assert.deepEqual(buildRow({ noteId: '9', day: 5, timeText: '', title: 'Offices Closed', place: '' }, nov), { skip: 'no_time' })
    assert.deepEqual(buildRow({ noteId: '9', day: 5, timeText: 'All day', title: 'Offices Closed', place: '' }, nov), { skip: 'no_time' })
    assert.deepEqual(buildRow({ noteId: '', day: 5, timeText: '6:00 pm', title: 'X' }, nov), { skip: 'invalid' })
  })
})

describe('run (dry, fixtures served by a fake fetch)', () => {
  it('reads all six entries and publishes none: they are all government meetings', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve(pages), now: () => NOW, delayMs: 0 })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.found, 6)
    assert.equal(result.planned, 0)
    assert.equal(result.exitCode, 0)
  })

  it('a community entry on the same grid is published', async () => {
    const withCleanup = { ...pages, [monthUrl(2026, 12)]: DEC.replace('Zoning Commission', 'Township Cleanup Day') }
    const result = await run({ dryRun: true, fetchImpl: serve(withCleanup), now: () => NOW, delayMs: 0 })
    assert.equal(result.planned, 1)
  })

  it('a site that answers a different month than asked is an error, not an empty run', async () => {
    const wrong = { ...pages, [monthUrl(2026, 12)]: NOV }
    const result = await run({ dryRun: true, fetchImpl: serve(wrong), now: () => NOW, delayMs: 0 })
    assert.notEqual(result.status, 'dry-run')
  })

  it('a page with no grid is an error', async () => {
    const broken = { ...pages, [monthUrl(2026, 11)]: '<html>Site maintenance</html>' }
    const result = await run({ dryRun: true, fetchImpl: serve(broken), now: () => NOW, delayMs: 0 })
    assert.notEqual(result.status, 'dry-run')
  })
})
