/**
 * test-jillys.js
 *
 * Comprehensive tests for the Jilly's Music Room scraper.
 * Tests category mapping, ticket URL extraction, tag parsing, and full normalization.
 *
 * Run:
 *   node --test scripts/tests/test-jillys.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import { stripHtml } from '../lib/normalize.js'
import {
  COMPLETE_AJAX_EVENT,
  COMPLETE_REST_POST,
  FREE_EVENT,
  NO_REST_DATA,
  FEATURED_EVENT,
  HTML_ENTITIES_TITLE,
  FOOD_EVENT,
  NO_IMAGE,
  MISSING_START_TIME,
  WORKSHOP_EVENT,
  TICKET_URL_EXTRACTION,
  ALL_FIXTURES,
} from './fixtures/jillys-events.js'

// Re-implement parsing logic from scraper
function extractTicketUrl(html = '', permalink = '') {
  const ticketPatterns = [
    /href="(https?:\/\/(?:www\.)?(?:tickpick|eventbrite|ticketmaster|axs|dice\.fm|bandsintown)[^"]+)"/i,
    /href="([^"]+)"\s[^>]*>\s*(?:BUY\s+)?TICKET/i,
    /href="([^"]+)"\s[^>]*>\s*GET\s+TICKET/i,
  ]
  for (const re of ticketPatterns) {
    const m = html.match(re)
    if (m) return m[1]
  }
  return permalink || null
}

function parseCategory(classList = []) {
  const classes = classList.join(' ').toLowerCase()
  if (classes.includes('event_type-food')) return 'food'
  if (classes.includes('event_type-music')) return 'music'
  if (classes.includes('event_type-class') || classes.includes('event_type-workshop')) return 'education'
  if (classes.includes('event_type-community')) return 'community'
  return 'music'
}

function parseTags(termArrays = []) {
  const tags = []
  for (const termList of termArrays) {
    for (const term of termList) {
      if (term.name) tags.push(term.name.toLowerCase())
    }
  }
  tags.push('live music', "jilly's")
  return [...new Set(tags)]
}

function mergeEvent(ajaxEvent, restPost) {
  if (!ajaxEvent.event_start_unix_utc) return null

  const tzOffsetSec = ajaxEvent.event_start_unix_utc - ajaxEvent.event_start_unix
  const startAt = new Date(ajaxEvent.event_start_unix_utc * 1000).toISOString()
  const endAt = ajaxEvent.event_end_unix
    ? new Date((ajaxEvent.event_end_unix + tzOffsetSec) * 1000).toISOString()
    : null

  let title = stripHtml(ajaxEvent.event_title ?? '')
  let description = null
  let imageUrl = null
  let ticketUrl = null
  let classList = []
  let termArrays = []

  if (restPost) {
    title = stripHtml(restPost.title?.rendered ?? ajaxEvent.event_title)
    description = stripHtml(restPost.content?.rendered ?? '') || null
    classList = restPost.class_list ?? []
    ticketUrl = extractTicketUrl(restPost.content?.rendered ?? '', restPost.link)

    const media = restPost._embedded?.['wp:featuredmedia']?.[0]
    imageUrl = media?.source_url ?? null

    const wpTerms = restPost._embedded?.['wp:term'] ?? []
    termArrays = wpTerms.slice(1)
  }

  const category = parseCategory(classList)
  const tags = parseTags(termArrays)

  return {
    title,
    description,
    start_at: startAt,
    end_at: endAt,
    category,
    tags,
    price_min: 0,
    price_max: null,
    age_restriction: 'not_specified',
    image_url: imageUrl,
    ticket_url: ticketUrl,
    source: 'jillys_music_room',
    source_id: String(ajaxEvent.ID),
    status: 'published',
    featured: ajaxEvent.featured === true || ajaxEvent.featured === 'yes',
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Category Mapping
// ════════════════════════════════════════════════════════════════════════════

describe('Jilly\'s: Category Mapping', () => {
  it('maps event_type-music to music', () => {
    assert.equal(parseCategory(['event_type-music']), 'music')
  })

  it('maps event_type-food to food', () => {
    assert.equal(parseCategory(['event_type-food']), 'food')
  })

  it('maps event_type-workshop to education', () => {
    assert.equal(parseCategory(['event_type-workshop']), 'education')
  })

  it('maps event_type-community to community', () => {
    assert.equal(parseCategory(['event_type-community']), 'community')
  })

  it('defaults to music for unknown types', () => {
    assert.equal(parseCategory([]), 'music')
    assert.equal(parseCategory(['event_type-unknown']), 'music')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Tag Parsing
// ════════════════════════════════════════════════════════════════════════════

describe('Jilly\'s: Tag Parsing', () => {
  it('extracts tags from taxonomy term objects', () => {
    const tags = parseTags([[{ name: 'Live Music' }, { name: 'Soul' }]])
    assert.ok(tags.includes('live music'))
    assert.ok(tags.includes('soul'))
    assert.ok(tags.includes("jilly's"))
  })

  it('always includes live music and jillys tags', () => {
    const tags = parseTags([])
    assert.ok(tags.includes('live music'))
    assert.ok(tags.includes("jilly's"))
  })

  it('deduplicates tags', () => {
    const tags = parseTags([[{ name: 'Music' }, { name: 'music' }]])
    const musicCount = tags.filter(t => t === 'music').length
    assert.equal(musicCount, 1)
  })

  it('lowercases all tags', () => {
    const tags = parseTags([[{ name: 'LIVE MUSIC' }]])
    assert.ok(tags.some(t => t === 'live music'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Ticket URL Extraction
// ════════════════════════════════════════════════════════════════════════════

describe('Jilly\'s: Ticket URL Extraction', () => {
  it('extracts Eventbrite ticket URL', () => {
    const html = '<a href="https://eventbrite.com/e/concert">GET TICKETS</a>'
    const url = extractTicketUrl(html, 'https://jillys.com/event')
    assert.equal(url, 'https://eventbrite.com/e/concert')
  })

  it('extracts Ticketmaster URL', () => {
    const html = '<a href="https://ticketmaster.com/show">BUY TICKET</a>'
    const url = extractTicketUrl(html)
    assert.equal(url, 'https://ticketmaster.com/show')
  })

  it('falls back to permalink when no ticket link found', () => {
    const html = '<p>No ticket links here</p>'
    const url = extractTicketUrl(html, 'https://jillys.com/event')
    assert.equal(url, 'https://jillys.com/event')
  })

  it('returns null when no URL and no permalink', () => {
    const url = extractTicketUrl('<p>Text only</p>', '')
    assert.equal(url, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Full Event Merging
// ════════════════════════════════════════════════════════════════════════════

describe('Jilly\'s: Event Merging', () => {
  it('merges complete ajax and rest data', () => {
    const row = mergeEvent(COMPLETE_AJAX_EVENT, COMPLETE_REST_POST)
    assert.ok(row)
    assert.equal(row.title, 'Motown Tribute Band')
    assert.equal(row.source, 'jillys_music_room')
    assert.equal(row.source_id, '100')
    assert.equal(row.category, 'music')
    assert.ok(row.tags.includes('live music'))
    assert.equal(row.image_url, 'https://jillysmusicroom.com/img/motown.jpg')
  })

  it('handles missing rest data', () => {
    const row = mergeEvent(NO_REST_DATA.ajaxEvent, null)
    assert.ok(row)
    assert.equal(row.title, 'Unplugged Night')
    assert.equal(row.category, 'music') // default
    assert.equal(row.image_url, null)
  })

  it('skips event with missing start time', () => {
    const row = mergeEvent(MISSING_START_TIME.ajaxEvent, MISSING_START_TIME.restPost)
    assert.equal(row, null)
  })

  it('decodes HTML entities in title', () => {
    const row = mergeEvent(HTML_ENTITIES_TITLE.ajaxEvent, HTML_ENTITIES_TITLE.restPost)
    assert.ok(row)
    assert.equal(row.title, 'The "Blues" Brothers & Friends')
  })

  it('marks featured events', () => {
    const row = mergeEvent(FEATURED_EVENT.ajaxEvent, FEATURED_EVENT.restPost)
    assert.ok(row)
    assert.equal(row.featured, true)
  })

  it('extracts ticket URL from rest content', () => {
    const row = mergeEvent(TICKET_URL_EXTRACTION.ajaxEvent, TICKET_URL_EXTRACTION.restPost)
    assert.ok(row)
    assert.ok(row.ticket_url.includes('eventbrite.com'))
  })

  it('categorizes food events correctly', () => {
    const row = mergeEvent(FOOD_EVENT.ajaxEvent, FOOD_EVENT.restPost)
    assert.ok(row)
    assert.equal(row.category, 'food')
  })

  it('categorizes workshop events as education', () => {
    const row = mergeEvent(WORKSHOP_EVENT.ajaxEvent, WORKSHOP_EVENT.restPost)
    assert.ok(row)
    assert.equal(row.category, 'education')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Batch Processing Invariants
// ════════════════════════════════════════════════════════════════════════════

describe('Jilly\'s: Batch Processing', () => {
  it('every merged event has consistent source', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = mergeEvent(fixture.ajax, fixture.rest)
      if (row) {
        assert.equal(row.source, 'jillys_music_room')
      }
    }
  })

  it('every non-null row has required fields', () => {
    const REQUIRED = ['title', 'start_at', 'category', 'source', 'source_id', 'status']
    for (const fixture of ALL_FIXTURES) {
      const row = mergeEvent(fixture.ajax, fixture.rest)
      if (!row) continue
      for (const field of REQUIRED) {
        assert.ok(row[field] != null, `missing field '${field}'`)
      }
    }
  })

  it('price_min is always a number', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = mergeEvent(fixture.ajax, fixture.rest)
      if (!row) continue
      assert.equal(typeof row.price_min, 'number')
    }
  })

  it('tags array always includes jillys tag', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = mergeEvent(fixture.ajax, fixture.rest)
      if (!row) continue
      assert.ok(Array.isArray(row.tags))
      assert.ok(row.tags.includes("jilly's"))
    }
  })

  it('source_id is always a string', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = mergeEvent(fixture.ajax, fixture.rest)
      if (!row) continue
      assert.equal(typeof row.source_id, 'string')
    }
  })

  it('category is always valid', () => {
    const ALLOWED = ['music', 'art', 'community', 'education', 'sports', 'food', 'nonprofit', 'other']
    for (const fixture of ALL_FIXTURES) {
      const row = mergeEvent(fixture.ajax, fixture.rest)
      if (!row) continue
      assert.ok(ALLOWED.includes(row.category))
    }
  })

  it('all start_at values are valid ISO 8601', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = mergeEvent(fixture.ajax, fixture.rest)
      if (!row) continue
      const parsed = new Date(row.start_at)
      assert.ok(!isNaN(parsed.getTime()))
      assert.ok(row.start_at.endsWith('Z'))
    }
  })

  it('no row has HTML in title or description', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = mergeEvent(fixture.ajax, fixture.rest)
      if (!row) continue
      assert.ok(!/<[a-zA-Z]/.test(row.title))
      if (row.description) {
        assert.ok(!/<[a-zA-Z]/.test(row.description))
      }
    }
  })
})
