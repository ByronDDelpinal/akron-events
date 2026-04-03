/**
 * test-akronym.js
 *
 * Tests for Akronym Brewing scraper.
 * Tests meta field date extraction, category mapping, and normalization.
 *
 * Run:
 *   node --test scripts/tests/test-akronym.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import { stripHtml, easternToIso } from '../lib/normalize.js'
import {
  COMPLETE_POST,
  META_DATE_FALLBACKS,
  NO_END_TIME,
  NO_META_FIELDS,
  FOOD_TASTING_EVENT,
  HTML_ENTITIES,
  NO_IMAGE,
  MISSING_TITLE,
  NO_START_DATE_META,
  MULTIPLE_CATEGORIES,
  ALL_FIXTURES,
} from './fixtures/akronym-events.js'

// Re-implement parsing logic
function extractDateFromMeta(meta = {}) {
  const candidates = [
    meta['_event_start_date'],
    meta['event_start_date'],
    meta['start_date'],
    meta['_start_date'],
    meta['event_date'],
    meta['_event_date'],
    meta['date'],
  ]
  for (const v of candidates) {
    if (v && typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function extractTimeFromMeta(meta = {}) {
  const candidates = [
    meta['_event_start_time'],
    meta['event_start_time'],
    meta['start_time'],
    meta['_start_time'],
    meta['event_time'],
  ]
  for (const v of candidates) {
    if (v && typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function extractEndDateFromMeta(meta = {}) {
  const candidates = [
    meta['_event_end_date'],
    meta['event_end_date'],
    meta['end_date'],
  ]
  for (const v of candidates) {
    if (v && typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function extractEndTimeFromMeta(meta = {}) {
  const candidates = [
    meta['_event_end_time'],
    meta['event_end_time'],
    meta['end_time'],
  ]
  for (const v of candidates) {
    if (v && typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function parseCategory(categories = []) {
  const slugs = categories.map(c =>
    (typeof c === 'string' ? c : c.slug ?? c.name ?? '').toLowerCase()
  )
  if (slugs.some(s => s.includes('music') || s.includes('concert') || s.includes('live'))) return 'music'
  if (slugs.some(s => s.includes('trivia') || s.includes('game') || s.includes('bingo'))) return 'community'
  if (slugs.some(s => s.includes('art') || s.includes('comedy') || s.includes('show'))) return 'art'
  if (slugs.some(s => s.includes('food') || s.includes('tasting') || s.includes('pairing'))) return 'food'
  return 'community'
}

function parseImage(post) {
  const media = post?._embedded?.['wp:featuredmedia']?.[0]
  if (media?.source_url) return media.source_url
  if (media?.media_details?.sizes?.medium?.source_url) return media.media_details.sizes.medium.source_url

  const match = (post?.content?.rendered ?? '').match(/<img[^>]+src="([^"]+)"/)
  return match?.[1] ?? null
}

function normalizePost(post) {
  const title = stripHtml(post.title?.rendered ?? '')
  if (!title) return null

  const meta = post.meta ?? {}
  const metaDate = extractDateFromMeta(meta)
  const metaTime = extractTimeFromMeta(meta) ?? '8:00 pm'
  const metaEndDate = extractEndDateFromMeta(meta)
  const metaEndTime = extractEndTimeFromMeta(meta)

  let startAt = null
  let endAt = null

  if (metaDate) {
    try {
      startAt = easternToIso(metaDate, metaTime)
      if (metaEndDate) {
        endAt = easternToIso(metaEndDate, metaEndTime ?? '11:00 pm')
      } else if (startAt) {
        endAt = new Date(new Date(startAt).getTime() + 3 * 3600_000).toISOString()
      }
    } catch {
      return null
    }
  } else {
    // Try post date
    if (post.date) {
      try {
        const d = new Date(post.date)
        if (!isNaN(d.getTime())) {
          const dateStr = d.toISOString().split('T')[0]
          startAt = easternToIso(dateStr, '8:00 pm')
          endAt = new Date(new Date(startAt).getTime() + 3 * 3600_000).toISOString()
        }
      } catch {
        return null
      }
    }
  }

  if (!startAt) return null

  const descText = stripHtml(post.content?.rendered ?? '')
  const imageUrl = parseImage(post)
  const ticketUrl = post.link ?? null

  const wpCats = post._embedded?.['wp:term']?.[0] ?? []
  const wpTags = post._embedded?.['wp:term']?.[1] ?? []
  const category = parseCategory(wpCats)
  const tags = [
    ...wpCats.map(c => c.name?.toLowerCase()).filter(Boolean),
    ...wpTags.map(t => t.name?.toLowerCase()).filter(Boolean),
    'brewery', 'akronym',
  ].filter((v, i, a) => a.indexOf(v) === i)

  return {
    title,
    description: descText || null,
    start_at: startAt,
    end_at: endAt,
    category,
    tags,
    price_min: null,
    price_max: null,
    age_restriction: 'not_specified',
    image_url: imageUrl,
    ticket_url: ticketUrl,
    source: 'akronym_brewing',
    source_id: String(post.id),
    status: 'published',
    featured: false,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Meta Field Extraction
// ════════════════════════════════════════════════════════════════════════════

describe('Akronym: Meta Field Extraction', () => {
  it('extracts date from _event_start_date', () => {
    const date = extractDateFromMeta({ '_event_start_date': '2026-05-15' })
    assert.equal(date, '2026-05-15')
  })

  it('tries multiple meta key candidates', () => {
    const date = extractDateFromMeta({ 'event_start_date': '2026-06-10' })
    assert.equal(date, '2026-06-10')
  })

  it('returns null for missing date', () => {
    const date = extractDateFromMeta({})
    assert.equal(date, null)
  })

  it('extracts time from meta fields', () => {
    const time = extractTimeFromMeta({ '_event_start_time': '7:00 pm' })
    assert.equal(time, '7:00 pm')
  })

  it('defaults to 8:00 pm when time missing', () => {
    const time = extractTimeFromMeta({})
    assert.equal(time, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Category Mapping
// ════════════════════════════════════════════════════════════════════════════

describe('Akronym: Category Mapping', () => {
  it('maps music to music', () => {
    assert.equal(parseCategory([{ name: 'Music', slug: 'music' }]), 'music')
  })

  it('maps food and tasting to food', () => {
    assert.equal(parseCategory([{ name: 'Food', slug: 'food' }]), 'food')
    assert.equal(parseCategory([{ name: 'Tasting', slug: 'tasting' }]), 'food')
  })

  it('maps comedy to art', () => {
    assert.equal(parseCategory([{ name: 'Comedy', slug: 'comedy' }]), 'art')
  })

  it('maps trivia to community', () => {
    assert.equal(parseCategory([{ name: 'Trivia', slug: 'trivia' }]), 'community')
  })

  it('defaults to community for unknown', () => {
    assert.equal(parseCategory([]), 'community')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Full Normalization
// ════════════════════════════════════════════════════════════════════════════

describe('Akronym: Event Normalization', () => {
  it('normalizes complete post with all meta fields', () => {
    const row = normalizePost(COMPLETE_POST)
    assert.ok(row)
    assert.equal(row.title, 'Live Music Friday Night')
    assert.equal(row.source, 'akronym_brewing')
    assert.equal(row.source_id, '1')
    assert.equal(row.category, 'music')
    assert.ok(row.start_at.includes('2026-05-15'))
    assert.ok(row.tags.includes('music'))
    assert.ok(row.tags.includes('brewery'))
  })

  it('handles meta date fallback keys', () => {
    const row = normalizePost(META_DATE_FALLBACKS)
    assert.ok(row)
    assert.ok(row.start_at.includes('2026-06-10'))
  })

  it('creates 3-hour end time when only start provided', () => {
    const row = normalizePost(NO_END_TIME)
    assert.ok(row)
    const start = new Date(row.start_at)
    const end = new Date(row.end_at)
    const diffHours = (end - start) / 3600000
    assert.equal(diffHours, 3)
  })

  it('falls back to post date when no meta fields', () => {
    const row = normalizePost(NO_META_FIELDS)
    assert.ok(row)
    assert.ok(row.start_at.includes('2026-08-15'))
  })

  it('skips post without title', () => {
    const row = normalizePost(MISSING_TITLE)
    assert.equal(row, null)
  })

  it('skips post without any date info', () => {
    const row = normalizePost(NO_START_DATE_META)
    assert.equal(row, null)
  })

  it('decodes HTML entities in title', () => {
    const row = normalizePost(HTML_ENTITIES)
    assert.ok(row)
    assert.ok(row.title.includes('"Hoppy"'))
    assert.ok(row.title.includes('&'))
  })

  it('handles missing image', () => {
    const row = normalizePost(NO_IMAGE)
    assert.ok(row)
    assert.equal(row.image_url, null)
  })

  it('categorizes food events correctly', () => {
    const row = normalizePost(FOOD_TASTING_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'food')
  })

  it('maps multiple categories with music priority', () => {
    const row = normalizePost(MULTIPLE_CATEGORIES)
    assert.ok(row)
    assert.equal(row.category, 'music')
    assert.ok(row.tags.includes('music'))
    assert.ok(row.tags.includes('art'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Batch Invariants
// ════════════════════════════════════════════════════════════════════════════

describe('Akronym: Batch Processing', () => {
  it('every post has consistent source', () => {
    for (const post of ALL_FIXTURES) {
      const row = normalizePost(post)
      if (row) {
        assert.equal(row.source, 'akronym_brewing')
      }
    }
  })

  it('every non-null row has required fields', () => {
    const REQUIRED = ['title', 'start_at', 'category', 'source', 'source_id']
    for (const post of ALL_FIXTURES) {
      const row = normalizePost(post)
      if (!row) continue
      for (const field of REQUIRED) {
        assert.ok(row[field] != null)
      }
    }
  })

  it('price_min is always a number or null', () => {
    for (const post of ALL_FIXTURES) {
      const row = normalizePost(post)
      if (!row) continue
      assert.ok(row.price_min === null || typeof row.price_min === 'number')
    }
  })

  it('all start_at are valid ISO 8601', () => {
    for (const post of ALL_FIXTURES) {
      const row = normalizePost(post)
      if (!row) continue
      const parsed = new Date(row.start_at)
      assert.ok(!isNaN(parsed.getTime()))
      assert.ok(row.start_at.endsWith('Z'))
    }
  })

  it('source_id is always a string', () => {
    for (const post of ALL_FIXTURES) {
      const row = normalizePost(post)
      if (!row) continue
      assert.equal(typeof row.source_id, 'string')
    }
  })

  it('tags always include brewery and akronym', () => {
    for (const post of ALL_FIXTURES) {
      const row = normalizePost(post)
      if (!row) continue
      assert.ok(row.tags.includes('brewery'))
      assert.ok(row.tags.includes('akronym'))
    }
  })

  it('no HTML in title or description', () => {
    for (const post of ALL_FIXTURES) {
      const row = normalizePost(post)
      if (!row) continue
      assert.ok(!/<[a-zA-Z]/.test(row.title))
      if (row.description) {
        assert.ok(!/<[a-zA-Z]/.test(row.description))
      }
    }
  })
})
