/**test-uakron.js - Tests for University of Akron calendar scraper*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { stripHtml } from '../lib/normalize.js'
import { EJ_THOMAS_EVENT, GENERAL_UAKRON_EVENT, SPORTS_EVENT, LECTURE_EVENT, MISSING_TITLE, MISSING_DATE, PAID_EVENT, PERFORMANCE_CONCERT, ALL_FIXTURES } from './fixtures/uakron-events.js'

const KNOWN_VENUES = {
  'E.J. Thomas Performing Arts Hall': { address: '198 Hill St', city: 'Akron', state: 'OH', zip: '44325', lat: 41.0756, lng: -81.5113 },
  'University of Akron': { address: '302 Buchtel Common', city: 'Akron', state: 'OH', zip: '44325', lat: 41.0756, lng: -81.5106 },
}

function parseCategory(ev) {
  const group = (ev.group_title ?? '').toLowerCase()
  const types = (ev.event_types ?? []).map(t => (t.name ?? '').toLowerCase())
  const tags = ev.tags ? (Array.isArray(ev.tags) ? ev.tags.map(t => (t.name ?? '').toLowerCase()) : []) : []
  const all = [...types, ...tags, group]

  if (group.includes('ej thomas') || group.includes('performing arts')) return 'art'
  if (group.includes('music') || group.includes('school of music')) return 'music'
  if (group.includes('art') || group.includes('school of art')) return 'art'
  if (all.some(s => s.includes('athletic') || s.includes('sport') || s.includes('recreation'))) return 'sports'
  if (all.some(s => s.includes('lecture') || s.includes('seminar') || s.includes('workshop') || s.includes('class'))) return 'education'
  if (all.some(s => s.includes('performance') || s.includes('recital') || s.includes('concert'))) {
    if (group.includes('music') || group.includes('school of music')) return 'music'
    return 'art'
  }
  return 'education'
}

function parseTags(ev) {
  const tags = ev.tags ? (Array.isArray(ev.tags) ? ev.tags.map(t => t.name?.toLowerCase()).filter(Boolean) : []) : []
  return [...new Set([...tags, 'university', 'uakron'])]
}

function parsePrice(costStr) {
  if (!costStr) return 0
  const s = costStr.trim().toLowerCase()
  if (!s || s === 'free' || s === 'no charge') return 0
  const m = s.match(/\d+(\.\d+)?/)
  return m ? parseFloat(m[0]) : 0
}

function normalizeEvent(ev) {
  if (!ev.title || !ev.date_iso) return null

  const startAt = new Date(ev.date_iso).toISOString()
  const endAt = ev.date2_iso ? new Date(ev.date2_iso).toISOString() : null

  const category = parseCategory(ev)
  const tags = parseTags(ev)
  const price_min = parsePrice(ev.cost)
  const descText = stripHtml(ev.description ?? '')

  const source = (ev.group_title === 'EJ Thomas Hall') ? 'ejthomas_hall' : 'uakron_calendar'

  return {
    title: ev.title,
    description: descText || null,
    start_at: startAt,
    end_at: endAt,
    category,
    tags,
    price_min,
    price_max: null,
    age_restriction: 'not_specified',
    image_url: ev.thumbnail ?? null,
    ticket_url: ev.url ?? null,
    source,
    source_id: String(ev.id),
    status: 'published',
    featured: false,
  }
}

describe('UAkron: Category Mapping', () => {
  it('maps EJ Thomas to art', () => {
    assert.equal(parseCategory({ group_title: 'EJ Thomas Hall', event_types: [] }), 'art')
  })

  it('maps music school to music', () => {
    assert.equal(parseCategory({ group_title: 'School of Music', event_types: [] }), 'music')
  })

  it('maps athletics to sports', () => {
    assert.equal(parseCategory({ group_title: 'Athletics', event_types: [{ name: 'Athletic Event' }] }), 'sports')
  })

  it('maps lectures to education', () => {
    assert.equal(parseCategory({ group_title: '', event_types: [{ name: 'Lecture' }] }), 'education')
  })
})

describe('UAkron: Price Parsing', () => {
  it('parses free events', () => {
    assert.equal(parsePrice('Free'), 0)
    assert.equal(parsePrice('No charge'), 0)
  })

  it('extracts numeric prices', () => {
    assert.equal(parsePrice('$25'), 25)
    assert.equal(parsePrice('$15.50'), 15.50)
  })

  it('defaults to 0 for null', () => {
    assert.equal(parsePrice(null), 0)
  })
})

describe('UAkron: Event Normalization', () => {
  it('normalizes EJ Thomas event', () => {
    const row = normalizeEvent(EJ_THOMAS_EVENT)
    assert.ok(row)
    assert.equal(row.source, 'ejthomas_hall')
    assert.equal(row.category, 'art')
  })

  it('normalizes general UAkron event', () => {
    const row = normalizeEvent(GENERAL_UAKRON_EVENT)
    assert.ok(row)
    assert.equal(row.source, 'uakron_calendar')
  })

  it('skips event without title', () => {
    const row = normalizeEvent(MISSING_TITLE)
    assert.equal(row, null)
  })

  it('skips event without date', () => {
    const row = normalizeEvent(MISSING_DATE)
    assert.equal(row, null)
  })

  it('parses paid events', () => {
    const row = normalizeEvent(PAID_EVENT)
    assert.ok(row)
    assert.equal(row.price_min, 25)
  })

  it('categorizes performance concerts', () => {
    const row = normalizeEvent(PERFORMANCE_CONCERT)
    assert.ok(row)
    assert.equal(row.category, 'music')
  })
})

describe('UAkron: Batch Processing', () => {
  it('every event has required fields', () => {
    const REQUIRED = ['title', 'start_at', 'source', 'source_id']
    for (const ev of ALL_FIXTURES) {
      const row = normalizeEvent(ev)
      if (!row) continue
      for (const field of REQUIRED) {
        assert.ok(row[field] != null)
      }
    }
  })

  it('all start_at are valid ISO 8601', () => {
    for (const ev of ALL_FIXTURES) {
      const row = normalizeEvent(ev)
      if (!row) continue
      const parsed = new Date(row.start_at)
      assert.ok(!isNaN(parsed.getTime()))
      assert.ok(row.start_at.endsWith('Z'))
    }
  })

  it('source is either ejthomas_hall or uakron_calendar', () => {
    for (const ev of ALL_FIXTURES) {
      const row = normalizeEvent(ev)
      if (!row) continue
      assert.ok(['ejthomas_hall', 'uakron_calendar'].includes(row.source))
    }
  })

  it('tags always include university and uakron', () => {
    for (const ev of ALL_FIXTURES) {
      const row = normalizeEvent(ev)
      if (!row) continue
      assert.ok(row.tags.includes('university'))
      assert.ok(row.tags.includes('uakron'))
    }
  })
})
