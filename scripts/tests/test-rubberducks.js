/**test-rubberducks.js*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { F1, F2, ALL } from './fixtures/rubberducks-events.js'

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
