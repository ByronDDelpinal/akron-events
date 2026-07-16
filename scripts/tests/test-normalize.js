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
  easternTodayIso,
  decodeEntities,
  sanitizeEventText,
  parseCostFromTribe,
  parseTagsFromTribe,
  parseEventbritePrice,
  canonicalVenueName,
  orgNameKey,
  titleCaseIfShouting,
} = await import('../lib/normalize.js')

describe('orgNameKey', () => {
  it('folds a leading "The" so "The X" and "X" resolve to one org', () => {
    // The real split: Eventbrite says "The Conservancy for …", our first-party
    // CVNP scraper says "Conservancy for …" — two rows for one org.
    assert.equal(
      orgNameKey('The Conservancy for Cuyahoga Valley National Park'),
      orgNameKey('Conservancy for Cuyahoga Valley National Park'))
    assert.equal(orgNameKey('The Peninsula Foundation'), orgNameKey('Peninsula Foundation'))
  })

  it('folds case-only variants', () => {
    assert.equal(orgNameKey('The Stray Cats'), orgNameKey('THE STRAY CATS'))
  })

  it('collapses whitespace', () => {
    assert.equal(orgNameKey('  Akron   Marathon  '), orgNameKey('Akron Marathon'))
  })

  it('decodes HTML entities', () => {
    assert.equal(orgNameKey('Bounce &amp; Co.'), orgNameKey('Bounce & Co.'))
  })

  it('only strips "The" at the START, not mid-name', () => {
    assert.equal(orgNameKey('Friends of The Mill'), 'friends of the mill')
  })

  it('keeps genuinely different orgs apart (does NOT strip punctuation)', () => {
    // Over-folding would silently merge two real orgs — worse than a dupe.
    assert.notEqual(orgNameKey("Art's Core"), orgNameKey('Arts Core'))
    assert.notEqual(orgNameKey('Akron Pride'), orgNameKey('Akron Pride Festival'))
  })

  it('handles empty / nullish input', () => {
    assert.equal(orgNameKey(''), '')
    assert.equal(orgNameKey(null), '')
    assert.equal(orgNameKey(undefined), '')
    assert.equal(orgNameKey('   '), '')
  })
})

describe('decodeEntities', () => {
  it('decodes astral (emoji) numeric entities without surrogate corruption', () => {
    // fromCharCode truncated code points above 0xFFFF into a lone surrogate.
    assert.equal(decodeEntities('Party &#128512; time'), 'Party \u{1F600} time')
    assert.equal(decodeEntities('&#x1F389;'), '\u{1F389}')
  })

  it('decodes named entities containing digits (&frac12;)', () => {
    // The old /&([a-zA-Z]+);/ regex could not match digit-bearing names.
    assert.equal(decodeEntities('5&frac12; hours'), '5½ hours')
  })

  it('leaves out-of-range numeric references verbatim instead of throwing', () => {
    assert.equal(decodeEntities('&#1114112;'), '&#1114112;') // 0x110000 > max
  })
})

describe('easternTodayIso', () => {
  it('returns the EASTERN calendar date, not the UTC one', () => {
    // 2026-07-15 23:30 ET = 2026-07-16 03:30 UTC — the UTC shortcut says
    // "tomorrow", which silently dropped the rest of today's events from
    // late-evening scrape runs.
    const lateEvening = new Date('2026-07-16T03:30:00Z')
    assert.equal(easternTodayIso(lateEvening), '2026-07-15')
  })

  it('matches the UTC date when both zones agree', () => {
    assert.equal(easternTodayIso(new Date('2026-07-15T15:00:00Z')), '2026-07-15')
  })
})

describe('canonicalVenueName', () => {
  it('folds known venue-name variants onto the canonical name (case/space-insensitive)', () => {
    assert.equal(canonicalVenueName('E.J. Thomas Hall - The University of Akron'), 'E.J. Thomas Performing Arts Hall')
    assert.equal(canonicalVenueName('lock 3 live'), 'Lock 3')
    assert.equal(canonicalVenueName('First and Main Green'), 'First & Main Green - First Street Hudson')
    assert.equal(canonicalVenueName('The Nightlight'), 'The Nightlight Cinema')
    assert.equal(canonicalVenueName('The Akron RubberDucks Duck Club'), '7 17 Credit Union Park')
    assert.equal(canonicalVenueName('The Duck Club by Firestone at 7 17 Credit Union Park'), '7 17 Credit Union Park')
  })
  it('returns the input unchanged for unknown names', () => {
    assert.equal(canonicalVenueName('Akron Civic Theatre'), 'Akron Civic Theatre')
    assert.equal(canonicalVenueName('Lock 3'), 'Lock 3')
  })
})

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
    // March 8 2026 is the 2nd Sunday of March — DST starts at 2:00 AM LOCAL.
    // 1:30 AM is therefore still EST (UTC-5) → 06:30 UTC. The old arithmetic
    // approximation put the boundary at UTC midnight of the transition day
    // and converted this as EDT (05:30Z, one hour early); the Intl-based
    // converter resolves the offset from the real zone rules.
    const result = easternToIso('2026-03-08 01:30:00')
    assert.equal(result, '2026-03-08T06:30:00.000Z')
  })

  it('handles the evening after spring-forward as EDT', () => {
    // 19:00 on the transition day is unambiguously EDT (UTC-4) → 23:00 UTC.
    assert.equal(easternToIso('2026-03-08 19:00:00'), '2026-03-08T23:00:00.000Z')
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

  // ── Two-argument form ──────────────────────────────────────────────────
  // Historically easternToIso(date, time) silently dropped the time argument,
  // landing every such event at midnight (the Akron Zoo "12am" bug). The
  // two-arg form is now a first-class, supported API. These tests lock it in.

  it('honors a separate time argument (does NOT drop it to midnight)', () => {
    // July = EDT (UTC-4): 14:00 EDT → 18:00 UTC
    const result = easternToIso('2026-07-15', '14:00:00')
    assert.equal(result, '2026-07-15T18:00:00.000Z')
  })

  it('two-arg and combined forms are equivalent', () => {
    assert.equal(
      easternToIso('2026-07-15', '14:00:00'),
      easternToIso('2026-07-15 14:00:00'),
    )
  })

  it('a 7:30 PM show is never stored at midnight (Weathervane regression)', () => {
    const result = easternToIso('2026-07-15', '19:30:00')
    assert.equal(result, '2026-07-15T23:30:00.000Z') // 19:30 EDT → 23:30 UTC
    assert.ok(!result.includes('T04:00:00'), 'must not be midnight Eastern')
  })

  // ── 12-hour (am/pm) parsing ────────────────────────────────────────────
  // Several scrapers pass am/pm times (art museum "1:00 pm", akronym "8:00 pm",
  // blu-jazz "12:00pm"). The old splitter produced NaN/midnight for these.

  it('parses 12-hour pm time with a space (art museum "1:00 pm")', () => {
    // 13:00 EDT → 17:00 UTC
    assert.equal(easternToIso('2026-07-15', '1:00 pm'), '2026-07-15T17:00:00.000Z')
  })

  it('parses 12-hour pm time without a space (blu-jazz "8:00pm")', () => {
    // 20:00 EDT → 00:00 UTC next day
    assert.equal(easternToIso('2026-07-15', '8:00pm'), '2026-07-16T00:00:00.000Z')
  })

  it('parses "a.m." / "p.m." with dots (zoo "10 a.m.")', () => {
    // 10:00 EDT → 14:00 UTC
    assert.equal(easternToIso('2026-07-15', '10 a.m.'), '2026-07-15T14:00:00.000Z')
  })

  it('handles the 12 am / 12 pm boundary correctly', () => {
    // 12:00 am = 00:00 EDT → 04:00 UTC ; 12:00 pm = 12:00 EDT → 16:00 UTC
    assert.equal(easternToIso('2026-07-15', '12:00 am'), '2026-07-15T04:00:00.000Z')
    assert.equal(easternToIso('2026-07-15', '12:00 pm'), '2026-07-15T16:00:00.000Z')
  })

  it('parses am/pm in the combined-string form too', () => {
    assert.equal(easternToIso('2026-07-15 1:00 pm'), '2026-07-15T17:00:00.000Z')
  })

  it('blank/whitespace time argument falls back to midnight', () => {
    const result = easternToIso('2026-06-01', '   ')
    assert.ok(result.startsWith('2026-06-01'))
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

  it('returns null/null for empty cost (unknown price)', () => {
    const result = parseCostFromTribe('')
    assert.equal(result.price_min, null)
    assert.equal(result.price_max, null)
  })

  it('returns null/null for undefined cost (unknown price)', () => {
    const result = parseCostFromTribe()
    assert.equal(result.price_min, null)
    assert.equal(result.price_max, null)
  })

  it('handles costDetails with non-numeric values gracefully', () => {
    const result = parseCostFromTribe('Donation', { values: ['donation'] })
    // Non-numeric values get filtered out, falls through to string parsing — unknown price
    assert.equal(result.price_min, null)
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

  it('returns null/null when no valid prices and not free (unknown price)', () => {
    const result = parseEventbritePrice([], false)
    assert.equal(result.price_min, null)
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

// ════════════════════════════════════════════════════════════════════════════
// sanitizeEventText — upsert-time HTML entity decoding
// ════════════════════════════════════════════════════════════════════════════
//
// This is the safety net that catches HTML entities in titles/descriptions
// that scrapers forgot to decode. Every event goes through upsertEventSafe →
// sanitizeEventText before hitting the database.

describe('sanitizeEventText', () => {
  it('decodes &#8217; (right single quote) in title — the Lil Sprouts bug', () => {
    const row = sanitizeEventText({
      title: 'Lil&#8217; Sprouts',
      description: 'A nature program for kids.',
      source: 'summit_metro_parks',
      source_id: '12345',
    })
    assert.equal(row.title, "Lil' Sprouts")
  })

  it('decodes &#8220; and &#8221; (smart double quotes) in title', () => {
    const row = sanitizeEventText({
      title: '&#8220;Fool&#8221; Moon Hike',
      description: null,
      source: 'summit_metro_parks',
      source_id: '12346',
    })
    assert.equal(row.title, '"Fool" Moon Hike')
  })

  it('decodes &amp; in title', () => {
    const row = sanitizeEventText({
      title: 'Arts &amp; Crafts Night',
      description: 'Fun for everyone.',
      source: 'test',
      source_id: '1',
    })
    assert.equal(row.title, 'Arts & Crafts Night')
  })

  it('decodes hex entities like &#x2019; in title', () => {
    const row = sanitizeEventText({
      title: 'It&#x2019;s Showtime',
      description: null,
      source: 'test',
      source_id: '2',
    })
    assert.equal(row.title, "It's Showtime")
  })

  it('strips HTML tags from title if present', () => {
    const row = sanitizeEventText({
      title: 'A <strong>Bold</strong> Event',
      description: null,
      source: 'test',
      source_id: '3',
    })
    assert.equal(row.title, 'A Bold Event')
  })

  it('decodes entities in description too', () => {
    const row = sanitizeEventText({
      title: 'Test',
      description: 'Join us for music &amp; dancing &#8212; don&#8217;t miss it!',
      source: 'test',
      source_id: '4',
    })
    assert.ok(!row.description.includes('&amp;'))
    assert.ok(!row.description.includes('&#8212;'))
    assert.ok(!row.description.includes('&#8217;'))
    assert.ok(row.description.includes('&'))
    assert.ok(row.description.includes('—'))
  })

  it('preserves null title and description', () => {
    const row = sanitizeEventText({
      title: null,
      description: null,
      source: 'test',
      source_id: '5',
    })
    assert.equal(row.title, null)
    assert.equal(row.description, null)
  })

  it('preserves non-text fields untouched', () => {
    const row = sanitizeEventText({
      title: 'Test',
      description: null,
      source: 'summit_metro_parks',
      source_id: '999',
      price_min: 0,
      price_max: null,
      tags: ['parks', 'outdoors'],
      category: 'community',
      start_at: '2026-05-15T18:00:00.000Z',
    })
    assert.equal(row.source, 'summit_metro_parks')
    assert.equal(row.source_id, '999')
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, null)
    assert.deepEqual(row.tags, ['parks', 'outdoors'])
    assert.equal(row.category, 'community')
    assert.equal(row.start_at, '2026-05-15T18:00:00.000Z')
  })

  it('handles multiple entities in a single title', () => {
    const row = sanitizeEventText({
      title: 'Rock &amp; Roll &#8212; It&#8217;s a &quot;Party&quot;',
      description: null,
      source: 'test',
      source_id: '6',
    })
    assert.equal(row.title, 'Rock & Roll \u2014 It\'s a "Party"')
  })

  it('normalizes smart single quotes to ASCII apostrophe', () => {
    // \u2018 = left single quote, \u2019 = right single quote
    const row = sanitizeEventText({
      title: '\u2018Hello\u2019',
      description: null,
      source: 'test',
      source_id: '7',
    })
    assert.equal(row.title, "'Hello'")
  })

  it('normalizes smart double quotes to ASCII', () => {
    const row = sanitizeEventText({
      title: '\u201CHello\u201D',
      description: null,
      source: 'test',
      source_id: '8',
    })
    assert.equal(row.title, '"Hello"')
  })

  it('collapses extra whitespace from stripped tags', () => {
    const row = sanitizeEventText({
      title: '  Too   Many   Spaces  ',
      description: null,
      source: 'test',
      source_id: '9',
    })
    assert.equal(row.title, 'Too Many Spaces')
  })

  it('title-cases a long ALL-CAPS title (2026-07-02 data-quality plan, task 7)', () => {
    const row = sanitizeEventText({
      title: 'SUMMER BLOWOUT COMEDY SHOWCASE AT THE KILLBOX',
      description: null,
      source: 'killbox_comedy',
      source_id: '10',
    })
    assert.equal(row.title, 'Summer Blowout Comedy Showcase at the Killbox')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// titleCaseIfShouting — 2026-07-02 data-quality plan, task 7
// ════════════════════════════════════════════════════════════════════════════

describe('titleCaseIfShouting', () => {
  it('title-cases a long shouted title', () => {
    assert.equal(
      titleCaseIfShouting('SUMMER BLOWOUT COMEDY SHOWCASE AT THE KILLBOX'),
      'Summer Blowout Comedy Showcase at the Killbox'
    )
  })

  it('capitalizes the first and last word even if they are minor words', () => {
    assert.equal(titleCaseIfShouting('OF MICE AND MEN LIVE ON STAGE TONIGHT'), 'Of Mice and Men Live on Stage Tonight')
  })

  it('leaves short titles alone (<=25 chars), even if shouted', () => {
    assert.equal(titleCaseIfShouting('LIVE MUSIC NIGHT'), 'LIVE MUSIC NIGHT')
  })

  it('leaves mixed-case titles alone entirely', () => {
    const t = 'Rialto Presents: An Evening With The Band'
    assert.equal(titleCaseIfShouting(t), t)
  })

  it('leaves null/empty untouched', () => {
    assert.equal(titleCaseIfShouting(null), null)
    assert.equal(titleCaseIfShouting(''), '')
  })

  it('keeps a short acronym uppercase inside a shouted title', () => {
    assert.equal(
      titleCaseIfShouting('DJ SPINS ALL NIGHT AT THE SUMMER BLOCK PARTY'),
      'DJ Spins All Night at the Summer Block Party'
    )
  })

  it('preserves an apostrophe and capitalizes the letter after it', () => {
    assert.equal(
      titleCaseIfShouting("AKRON'S BIGGEST SUMMER BLOCK PARTY DOWNTOWN"),
      "Akron's Biggest Summer Block Party Downtown"
    )
  })

  it('title-cases each segment of a hyphenated compound', () => {
    assert.equal(
      titleCaseIfShouting('STATE-OF-THE-ART LASER LIGHT SHOW THIS FRIDAY'),
      'State-of-the-Art Laser Light Show This Friday'
    )
  })

  it('preserves exact whitespace/spacing between words', () => {
    assert.equal(
      titleCaseIfShouting('BIG   SUMMER  COMEDY NIGHT AT THE KILLBOX CLUB'),
      'Big   Summer  Comedy Night at the Killbox Club'
    )
  })
})
