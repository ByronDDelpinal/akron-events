/**
 * test-mustard-seed.js — pure-helper coverage for the Mustard Seed (EventON)
 * scraper: list-HTML parsing, location/type slug extraction, venue + category
 * mapping, and row construction. The Puppeteer render and WP REST fetch are
 * integration concerns and aren't unit-tested here.
 *
 * Run:  node --test scripts/tests/test-mustard-seed.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  parseEventonList, locationSlug, typeSlug, venueForLocation, mapCategory, buildRow, SOURCE_KEY,
} = await import('../scrape-mustard-seed.js')

// A trimmed EventON list fragment: two events + one malformed block (no time).
const LIST_HTML = `
<div class="eventon_list_event scheduled event clrW event_28581_2" data-event_id="28581" data-time="1780792200-1780799400">
  <a href="https://www.mustardseedmarket.com/events/soulshine-6/"><span itemprop="name">Soulshine</span></a>
</div>
<div class="eventon_list_event scheduled event event_29181_2" data-event_id="29181" data-time="1781397000-1781404200">
  <span class="evcal_event_title">Mo MoJo</span>
</div>
<div class="eventon_list_event broken" data-event_id="999">no time here</div>
`

describe('Mustard Seed parseEventonList', () => {
  it('extracts id, start/end unix, and title from each valid block', () => {
    const evs = parseEventonList(LIST_HTML)
    assert.equal(evs.length, 2)
    assert.deepEqual(evs[0], { id: '28581', start: 1780792200, end: 1780799400, title: 'Soulshine' })
    assert.equal(evs[1].id, '29181')
    assert.equal(evs[1].title, 'Mo MoJo')           // falls back to evcal_event_title
  })

  it('skips blocks without a data-time', () => {
    assert.ok(!parseEventonList(LIST_HTML).some((e) => e.id === '999'))
  })

  it('returns [] for empty/invalid input', () => {
    assert.deepEqual(parseEventonList(''), [])
    assert.deepEqual(parseEventonList(null), [])
  })
})

describe('Mustard Seed slug extraction', () => {
  it('pulls the event_location / event_type slug from a class_list', () => {
    const cl = ['post-1', 'event_location-highland-square-cafe', 'event_type-music']
    assert.equal(locationSlug(cl), 'highland-square-cafe')
    assert.equal(typeSlug(cl), 'music')
  })
  it('returns null when absent', () => {
    assert.equal(locationSlug(['post-1']), null)
    assert.equal(typeSlug([]), null)
  })
})

describe('Mustard Seed venueForLocation', () => {
  it('maps Montrose slugs to the Montrose store', () => {
    const v = venueForLocation('montrose-cafe')
    assert.match(v.name, /Montrose/)
    assert.equal(v.details.address, '3885 W Market St')
    assert.equal(v.details.neighborhood_slug, undefined)
  })
  it('defaults everything else to the Highland Square café', () => {
    for (const slug of ['highland-square-cafe', 'something-else', null]) {
      const v = venueForLocation(slug)
      assert.match(v.name, /Highland Square/)
      assert.equal(v.details.address, '867 W Market St')
      assert.equal(v.details.neighborhood_slug, 'highland-square')
    }
  })
})

describe('Mustard Seed mapCategory', () => {
  it('music for music/concert/live types', () => {
    assert.equal(mapCategory('music'), 'music')
    assert.equal(mapCategory('live-music'), 'music')
  })
  it('learning for classes and lectures', () => {
    assert.equal(mapCategory('cooking-class'), 'learning')
    assert.equal(mapCategory('lecture-series'), 'learning')
  })
  it('null (defer to inference) otherwise', () => {
    assert.equal(mapCategory('tasting'), null)
    assert.equal(mapCategory(null), null)
  })
})

describe('Mustard Seed buildRow', () => {
  const entry = { id: '28581', start: 1780792200, end: 1780799400, title: 'Soulshine' }

  it('builds a full row joining date entry + REST meta', () => {
    const { row, venue } = buildRow(entry, {
      title: 'Soulshine',
      link: 'https://www.mustardseedmarket.com/events/soulshine-6/',
      class_list: ['event_location-highland-square-cafe', 'event_type-music'],
      image_url: 'https://www.mustardseedmarket.com/wp-content/uploads/soulshine.jpg',
    })
    assert.equal(row.title, 'Soulshine')
    assert.equal(row.category, 'music')
    assert.equal(row.start_at, new Date(1780792200 * 1000).toISOString())
    assert.equal(row.end_at, new Date(1780799400 * 1000).toISOString())
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'mustard_seed_28581_1780792200')
    assert.equal(row.price_min, null)
    assert.equal(row.price_max, null)
    assert.ok(row.tags.includes('mustard-seed'))
    assert.match(venue.name, /Highland Square/)
  })

  it('routes Montrose events to the Montrose venue', () => {
    const { venue } = buildRow(entry, { title: 'Wine Tasting', class_list: ['event_location-montrose'] })
    assert.match(venue.name, /Montrose/)
  })

  it('returns null without a title or start', () => {
    assert.equal(buildRow({ id: '1', start: 0 }, { title: 'x' }), null)
    assert.equal(buildRow({ id: '1', start: 123 }, { title: '' }), null)
  })
})
