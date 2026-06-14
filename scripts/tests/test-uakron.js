/**test-uakron.js - Tests for University of Akron calendar scraper*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { stripHtml } from '../lib/normalize.js'
import { classifySource, isAllDayEntry } from '../scrape-uakron-calendar.js'
import { EJ_THOMAS_EVENT, GENERAL_UAKRON_EVENT, MISSING_TITLE, MISSING_DATE, PAID_EVENT, PERFORMANCE_CONCERT, MYERS_ART_EVENT, CHP_EVENT, NUMERIC_COST_EVENT, TIERED_COST_EVENT, OBJECT_COST_EVENT, ALL_FIXTURES } from './fixtures/uakron-events.js'

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
  // Mirror of scrape-uakron-calendar.js parsePrice(). LiveWhale's cost field
  // can be a string, number, or array depending on the admin's entry.
  if (costStr == null || costStr === '' || costStr === false) return 0

  if (typeof costStr === 'number') {
    return Number.isFinite(costStr) && costStr >= 0 ? costStr : 0
  }

  if (Array.isArray(costStr)) {
    const nums = costStr
      .map(v => typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.]/g, '')))
      .filter(n => Number.isFinite(n) && n >= 0)
    return nums.length ? Math.min(...nums) : 0
  }

  if (typeof costStr !== 'string') return 0

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

  const source = classifySource(ev.group_title)

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

  // ── Non-string cost handling (Simonetti Awards incident, 2026-04-17) ─────
  // LiveWhale's JSON API serialises the cost field by content type. A bare
  // numeric price is emitted as a JSON number; tiered pricing as an array.
  // parsePrice must accept these without calling .trim() on them.
  it('accepts a bare number (no dollar sign in admin entry)', () => {
    assert.equal(parsePrice(45), 45)
    assert.equal(parsePrice(0), 0)
    assert.equal(parsePrice(15.5), 15.5)
  })

  it('rejects negative / non-finite numbers', () => {
    assert.equal(parsePrice(-10), 0)
    assert.equal(parsePrice(NaN), 0)
    assert.equal(parsePrice(Infinity), 0)
  })

  it('takes the minimum of a tiered price array', () => {
    assert.equal(parsePrice([35, 60]), 35)
    assert.equal(parsePrice([60, 35, 100]), 35)
    assert.equal(parsePrice([5]), 5)
  })

  it('parses string entries inside a tiered array', () => {
    assert.equal(parsePrice(['$35', '$60']), 35)
    assert.equal(parsePrice(['alumni: $25', 'guest: $40']), 25)
  })

  it('falls back to 0 for empty or all-invalid arrays', () => {
    assert.equal(parsePrice([]), 0)
    assert.equal(parsePrice(['invalid', null]), 0)
    assert.equal(parsePrice([-5, -10]), 0)
  })

  it('treats objects and booleans as unknown (0)', () => {
    assert.equal(parsePrice({ amount: 50 }), 0)
    assert.equal(parsePrice(true), 0)
    assert.equal(parsePrice(undefined), 0)
  })

  it('does not throw on any of the observed shapes', () => {
    // Regression guard: the incident crashed here with
    // "costStr.trim is not a function".
    assert.doesNotThrow(() => parsePrice(45))
    assert.doesNotThrow(() => parsePrice([35, 60]))
    assert.doesNotThrow(() => parsePrice({ amount: 50 }))
    assert.doesNotThrow(() => parsePrice(null))
    assert.doesNotThrow(() => parsePrice('Free'))
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

  it('routes Myers School of Art to uakron_myers_art', () => {
    const row = normalizeEvent(MYERS_ART_EVENT)
    assert.ok(row)
    assert.equal(row.source, 'uakron_myers_art')
  })

  it('routes Cummings Center to uakron_chp', () => {
    const row = normalizeEvent(CHP_EVENT)
    assert.ok(row)
    assert.equal(row.source, 'uakron_chp')
  })

  it('normalizes event with numeric cost (Simonetti-shape)', () => {
    const row = normalizeEvent(NUMERIC_COST_EVENT)
    assert.ok(row, 'event with cost: 45 should normalize, not throw')
    assert.equal(row.price_min, 45)
  })

  it('normalizes event with tiered array cost', () => {
    const row = normalizeEvent(TIERED_COST_EVENT)
    assert.ok(row, 'event with cost: [35, 60] should normalize')
    assert.equal(row.price_min, 35, 'array cost should use the minimum tier')
  })

  it('normalizes event with object cost (graceful 0)', () => {
    const row = normalizeEvent(OBJECT_COST_EVENT)
    assert.ok(row, 'event with object cost should normalize, not throw')
    assert.equal(row.price_min, 0, 'unknown-shape cost falls back to 0')
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

describe('UAkron: All-day academic-calendar filter', () => {
  // Real shapes pulled from the LiveWhale feed (2026-06-14): these all carry
  // is_all_day:1, a midnight start, and no end time.
  const ALL_DAY_NOISE = [
    { title: 'Summer Hours Begin: 8:00 am - 4:30 pm', date_iso: '2026-06-14T00:00:00-04:00', is_all_day: 1 },
    { title: 'Juneteenth',                            date_iso: '2026-06-19T00:00:00-04:00', is_all_day: 1 },
    { title: 'Day and Evening Classes Begin',         date_iso: '2026-08-24T00:00:00-04:00', is_all_day: 1 },
    { title: 'Commencement',                          date_iso: '2026-08-15T00:00:00-04:00', is_all_day: 1 },
    { title: 'BCAS Summer CORE', description: 'Orientation', location: 'Student Union', is_all_day: 1, date_iso: '2026-06-15T00:00:00-04:00' },
  ]

  it('flags every all-day entry, even one that carries a description', () => {
    for (const ev of ALL_DAY_NOISE) {
      assert.equal(isAllDayEntry(ev), true, `should filter "${ev.title}"`)
    }
  })

  it('keeps timed events (is_all_day falsy)', () => {
    assert.equal(isAllDayEntry({ title: 'Jazz Concert', date_iso: '2026-06-20T19:00:00-04:00', is_all_day: 0 }), false)
    assert.equal(isAllDayEntry({ title: 'Lecture', date_iso: '2026-06-20T14:00:00-04:00' }), false)
    assert.equal(isAllDayEntry(EJ_THOMAS_EVENT), false)
  })

  it('is null-safe', () => {
    assert.equal(isAllDayEntry(null), false)
    assert.equal(isAllDayEntry(undefined), false)
    assert.equal(isAllDayEntry({}), false)
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

  it('source is one of the four known UAkron sub-calendars', () => {
    const VALID = ['ejthomas_hall', 'uakron_myers_art', 'uakron_chp', 'uakron_calendar']
    for (const ev of ALL_FIXTURES) {
      const row = normalizeEvent(ev)
      if (!row) continue
      assert.ok(VALID.includes(row.source), `Unexpected source: ${row.source}`)
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
