/**
 * test-akron-canton-foodbank.js — the Akron-Canton Regional Foodbank scraper.
 * No network, no database.
 *
 * Fixtures (captured live 2026-11-18; script/style/svg blocks, inline style
 * attributes and comments removed by script, email addresses replaced):
 *   akron-canton-foodbank-list.html            /upcoming-events (3 listings)
 *   akron-canton-foodbank-detail-akron.html    /events/selfless-elf-5k — at the
 *                                              Akron campus, two clock times
 *   akron-canton-foodbank-detail-canton.html   /events/merry-meals-mixer-2026 —
 *                                              at a hall in Canton (Stark County)
 *   akron-canton-foodbank-detail-offsite.html  /events/harvest-hunger-campaign-kickoff-luncheon
 *                                              — at the John S. Knight Center
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const { SOURCE_KEY, MAIN_VENUE, parseList, parseDetailDate, parseDetail, resolveVenue, buildRow, run } =
  await import('../scrape-akron-canton-foodbank.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const fx = (name) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')
const LIST = fx('akron-canton-foodbank-list.html')
const AKRON = fx('akron-canton-foodbank-detail-akron.html')
const CANTON = fx('akron-canton-foodbank-detail-canton.html')
const OFFSITE = fx('akron-canton-foodbank-detail-offsite.html')
const NOW = Date.parse('2026-11-18T17:00:00Z')

describe('parseList', () => {
  const items = parseList(LIST)

  it('reads the three listings with clean titles and absolute images', () => {
    assert.deepEqual(items.map((i) => [i.slug, i.title]), [
      ['merry-meals-mixer-2026', '2026 Merry Meals Mixer'],
      ['selfless-elf-5k', 'Selfless Elf 5k'],
      ['harvest-hunger-campaign-kickoff-luncheon', 'Harvest for Hunger Campaign Kickoff Luncheon'],
    ])
    for (const i of items) assert.match(i.imageUrl, /^https:\/\/www\.akroncantonfoodbank\.org\//)
  })

  it('the hero image block that shares the "item" class is not a listing', () => {
    assert.equal(items.length, 3)
  })
})

describe('parseDetailDate', () => {
  it('reads the detail page\'s full date, with or without a comma', () => {
    assert.equal(parseDetailDate('Dec 19 2026'), '2026-12-19')
    assert.equal(parseDetailDate('Feb 26, 2027'), '2027-02-26')
  })

  it('a year-less or malformed date is null', () => {
    assert.equal(parseDetailDate('Dec 19'), null)
    assert.equal(parseDetailDate('Dec 45 2026'), null)
    assert.equal(parseDetailDate('TBD'), null)
  })
})

describe('parseDetail', () => {
  it('takes the date from the event-date block and the text from the content block', () => {
    const d = parseDetail(AKRON)
    assert.equal(d.dateStr, '2026-12-19')
    assert.match(d.description, /^14th annual Selfless Elf 5k/)
    assert.ok(!/Main navigation|Ways To Give/i.test(d.description), 'site menus must not leak into the description')
  })

  it('reads the other two pages', () => {
    assert.equal(parseDetail(CANTON).dateStr, '2026-12-02')
    assert.equal(parseDetail(OFFSITE).dateStr, '2027-02-26')
    assert.match(parseDetail(OFFSITE).description, /John S\. Knight Center, 77 E\. Mill Street, Akron/)
  })
})

describe('resolveVenue: only where the page says', () => {
  it('the Foodbank\'s own address is the one canonical venue record', () => {
    assert.equal(resolveVenue(parseDetail(AKRON).description).venue, MAIN_VENUE)
  })

  it('a hall in Akron is that hall', () => {
    assert.deepEqual(resolveVenue(parseDetail(OFFSITE).description), {
      venue: { name: 'John S. Knight Center', details: { address: '77 E. Mill Street', city: 'Akron', state: 'OH' } },
      needsReview: undefined,
    })
  })

  it('a hall in Canton is out of county', () => {
    assert.deepEqual(resolveVenue(parseDetail(CANTON).description), { venue: null, drop: true })
  })

  it('the Stark County campus alone is out of county; both campuses is Akron', () => {
    assert.deepEqual(resolveVenue('Volunteer at our Stark County Campus this Saturday.'), { venue: null, drop: true })
    assert.equal(resolveVenue('Join us at the Akron campus or the Stark County Campus.').venue, MAIN_VENUE)
  })

  it('no stated place: no venue, flagged — never pinned to the campus', () => {
    assert.deepEqual(resolveVenue('Details to be announced soon.'), { venue: null, needsReview: true })
    assert.deepEqual(resolveVenue(null), { venue: null, needsReview: true })
  })
})

describe('buildRow', () => {
  const items = parseList(LIST)
  const item = (slug) => items.find((i) => i.slug === slug)

  it('two stated times keep the flagged noon placeholder', () => {
    const { row, venue } = buildRow(item('selfless-elf-5k'), parseDetail(AKRON))
    assert.equal(row.start_at, '2026-12-19T17:00:00.000Z') // noon EST
    assert.equal(row.time_inferred, true)
    assert.equal(row.needs_review, undefined) // the venue is known
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'selfless-elf-5k-2026') // the slug is reused yearly
    assert.equal(row.is_fundraiser, true)
    assert.equal(row.price_min, null)
    assert.equal(venue, MAIN_VENUE)
  })

  it('the off-site luncheon is at the Knight Center', () => {
    const { row, venue } = buildRow(item('harvest-hunger-campaign-kickoff-luncheon'), parseDetail(OFFSITE))
    assert.equal(row.source_id, 'harvest-hunger-campaign-kickoff-luncheon-2027')
    assert.equal(venue.name, 'John S. Knight Center')
    assert.equal(row.ticket_url, 'https://www.akroncantonfoodbank.org/events/harvest-hunger-campaign-kickoff-luncheon')
  })

  it('the Canton mixer is skipped as out of county', () => {
    assert.deepEqual(buildRow(item('merry-meals-mixer-2026'), parseDetail(CANTON)), { skip: 'out_of_county' })
  })

  it('a single stated time is used, and the row is not flagged for it', () => {
    const { row } = buildRow(item('selfless-elf-5k'), {
      dateStr: '2026-12-19',
      description: 'Race day at the Akron-Canton Regional Foodbank\n350 Opportunity Pkwy, Akron OH 44307\nThe race starts at 8 a.m.',
    })
    assert.equal(row.start_at, '2026-12-19T13:00:00.000Z')
    assert.equal(row.time_inferred, undefined)
  })

  it('no detail date: skipped, never dated from the list\'s "Dec 19"', () => {
    assert.deepEqual(buildRow(item('selfless-elf-5k'), { dateStr: null, description: 'x' }), { skip: 'undatable' })
  })
})

describe('run (dry, stub site)', () => {
  it('plans the two Summit County events and counts the Canton one', async () => {
    const log = console.log; console.log = () => {}
    try {
      const pages = {
        '/upcoming-events': LIST,
        '/events/selfless-elf-5k': AKRON,
        '/events/merry-meals-mixer-2026': CANTON,
        '/events/harvest-hunger-campaign-kickoff-luncheon': OFFSITE,
      }
      const fetchImpl = async (url) => {
        const body = pages[new URL(String(url)).pathname]
        return body ? new Response(body, { status: 200 }) : new Response('missing', { status: 404 })
      }
      const result = await run({ dryRun: true, fetchImpl, now: () => NOW, delayMs: 0 })
      assert.deepEqual(
        { status: result.status, found: result.found, planned: result.planned },
        { status: 'dry-run', found: 3, planned: 2 },
      )
    } finally { console.log = log }
  })
})
