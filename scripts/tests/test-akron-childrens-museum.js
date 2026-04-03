/**
 * test-akron-childrens-museum.js
 *
 * Tests for the Akron Children's Museum (Drupal HTML scrape) scraper.
 * Date parsing, time parsing, cost parsing, category mapping,
 * full normalization, and batch invariants.
 *
 * Run:
 *   node --test scripts/tests/test-akron-childrens-museum.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Set dummy env vars before any imports ───────────────────────────────────
process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  parseDateString,
  parseTimeRange,
  parseCost,
  mapCategory,
  normaliseEvent,
} from '../scrape-akron-childrens-museum.js'

import { sanitizeEventText } from '../lib/normalize.js'

import {
  SPECIAL_EVENT,
  RECURRING_EVENT,
  NO_IMAGE,
  FREE_EVENT,
  NO_TIMES,
  NO_DATE_NO_REPEAT,
  RECURRING_SATURDAY,
  HTML_ENTITIES,
  MIXED_COST,
  RELATIVE_IMAGE,
  ALL_FIXTURES,
} from './fixtures/akron-childrens-museum-events.js'

// ════════════════════════════════════════════════════════════════════════════
// parseDateString
// ════════════════════════════════════════════════════════════════════════════

describe('ACM — parseDateString', () => {
  it('parses "April 25, April 26" to first date', () => {
    const result = parseDateString('April 25, April 26', null)
    assert.ok(result)
    assert.ok(result.includes('-04-25'))
  })

  it('parses single date "May 3"', () => {
    const result = parseDateString('May 3', null)
    assert.ok(result)
    assert.ok(result.includes('-05-03'))
  })

  it('parses "June 20"', () => {
    const result = parseDateString('June 20', null)
    assert.ok(result)
    assert.ok(result.includes('-06-20'))
  })

  it('handles recurring "Every Thursday"', () => {
    const result = parseDateString(null, 'Every Thursday')
    assert.ok(result, 'should compute next Thursday')
    const d = new Date(result + 'T00:00:00Z')
    assert.equal(d.getUTCDay(), 4) // Thursday = 4
  })

  it('handles recurring "Every Saturday"', () => {
    const result = parseDateString(null, 'Every Saturday')
    assert.ok(result)
    const d = new Date(result + 'T00:00:00Z')
    assert.equal(d.getUTCDay(), 6) // Saturday = 6
  })

  it('returns null when both date and repeat are null', () => {
    const result = parseDateString(null, null)
    assert.equal(result, null)
  })

  it('returns null for empty strings', () => {
    const result = parseDateString('', '')
    assert.equal(result, null)
  })

  it('prefers specific date over repeat', () => {
    const result = parseDateString('August 15', 'Every Thursday')
    assert.ok(result.includes('-08-15'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// parseTimeRange
// ════════════════════════════════════════════════════════════════════════════

describe('ACM — parseTimeRange', () => {
  it('parses "5:00pm - 8:00pm"', () => {
    const { startTime, endTime } = parseTimeRange('5:00pm - 8:00pm')
    assert.equal(startTime, '17:00:00')
    assert.equal(endTime, '20:00:00')
  })

  it('parses "10:00am - 3:00pm"', () => {
    const { startTime, endTime } = parseTimeRange('10:00am - 3:00pm')
    assert.equal(startTime, '10:00:00')
    assert.equal(endTime, '15:00:00')
  })

  it('parses "11:00am - 11:30am"', () => {
    const { startTime, endTime } = parseTimeRange('11:00am - 11:30am')
    assert.equal(startTime, '11:00:00')
    assert.equal(endTime, '11:30:00')
  })

  it('parses "9:30am - 12:00pm"', () => {
    const { startTime, endTime } = parseTimeRange('9:30am - 12:00pm')
    assert.equal(startTime, '09:30:00')
    assert.equal(endTime, '12:00:00')
  })

  it('returns nulls for null input', () => {
    const { startTime, endTime } = parseTimeRange(null)
    assert.equal(startTime, null)
    assert.equal(endTime, null)
  })

  it('returns nulls for empty string', () => {
    const { startTime, endTime } = parseTimeRange('')
    assert.equal(startTime, null)
    assert.equal(endTime, null)
  })

  it('handles 12:00am correctly (midnight)', () => {
    const { startTime } = parseTimeRange('12:00am - 1:00am')
    assert.equal(startTime, '00:00:00')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// parseCost
// ════════════════════════════════════════════════════════════════════════════

describe('ACM — parseCost', () => {
  it('parses "Free" as free', () => {
    const { price_min, price_max } = parseCost('Free')
    assert.equal(price_min, 0)
    assert.equal(price_max, null)
  })

  it('parses "$10 per person"', () => {
    const { price_min, price_max } = parseCost('$10 per person')
    assert.equal(price_min, 10)
    assert.equal(price_max, null)
  })

  it('parses "$5" alone', () => {
    const { price_min, price_max } = parseCost('$5')
    assert.equal(price_min, 5)
    assert.equal(price_max, null)
  })

  it('parses mixed free + paid cost', () => {
    const { price_min, price_max } = parseCost('Free for members! $8 for non-members, $5 for children')
    assert.equal(price_min, 0)
    assert.equal(price_max, 8)
  })

  it('parses "Cost: Free for members! $8 for regular admission."', () => {
    const { price_min, price_max } = parseCost('Cost: Free for members! $8 for regular admission.')
    assert.equal(price_min, 0)
    assert.equal(price_max, 8)
  })

  it('returns free for null input', () => {
    const { price_min, price_max } = parseCost(null)
    assert.equal(price_min, null)
    assert.equal(price_max, null)
  })

  it('returns free for "Free with admission"', () => {
    const { price_min, price_max } = parseCost('Free with admission')
    assert.equal(price_min, 0)
    assert.equal(price_max, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// mapCategory
// ════════════════════════════════════════════════════════════════════════════

describe('ACM — mapCategory', () => {
  it('maps "Programs" to education', () => {
    assert.equal(mapCategory('Programs'), 'education')
  })

  it('maps "Special Events" to community', () => {
    assert.equal(mapCategory('Special Events'), 'community')
  })

  it('defaults to education for null category', () => {
    assert.equal(mapCategory(null), 'education')
  })

  it('defaults to education for empty string', () => {
    assert.equal(mapCategory(''), 'education')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Full normalization (normaliseEvent)
// ════════════════════════════════════════════════════════════════════════════

describe('ACM — full normalization', () => {
  it('normalises special event with specific dates', () => {
    const row = normaliseEvent(SPECIAL_EVENT)
    assert.ok(row)
    assert.equal(row.source, 'akron_childrens_museum')
    assert.equal(row.title, 'Akron Express Rails & Runways!')
    assert.ok(row.start_at)
    assert.equal(row.status, 'published')
    assert.equal(row.age_restriction, 'all_ages')
  })

  it('normalises recurring event to next occurrence', () => {
    const row = normaliseEvent(RECURRING_EVENT)
    assert.ok(row)
    assert.ok(row.start_at)
    assert.ok(row.tags.includes('recurring'))
  })

  it('returns null for event with no date and no repeat', () => {
    const row = normaliseEvent(NO_DATE_NO_REPEAT)
    assert.equal(row, null)
  })

  it('sets default start time when times are null', () => {
    const row = normaliseEvent(NO_TIMES)
    assert.ok(row)
    assert.ok(row.start_at)
    // Should default to 10:00 ET
    assert.equal(row.end_at, null)
  })

  it('includes family and children tags', () => {
    const row = normaliseEvent(SPECIAL_EVENT)
    assert.ok(row.tags.includes('children'))
    assert.ok(row.tags.includes('family'))
    assert.ok(row.tags.includes('museum'))
    assert.ok(row.tags.includes('akron'))
  })

  it('builds source_id from detail URL path', () => {
    const row = normaliseEvent(SPECIAL_EVENT)
    assert.equal(row.source_id, 'calendar/special-events/allaboardakronexpress2026')
  })

  it('builds source_id from title when no detail URL', () => {
    const row = normaliseEvent(NO_TIMES)
    assert.ok(row.source_id)
    assert.ok(row.source_id.includes('holiday-closure'))
  })

  it('sets ticket_url to detail URL', () => {
    const row = normaliseEvent(SPECIAL_EVENT)
    assert.equal(row.ticket_url, 'https://akronkids.org/calendar/special-events/allaboardakronexpress2026')
  })

  it('maps Programs category to education', () => {
    const row = normaliseEvent(RECURRING_EVENT)
    assert.equal(row.category, 'education')
  })

  it('maps Special Events category to community', () => {
    const row = normaliseEvent(SPECIAL_EVENT)
    assert.equal(row.category, 'community')
  })

  it('parses mixed cost correctly', () => {
    const row = normaliseEvent(MIXED_COST)
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, 8)
  })

  it('handles image URL correctly', () => {
    const row = normaliseEvent(SPECIAL_EVENT)
    assert.ok(row.image_url.startsWith('https://'))
  })

  it('handles null image URL', () => {
    const row = normaliseEvent(NO_IMAGE)
    assert.equal(row.image_url, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// HTML entity handling
// ════════════════════════════════════════════════════════════════════════════

describe('ACM — HTML entity handling', () => {
  it('sanitizeEventText decodes &amp; in title', () => {
    const row = normaliseEvent(HTML_ENTITIES)
    const sanitized = sanitizeEventText(row)
    assert.ok(!sanitized.title.includes('&amp;'))
    assert.ok(sanitized.title.includes('&'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Batch invariants
// ════════════════════════════════════════════════════════════════════════════

describe('ACM — batch invariants', () => {
  it('every fixture normalises without throwing', () => {
    for (const ev of ALL_FIXTURES) {
      assert.doesNotThrow(() => normaliseEvent(ev))
    }
  })

  it('normalised rows have source=akron_childrens_museum', () => {
    for (const ev of ALL_FIXTURES) {
      const row = normaliseEvent(ev)
      if (row) assert.equal(row.source, 'akron_childrens_museum')
    }
  })

  it('normalised rows have non-empty tags', () => {
    for (const ev of ALL_FIXTURES) {
      const row = normaliseEvent(ev)
      if (row) {
        assert.ok(row.tags.length >= 3, `Too few tags for "${ev.title}"`)
      }
    }
  })

  it('no duplicate tags in any row', () => {
    for (const ev of ALL_FIXTURES) {
      const row = normaliseEvent(ev)
      if (row) {
        const unique = new Set(row.tags)
        assert.equal(row.tags.length, unique.size, `Duplicate tags for "${ev.title}"`)
      }
    }
  })

  it('start_at is valid ISO 8601 or row is null', () => {
    for (const ev of ALL_FIXTURES) {
      const row = normaliseEvent(ev)
      if (row && row.start_at) {
        assert.ok(!isNaN(Date.parse(row.start_at)),
          `Invalid start_at for "${ev.title}"`)
      }
    }
  })
})
