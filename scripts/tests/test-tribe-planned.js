/**
 * test-tribe-planned.js — the shared Tribe-to-plan builder and the three
 * sources configured on it. No network, no database.
 *
 * Fixtures (captured live 2026-11-19 from each site's REST API, reduced by
 * script to the fields the builder reads):
 *   village-of-silver-lake-events.json   3 community events + one of each kind of meeting
 *   keep-akron-beautiful-events.json     1 timed event with a feed venue
 *   maps-air-museum-events.json          1 all-day event with a price, 1 timed event
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const { buildTribeRow, tribeVenue, collectTribe } = await import('../lib/tribe-planned.js')
const silver = await import('../scrape-village-of-silver-lake.js')
const kab = await import('../scrape-keep-akron-beautiful.js')
const maps = await import('../scrape-maps-air-museum.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const fx = (name) => JSON.parse(readFileSync(resolve(__dirname, 'fixtures', name), 'utf8'))
const SILVER = fx('village-of-silver-lake-events.json')
const KAB = fx('keep-akron-beautiful-events.json')
const MAPS = fx('maps-air-museum-events.json')
const NOW = Date.parse('2026-11-19T15:00:00Z')
const serve = (body, status = 200) => async () => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) })
const byTitle = (feed, re) => feed.events.find((e) => re.test(e.title))

describe('buildTribeRow', () => {
  it('reads a timed event from its LOCAL start and end, as Eastern', () => {
    const { row, venue } = buildTribeRow(byTitle(SILVER, /Tree Lighting/), silver.config)
    assert.equal(row.title, 'Annual Christmas Tree Lighting')
    assert.equal(row.start_at, '2026-12-06T21:30:00.000Z') // 4:30 PM EST
    assert.equal(row.end_at, '2026-12-06T23:30:00.000Z')
    assert.equal('time_inferred' in row, false)
    assert.equal(row.source, 'village_of_silver_lake')
    assert.equal(row.source_id, '17145')
    assert.deepEqual(row.categories, ['festival'])
    assert.equal(venue.name, 'Gazebo on Silver Lake Blvd')
  })

  it('decodes entities in titles', () => {
    assert.equal(buildTribeRow(byTitle(SILVER, /Craft Cafe/), silver.config).row.title, 'Craft Cafe – Flower Pens')
    assert.equal(buildTribeRow(KAB.events[0], kab.config).row.title, 'Beautify & Boogie')
  })

  it('an all-day event gets the noon placeholder and is flagged, with its printed price', () => {
    const { row } = buildTribeRow(byTitle(MAPS, /Go See It/), maps.config)
    assert.equal(row.start_at, '2026-11-21T17:00:00.000Z') // noon EST
    assert.equal(row.time_inferred, true)
    assert.equal(row.price_min, 5)
    assert.equal(row.price_max, 5)
  })

  it('an event with no venue in the feed is published without one', () => {
    const { row, venue } = buildTribeRow(byTitle(SILVER, /Craft Cafe/), silver.config)
    assert.equal(venue, null)
    assert.equal(row.price_min, null)
  })

  it('a feed venue outside Summit County is skipped, unless the source pins its own venue', () => {
    const away = { ...KAB.events[0], venue: { venue: 'Canton Civic Center', address: '1101 Market Ave N', city: 'Canton', zip: '44702' } }
    assert.deepEqual(buildTribeRow(away, kab.config), { skip: 'out_of_county' })
    assert.equal(buildTribeRow({ ...MAPS.events[1], venue: away.venue }, maps.config).venue, maps.VENUE)
  })

  it('refuses an entry with no id, title or start', () => {
    assert.deepEqual(buildTribeRow({ id: 1, title: '' }, kab.config), { skip: 'invalid' })
    assert.deepEqual(buildTribeRow({ title: 'X' }, kab.config), { skip: 'invalid' })
    assert.deepEqual(buildTribeRow({ id: 1, title: 'X', start_date: '' }, kab.config), { skip: 'undatable' })
  })

  it('tribeVenue handles the empty-array shape the API uses for "no venue"', () => {
    assert.equal(tribeVenue({ venue: [] }), null)
    assert.equal(tribeVenue({}), null)
    assert.deepEqual(tribeVenue({ venue: { venue: 'Village Hall', address: '2961 Kent Rd', city: 'Silver Lake', zip: '44224' } }),
      { name: 'Village Hall', details: { address: '2961 Kent Rd', city: 'Silver Lake', state: 'OH', zip: '44224' } })
  })
})

describe('Village of Silver Lake', () => {
  it('drops every kind of government meeting and keeps the community events', async () => {
    const plan = await collectTribe(silver.config, { fetchImpl: serve(SILVER), now: () => NOW })
    assert.equal(plan.found, 8)
    assert.deepEqual(plan.rows.map((r) => r.row.title), ['Annual Christmas Tree Lighting', 'Craft Cafe – Flower Pens', 'Free Seminar – Settling a loved one’s estate'])
    assert.deepEqual(plan.skipped, { government_meeting_or_notice: 5 })
  })

  it('categories', () => {
    assert.deepEqual(silver.categoriesFor('Free Seminar – Settling a loved one’s estate'), ['learning'])
    assert.deepEqual(silver.categoriesFor('Summer Concert at the Gazebo'), ['music'])
    assert.deepEqual(silver.categoriesFor('Community Shred Day'), ['civic'])
  })

  it('dry run', async () => {
    const result = await silver.run({ dryRun: true, fetchImpl: serve(SILVER), now: () => NOW })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.planned, 3)
  })
})

describe('Keep Akron Beautiful', () => {
  it('plans its one upcoming event at the venue the feed names', async () => {
    const plan = await collectTribe(kab.config, { fetchImpl: serve(KAB), now: () => NOW })
    assert.equal(plan.rows.length, 1)
    assert.equal(plan.rows[0].row.start_at, '2027-03-12T23:00:00.000Z') // 6:00 PM EST
    assert.equal(plan.rows[0].venue.name, 'The Carovillese Club')
  })
  it('an empty calendar (the API answers 404 or an empty list) is an empty run, not an error', async () => {
    for (const fetchImpl of [serve({ events: [], total_pages: 1 }), serve({ code: 'rest_no_route' }, 404)]) {
      const result = await kab.run({ dryRun: true, fetchImpl, now: () => NOW })
      assert.equal(result.status, 'dry-run')
      assert.equal(result.found, 0)
      assert.equal(result.exitCode, 0)
    }
  })
  it('a server error is an error run', async () => {
    const result = await kab.run({ dryRun: true, fetchImpl: serve({}, 500), now: () => NOW })
    assert.notEqual(result.status, 'dry-run')
  })
  it('categories', () => {
    assert.deepEqual(kab.categoriesFor('Spring Clean Up Akron'), ['outdoors', 'civic'])
    assert.deepEqual(kab.categoriesFor('Beautify & Boogie'), ['civic'])
  })
})

describe('MAPS Air Museum', () => {
  it('pins both events to the museum and does not apply the city check', async () => {
    const plan = await collectTribe(maps.config, { fetchImpl: serve(MAPS), now: () => NOW })
    assert.equal(plan.rows.length, 2)
    assert.ok(plan.rows.every((r) => r.venue === maps.VENUE))
    assert.equal(maps.VENUE.details.city, 'North Canton') // mailing city; the building is in Summit County
  })
  it('a shopping market is a market; everything else is learning', () => {
    assert.deepEqual(maps.categoriesFor('720 Dec MKT Shopping Party & Santa Photos'), ['market'])
    assert.deepEqual(maps.categoriesFor('Cub Scout & Girl Scout “Go See It” Day'), ['learning'])
  })
})
