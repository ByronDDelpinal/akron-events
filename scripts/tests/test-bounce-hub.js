/**
 * test-bounce-hub.js — the Bounce Innovation Hub scraper. No network, no DB.
 *
 * Fixtures (captured live 2026-11-18; script/style/svg blocks, inline style
 * attributes and comments removed by script, nothing else touched):
 *   bounce-hub-list.html              https://bouncehub.org/events (4 listings)
 *   bounce-hub-detail-single.html     /events/empowering-business-owners-delegate-their-bookkeeping
 *   bounce-hub-detail-recurring.html  /events/free-coworking-day-4 — ONE page
 *                                     whose date line lists ten dates
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const { SOURCE_KEY, MAIN_VENUE, parseList, parseDateLine, parseDetail, buildRows, run } =
  await import('../scrape-bounce-hub.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const fx = (name) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')
const LIST = fx('bounce-hub-list.html')
const SINGLE = fx('bounce-hub-detail-single.html')
const RECURRING = fx('bounce-hub-detail-recurring.html')
const NOW = Date.parse('2026-11-18T17:00:00Z')

describe('parseList', () => {
  const items = parseList(LIST)

  it('reads every listing once, in page order', () => {
    assert.deepEqual(items.map((i) => i.slug), [
      'good-spirits-great-cigars-even-better-connections',
      'build-your-business-brain-crm-ai-connected-90-minutes',
      'free-coworking-day-4',
      'empowering-business-owners-delegate-their-bookkeeping',
    ])
  })

  it('reads title, series label and an absolute image URL', () => {
    const crm = items[1]
    assert.equal(crm.title, 'Build Your Business Brain: CRM + AI Connected in 90 Minutes')
    assert.equal(crm.label, 'Beyond Startup Series')
    assert.match(crm.imageUrl, /^https:\/\/bouncehub\.org\/sites\/default\/files\//)
    assert.ok(!crm.imageUrl.includes('&amp;'))
    assert.equal(items[2].label, null) // an empty label div is no label
  })

  it('returns nothing for a page with no listings', () => {
    assert.deepEqual(parseList('<html><body><p>No upcoming events.</p></body></html>'), [])
  })
})

describe('parseDateLine', () => {
  it('one date with a range, the start borrowing the end\'s meridiem', () => {
    assert.deepEqual(parseDateLine('Nov 18, 2026 10:00 - 11:30 AM'), { dates: ['2026-11-18'], startTime: '10:00 am', endTime: '11:30 am' })
    assert.deepEqual(parseDateLine('Nov 18, 2026 5:00 - 9:00 PM'), { dates: ['2026-11-18'], startTime: '5:00 pm', endTime: '9:00 pm' })
  })

  it('"11:00 - 1:00 PM" starts in the morning', () => {
    assert.deepEqual(parseDateLine('Jan 12, 2027 11:00 - 1:00 PM'), { dates: ['2027-01-12'], startTime: '11:00 am', endTime: '1:00 pm' })
  })

  it('both meridiems given', () => {
    assert.deepEqual(parseDateLine('Dec 02, 2026 10:00 AM - 11:30 AM'), { dates: ['2026-12-02'], startTime: '10:00 am', endTime: '11:30 am' })
  })

  it('a recurring line: every date, one shared time', () => {
    const when = parseDateLine('Feb 25, 2026, Mar 25, 2026, Nov 25, 2026, Dec 23, 2026 8 AM - 5 PM')
    assert.deepEqual(when.dates, ['2026-02-25', '2026-03-25', '2026-11-25', '2026-12-23'])
    assert.equal(when.startTime, '8:00 am')
    assert.equal(when.endTime, '5:00 pm')
  })

  it('a date with no time has no time', () => {
    assert.deepEqual(parseDateLine('Mar 3, 2027'), { dates: ['2027-03-03'], startTime: null, endTime: null })
  })

  it('a line with no full date is null — never dated from "Nov 18" alone', () => {
    assert.equal(parseDateLine('Nov 18'), null)
    assert.equal(parseDateLine('Coming soon'), null)
    assert.equal(parseDateLine(''), null)
  })
})

describe('parseDetail', () => {
  it('reads the date line and the description from the content block', () => {
    const d = parseDetail(SINGLE)
    assert.equal(d.dateLine, 'Dec 02, 2026 10:00 AM - 11:30 AM')
    assert.match(d.description, /^Are you hesitant about outsourcing your bookkeeping\?/)
    // The site's menus carry their own body-field markup; none of it leaks in.
    assert.ok(!/Main navigation/i.test(d.description))
  })

  it('a page with neither is all nulls', () => {
    assert.deepEqual(parseDetail('<html><body></body></html>'), { dateLine: null, description: null })
  })
})

describe('buildRows', () => {
  const items = parseList(LIST)

  it('a single-date listing is one row keyed by its slug', () => {
    const { rows } = buildRows(items[3], parseDetail(SINGLE))
    assert.equal(rows.length, 1)
    const { row, venue } = rows[0]
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'empowering-business-owners-delegate-their-bookkeeping')
    assert.equal(row.start_at, '2026-12-02T15:00:00.000Z') // 10:00 am EST
    assert.equal(row.end_at, '2026-12-02T16:30:00.000Z')
    assert.equal(row.price_min, null) // never assume free
    assert.equal(row.time_inferred, undefined)
    assert.ok(row.tags.includes('beyond startup series'))
    assert.equal(row.ticket_url, 'https://bouncehub.org/events/empowering-business-owners-delegate-their-bookkeeping')
    assert.equal(venue, MAIN_VENUE)
  })

  it('a recurring listing is one row per date, each with its own id', () => {
    const { rows } = buildRows(items[2], parseDetail(RECURRING))
    assert.equal(rows.length, 10)
    assert.equal(rows[0].row.source_id, 'free-coworking-day-4-2026-02-25')
    assert.equal(rows.at(-1).row.source_id, 'free-coworking-day-4-2026-12-23')
    // 8 am is 13:00Z in winter and 12:00Z in summer: each date gets its own offset.
    assert.equal(rows[0].row.start_at, '2026-02-25T13:00:00.000Z')
    assert.equal(rows[4].row.start_at, '2026-07-22T12:00:00.000Z')
    assert.equal(new Set(rows.map((r) => r.row.source_id)).size, 10)
  })

  it('a date with no time gets the flagged noon placeholder', () => {
    const { rows } = buildRows(items[0], { dateLine: 'Mar 3, 2027', description: null })
    assert.equal(rows[0].row.start_at, '2027-03-03T17:00:00.000Z')
    assert.equal(rows[0].row.time_inferred, true)
  })

  it('a virtual event has no venue', () => {
    const { rows } = buildRows({ ...items[0], title: 'Virtual Office Hours' }, parseDetail(SINGLE))
    assert.equal(rows[0].venue, null)
    assert.ok(rows[0].row.tags.includes('online'))
  })

  it('an unparseable date line is skipped, not guessed', () => {
    assert.deepEqual(buildRows(items[0], { dateLine: 'TBA', description: null }), { skip: 'undatable' })
    assert.deepEqual(buildRows(items[0], { dateLine: null, description: null }), { skip: 'undatable' })
  })
})

describe('run (dry, stub site)', () => {
  it('walks list → detail pages and drops dates already past', async () => {
    const log = console.log; console.log = () => {}
    try {
      const fetchImpl = async (url) => {
        const u = String(url)
        const body = u.endsWith('/events') ? LIST : u.endsWith('/free-coworking-day-4') ? RECURRING : SINGLE
        return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
      }
      const result = await run({ dryRun: true, fetchImpl, now: () => NOW, delayMs: 0 })
      assert.equal(result.status, 'dry-run')
      assert.equal(result.found, 4)
      // 3 single-date listings (the stub serves each the Dec 2 page) + the
      // two coworking dates still ahead (Nov 25, Dec 23).
      assert.equal(result.planned, 5)
    } finally { console.log = log }
  })

  it('a list page that fails is an error run, not an empty success', async () => {
    const log = console.log, error = console.error; console.log = () => {}; console.error = () => {}
    try {
      const fetchImpl = async () => new Response('nope', { status: 404 })
      const result = await run({ dryRun: true, fetchImpl, now: () => NOW, delayMs: 0 })
      assert.equal(result.status, 'error')
      assert.equal(result.exitCode, 1)
      assert.match(result.error, /HTTP 404/)
    } finally { console.log = log; console.error = error }
  })
})
