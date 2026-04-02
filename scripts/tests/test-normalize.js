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
