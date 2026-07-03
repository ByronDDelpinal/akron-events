/**test-rubberducks.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { F1, ALL } from './fixtures/rubberducks-events.js'
import { pickPromoImage, pickTicketUrl } from '../scrape-rubberducks.js'

function normalizeGame(game) {
  if (!game.game || !game.date) return null

  return {
    title: game.game,
    source: 'akron_rubberducks',
    source_id: `${game.date}_${game.game}`,
    category: 'sports',
    start_at: `${game.date}T${game.time}:00`,
  }
}

describe('RubberDucks: Game Processing', () => {
  it('normalizes game', () => {
    const row = normalizeGame(F1)
    assert.ok(row)
    assert.equal(row.source, 'akron_rubberducks')
    assert.equal(row.category, 'sports')
  })

  it('skips game without date', () => {
    const row = normalizeGame({ game: 'Test', date: null })
    assert.equal(row, null)
  })
})

describe('RubberDucks: Batch Invariants', () => {
  it('all games have required fields', () => {
    for (const game of ALL) {
      const row = normalizeGame(game)
      assert.ok(row.title)
      assert.ok(row.source)
      assert.ok(row.source_id)
    }
  })
})

// 2026-07-02 rework: the MLB Stats API's field is `imageUrl`, not the
// `thumbnailUrl` the scraper had been reading — every promo image was
// silently dropped. Fixtures below are real shapes from the live API
// (2026-07-01/02 games), including the literal string "undefined" some
// promotions carry instead of omitting the field.
describe('RubberDucks: pickPromoImage', () => {
  it('finds the imageUrl field (not thumbnailUrl)', () => {
    const promos = [{ offerId: 1, name: 'Paws & Claws', imageUrl: 'https://img.mlbstatic.com/milb-images/x' }]
    assert.equal(pickPromoImage(promos), 'https://img.mlbstatic.com/milb-images/x')
  })

  it('skips a promo whose imageUrl is the literal string "undefined"', () => {
    const promos = [
      { offerId: 1, name: 'Los Perros Calientes', imageUrl: 'undefined' },
      { offerId: 2, name: 'Paws & Claws', imageUrl: 'https://img.mlbstatic.com/milb-images/real' },
    ]
    assert.equal(pickPromoImage(promos), 'https://img.mlbstatic.com/milb-images/real')
  })

  it('returns null when no promotion has a usable image', () => {
    assert.equal(pickPromoImage([{ imageUrl: 'undefined' }, { name: 'No image field' }]), null)
    assert.equal(pickPromoImage([]), null)
    assert.equal(pickPromoImage(undefined), null)
  })
})

describe('RubberDucks: pickTicketUrl', () => {
  const tickets = [
    { ticketType: 'wired', ticketLinks: { home: 'https://mlb.tickets.com/?pid=9633285' } },
    { ticketType: 'mobile', ticketLinks: { home: 'https://mlb.tickets.com/?pid=9633285' } },
  ]

  it('prefers the wired (desktop) ticket link', () => {
    assert.equal(pickTicketUrl(tickets), 'https://mlb.tickets.com/?pid=9633285')
  })

  it('falls back to the generic team ticket page when no tickets entry exists yet', () => {
    assert.equal(pickTicketUrl([], 'https://www.milb.com/akron/tickets'), 'https://www.milb.com/akron/tickets')
    assert.equal(pickTicketUrl(undefined, 'https://www.milb.com/akron/tickets'), 'https://www.milb.com/akron/tickets')
  })
})
