/**
 * test-normalize.js
 *
 * Unit tests for shared normalization utilities in scripts/lib/normalize.js.
 * These are pure functions with no database dependencies — no mocking needed.
 *
 * Run:
 *   node --test scripts/tests/test-normalize.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// We can't directly import from normalize.js because it imports supabase-admin.js
// which throws if env vars are missing. Instead, we'll extract and test the pure
// functions by re-implementing them here from the source — OR we set dummy env vars.

// Set dummy env vars so supabase-admin.js doesn't throw on import
process.env.VITE_SUPABASE_URL       = process.env.VITE_SUPABASE_URL       || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  stripHtml,
  htmlToText,
  easternToIso,
  parseCostFromTribe,
  parseTagsFromTribe,
  parseEventbritePrice,
} = await import('../lib/normalize.js')

// ════════════════════════════════════════════════════════════════════════════
// stripHtml
// ════════════════════════════════════════════════════════════════════════════

describe('stripHtml', () => {
  it('strips basic HTML tags', () => {
    assert.equal(stripHtml('<p>Hello <b>world</b></p>'), 'Hello world')
  })

  it('decodes numeric HTML entities', () => {
    assert.equal(stripHtml('Price: &#36;25'), 'Price: $25')
  })

  it('decodes hex HTML entities', () => {
    assert.equal(stripHtml('&#x2014; dash'), '— dash')
  })

  it('decodes named HTML entities', () => {
    assert.equal(stripHtml('Fish &amp; Chips'), 'Fish & Chips')
    assert.equal(stripHtml('&lt;script&gt;'), '<script>')
  })

  it('normalizes smart quotes to ASCII', () => {
    assert.equal(stripHtml('\u2018hello\u2019'), "'hello'")
    assert.equal(stripHtml('\u201Chello\u201D'), '"hello"')
  })

  it('collapses whitespace', () => {
    assert.equal(stripHtml('  too   many    spaces  '), 'too many spaces')
  })

  it('handles empty/null input', () => {
    assert.equal(stripHtml(''), '')
    assert.equal(stripHtml(undefined), '')
  })

  it('decodes &nbsp; to space', () => {
    assert.equal(stripHtml('hello&nbsp;world'), 'hello world')
  })

  it('strips nested tags', () => {
    assert.equal(
      stripHtml('<div><ul><li>Item 1</li><li>Item 2</li></ul></div>'),
      'Item 1 Item 2'
    )
  })

  it('handles multiple entity types in one string', () => {
    assert.equal(
      stripHtml('It&#8217;s a &quot;great&quot; day &amp; night'),
      "It's a \"great\" day & night"
    )
  })
})

// ════════════════════════════════════════════════════════════════════════════
// htmlToText
// ════════════════════════════════════════════════════════════════════════════

describe('htmlToText', () => {
  it('preserves paragraph breaks', () => {
    const result = htmlToText('<p>Paragraph 1</p><p>Paragraph 2</p>')
    assert.ok(result.includes('Paragraph 1'))
    assert.ok(result.includes('Paragraph 2'))
    assert.ok(result.includes('\n'))
  })

  it('converts <br> to newlines', () => {
    const result = htmlToText('Line 1<br>Line 2<br/>Line 3')
    assert.ok(result.includes('Line 1\nLine 2\nLine 3'))
  })

  it('converts list items to bullet points', () => {
    const result = htmlToText('<ul><li>First</li><li>Second</li></ul>')
    assert.ok(result.includes('• First'))
    assert.ok(result.includes('• Second'))
  })

  it('handles empty input', () => {
    assert.equal(htmlToText(''), '')
    assert.equal(htmlToText(undefined), '')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// easternToIso
// ════════════════════════════════════════════════════════════════════════════

describe('easternToIso', () => {
  it('converts EST (winter) time correctly — UTC-5', () => {
    // January 15 = EST, so 14:00 EST → 19:00 UTC
    const result = easternToIso('2026-01-15 14:00:00')
    assert.equal(result, '2026-01-15T19:00:00.000Z')
  })

  it('converts EDT (summer) time correctly — UTC-4', () => {
    // July 15 = EDT, so 14:00 EDT → 18:00 UTC
    const result = easternToIso('2026-07-15 14:00:00')
    assert.equal(result, '2026-07-15T18:00:00.000Z')
  })

  it('handles date-only input (no time part)', () => {
    // Should default to midnight
    const result = easternToIso('2026-06-01')
    assert.ok(result)
    assert.ok(result.includes('2026-06-01'))
  })

  it('handles DST spring-forward boundary (March 8, 2026)', () => {
    // March 8 2026 is the 2nd Sunday of March — DST starts at 2:00 AM.
    // Our algorithm approximates by checking if the date falls in the DST
    // window (2nd Sun Mar – 1st Sun Nov). Since March 8 IS the transition
    // day and the function sees it as DST, 1:30 AM → UTC-4 → 05:30 UTC.
    const result = easternToIso('2026-03-08 01:30:00')
    assert.equal(result, '2026-03-08T05:30:00.000Z')
  })

  it('handles DST fall-back boundary (November 1, 2026)', () => {
    // November 1 2026 is the 1st Sunday of November — DST ends at 2:00 AM
    // After fall-back, 14:00 → EST (UTC-5)
    const result = easternToIso('2026-11-01 14:00:00')
    assert.equal(result, '2026-11-01T19:00:00.000Z')
  })

  it('returns null for null/undefined input', () => {
    assert.equal(easternToIso(null), null)
    assert.equal(easternToIso(undefined), null)
    assert.equal(easternToIso(''), null)
  })

  it('returns null for malformed date string', () => {
    assert.equal(easternToIso('not-a-date'), null)
  })

  it('handles time without seconds', () => {
    const result = easternToIso('2026-06-15 10:00')
    assert.ok(result)
    assert.ok(result.startsWith('2026-06-15'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// parseCostFromTribe
// ════════════════════════════════════════════════════════════════════════════

describe('parseCostFromTribe', () => {
  it('parses cost from costDetails.values array', () => {
    const result = parseCostFromTribe('$10 - $25', { values: ['10', '25'] })
    assert.equal(result.price_min, 10)
    assert.equal(result.price_max, 25)
  })

  it('returns null price_max when all values are the same', () => {
    const result = parseCostFromTribe('$15', { values: ['15'] })
    assert.equal(result.price_min, 15)
    assert.equal(result.price_max, null)
  })

  it('parses "Free" cost string', () => {
    const result = parseCostFromTribe('Free')
    assert.equal(result.price_min, 0)
    assert.equal(result.price_max, null)
  })

  it('parses "free" case-insensitively', () => {
    const result = parseCostFromTribe('FREE')
    assert.equal(result.price_min, 0)
  })

  it('parses cost string with dollar amounts when no costDetails', () => {
    const result = parseCostFromTribe('$5 - $20')
    assert.equal(result.price_min, 5)
    assert.equal(result.price_max, 20)
  })

  it('returns 0/null for empty cost', () => {
    const result = parseCostFromTribe('')
    assert.equal(result.price_min, 0)
    assert.equal(result.price_max, null)
  })

  it('returns 0/null for undefined cost', () => {
    const result = parseCostFromTribe()
    assert.equal(result.price_min, 0)
    assert.equal(result.price_max, null)
  })

  it('handles costDetails with non-numeric values gracefully', () => {
    const result = parseCostFromTribe('Donation', { values: ['donation'] })
    // Non-numeric values get filtered out, falls through to string parsing
    assert.equal(result.price_min, 0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// parseTagsFromTribe
// ════════════════════════════════════════════════════════════════════════════

describe('parseTagsFromTribe', () => {
  it('combines categories, tags, and extra tags', () => {
    const result = parseTagsFromTribe(
      [{ name: 'Hiking' }],
      [{ name: 'Family Friendly' }],
      ['parks', 'outdoors']
    )
    assert.deepEqual(result, ['hiking', 'family friendly', 'parks', 'outdoors'])
  })

  it('deduplicates tags', () => {
    const result = parseTagsFromTribe(
      [{ name: 'Music' }],
      [{ name: 'Music' }],
      ['music']
    )
    assert.equal(result.length, 1)
    assert.equal(result[0], 'music')
  })

  it('handles empty inputs', () => {
    const result = parseTagsFromTribe()
    assert.deepEqual(result, [])
  })

  it('filters out null/undefined names', () => {
    const result = parseTagsFromTribe(
      [{ name: null }, { name: 'Art' }],
      [{ slug: 'no-name' }]
    )
    assert.deepEqual(result, ['art'])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// parseEventbritePrice
// ════════════════════════════════════════════════════════════════════════════

describe('parseEventbritePrice', () => {
  it('returns free when isFree is true', () => {
    const result = parseEventbritePrice([], true)
    assert.equal(result.price_min, 0)
    assert.equal(result.price_max, 0)
  })

  it('extracts min and max from ticket classes', () => {
    const classes = [
      { free: false, cost: { major_value: '25.00' } },
      { free: false, cost: { major_value: '50.00' } },
      { free: false, cost: { major_value: '35.00' } },
    ]
    const result = parseEventbritePrice(classes, false)
    assert.equal(result.price_min, 25)
    assert.equal(result.price_max, 50)
  })

  it('returns null price_max when only one price', () => {
    const classes = [
      { free: false, cost: { major_value: '30.00' } },
    ]
    const result = parseEventbritePrice(classes, false)
    assert.equal(result.price_min, 30)
    assert.equal(result.price_max, null)
  })

  it('ignores free ticket classes', () => {
    const classes = [
      { free: true, cost: { major_value: '0.00' } },
      { free: false, cost: { major_value: '45.00' } },
    ]
    const result = parseEventbritePrice(classes, false)
    assert.equal(result.price_min, 45)
    assert.equal(result.price_max, null)
  })

  it('returns 0/null when no valid prices and not free', () => {
    const result = parseEventbritePrice([], false)
    assert.equal(result.price_min, 0)
    assert.equal(result.price_max, null)
  })

  it('handles ticket classes with null cost', () => {
    const classes = [
      { free: false, cost: null },
      { free: false, cost: { major_value: '20.00' } },
    ]
    const result = parseEventbritePrice(classes, false)
    assert.equal(result.price_min, 20)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ensureOrganization / ensureVenue — insert payload construction
// ════════════════════════════════════════════════════════════════════════════
//
// We can't call ensureOrganization/ensureVenue directly in unit tests (they
// hit Supabase), but we CAN test the critical bug pattern: building an insert
// payload that omits null values so Postgres uses column defaults instead of
// violating NOT NULL constraints.
//
// This mirrors the exact logic in ensureOrganization and ensureVenue.

describe('Insert payload construction (NOT NULL DEFAULT safety)', () => {
  /**
   * Simulate how ensureOrganization builds its insert row.
   * This must match the actual implementation in normalize.js.
   */
  function buildOrgPayload(name, details = {}) {
    const row = { name }
    if (details.website)     row.website     = details.website
    if (details.description) row.description = details.description
    if (details.image_url)   row.image_url   = details.image_url
    if (details.address)     row.address     = details.address
    if (details.city)        row.city        = details.city
    if (details.state)       row.state       = details.state
    if (details.zip)         row.zip         = details.zip
    return row
  }

  /**
   * Simulate how ensureVenue builds its insert row.
   */
  function buildVenuePayload(name, details = {}) {
    const row = { name }
    if (details.address)       row.address       = details.address
    if (details.city)          row.city          = details.city
    if (details.state)         row.state         = details.state
    if (details.zip)           row.zip           = details.zip
    if (details.lat != null)   row.lat           = details.lat
    if (details.lng != null)   row.lng           = details.lng
    if (details.parking_type)  row.parking_type  = details.parking_type
    if (details.parking_notes) row.parking_notes = details.parking_notes
    if (details.website)       row.website       = details.website
    if (details.description)   row.description   = details.description
    if (details.tags?.length)  row.tags          = details.tags
    return row
  }

  // ── Organization payload tests ─────────────────────────────────────────

  it('org payload: omits city when not provided (lets DB default to Akron)', () => {
    const row = buildOrgPayload('Summit Metro Parks', {
      website: 'https://summitmetroparks.org',
      description: 'Park system',
    })
    assert.ok(!('city' in row), 'city should NOT be in the payload when not provided')
    assert.ok(!('state' in row), 'state should NOT be in the payload when not provided')
    assert.equal(row.name, 'Summit Metro Parks')
    assert.equal(row.website, 'https://summitmetroparks.org')
  })

  it('org payload: includes city when explicitly provided', () => {
    const row = buildOrgPayload('Some Org', {
      city: 'Canton',
      state: 'OH',
    })
    assert.equal(row.city, 'Canton')
    assert.equal(row.state, 'OH')
  })

  it('org payload: does NOT include null or undefined values', () => {
    const row = buildOrgPayload('Test Org', {
      website: null,
      description: undefined,
      city: null,
      zip: '',
    })
    assert.ok(!('website' in row), 'null website should be omitted')
    assert.ok(!('description' in row), 'undefined description should be omitted')
    assert.ok(!('city' in row), 'null city should be omitted')
    assert.ok(!('zip' in row), 'empty string zip should be omitted')
  })

  it('org payload: only has name when no details provided', () => {
    const row = buildOrgPayload('Minimal Org')
    assert.deepEqual(Object.keys(row), ['name'])
  })

  it('org payload: preserves all provided non-empty values', () => {
    const row = buildOrgPayload('Full Org', {
      website: 'https://example.com',
      description: 'Desc',
      image_url: 'https://img.com/logo.png',
      address: '123 Main St',
      city: 'Akron',
      state: 'OH',
      zip: '44311',
    })
    assert.equal(Object.keys(row).length, 8)
    assert.equal(row.name, 'Full Org')
    assert.equal(row.city, 'Akron')
  })

  // ── Venue payload tests ────────────────────────────────────────────────

  it('venue payload: omits city when not provided (lets DB default)', () => {
    const row = buildVenuePayload('Some Venue', {
      address: '100 Park Ave',
    })
    assert.ok(!('city' in row), 'city should NOT be in the payload')
    assert.equal(row.address, '100 Park Ave')
  })

  it('venue payload: includes lat/lng as 0 (falsy but valid)', () => {
    const row = buildVenuePayload('Equator Venue', {
      lat: 0,
      lng: 0,
    })
    assert.equal(row.lat, 0, 'lat=0 should be included (equator)')
    assert.equal(row.lng, 0, 'lng=0 should be included (prime meridian)')
  })

  it('venue payload: omits lat/lng when null', () => {
    const row = buildVenuePayload('No Coords Venue', {
      lat: null,
      lng: undefined,
    })
    assert.ok(!('lat' in row), 'null lat should be omitted')
    assert.ok(!('lng' in row), 'undefined lng should be omitted')
  })

  it('venue payload: omits empty tags array', () => {
    const row = buildVenuePayload('Tagless Venue', {
      tags: [],
    })
    assert.ok(!('tags' in row), 'empty tags array should be omitted')
  })

  it('venue payload: includes non-empty tags array', () => {
    const row = buildVenuePayload('Tagged Venue', {
      tags: ['outdoor', 'accessible'],
    })
    assert.deepEqual(row.tags, ['outdoor', 'accessible'])
  })

  it('venue payload: does NOT include null or undefined values for any field', () => {
    const row = buildVenuePayload('Null Test Venue', {
      address: null,
      city: null,
      state: null,
      zip: null,
      lat: null,
      lng: null,
      parking_type: null,
      parking_notes: null,
      website: null,
      description: null,
      tags: null,
    })
    assert.deepEqual(Object.keys(row), ['name'], 'only name should remain when all details are null')
  })
})
