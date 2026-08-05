/**
 * test-gather-round-games.js
 *
 * Gather Round Games moved from Wix Bookings to the Wix Events app (2026-08).
 * The scraper now reads lib/wix-events.js and keeps only community play nights.
 * These tests pin the allowlist against the REAL titles observed on the live
 * /event-list page and check the Wix→row mapping (source, category, tags,
 * ticket url, slug).
 *
 * Run:  node --test scripts/tests/test-gather-round-games.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { isCommunityNight, buildTags, SOURCE_KEY } = await import('../scrape-gather-round-games.js')
const { normaliseWixEvent } = await import('../lib/wix-events.js')

// Titles observed on the live /event-list page. Community nights are kept; the
// set-launch / product events are dropped.
const LIVE_TITLES = [
  ['Lorcana: Attack of the Vine League Play', true],
  ['Tarkir Dragonstorm Draft',                false],
  ['The Hobbit: Prerelease',                  false],
  ['Vendetta Pre-Rift Event',                 false],
  ['The Hobbit: Two Headed Giant Commander',  false],
  ['The Hobbit: Commander Party',             false],
  ['Pokemon Trade Night',                     true],
  ['The Hobbit: Heart of the Mountain Event', false],
]

describe('gather round: isCommunityNight (community nights only)', () => {
  for (const [title, keep] of LIVE_TITLES) {
    it(`${keep ? 'KEEPS' : 'drops'}: ${title}`, () => {
      assert.equal(isCommunityNight(title), keep)
    })
  }
  it('keeps other standing-night phrasings; drops product events', () => {
    assert.equal(isCommunityNight('Friday Night Magic'), true)
    assert.equal(isCommunityNight('FNM: Standard'), true)
    assert.equal(isCommunityNight('Board Game Night'), true)
    assert.equal(isCommunityNight('Learn to Play Magic'), true)
    assert.equal(isCommunityNight('Marvel Two Headed Giant Prerelease'), false)
    assert.equal(isCommunityNight(''), false)
    assert.equal(isCommunityNight(null), false)
  })
})

describe('gather round: buildTags', () => {
  it('tags by game', () => {
    assert.deepEqual(buildTags('Pokemon Trade Night', 'trading and prizes').sort(),
      ['game-night', 'pokemon', 'tabletop', 'tcg', 'trading'].sort())
    assert.ok(buildTags('Lorcana: Attack of the Vine League Play', '').includes('lorcana'))
    assert.ok(buildTags('Friday Night Magic', '').includes('magic-the-gathering'))
  })
})

describe('gather round: Wix event → row mapping', () => {
  const ev = {
    title: 'Pokemon Trade Night',
    slug: 'pokemon-trade-night-1',
    description: 'Join us for a fun night of trading, prizes, deals, and pizza!',
    scheduling: { config: { startDate: '2026-08-29T21:00:00.000Z', endDate: '2026-08-30T00:00:00.000Z' } },
    location: { name: 'Gather Round Games', address: '121 Ghent Rd, Fairlawn, OH 44333, USA' },
  }
  const row = normaliseWixEvent(ev, {
    source: SOURCE_KEY,
    mapCategory: () => 'games',
    mapTags: (e) => buildTags(e.title, e.description),
    ageRestriction: 'all_ages',
    siteBaseUrl: 'https://www.grgcollect.com',
  })

  it('maps source/category/tags/status', () => {
    assert.equal(row.source, 'gather_round_games')
    assert.equal(row.category, 'games')
    assert.equal(row.status, 'published')
    assert.equal(row.featured, false)
    assert.ok(row.tags.includes('pokemon') && row.tags.includes('trading'))
  })
  it('start_at from Wix schedule; slug source_id; event-details ticket url', () => {
    assert.equal(row.start_at, '2026-08-29T21:00:00.000Z')
    assert.equal(row.source_id, 'pokemon-trade-night-1')
    assert.ok(/\/event-details\/pokemon-trade-night-1$/.test(row.ticket_url))
  })
  it('price left null (RSVP events state no fee)', () => {
    assert.equal(row.price_min, null); assert.equal(row.price_max, null)
  })
})
