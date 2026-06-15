/**
 * test-wix-events.js — shared Wix Events parser (lib/wix-events.js).
 *
 * Run:  node --test scripts/tests/test-wix-events.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  parseWixWarmupEvents, parseWixLocation, normaliseWixEvent, buildWixEventUrl,
} = await import('../lib/wix-events.js')

const WARMUP = {
  appData: { widget1: { events: [
    {
      id: 'abc', title: 'Live Bronze Pour', slug: 'live-bronze-pour',
      description: 'Witness molten metal transform.',
      scheduling: { config: {
        scheduleTbd: false,
        startDate: '2026-06-22T21:00:00.000Z',
        endDate:   '2026-06-22T23:00:00.000Z',
        endDateHidden: false,
      } },
      location: {
        name: 'Myers School of Art',
        coordinates: { lat: 41.0734, lng: -81.5182 },
        address: '150 E Exchange St, Akron, OH 44325, USA',
        fullAddress: { city: 'Akron', subdivision: 'OH', postalCode: '44325' },
      },
    },
    { title: 'Future Show', slug: 'future-show', scheduling: { config: { scheduleTbd: true } }, location: {} },
    // duplicate slug should be ignored
    { title: 'Live Bronze Pour (dup)', slug: 'live-bronze-pour', scheduling: { config: {} } },
  ] } },
}
const HTML = `<html><head><script id="wix-warmup-data" type="application/json">${JSON.stringify(WARMUP)}</script></head><body></body></html>`

describe('parseWixWarmupEvents', () => {
  it('extracts event objects (title+scheduling+slug), de-duped by slug', () => {
    const evs = parseWixWarmupEvents(HTML)
    assert.equal(evs.length, 2)
    assert.deepEqual(evs.map((e) => e.slug).sort(), ['future-show', 'live-bronze-pour'])
  })
  it('returns [] when there is no warmup blob or invalid JSON', () => {
    assert.deepEqual(parseWixWarmupEvents('<html></html>'), [])
    assert.deepEqual(parseWixWarmupEvents('<script id="wix-warmup-data">not json</script>'), [])
  })
})

describe('parseWixLocation', () => {
  it('flattens the Wix location object', () => {
    assert.deepEqual(
      parseWixLocation({
        name: 'Myers School of Art', coordinates: { lat: 41.07, lng: -81.51 },
        address: '150 E Exchange St', fullAddress: { city: 'Akron', subdivision: 'OH', postalCode: '44325' },
      }),
      { name: 'Myers School of Art', address: '150 E Exchange St', city: 'Akron', state: 'OH', zip: '44325', lat: 41.07, lng: -81.51 },
    )
  })
  it('returns null for empty', () => {
    assert.equal(parseWixLocation(null), null)
  })
})

describe('buildWixEventUrl', () => {
  it('builds {site}/event-details/{slug}', () => {
    assert.equal(buildWixEventUrl('https://x.org/', { slug: 'foo' }), 'https://x.org/event-details/foo')
    assert.equal(buildWixEventUrl(null, { slug: 'foo' }), null)
  })
})

describe('normaliseWixEvent', () => {
  const byline = Object.fromEntries(parseWixWarmupEvents(HTML).map((e) => [e.slug, e]))

  it('maps a scheduled event to dated row fields', () => {
    const r = normaliseWixEvent(byline['live-bronze-pour'], {
      source: 'akron_soul_train', siteBaseUrl: 'https://www.akronsoultrain.org',
      mapTags: () => ['art'],
    })
    assert.equal(r.title, 'Live Bronze Pour')
    assert.equal(r.start_at, '2026-06-22T21:00:00.000Z')
    assert.equal(r.end_at, '2026-06-22T23:00:00.000Z')
    assert.equal(r.ticket_url, 'https://www.akronsoultrain.org/event-details/live-bronze-pour')
    assert.equal(r.source_id, 'live-bronze-pour')
    assert.equal(r.price_min, null) // never assume free
    assert.deepEqual(r.tags, ['art'])
    assert.ok(r.description.startsWith('Witness molten metal'))
  })

  it('returns start_at null for a TBD-scheduled event', () => {
    assert.equal(normaliseWixEvent(byline['future-show'], {}).start_at, null)
  })
})
