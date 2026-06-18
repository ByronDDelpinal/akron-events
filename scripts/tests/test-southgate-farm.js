/**
 * test-southgate-farm.js — Southgate Farm (Wix Events) scraper.
 *
 * The heavy lifting (warmup-data parsing, normalisation) lives in the shared
 * lib/wix-events.js and is covered by test-wix-events.js. Here we lock the
 * scraper-specific config (source key + the single canonical venue) and verify a
 * Southgate-shaped event flows through normaliseWixEvent into the expected row.
 *
 * Run:  node --test scripts/tests/test-southgate-farm.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { SOURCE_KEY, FARM } = await import('../scrape-southgate-farm.js')
const { normaliseWixEvent, parseWixLocation } = await import('../lib/wix-events.js')

describe('Southgate Farm config', () => {
  it('uses the expected source key', () => {
    assert.equal(SOURCE_KEY, 'southgate_farm')
  })
  it('pins to one canonical North Canton venue', () => {
    assert.equal(FARM.name, 'Southgate Farm')
    assert.equal(FARM.address, '6521 Mt Pleasant St NW')
    assert.equal(FARM.city, 'North Canton')
    assert.equal(FARM.state, 'OH')
    assert.equal(FARM.zip, '44720')
  })
})

describe('Southgate Farm event normalisation', () => {
  // Shaped like the live warmup-data objects observed on /events.
  const raw = {
    title: 'Yoga Pop-Up June',
    slug: 'yoga-pop-up-june',
    description: '<p>Flow in the barn, then stay for tea.</p>',
    scheduling: { config: { startDate: '2026-06-24T23:00:00.000Z', endDate: '2026-06-25T00:00:00.000Z', scheduleTbd: false } },
    location: {
      name: 'Southgate Farm Barn',
      address: '6521 Mt Pleasant St NW, North Canton, OH 44720',
      coordinates: { lat: 40.9, lng: -81.4 },
      fullAddress: { city: 'North Canton', subdivision: 'OH', postalCode: '44720' },
    },
  }

  it('produces a dated row with null price and a detail URL', () => {
    const row = normaliseWixEvent(raw, {
      source: SOURCE_KEY,
      mapTags: () => ['southgate-farm', 'farm', 'north-canton'],
      defaultPriceMin: null,
      ageRestriction: 'all_ages',
      siteBaseUrl: 'https://www.southgatefarm.com',
    })
    assert.equal(row.title, 'Yoga Pop-Up June')
    assert.equal(row.source, 'southgate_farm')
    assert.equal(row.source_id, 'yoga-pop-up-june')
    assert.ok(row.start_at.endsWith('Z'))
    assert.equal(row.price_min, null) // never assume free
    assert.equal(row.age_restriction, 'all_ages')
    assert.deepEqual(row.tags, ['southgate-farm', 'farm', 'north-canton'])
    assert.equal(row.ticket_url, 'https://www.southgatefarm.com/event-details/yoga-pop-up-june')
    assert.match(row.description, /Flow in the barn/)
  })

  it('exposes coordinates from the Wix location for the venue pin', () => {
    const loc = parseWixLocation(raw.location)
    assert.equal(loc.lat, 40.9)
    assert.equal(loc.lng, -81.4)
    assert.equal(loc.city, 'North Canton')
  })
})
