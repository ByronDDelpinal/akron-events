/**
 * test-akron-dance-festival.js — the curated Heinz Poll Summer Dance Festival
 * source. Verifies the date expansion + row shape (data is hand-entered).
 *
 * Run:  node --test scripts/tests/test-akron-dance-festival.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { buildEvents, PERFORMANCES, SOURCE_KEY } = await import('../scrape-akron-dance-festival.js')

// "Now" before the 2026 season so every performance is upcoming.
const BEFORE = new Date('2026-06-18T12:00:00Z')

describe('buildEvents', () => {
  const events = buildEvents(PERFORMANCES, BEFORE)

  it('expands every company + night into its own event (3 companies x 2 nights)', () => {
    assert.equal(events.length, 6)
  })

  it('builds a free, 8:45pm ET theater event with the right venue + stable id', () => {
    const e = events.find((x) => x.row.source_id === 'ohio-contemporary-ballet-2026-07-24')
    assert.ok(e)
    assert.equal(e.venue, 'Forest Lodge Park')
    assert.equal(e.row.title, 'Ohio Contemporary Ballet — Heinz Poll Summer Dance Festival')
    assert.equal(e.row.category, 'theater')          // dance → theater taxonomy
    assert.equal(e.row.price_min, 0)                 // explicitly free
    assert.equal(e.row.start_at, new Date('2026-07-25T00:45:00Z').toISOString()) // 8:45pm EDT
    assert.equal(e.row.source, SOURCE_KEY)
    assert.ok(e.row.tags.includes('dance') && e.row.tags.includes('free'))
    assert.match(e.row.description, /children's program at 7:45/)
  })

  it('maps each company to its park venue', () => {
    const venues = new Set(events.map((e) => e.venue))
    assert.deepEqual([...venues].sort(), ['Firestone Park', 'Forest Lodge Park', 'Goodyear Heights Metro Park'])
  })

  it('skips performances already in the past', () => {
    const afterSeason = new Date('2026-09-01T12:00:00Z')
    assert.equal(buildEvents(PERFORMANCES, afterSeason).length, 0)
  })
})
