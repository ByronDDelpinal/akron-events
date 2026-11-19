/**
 * test-summit-historical.js — the Summit County Historical Society scraper.
 * No network, no database.
 *
 * Fixtures (captured live 2026-11-18; script/style/svg blocks, inline style
 * attributes and comments removed by script, email addresses replaced):
 *   summit-historical-list.html            /events (12 listings)
 *   summit-historical-detail-lecture.html  /events/john-brown-institute-fall-lecture-ken-morris-jr
 *                                          — off-site, "Doors open at 5 p.m. …
 *                                          The program will start at 6 p.m."
 *   summit-historical-detail-tour.html     /events/simple-gifts-holidays-tours —
 *                                          at the mansion, "tours at 1 p.m.,
 *                                          2 p.m. and 3 p.m."
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const {
  SOURCE_KEY, PERKINS_MANSION, JOHN_BROWN_HOUSE, parseList, parseDetail, isMembersOnly, resolveVenue, buildRow, run,
} = await import('../scrape-summit-historical.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const fx = (name) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')
const LIST = fx('summit-historical-list.html')
const LECTURE = fx('summit-historical-detail-lecture.html')
const TOUR = fx('summit-historical-detail-tour.html')
const NOW = Date.parse('2026-11-18T17:00:00Z')

describe('parseList', () => {
  const items = parseList(LIST)

  it('reads all twelve listings with their machine-readable day', () => {
    assert.equal(items.length, 12)
    assert.deepEqual(items.slice(0, 3).map((i) => [i.slug, i.title, i.dateStr]), [
      ['john-brown-institute-fall-lecture-ken-morris-jr', 'John Brown Institute Fall Lecture - Ken Morris, Jr.', '2026-11-18'],
      ['members-only-holiday-open-house', 'Members Only Holiday Open House', '2026-11-21'],
      ['simple-gifts-holiday-tours-start', 'Simple Gifts Holiday Tours Start', '2026-11-28'],
    ])
  })

  it('one row per slug, even though each listing prints its date twice', () => {
    assert.equal(new Set(items.map((i) => i.slug)).size, 12)
  })

  it('a listing with no date attribute is not a listing', () => {
    assert.deepEqual(parseList('<div class="news-event-item"> <a href="/events/x" class="content-wrap"><span class="info">X</span></a></div>'), [])
  })
})

describe('parseDetail', () => {
  it('reads the body text only', () => {
    const d = parseDetail(LECTURE)
    assert.match(d.description, /^Kenneth B\. Morris, Jr\., is the keynote speaker/)
    assert.match(d.description, /The program will start at 6 p\.m\./)
    assert.ok(!/Copyright|Share on Facebook/i.test(d.description), 'page chrome must not leak into the description')
  })
})

describe('isMembersOnly', () => {
  it('matches the forms the Society uses, and nothing else', () => {
    assert.equal(isMembersOnly('Members Only Holiday Open House'), true)
    assert.equal(isMembersOnly('Members-Only Preview'), true)
    assert.equal(isMembersOnly('Member Only Tour'), true)
    assert.equal(isMembersOnly('New Members Welcome Reception'), false)
    assert.equal(isMembersOnly('Simple Gifts for the Holidays Tour'), false)
  })
})

describe('resolveVenue', () => {
  it('a spelled-out place wins over a passing mention of the mansion', () => {
    const text = 'Light refreshments at the City of Joy Enrichment Center, 610 W. Exchange Street, Akron. The Society also operates the Perkins Stone Mansion.'
    assert.deepEqual(resolveVenue('Fall Lecture', text), {
      venue: { name: 'City of Joy Enrichment Center', details: { address: '610 W. Exchange Street', city: 'Akron', state: 'OH' } },
      needsReview: undefined,
    })
  })

  it('the Society\'s own houses, by name', () => {
    assert.equal(resolveVenue('Tour', 'Prepare for the season by visiting the Perkins Stone Mansion.').venue, PERKINS_MANSION)
    assert.equal(resolveVenue('Open House at the John Brown House', '').venue, JOHN_BROWN_HOUSE)
    assert.equal(resolveVenue('Tour', 'See the John Brown House and the Perkins Stone Mansion.').venue, PERKINS_MANSION)
  })

  it('a spelled-out place outside Summit County drops the row', () => {
    assert.deepEqual(resolveVenue('Bus Trip', 'We meet at the McKinley Museum, 800 McKinley Monument Drive, Canton.'), { venue: null, drop: true })
  })

  it('nothing stated: no venue, flagged — never the mansion by default', () => {
    assert.deepEqual(resolveVenue('Annual Meeting', 'Join us for the annual meeting.'), { venue: null, needsReview: true })
  })
})

describe('buildRow', () => {
  const items = parseList(LIST)
  const item = (slug) => items.find((i) => i.slug === slug)

  it('the lecture: the stated start, at the stated place', () => {
    const { row, venue } = buildRow(item('john-brown-institute-fall-lecture-ken-morris-jr'), parseDetail(LECTURE))
    assert.equal(row.start_at, '2026-11-18T23:00:00.000Z') // 6 p.m. EST, not the 5 p.m. doors
    assert.equal(row.time_inferred, undefined)
    assert.equal(row.needs_review, undefined)
    assert.equal(venue.name, 'City of Joy Enrichment Center')
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'john-brown-institute-fall-lecture-ken-morris-jr')
    assert.equal(row.price_min, null)
  })

  it('a tour day: the first tour slot, at the mansion', () => {
    const { row, venue } = buildRow(item('simple-gifts-holidays-tours'), parseDetail(TOUR))
    assert.equal(row.start_at, '2026-12-02T18:00:00.000Z') // 1 p.m. EST
    assert.equal(row.time_inferred, undefined)
    assert.equal(venue, PERKINS_MANSION)
  })

  it('no time in the text: the flagged noon placeholder', () => {
    const { row } = buildRow(item('simple-gifts-holidays-tours'), { description: 'Visit the Perkins Stone Mansion.' })
    assert.equal(row.start_at, '2026-12-02T17:00:00.000Z')
    assert.equal(row.time_inferred, true)
  })

  it('a members-only event is skipped', () => {
    assert.deepEqual(buildRow(item('members-only-holiday-open-house'), {}), { skip: 'members_only' })
  })
})

describe('run (dry, stub site)', () => {
  it('skips the members-only listing without fetching its page', async () => {
    const log = console.log; console.log = () => {}
    try {
      const fetched = []
      const fetchImpl = async (url) => {
        const path = new URL(String(url)).pathname
        fetched.push(path)
        const body = path === '/events' ? LIST : /lecture/.test(path) ? LECTURE : TOUR
        return new Response(body, { status: 200 })
      }
      const result = await run({ dryRun: true, fetchImpl, now: () => NOW, delayMs: 0 })
      assert.deepEqual(
        { status: result.status, found: result.found, planned: result.planned },
        { status: 'dry-run', found: 12, planned: 11 },
      )
      assert.ok(!fetched.includes('/events/members-only-holiday-open-house'))
    } finally { console.log = log }
  })
})
