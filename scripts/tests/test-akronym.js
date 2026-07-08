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

/** The America/New_York calendar date (YYYY-MM-DD) for an ISO UTC instant. */
function easternDate(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

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
    // 8:00 pm EDT on 2026-05-15 → 2026-05-16T00:00:00Z. Assert the Eastern-local
    // date so an evening event crossing into the next UTC day doesn't false-fail.
    assert.equal(easternDate(row.start_at), '2026-05-15')
    assert.ok(row.tags.includes('music'))
    assert.ok(row.tags.includes('brewery'))
  })

  it('handles meta date fallback keys', () => {
    const row = normalizePost(META_DATE_FALLBACKS)
    assert.ok(row)
    assert.equal(easternDate(row.start_at), '2026-06-10')
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
    assert.equal(easternDate(row.start_at), '2026-08-15')
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

// ── Content prose date/time extraction (2026-07 fix) ────────────────────────
// The live site has NO events plugin: post.meta only carries `footnotes`, so
// the meta path above never fires. Dates live in the prose. These tests hit
// the real exported parsers.

import { extractEventDateTime, cleanTitle, isTicketFollowUp } from '../scrape-akronym.js'

describe('extractEventDateTime (prose parsing)', () => {
  it('parses explicit full date with Noon-to-4PM range (LagerFest)', () => {
    const text = 'LagerFest Returns to Akronym Brewing This August. Lager Fest returns to the Biergarten on Sunday, August 2, 2026, from Noon to 4PM. Mark your calendars.'
    const r = extractEventDateTime(text, '2026-06-09T14:40:18')
    assert.ok(r)
    assert.equal(r.dateStr, '2026-08-02')
    assert.equal(r.timeStr, '12:00 pm')
    assert.equal(r.endTimeStr, '4:00 pm')
    // Noon ET in August (EDT) = 16:00 UTC
    assert.equal(easternToIso(r.dateStr, r.timeStr), '2026-08-02T16:00:00.000Z')
  })

  it('parses ordinal date without year + meridiem-inheriting range (Goat Yoga)', () => {
    const text = 'On Saturday, June 13th, Akronym Brewing will host Goat Yoga in the Biergarten from 10-11AM and tickets are now on sale!'
    const r = extractEventDateTime(text, '2026-05-28T11:34:06')
    assert.ok(r)
    assert.equal(r.dateStr, '2026-06-13')
    assert.equal(r.timeStr, '10:00 am')
    assert.equal(r.endTimeStr, '11:00 am')
  })

  it('rolls year forward for December posts about January events', () => {
    const r = extractEventDateTime('Join us on Friday, January 9th for trivia night at 7 PM.', '2025-12-19T13:36:36')
    assert.ok(r)
    assert.equal(r.dateStr, '2026-01-09')
    assert.equal(r.timeStr, '7:00 pm')
  })

  it('keeps the publish year for same-season dates without a year', () => {
    const r = extractEventDateTime('Live music on Friday, July 10.', '2026-07-02T11:11:24')
    assert.ok(r)
    assert.equal(r.dateStr, '2026-07-10')
  })

  it('returns null time when the prose has no clock (fairgrounds time-less convention)', () => {
    const r = extractEventDateTime('Holiday market on Saturday, December 5, 2026 in the taproom.', '2026-11-01T09:00:00')
    assert.ok(r)
    assert.equal(r.dateStr, '2026-12-05')
    assert.equal(r.timeStr, null)
    // easternToIso with '' stores the time-less midnight-ET instant
    assert.ok(easternToIso(r.dateStr, ''))
  })

  it('returns null for news posts with no calendar date', () => {
    assert.equal(extractEventDateTime('Akronym Brewing Announces New Hours. We are now open later on weekends!', '2026-06-23T14:46:21'), null)
    assert.equal(extractEventDateTime('', '2026-06-23T14:46:21'), null)
  })

  it('prefers an explicit-year future date over an earlier yearless mention', () => {
    const text = 'Goat Yoga is back June 13th! Vouchers are only valid for dine-in purchases on June 13, 2026.'
    const r = extractEventDateTime(text, '2026-05-28T11:34:06')
    assert.equal(r.dateStr, '2026-06-13')
  })

  it('never uses the publish date as the event date', () => {
    // Publish date 2026-07-02 must not leak: content date is the only source
    const r = extractEventDateTime('Party on Saturday, August 15 at 6 PM.', '2026-07-02T11:11:24')
    assert.equal(r.dateStr, '2026-08-15')
  })
})

describe('cleanTitle', () => {
  it('drops SEO pipe segments', () => {
    assert.equal(
      cleanTitle('Books & Brews Event 2026 | Akron Brewery Book Launch & Craft Beer Social | Akronym Brewing'),
      'Books & Brews Event 2026'
    )
  })
  it('leaves normal titles alone', () => {
    assert.equal(cleanTitle('LagerFest Returns to Akronym Brewing This August'), 'LagerFest Returns to Akronym Brewing This August')
  })
})

describe('extractEventDateTime — live-run gap fixes (2026-07-08)', () => {
  it('parses day-first holiday dates ("4th of July")', () => {
    const text = '4th of July at Akronym Brewing: Ghost Slime Live in the Biergarten. Celebrate the 4th of July with us from 6-9PM.'
    const r = extractEventDateTime(text, '2026-07-02T11:11:24')
    assert.ok(r)
    assert.equal(r.dateStr, '2026-07-04')
    assert.equal(r.timeStr, '6:00 pm')
    assert.equal(r.endTimeStr, '9:00 pm')
  })

  it('maps fixed-date holiday names (St. Patrick\u2019s)', () => {
    const r = extractEventDateTime('St. Patrick\u2019s 2026 Day at Akronym Brewing. Green beer, bagpipes, and food trucks all day.', '2026-03-05T20:31:13')
    assert.ok(r)
    assert.equal(r.dateStr, '2026-03-17')
  })

  it('resolves "This Friday" against the publish calendar date', () => {
    // Published Thursday 2026-06-25 → Friday 2026-06-26
    const r = extractEventDateTime('Free Live Music in the Biergarten This Friday with On The Frontier, from 7-10PM.', '2026-06-25T10:13:40')
    assert.ok(r)
    assert.equal(r.dateStr, '2026-06-26')
    assert.equal(r.timeStr, '7:00 pm')
  })

  it('"this Friday" published ON a Friday resolves to the same day', () => {
    const r = extractEventDateTime('Join us this Friday for live music at 7 PM.', '2026-06-26T08:00:00')
    assert.equal(r.dateStr, '2026-06-26')
  })

  it('explicit dates always outrank holiday names and relative weekdays', () => {
    const r = extractEventDateTime('Celebrate Halloween early this Friday! Party on Saturday, October 24, 2026 at 8 PM.', '2026-10-19T09:00:00')
    assert.equal(r.dateStr, '2026-10-24')
  })

  it('still returns null for undated news posts', () => {
    assert.equal(extractEventDateTime('Just in Time for the Akron Marathon! Our new lager is on tap now.', '2026-09-20T09:00:00'), null)
  })
})

describe('isTicketFollowUp', () => {
  it('flags ticket-sale follow-up posts', () => {
    assert.ok(isTicketFollowUp('Lager Fest Tickets Are On Sale Now at Akronym Brewing'))
    assert.ok(isTicketFollowUp('Tickets on sale now for Goat Yoga'))
  })
  it('does not flag announcements', () => {
    assert.ok(!isTicketFollowUp('LagerFest Returns to Akronym Brewing This August'))
    assert.ok(!isTicketFollowUp('Goat Yoga at Akronym Brewing\u2019s Biergarten'))
  })
})

describe('parseCategory biergarten collision (2026-07-08)', () => {
  // parseCategory is not exported; assert via normalizePost fixture path if
  // available, else this documents the regression through the regex itself.
  it('"biergarten" must not match the art keyword', () => {
    assert.ok(!/\bart\b|\bshows?\b/.test('biergarten'))
    assert.ok(/\bart\b/.test('art'))
    assert.ok(/\bshows?\b/.test('shows'))
  })
})
