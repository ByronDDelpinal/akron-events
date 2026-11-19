/**
 * test-twinsburg-library.js — the Twinsburg Public Library (LibCal) scraper.
 * Fetching, pagination and the platform shape helpers are covered in
 * test-libcal.js; this file covers what is Twinsburg's: its vocabulary, its
 * three kinds of `location`, and the run plan. No network, no database.
 *
 * Fixture: scripts/tests/fixtures/twinsburg-library-list.json
 *   Thirteen real rows from the live feed
 *   (GET https://twinsburglibrary.libcal.com/ajax/calendar/list?c=-1
 *   &date=0000-00-00, captured 2026-11-18), inside the real envelope. Rows
 *   were selected WHOLE, by a script, on the criteria below; nothing was
 *   typed or trimmed by hand. The script blanked three fields the scraper
 *   never reads (`org`, `orgurl`, `presenter`: staff and presenter names) and
 *   refuses to write a fixture containing an email address.
 *
 *     17288723  one room; "Teen Afterschool Gaming" → games
 *     17288896  two rooms, comma-joined
 *     17230061  "Story Times" → learning; kids audiences
 *     17267291  "Meeting Rooms 1, 2, and 3"; adults only
 *     17132187  all-day, multi-day, in "Children's Place"
 *     15738545  blank location, in person → the library
 *     17272481  bookmobile stop: "Pinewood Gardens, 8788 Ray Ct., Twinsburg, OH"
 *     17272649  off-site in Reminderville: "Heritage Hall, 3601 Glenwood Blvd., …"
 *     15644874  online_event: true, blank location
 *     15682066  Board of Trustees meeting (governance, skipped)
 *     16806031  "Teen Advisory Board Meeting" (a teen program, kept)
 *     17567226  "Book Groups" → learning
 *     15720661  "Job Seeker Workshop" → learning
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const {
  SOURCE_KEY, MAIN_VENUE, skipReason, mapCategories, parseIsFamily, parseTags,
  resolveVenue, buildRow, planRun, run,
} = await import('../scrape-twinsburg-library.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const ENVELOPE = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/twinsburg-library-list.json'), 'utf8'))
const byId = (id) => ENVELOPE.results.find((e) => e.id === id)
const NOW = Date.parse('2026-11-18T17:00:00Z') // noon Eastern on the capture day

describe('vocabulary', () => {
  it('skips governance and closures, keeps the teen advisory board', () => {
    assert.equal(skipReason(['Board of Trustees Meeting'], 'Twinsburg Public Library Board of Trustees Meeting'), 'governance')
    assert.equal(skipReason(['Teen Events'], 'Teen Advisory Board Meeting'), null)
    assert.equal(skipReason([], 'Library Closed for Thanksgiving'), 'closure')
    assert.equal(skipReason(['Adult Events'], 'Boardgamers of Greater Akron'), null)
  })

  it('maps only the category names that say what a program is', () => {
    assert.deepEqual(mapCategories(['Children Events', 'Story Times']), ['learning'])
    assert.deepEqual(mapCategories(['Teen Afterschool Gaming', 'Teen Events']), ['games'])
    assert.deepEqual(mapCategories(['Book Groups', 'Teen Afterschool Gaming']), ['learning', 'games'])
    assert.deepEqual(mapCategories(['Children Events', 'All Patrons', 'Bookmobile']), [])
  })

  it('is_family is true or undefined, never false', () => {
    assert.equal(parseIsFamily(['Toddlers', 'Preschool']), true)
    assert.equal(parseIsFamily(['Teens']), true)
    assert.equal(parseIsFamily(['Family']), true)
    assert.equal(parseIsFamily(['Adults', 'Seniors']), undefined)
  })

  it('tags name the audiences, free, and online', () => {
    assert.deepEqual(parseTags(['Adults', 'Seniors'], 0, true), ['library', 'twinsburg', 'free', 'adults', 'seniors', 'online'])
    assert.deepEqual(parseTags(['Babies', 'Tweens', 'Teens'], null, false), ['library', 'twinsburg', 'kids', 'teens'])
  })
})

describe('resolveVenue: a room, an address, or nothing we can place', () => {
  it('rooms and a blank location are the library', () => {
    for (const loc of ['Story Time Room A', 'Story Time Room A, Story Time Room B', 'Meeting Rooms 1, 2, and 3', "Children's Place", 'Bissell Local History Room', 'Conference Room', '']) {
      assert.equal(resolveVenue(loc, false).venue, MAIN_VENUE, loc)
    }
  })

  it('an off-site address becomes its own venue', () => {
    assert.deepEqual(resolveVenue('Pinewood Gardens, 8788 Ray Ct., Twinsburg, OH', false), {
      venue: { name: 'Pinewood Gardens', details: { address: '8788 Ray Ct', city: 'Twinsburg', state: 'OH' } },
      needsReview: undefined,
    })
    assert.equal(resolveVenue('Heritage Hall, 3601 Glenwood Blvd., Reminderville, OH', false).venue.details.city, 'Reminderville')
  })

  it('an address in a city outside Summit County drops the row', () => {
    assert.deepEqual(resolveVenue('Solon Community Center, 35000 Portz Pkwy, Solon, OH', false), { venue: null, drop: true })
  })

  it('an online program has no venue, whatever the location says', () => {
    assert.deepEqual(resolveVenue('Meeting Room 1', true), { venue: null })
  })

  it('a place that is neither a room nor an address is never pinned to the library', () => {
    assert.deepEqual(resolveVenue('Liberty Park', false), { venue: null, needsReview: true })
  })
})

describe('buildRow (real feed rows)', () => {
  it('a timed room program', () => {
    const { row, venue } = buildRow(byId(17288723))
    assert.equal(row.title, 'Magic: The Gathering & Trading Card Game Day')
    assert.equal(row.start_at, '2026-11-18T19:30:00.000Z') // 2:30 pm EST
    assert.equal(row.end_at, '2026-11-18T22:00:00.000Z')
    assert.deepEqual(row.categories, ['games'])
    assert.equal(row.price_min, 0)
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'tpl_17288723')
    assert.equal(row.ticket_url, 'https://twinsburglibrary.libcal.com/event/17288723')
    assert.equal(row.status, 'published')
    assert.equal(row.featured, false)
    assert.equal(row.time_inferred, undefined)
    assert.equal(venue, MAIN_VENUE)
  })

  it('an unmapped vocabulary sends no categories key at all', () => {
    assert.equal('categories' in buildRow(byId(17267291)).row, false)
  })

  it('an all-day row gets the noon placeholder and says so', () => {
    const { row } = buildRow(byId(17132187))
    assert.equal(row.start_at, '2026-11-21T17:00:00.000Z') // noon EST
    assert.equal(row.time_inferred, true)
  })

  it('a bookmobile stop is at the stop, not the library', () => {
    const { venue, row } = buildRow(byId(17272481))
    assert.equal(venue.name, 'Pinewood Gardens')
    assert.equal(row.needs_review, undefined)
  })

  it('an online program is venue-less and tagged', () => {
    const { venue, row } = buildRow(byId(15644874))
    assert.equal(venue, null)
    assert.ok(row.tags.includes('online'))
    assert.equal(row.needs_review, undefined)
  })

  it('a trustees meeting is skipped; the teen advisory board is not', () => {
    assert.deepEqual(buildRow(byId(15682066)), { skip: 'governance' })
    assert.equal(buildRow(byId(16806031)).row.title, 'Teen Advisory Board Meeting')
  })

  it('a canceled title is upserted as cancelled so a published copy comes down', () => {
    const { row } = buildRow({ ...byId(17230061), title: 'CANCELED- Family Story Time' })
    assert.equal(row.status, 'cancelled')
    assert.equal(row.source_id, 'tpl_17230061')
  })

  it('rows with no id, no title or no start are invalid', () => {
    assert.deepEqual(buildRow({ title: 'x', startdt: '2026-12-01 10:00:00' }), { skip: 'invalid' })
    assert.deepEqual(buildRow({ id: 1, title: '  ', startdt: '2026-12-01 10:00:00' }), { skip: 'invalid' })
    assert.deepEqual(buildRow({ id: 1, title: 'x', startdt: '' }), { skip: 'invalid' })
  })
})

describe('planRun', () => {
  it('counts every listing and says why each one was left out', () => {
    const plan = planRun(ENVELOPE.results, { nowMs: NOW })
    assert.equal(plan.found, 13)
    assert.equal(plan.rows.length, 12)
    assert.deepEqual(plan.skipped, { governance: 1 })
  })

  it('drops what has passed and what is beyond the horizon', () => {
    const plan = planRun(ENVELOPE.results, { nowMs: Date.parse('2026-11-25T17:00:00Z') })
    assert.ok(plan.skipped.past >= 6)
    assert.ok(plan.rows.every((r) => Date.parse(r.row.start_at) >= Date.parse('2026-11-24T17:00:00Z')))
    const far = planRun([{ ...byId(17230061), startdt: '2027-08-01 10:00:00', enddt: '2027-08-01 10:30:00' }], { nowMs: NOW })
    assert.deepEqual(far.skipped, { beyond_horizon: 1 })
  })
})

describe('run (dry, stub feed)', () => {
  it('fetches, plans and writes nothing', async () => {
    const log = console.log; console.log = () => {}
    try {
      const body = JSON.stringify({ ...ENVELOPE, total_results: ENVELOPE.results.length })
      const urls = []
      const fetchImpl = async (url) => { urls.push(String(url)); return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }) }
      const result = await run({ dryRun: true, fetchImpl, sleep: async () => {}, now: () => NOW })
      assert.equal(result.status, 'dry-run')
      assert.equal(result.found, 13)
      assert.equal(result.planned, 12)
      assert.match(urls[0], /^https:\/\/twinsburglibrary\.libcal\.com\/ajax\/calendar\/list\?c=-1&/)
    } finally { console.log = log }
  })
})
