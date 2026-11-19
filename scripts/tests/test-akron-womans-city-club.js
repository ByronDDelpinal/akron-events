/**
 * test-akron-womans-city-club.js — the Akron Woman's City Club scraper.
 * No network, no database.
 * Fixture (captured live 2026-11-19): akron-womans-city-club-events.html.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL ??= 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ??= 'dummy-key'

const { SOURCE_KEY, VENUE, parseEvents, categoriesFor, buildRow, run } = await import('../scrape-akron-womans-city-club.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(resolve(__dirname, 'fixtures', 'akron-womans-city-club-events.html'), 'utf8')
const serve = (body) => async () => ({ ok: true, status: 200, text: async () => body })
const NOW = Date.parse('2026-11-19T15:00:00Z')

describe('the events list', () => {
  it('reads each event with its machine-readable date', () => {
    assert.deepEqual(parseEvents(PAGE), [
      { slug: 'thanksgiving-buffet-awcc-ballroom', url: 'https://www.akronwomanscityclub.org/events/thanksgiving-buffet-awcc-ballroom', title: 'Thanksgiving Buffet: AWCC Ballroom', date: '2026-11-26' },
      { slug: 'victorian-christmas-bazaar-and-theater-performance', url: 'https://www.akronwomanscityclub.org/events/victorian-christmas-bazaar-and-theater-performance', title: 'Victorian Christmas Bazaar and Theater Performance', date: '2026-11-28' },
    ])
  })
  it('a chunk without a date or a link is ignored', () => {
    assert.deepEqual(parseEvents('<div class="chunk clearfix"><h3 class="title"><a href="/events/x">X</a></h3></div>'), [])
  })
})

describe('rows', () => {
  const [buffet, bazaar] = parseEvents(PAGE)
  it('the site gives a date only, so the row is a disclosed noon placeholder at the club', () => {
    const { row, venue } = buildRow(bazaar)
    assert.equal(row.start_at, '2026-11-28T17:00:00.000Z') // noon EST
    assert.equal(row.time_inferred, true)
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'victorian-christmas-bazaar-and-theater-performance-2026-11-28')
    assert.equal(row.price_min, null)
    assert.equal(venue, VENUE)
  })
  it('categories come from the title', () => {
    assert.deepEqual(buildRow(buffet).row.categories, ['food'])
    assert.deepEqual(buildRow(bazaar).row.categories, ['theater'])
    assert.deepEqual(categoriesFor('Holiday Bazaar'), ['market'])
    assert.deepEqual(categoriesFor('Gallery 732 Opening'), ['visual-art'])
    assert.deepEqual(categoriesFor('Town Hall Series: An Evening With'), ['other'])
  })
  it('refuses a listing with no title or date', () => {
    assert.deepEqual(buildRow({ slug: 'x', title: '', date: '2026-11-28' }), { skip: 'invalid' })
  })
})

describe('run (dry)', () => {
  it('plans both upcoming events', async () => {
    const result = await run({ dryRun: true, fetchImpl: serve(PAGE), now: () => NOW })
    assert.equal(result.status, 'dry-run')
    assert.equal(result.planned, 2)
  })
  it('a listing page with no events is an empty run; a page without the listing is an error', async () => {
    const empty = await run({ dryRun: true, fetchImpl: serve('<form><select name="field_event_type_tid"></select></form><div class="view-content"></div>'), now: () => NOW })
    assert.equal(empty.status, 'dry-run')
    assert.equal(empty.found, 0)
    const broken = await run({ dryRun: true, fetchImpl: serve('<h1>Welcome</h1>'), now: () => NOW })
    assert.notEqual(broken.status, 'dry-run')
  })
})
