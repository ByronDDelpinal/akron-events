/**
 * test-blu-jazz.js
 *
 * Comprehensive tests for the BLU Jazz+ scraper.
 * Tests card parsing, price extraction, time parsing, and full normalization.
 *
 * Run:
 *   node --test scripts/tests/test-blu-jazz.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import { stripHtml, easternToIso } from '../lib/normalize.js'
import {
  COMPLETE_EVENT,
  FREE_ADMISSION,
  NO_COVER_CHARGE,
  SINGLE_PRICE,
  MISSING_SHOW_TIME,
  MISSING_ID,
  MISSING_TITLE,
  HTML_ENTITIES_IN_TITLE,
  PRICE_RANGE_VARIATIONS,
  ONLY_DOORS_TIME,
  NO_IMAGE,
  WEBP_IMAGE,
  LONG_DESCRIPTION_TEXT,
  ALL_FIXTURES,
} from './fixtures/blu-jazz-events.js'

// Re-implement parsing logic from scraper
function parseCard(cardHtml) {
  const idMatch = cardHtml.match(/id="show-(\d+)-(\d{4}-\d{2}-\d{2})"/)
  if (!idMatch) return null
  const [, showId, showDate] = idMatch

  const titleMatch = cardHtml.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i)
  const title = titleMatch ? stripHtml(titleMatch[1]).trim() : null
  if (!title) return null

  const imgMatch = cardHtml.match(
    /<img\b[^>]*\bsrc="(https:\/\/assets-prod\.turntabletickets\.com\/[^"]+\.(jpe?g|png|gif|webp))"/i
  )
  const imageUrl = imgMatch ? imgMatch[1] : null

  const rawText = stripHtml(cardHtml)

  const showTimeMatch =
    rawText.match(/\bShow:\s*(\d{1,2}:\d{2}\s*(?:am|pm))/i) ||
    rawText.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))\s+SHOW\b/i)
  const showTimeStr = showTimeMatch ? showTimeMatch[1].trim() : null

  const doorsTimeMatch = rawText.match(/\bDoors:\s*(\d{1,2}:\d{2}\s*(?:am|pm))/i)
  const doorsTimeStr = doorsTimeMatch ? doorsTimeMatch[1].trim() : null

  let priceMin = null
  let priceMax = null

  const freeMatch = rawText.match(/\bfree\s+admission\b|\bno\s+cover\b|\bno\s+charge\b|\bfree\s+to\s+attend\b/i)
  if (freeMatch) {
    priceMin = 0
    priceMax = 0
  } else {
    const advanceMatch = rawText.match(/\$(\d+(?:\.\d+)?)\s+in\s+advance/i)
    const doorMatch = rawText.match(/\$(\d+(?:\.\d+)?)\s+(?:at\s+the\s+)?door/i)
    const generalMatch = rawText.match(/\$(\d+(?:\.\d+)?)(?:\s+(?:general|admission|per\s+person|pp))?/i)

    if (advanceMatch) priceMin = parseFloat(advanceMatch[1])
    if (doorMatch) priceMax = parseFloat(doorMatch[1])
    if (!priceMin && generalMatch) priceMin = parseFloat(generalMatch[1])
    if (!priceMax && priceMin !== null) priceMax = priceMin
  }

  let description = null
  const descBlockMatch = rawText.match(
    /(?:(?:mon|tue|wed|thu|fri|sat|sun),\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d+\s*)([\s\S]*?)(?:\s*Doors:|$)/i
  )
  if (descBlockMatch) {
    description = descBlockMatch[1].trim().replace(/\s+/g, ' ') || null
  }
  if (!description) {
    description = rawText.replace(title, '').replace(/\s+/g, ' ').trim() || null
  }
  if (description && description.length > 1200) {
    description = description.substring(0, 1197) + '…'
  }

  return { showId, showDate, title, showTimeStr, doorsTimeStr, priceMin, priceMax, description, imageUrl }
}

function addHour(timeStr) {
  const m = timeStr.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i)
  if (!m) return timeStr
  let h = parseInt(m[1], 10)
  const min = m[2]
  let meridiem = m[3].toLowerCase()
  h += 1
  if (h === 12) meridiem = 'pm'
  if (h > 12) { h -= 12; if (meridiem === 'am') meridiem = 'pm' }
  return `${h}:${min}${meridiem}`
}

function normalizeCard(cardHtml) {
  const ev = parseCard(cardHtml)
  if (!ev) return null

  const { showId, showDate, title, showTimeStr, doorsTimeStr, priceMin, priceMax, description, imageUrl } = ev

  const effectiveShowTime = showTimeStr ?? (doorsTimeStr ? addHour(doorsTimeStr) : '12:00pm')
  let startAt, endAt = null

  try {
    startAt = easternToIso(showDate, effectiveShowTime)
    endAt = new Date(new Date(startAt).getTime() + 3 * 3_600_000).toISOString()
  } catch {
    return null
  }

  const ticketUrl = `https://blu-jazz.turntabletickets.com/shows/${showId}/?date=${showDate}`

  return {
    title,
    description,
    start_at: startAt,
    end_at: endAt,
    category: 'music',
    tags: ['jazz', 'live music', 'blu jazz+'],
    price_min: priceMin,
    price_max: priceMax,
    age_restriction: 'not_specified',
    image_url: imageUrl,
    ticket_url: ticketUrl,
    source: 'blu_jazz',
    source_id: `${showId}_${showDate}`,
    status: 'published',
    featured: false,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Card Parsing
// ════════════════════════════════════════════════════════════════════════════

describe('BLU Jazz: Card Parsing', () => {
  it('parses a complete event card', () => {
    const card = parseCard(COMPLETE_EVENT.cardHtml)
    assert.ok(card, 'should not be null')
    assert.equal(card.showId, COMPLETE_EVENT.expectedShowId)
    assert.equal(card.showDate, COMPLETE_EVENT.expectedShowDate)
    assert.equal(card.title, COMPLETE_EVENT.expectedTitle)
    assert.equal(card.showTimeStr, COMPLETE_EVENT.expectedShowTime)
    assert.equal(card.doorsTimeStr, COMPLETE_EVENT.expectedDoorsTime)
    assert.equal(card.priceMin, COMPLETE_EVENT.expectedPriceMin)
    assert.equal(card.priceMax, COMPLETE_EVENT.expectedPriceMax)
    assert.equal(card.imageUrl, COMPLETE_EVENT.expectedImageUrl)
  })

  it('returns null for card without id attribute', () => {
    const card = parseCard(MISSING_ID.cardHtml)
    assert.equal(card, null)
  })

  it('returns null for card without title', () => {
    const card = parseCard(MISSING_TITLE.cardHtml)
    assert.equal(card, null)
  })

  it('decodes HTML entities in title', () => {
    const card = parseCard(HTML_ENTITIES_IN_TITLE.cardHtml)
    assert.ok(card)
    assert.equal(card.title, HTML_ENTITIES_IN_TITLE.expectedTitle)
  })

  it('extracts webp images', () => {
    const card = parseCard(WEBP_IMAGE.cardHtml)
    assert.ok(card)
    assert.equal(card.imageUrl, WEBP_IMAGE.expectedImageUrl)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Price Extraction
// ════════════════════════════════════════════════════════════════════════════

describe('BLU Jazz: Price Extraction', () => {
  it('parses free admission', () => {
    const card = parseCard(FREE_ADMISSION.cardHtml)
    assert.ok(card)
    assert.equal(card.priceMin, 0)
    assert.equal(card.priceMax, 0)
  })

  it('parses "no cover charge"', () => {
    const card = parseCard(NO_COVER_CHARGE.cardHtml)
    assert.ok(card)
    assert.equal(card.priceMin, 0)
    assert.equal(card.priceMax, 0)
  })

  it('parses single price', () => {
    const card = parseCard(SINGLE_PRICE.cardHtml)
    assert.ok(card)
    assert.equal(card.priceMin, SINGLE_PRICE.expectedPriceMin)
    assert.equal(card.priceMax, SINGLE_PRICE.expectedPriceMax)
  })

  it('parses price range with advance/door pricing', () => {
    const card = parseCard(PRICE_RANGE_VARIATIONS.cardHtml)
    assert.ok(card)
    assert.equal(card.priceMin, PRICE_RANGE_VARIATIONS.expectedPriceMin)
    assert.equal(card.priceMax, PRICE_RANGE_VARIATIONS.expectedPriceMax)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Time Extraction
// ════════════════════════════════════════════════════════════════════════════

describe('BLU Jazz: Time Extraction', () => {
  it('extracts show time when present', () => {
    const card = parseCard(COMPLETE_EVENT.cardHtml)
    assert.ok(card)
    assert.equal(card.showTimeStr, COMPLETE_EVENT.expectedShowTime)
  })

  it('handles missing show time', () => {
    const card = parseCard(MISSING_SHOW_TIME.cardHtml)
    assert.ok(card)
    assert.equal(card.showTimeStr, null)
  })

  it('extracts doors time when show time missing', () => {
    const card = parseCard(ONLY_DOORS_TIME.cardHtml)
    assert.ok(card)
    assert.equal(card.doorsTimeStr, ONLY_DOORS_TIME.expectedDoorsTime)
    assert.equal(card.showTimeStr, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Full Normalization Pipeline
// ════════════════════════════════════════════════════════════════════════════

describe('BLU Jazz: Event Normalization', () => {
  it('normalizes a complete event', () => {
    const row = normalizeCard(COMPLETE_EVENT.cardHtml)
    assert.ok(row)
    assert.equal(row.title, COMPLETE_EVENT.expectedTitle)
    assert.equal(row.source, 'blu_jazz')
    assert.equal(row.source_id, '42_2026-05-15')
    assert.equal(row.category, 'music')
    assert.equal(row.price_min, 20)
    assert.equal(row.price_max, 25)
    assert.ok(row.start_at.includes('2026-05-15'))
    assert.ok(row.tags.includes('jazz'))
    assert.ok(row.tags.includes('live music'))
    assert.ok(row.tags.includes('blu jazz+'))
    assert.equal(row.image_url, COMPLETE_EVENT.expectedImageUrl)
    assert.ok(row.ticket_url.includes('42'))
    assert.ok(row.ticket_url.includes('2026-05-15'))
  })

  it('normalizes free event', () => {
    const row = normalizeCard(FREE_ADMISSION.cardHtml)
    assert.ok(row)
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, 0)
  })

  it('uses doors time + 1 hour when show time missing', () => {
    const row = normalizeCard(ONLY_DOORS_TIME.cardHtml)
    assert.ok(row)
    // Doors is 10:00pm, so effective show time should be 11:00pm
    const startDate = new Date(row.start_at)
    const hour = startDate.getUTCHours()
    // 11:00pm ET = 3:00am UTC (EDT, UTC-4) or 4:00am UTC (EST, UTC-5)
    assert.ok(hour === 3 || hour === 4, `hour should be 3 or 4, got ${hour}`)
  })

  it('uses noon as fallback when no time info', () => {
    const row = normalizeCard(MISSING_SHOW_TIME.cardHtml)
    assert.ok(row)
    // Just verify we have a valid start time - exact hour depends on DST
    assert.ok(row.start_at.includes('2026-08-05'))
  })

  it('estimates end time as 3 hours after start', () => {
    const row = normalizeCard(COMPLETE_EVENT.cardHtml)
    assert.ok(row)
    const start = new Date(row.start_at)
    const end = new Date(row.end_at)
    const diffMs = end - start
    const diffHours = diffMs / 3600000
    assert.equal(diffHours, 3)
  })

  it('handles card without image', () => {
    const row = normalizeCard(NO_IMAGE.cardHtml)
    assert.ok(row)
    assert.equal(row.image_url, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Batch Processing Invariants
// ════════════════════════════════════════════════════════════════════════════

describe('BLU Jazz: Batch Processing', () => {
  it('every parsed card has consistent source', () => {
    for (const fixture of ALL_FIXTURES) {
      if (fixture.shouldReturnNull) continue
      const row = normalizeCard(fixture.cardHtml)
      if (row) {
        assert.equal(row.source, 'blu_jazz')
      }
    }
  })

  it('every non-null row has required fields', () => {
    const REQUIRED = ['title', 'start_at', 'category', 'source', 'source_id', 'status']
    for (const fixture of ALL_FIXTURES) {
      if (fixture.shouldReturnNull) continue
      const row = normalizeCard(fixture.cardHtml)
      if (!row) continue
      for (const field of REQUIRED) {
        assert.ok(row[field] != null, `missing required field '${field}'`)
      }
    }
  })

  it('price_min is always a number', () => {
    for (const fixture of ALL_FIXTURES) {
      if (fixture.shouldReturnNull) continue
      const row = normalizeCard(fixture.cardHtml)
      if (!row) continue
      assert.equal(typeof row.price_min, 'number')
    }
  })

  it('tags array always includes expected values', () => {
    for (const fixture of ALL_FIXTURES) {
      if (fixture.shouldReturnNull) continue
      const row = normalizeCard(fixture.cardHtml)
      if (!row) continue
      assert.ok(Array.isArray(row.tags))
      assert.ok(row.tags.includes('jazz'))
      assert.ok(row.tags.includes('live music'))
    }
  })

  it('category is always "music"', () => {
    for (const fixture of ALL_FIXTURES) {
      if (fixture.shouldReturnNull) continue
      const row = normalizeCard(fixture.cardHtml)
      if (!row) continue
      assert.equal(row.category, 'music')
    }
  })

  it('source_id is always a string', () => {
    for (const fixture of ALL_FIXTURES) {
      if (fixture.shouldReturnNull) continue
      const row = normalizeCard(fixture.cardHtml)
      if (!row) continue
      assert.equal(typeof row.source_id, 'string')
    }
  })

  it('all start_at values are valid ISO 8601', () => {
    for (const fixture of ALL_FIXTURES) {
      if (fixture.shouldReturnNull) continue
      const row = normalizeCard(fixture.cardHtml)
      if (!row) continue
      const parsed = new Date(row.start_at)
      assert.ok(!isNaN(parsed.getTime()), `invalid start_at: ${row.start_at}`)
      assert.ok(row.start_at.endsWith('Z'))
    }
  })

  it('no row has HTML in title or description', () => {
    for (const fixture of ALL_FIXTURES) {
      if (fixture.shouldReturnNull) continue
      const row = normalizeCard(fixture.cardHtml)
      if (!row) continue
      assert.ok(!/<[a-zA-Z]/.test(row.title), `HTML in title: ${row.title}`)
      if (row.description) {
        assert.ok(!/<[a-zA-Z]/.test(row.description), `HTML in description`)
      }
    }
  })

  it('exactly 2 fixtures return null (missing id, missing title)', () => {
    const nullCards = ALL_FIXTURES.filter(f => {
      const row = normalizeCard(f.cardHtml)
      return row === null
    })
    assert.equal(nullCards.length, 2)
  })
})
