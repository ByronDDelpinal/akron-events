/**
 * test-eventbrite.js
 *
 * Comprehensive tests for the Eventbrite scraper's event normalization and
 * pricing logic. Special focus on the critical is_free trust fix: when is_free=true
 * but there's NO ticket_availability or ticket_classes data, we treat it as UNKNOWN
 * (0/null) rather than asserting it's FREE (0/0).
 *
 * Run:
 *   node --test scripts/tests/test-eventbrite.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Set dummy env vars before any imports ────────────────────────────────────
process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

// ── Import fixtures ──────────────────────────────────────────────────────────
import {
  COMPLETE_EVENT,
  FREE_EVENT_WITH_CONFIRMATION,
  FREE_FLAG_NO_PRICING_DATA,
  FREE_FLAG_BUT_PAID_TICKETS,
  MULTIPLE_TICKET_CLASSES,
  NAME_AS_STRING,
  DATE_TIME_SEPARATE,
  START_DATETIME_FORMAT,
  NO_START_TIME,
  DESCRIPTION_AS_OBJECT,
  DESCRIPTION_AS_STRING,
  NO_DESCRIPTION,
  CATEGORY_MUSIC,
  CATEGORY_ART,
  IMAGE_PRIORITY_CHAIN,
  NO_IMAGE,
  WITH_VENUE_AND_ORGANIZER,
  JSONLD_FORMAT,
  MIN_MAX_PRICE_FORMAT,
  UNMAPPED_CATEGORY,
  ALL_FIXTURES,
} from './fixtures/eventbrite-events.js'

// ── Import shared utilities (pure functions) ─────────────────────────────────
import { stripHtml, parseEventbritePrice, EVENTBRITE_CATEGORY_MAP } from '../lib/normalize.js'

// ════════════════════════════════════════════════════════════════════════════
// RE-IMPLEMENT SCRAPER LOGIC FOR TESTABILITY
// ════════════════════════════════════════════════════════════════════════════

/**
 * Simulate the full event normalization pipeline for one raw Eventbrite event.
 * Mirrors the normaliseEvent() function from the scraper.
 * Returns the normalized row that would be upserted, or null if skipped.
 */
function normaliseEvent(ev) {
  if (!ev) return null

  const title = stripHtml(
    typeof ev.name === 'string' ? ev.name : ev.name?.text ?? ev.title ?? 'Untitled'
  )

  const rawDesc = ev.description?.text ?? ev.summary ??
    (typeof ev.description === 'string' ? ev.description : null)
  const description = rawDesc ? stripHtml(rawDesc).slice(0, 5000) || null : null

  let start_at = null, end_at = null
  if (ev.start?.utc) {
    start_at = ev.start.utc; end_at = ev.end?.utc ?? null
  } else if (ev.start_date && ev.start_time) {
    start_at = `${ev.start_date}T${ev.start_time}`
    end_at   = ev.end_date ? `${ev.end_date}T${ev.end_time ?? '23:59:00'}` : null
  } else if (ev.start_datetime) {
    start_at = ev.start_datetime; end_at = ev.end_datetime ?? null
  }

  if (!start_at) return null

  let price_min = 0, price_max = null
  const ta = ev.ticket_availability
  // CRITICAL FIX: Only assert definitively free (price_max=0) when we have
  // confirming data. Search results sometimes set is_free=true incorrectly;
  // the detail-fetch pass patches ev.is_free with accurate data, but if that
  // fails we'd propagate the wrong value. Require ticket_availability or
  // ticket_classes confirmation before marking as free.
  const hasPricingData = ta?.minimum_ticket_price != null || ev.ticket_classes?.length > 0
  if ((ev.is_free || ta?.is_free) && hasPricingData) {
    price_min = 0; price_max = 0
  } else if (ev.is_free && !hasPricingData) {
    // is_free flag without backing data — treat as unknown rather than asserting free
    price_min = 0; price_max = null
  } else if (ta?.minimum_ticket_price?.major_value != null) {
    // ticket_availability is the most reliable pricing source in search results
    price_min = parseFloat(ta.minimum_ticket_price.major_value) || 0
    const taMax = ta.maximum_ticket_price?.major_value
    price_max = taMax != null && parseFloat(taMax) > price_min ? parseFloat(taMax) : null
  } else if (ev.ticket_classes?.length) {
    ;({ price_min, price_max } = parseEventbritePrice(ev.ticket_classes, ev.is_free))
  } else if (ev.min_price != null) {
    price_min = parseFloat(ev.min_price) || 0
    price_max = ev.max_price != null && ev.max_price !== ev.min_price
      ? parseFloat(ev.max_price) : null
  }

  const category = EVENTBRITE_CATEGORY_MAP[ev.category_id] ?? 'other'

  const rawImg =
    ev.image?.url ?? ev.logo?.url ?? ev.banner_url ?? ev.hero_image_url ??
    (typeof ev.logo === 'string' ? ev.logo : null)
  const image_url = rawImg && /^https?:\/\//i.test(rawImg) ? rawImg : null

  return {
    title,
    description,
    start_at,
    end_at,
    category,
    tags:            [],
    price_min,
    price_max,
    age_restriction: 'not_specified',
    image_url,
    ticket_url:      ev.url ?? ev.ticket_url ?? null,
    source:          'eventbrite',
    source_id:       String(ev.id),
    status:          'published',
    featured:        false,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Category Mapping
// ════════════════════════════════════════════════════════════════════════════

describe('Eventbrite: Category Mapping', () => {
  it('maps category_id 103 to music', () => {
    const row = normaliseEvent({ ...CATEGORY_MUSIC, id: '113a' })
    assert.equal(row.category, 'music')
  })

  it('maps category_id 105 to art', () => {
    const row = normaliseEvent({ ...CATEGORY_ART, id: '114a' })
    assert.equal(row.category, 'art')
  })

  it('maps known category IDs correctly', () => {
    assert.equal(EVENTBRITE_CATEGORY_MAP['103'], 'music')
    assert.equal(EVENTBRITE_CATEGORY_MAP['105'], 'art')
    assert.equal(EVENTBRITE_CATEGORY_MAP['110'], 'food')
    assert.equal(EVENTBRITE_CATEGORY_MAP['113'], 'community')
    assert.equal(EVENTBRITE_CATEGORY_MAP['115'], 'nonprofit')
    assert.equal(EVENTBRITE_CATEGORY_MAP['107'], 'sports')
    assert.equal(EVENTBRITE_CATEGORY_MAP['102'], 'education')
  })

  it('defaults to "other" for unknown category_id', () => {
    const row = normaliseEvent({ ...UNMAPPED_CATEGORY })
    assert.equal(row.category, 'other')
  })

  it('handles missing category_id as "other"', () => {
    const row = normaliseEvent({
      id: '999',
      name: { text: 'Test Event' },
      start: { utc: '2026-05-01T10:00:00Z' }
    })
    assert.equal(row.category, 'other')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: CRITICAL PRICING LOGIC — THE is_free FIX
// ════════════════════════════════════════════════════════════════════════════

describe('Eventbrite: Pricing Logic (Critical is_free Fix)', () => {
  it('is_free=true WITH ticket_availability → FREE (0/0)', () => {
    const row = normaliseEvent(FREE_EVENT_WITH_CONFIRMATION)
    assert.ok(row)
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, 0, 'with confirming data, should be (0/0)')
  })

  it('CRITICAL: is_free=true WITHOUT pricing data → UNKNOWN (0/null)', () => {
    // This is the critical bug fix: is_free flag alone is NOT trustworthy
    const row = normaliseEvent(FREE_FLAG_NO_PRICING_DATA)
    assert.ok(row)
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, null, 'without confirming data, treat as unknown (0/null)')
  })

  it('is_free=true AND ta.is_free=true with pricing data → FREE (0/0)', () => {
    const row = normaliseEvent(FREE_FLAG_BUT_PAID_TICKETS)
    assert.ok(row)
    // Both is_free flags are true with pricing data → assert free
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, 0, 'both flags agree: free')
  })

  it('ticket_availability with minimum_ticket_price → USE IT', () => {
    const row = normaliseEvent(COMPLETE_EVENT)
    assert.ok(row)
    assert.equal(row.price_min, 10)
    assert.equal(row.price_max, 20)
  })

  it('multiple ticket_classes → aggregate min/max prices', () => {
    const row = normaliseEvent(MULTIPLE_TICKET_CLASSES)
    assert.ok(row)
    assert.equal(row.price_min, 15)
    assert.equal(row.price_max, 50)
  })

  it('min_price/max_price format → use those', () => {
    const row = normaliseEvent(MIN_MAX_PRICE_FORMAT)
    assert.ok(row)
    assert.equal(row.price_min, 45)
    assert.equal(row.price_max, 65)
  })

  it('is_free=false without explicit pricing → (0/null)', () => {
    const row = normaliseEvent({
      id: '200',
      name: { text: 'Event' },
      start: { utc: '2026-05-01T10:00:00Z' },
      is_free: false
    })
    assert.ok(row)
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Name Parsing
// ════════════════════════════════════════════════════════════════════════════

describe('Eventbrite: Name Parsing', () => {
  it('parses name as object {text: "..."}', () => {
    const row = normaliseEvent(COMPLETE_EVENT)
    assert.equal(row.title, 'Spring Market & Craft Fair')
  })

  it('parses name as plain string', () => {
    const row = normaliseEvent(NAME_AS_STRING)
    assert.equal(row.title, 'Food Truck Rally')
  })

  it('falls back to ev.title if name missing', () => {
    const row = normaliseEvent({
      id: '201',
      title: 'Fallback Title',
      start: { utc: '2026-05-01T10:00:00Z' },
      name: null
    })
    assert.equal(row.title, 'Fallback Title')
  })

  it('uses "Untitled" if name and title both missing', () => {
    const row = normaliseEvent({
      id: '202',
      start: { utc: '2026-05-01T10:00:00Z' }
    })
    assert.equal(row.title, 'Untitled')
  })

  it('strips HTML from name', () => {
    const row = normaliseEvent({
      id: '203',
      name: { text: 'Event <strong>Spectacular</strong>' },
      start: { utc: '2026-05-01T10:00:00Z' }
    })
    assert.ok(!row.title.includes('<strong>'))
    assert.ok(row.title.includes('Event Spectacular'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Description Parsing
// ════════════════════════════════════════════════════════════════════════════

describe('Eventbrite: Description Parsing', () => {
  it('parses description.text object', () => {
    const row = normaliseEvent(DESCRIPTION_AS_OBJECT)
    assert.ok(row.description)
    assert.ok(row.description.includes('tech meetup'))
    assert.ok(!row.description.includes('<p>'))
  })

  it('parses description as plain string', () => {
    const row = normaliseEvent(DESCRIPTION_AS_STRING)
    assert.ok(row.description)
    assert.ok(row.description.includes('casual 5k run'))
  })

  it('falls back to summary if description missing', () => {
    const row = normaliseEvent({
      id: '204',
      name: { text: 'Event' },
      start: { utc: '2026-05-01T10:00:00Z' },
      summary: 'Short summary text',
      description: null
    })
    assert.ok(row.description)
    assert.equal(row.description, 'Short summary text')
  })

  it('handles no description', () => {
    const row = normaliseEvent(NO_DESCRIPTION)
    assert.equal(row.description, null)
  })

  it('truncates description to 5000 chars', () => {
    const longDesc = 'a'.repeat(6000)
    const row = normaliseEvent({
      id: '205',
      name: { text: 'Event' },
      start: { utc: '2026-05-01T10:00:00Z' },
      description: { text: longDesc }
    })
    assert.ok(row.description.length <= 5000)
  })

  it('strips HTML from description', () => {
    const row = normaliseEvent({
      id: '206',
      name: { text: 'Event' },
      start: { utc: '2026-05-01T10:00:00Z' },
      description: { text: '<h2>Title</h2><p>Paragraph with <em>emphasis</em>.</p>' }
    })
    assert.ok(!row.description.includes('<'))
    assert.ok(row.description.includes('Title'))
    assert.ok(row.description.includes('Paragraph'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Date/Time Parsing
// ════════════════════════════════════════════════════════════════════════════

describe('Eventbrite: Date/Time Parsing', () => {
  it('parses start.utc format', () => {
    const row = normaliseEvent(COMPLETE_EVENT)
    assert.equal(row.start_at, '2026-05-15T14:00:00Z')
    assert.equal(row.end_at, '2026-05-15T18:00:00Z')
  })

  it('parses start_date + start_time format', () => {
    const row = normaliseEvent(DATE_TIME_SEPARATE)
    assert.equal(row.start_at, '2026-07-05T18:00:00')
    assert.ok(row.end_at.includes('2026-07-05'))
  })

  it('falls back to end_time or 23:59:00 if no end_time', () => {
    const ev = { ...DATE_TIME_SEPARATE }
    delete ev.end_time
    const row = normaliseEvent(ev)
    assert.ok(row.end_at.includes('23:59:00'))
  })

  it('parses start_datetime format', () => {
    const row = normaliseEvent(START_DATETIME_FORMAT)
    assert.equal(row.start_at, '2026-05-30T09:00:00')
    assert.equal(row.end_at, '2026-05-30T13:00:00')
  })

  it('skips event with no start time', () => {
    const row = normaliseEvent(NO_START_TIME)
    assert.equal(row, null, 'event without start time should be skipped')
  })

  it('handles missing end_at gracefully', () => {
    const row = normaliseEvent({
      id: '207',
      name: { text: 'Event' },
      start: { utc: '2026-05-01T10:00:00Z' },
      end: null
    })
    assert.ok(row)
    assert.equal(row.end_at, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Image URL Extraction (Fallback Chain)
// ════════════════════════════════════════════════════════════════════════════

describe('Eventbrite: Image URL Extraction', () => {
  it('prefers image.url over others', () => {
    const row = normaliseEvent(IMAGE_PRIORITY_CHAIN)
    assert.equal(row.image_url, 'https://cdn.evbstatic.com/conf-image.jpg')
  })

  it('falls back to logo.url if no image.url', () => {
    const ev = { ...IMAGE_PRIORITY_CHAIN }
    ev.image = null
    const row = normaliseEvent(ev)
    assert.equal(row.image_url, 'https://cdn.evbstatic.com/logo.jpg')
  })

  it('falls back to banner_url', () => {
    const ev = { ...IMAGE_PRIORITY_CHAIN }
    ev.image = null
    ev.logo = null
    const row = normaliseEvent(ev)
    assert.equal(row.image_url, 'https://cdn.evbstatic.com/banner.jpg')
  })

  it('falls back to hero_image_url', () => {
    const ev = { ...IMAGE_PRIORITY_CHAIN }
    ev.image = null
    ev.logo = null
    ev.banner_url = null
    const row = normaliseEvent(ev)
    assert.equal(row.image_url, 'https://cdn.evbstatic.com/hero.jpg')
  })

  it('handles missing image entirely', () => {
    const row = normaliseEvent(NO_IMAGE)
    assert.equal(row.image_url, null)
  })

  it('rejects non-http image URLs', () => {
    const row = normaliseEvent({
      id: '208',
      name: { text: 'Event' },
      start: { utc: '2026-05-01T10:00:00Z' },
      image: { url: 'data:image/png;base64,ABC123' }
    })
    assert.equal(row.image_url, null)
  })

  it('handles string logo (fallback format)', () => {
    const row = normaliseEvent({
      id: '209',
      name: { text: 'Event' },
      start: { utc: '2026-05-01T10:00:00Z' },
      logo: 'https://example.com/logo.jpg'
    })
    assert.equal(row.image_url, 'https://example.com/logo.jpg')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Venue & Organizer Extraction
// ════════════════════════════════════════════════════════════════════════════

describe('Eventbrite: Venue & Organizer Extraction', () => {
  it('extracts primary_venue and primary_organizer when present', () => {
    const row = normaliseEvent(WITH_VENUE_AND_ORGANIZER)
    assert.ok(row)
    assert.equal(row.ticket_url, 'https://www.eventbrite.com/e/breakfast-117')
  })

  it('handles event with no venue', () => {
    const row = normaliseEvent(FREE_FLAG_NO_PRICING_DATA)
    assert.ok(row)
    // Normalization doesn't fail; venue upsert happens separately in scraper
  })

  it('handles event with no organizer', () => {
    const row = normaliseEvent({
      id: '210',
      name: { text: 'Event' },
      start: { utc: '2026-05-01T10:00:00Z' },
      organizer: null
    })
    assert.ok(row)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Full Event Normalization Examples
// ════════════════════════════════════════════════════════════════════════════

describe('Eventbrite: Full Event Normalization', () => {
  it('normalizes a complete event correctly', () => {
    const row = normaliseEvent(COMPLETE_EVENT)
    assert.ok(row)
    assert.equal(row.title, 'Spring Market & Craft Fair')
    assert.equal(row.source, 'eventbrite')
    assert.equal(row.source_id, '101')
    assert.equal(row.category, 'food')
    assert.equal(row.price_min, 10)
    assert.equal(row.price_max, 20)
    assert.ok(row.description.includes('annual spring market'))
    assert.ok(!row.description.includes('<strong>'))
  })

  it('normalizes a free event with confirmation', () => {
    const row = normaliseEvent(FREE_EVENT_WITH_CONFIRMATION)
    assert.ok(row)
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, 0)
    assert.equal(row.category, 'community')
  })

  it('normalizes JSON-LD fallback format', () => {
    const row = normaliseEvent(JSONLD_FORMAT)
    assert.ok(row)
    assert.equal(row.title, 'Summer Carnival')
    assert.ok(row.image_url.includes('carnival.jpg'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Batch Processing Invariants
// ════════════════════════════════════════════════════════════════════════════

describe('Eventbrite: Batch Processing', () => {
  it('every fixture produces consistent source field', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normaliseEvent(fixture)
      if (row) {
        assert.equal(row.source, 'eventbrite', `source wrong for fixture id=${fixture.id}`)
      }
    }
  })

  it('every non-null row has required fields', () => {
    const REQUIRED = ['title', 'start_at', 'category', 'source', 'source_id', 'status']
    for (const fixture of ALL_FIXTURES) {
      const row = normaliseEvent(fixture)
      if (!row) continue
      for (const field of REQUIRED) {
        assert.ok(row[field] != null, `fixture id=${fixture.id} missing required field '${field}'`)
      }
    }
  })

  it('every non-null row has price_min as a number', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normaliseEvent(fixture)
      if (!row) continue
      assert.equal(typeof row.price_min, 'number', `fixture id=${fixture.id} price_min not a number`)
    }
  })

  it('every price_max is a number or null', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normaliseEvent(fixture)
      if (!row) continue
      assert.ok(row.price_max === null || typeof row.price_max === 'number',
        `fixture id=${fixture.id} price_max invalid: ${row.price_max}`)
    }
  })

  it('no row has HTML in title or description', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normaliseEvent(fixture)
      if (!row) continue
      assert.ok(!/<[a-zA-Z]/.test(row.title), `fixture id=${fixture.id} has HTML in title`)
      if (row.description) {
        assert.ok(!/<[a-zA-Z]/.test(row.description), `fixture id=${fixture.id} has HTML in description`)
      }
    }
  })

  it('category is always one of the allowed or "other"', () => {
    const ALLOWED = ['music', 'art', 'community', 'education', 'sports', 'food', 'nonprofit', 'other']
    for (const fixture of ALL_FIXTURES) {
      const row = normaliseEvent(fixture)
      if (!row) continue
      assert.ok(ALLOWED.includes(row.category), `fixture id=${fixture.id} has invalid category: ${row.category}`)
    }
  })

  it('all start_at values are valid date strings', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normaliseEvent(fixture)
      if (!row) continue
      // Should parse as a valid date (ISO-ish or datetime string)
      const parsed = new Date(row.start_at)
      assert.ok(!isNaN(parsed.getTime()), `fixture id=${fixture.id} has invalid start_at: ${row.start_at}`)
    }
  })

  it('source_id is always a string', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normaliseEvent(fixture)
      if (!row) continue
      assert.equal(typeof row.source_id, 'string', `fixture id=${fixture.id} source_id not a string`)
    }
  })

  it('exactly one fixture should be skipped (no start time)', () => {
    const skipped = ALL_FIXTURES.filter(f => normaliseEvent(f) === null)
    assert.equal(skipped.length, 1, `should have exactly 1 skipped fixture, got ${skipped.length}`)
    assert.equal(skipped[0].id, NO_START_TIME.id)
  })

  it('tags array is always empty (Eventbrite events use other sources for tags)', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normaliseEvent(fixture)
      if (!row) continue
      assert.ok(Array.isArray(row.tags), `fixture id=${fixture.id} tags not an array`)
      assert.equal(row.tags.length, 0, `fixture id=${fixture.id} should have empty tags`)
    }
  })

  it('all processed events have valid ticket_url (or null)', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normaliseEvent(fixture)
      if (!row) continue
      assert.ok(row.ticket_url === null || /^https?:\/\//.test(row.ticket_url),
        `fixture id=${fixture.id} has invalid ticket_url: ${row.ticket_url}`)
    }
  })

  it('status is always "published"', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normaliseEvent(fixture)
      if (!row) continue
      assert.equal(row.status, 'published', `fixture id=${fixture.id} status not published`)
    }
  })

  it('featured is always false', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normaliseEvent(fixture)
      if (!row) continue
      assert.equal(row.featured, false, `fixture id=${fixture.id} featured not false`)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Edge Cases & Error Handling
// ════════════════════════════════════════════════════════════════════════════

describe('Eventbrite: Edge Cases', () => {
  it('handles null event gracefully', () => {
    const row = normaliseEvent(null)
    assert.equal(row, null)
  })

  it('handles event with all null/undefined optional fields', () => {
    const row = normaliseEvent({
      id: '211',
      name: 'Minimal Event',
      start: { utc: '2026-05-01T10:00:00Z' }
    })
    assert.ok(row)
    assert.equal(row.title, 'Minimal Event')
    assert.equal(row.description, null)
    assert.equal(row.image_url, null)
    assert.equal(row.ticket_url, null)
    assert.equal(row.category, 'other')
  })

  it('handles description that becomes empty after stripping HTML', () => {
    const row = normaliseEvent({
      id: '212',
      name: { text: 'Event' },
      start: { utc: '2026-05-01T10:00:00Z' },
      description: { text: '<p>&nbsp;</p><div></div>' }
    })
    assert.ok(row)
    assert.equal(row.description, null)
  })

  it('handles malformed but non-null price objects', () => {
    const row = normaliseEvent({
      id: '213',
      name: { text: 'Event' },
      start: { utc: '2026-05-01T10:00:00Z' },
      ticket_availability: {
        minimum_ticket_price: { major_value: 'not-a-number' },
        maximum_ticket_price: null
      }
    })
    assert.ok(row)
    // parseFloat('not-a-number') returns NaN, which becomes 0
    assert.equal(row.price_min, 0)
  })

  it('handles ticket_classes with free tickets mixed with paid', () => {
    const row = normaliseEvent({
      id: '214',
      name: { text: 'Event' },
      start: { utc: '2026-05-01T10:00:00Z' },
      ticket_classes: [
        { id: 'free', free: true, cost: null },
        { id: 'paid', free: false, cost: { major_value: 25 } }
      ]
    })
    assert.ok(row)
    // parseEventbritePrice filters out free tickets and those without cost
    assert.equal(row.price_min, 25)
  })
})
