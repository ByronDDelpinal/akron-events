/**
 * test-normalize.js
 *
 * Unit tests for shared normalization utilities in scripts/lib/normalize.js.
 * These are pure functions with no database dependencies — no mocking needed.
 *
 * Run:
 *   node --test scripts/tests/test-normalize.js
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

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
  splitCommaLocation,
  sanitizeEventText,
  parseCostFromTribe,
  parseTagsFromTribe,
  parseEventbritePrice,
  canonicalVenueName,
  venueNameKey,
  isJunkVenueName,
  isProseContactVenueName,
  looksLikeStreetAddress,
  ensureVenue,
  orgNameKey,
  titleCaseIfShouting,
  absoluteUrl,
  _resetVenueAddressIndex,
  _resetVenueNameIndex,
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

describe('splitCommaLocation', () => {
  it('splits the Tribe/Events-Manager comma format into name + address + city', () => {
    // The exact string that minted an address-in-name junk venue (akron_symphony, 2026-07-12)
    const r = splitCommaLocation('E.J. Thomas Hall, 198 Hill Street, Akron, OH, 44325, United States')
    assert.equal(r.name, 'E.J. Thomas Hall')
    assert.equal(r.address, '198 Hill Street')
    assert.equal(r.city, 'Akron')
  })

  it('splits the short "Name, Street, City" form (ohio_erie_canalway)', () => {
    const r = splitCommaLocation('Summit Lake NorthShore Park, 540 W. South Street, Akron')
    assert.equal(r.name, 'Summit Lake NorthShore Park')
    assert.equal(r.address, '540 W. South Street')
    assert.equal(r.city, 'Akron')
  })

  it('returns null for plain venue names, even ones containing a comma', () => {
    assert.equal(splitCommaLocation('E.J. Thomas Hall'), null)
    assert.equal(splitCommaLocation('Hopocan, Hall of Fame Room'), null) // 2nd part not a street
    assert.equal(splitCommaLocation(''), null)
    assert.equal(splitCommaLocation(null), null)
  })

  it('returns null when the first segment is itself an address', () => {
    assert.equal(splitCommaLocation('1000 Kenmore Blvd, 1000 Kenmore Blvd, Akron'), null)
  })

  it('splits the full Eventbrite location string (the People\'s Park incident)', () => {
    const r = splitCommaLocation("People's Park, 760 Elma St, Akron, OH, 44310, United States")
    assert.equal(r.name, "People's Park")
    assert.equal(r.address, '760 Elma St')
    assert.equal(r.city, 'Akron')
  })

  it('never splits digit-led legit names (conservative: falls back to no-split)', () => {
    assert.equal(splitCommaLocation('7 17 Credit Union Park, 300 S Main St, Akron'), null)
  })
})

describe('venueNameKey', () => {
  it('folds curly and straight apostrophes to one key (People’s Park ≡ People\'s Park)', () => {
    assert.equal(venueNameKey('People’s Park'), venueNameKey("People's Park"))
    assert.equal(venueNameKey("People's Park"), "people's park")
  })

  it('folds U+02BC modifier letter apostrophe too', () => {
    assert.equal(venueNameKey('Peopleʼs Park'), venueNameKey("People's Park"))
  })

  it('folds case, whitespace, and a single trailing period/comma', () => {
    assert.equal(venueNameKey('  PEOPLE’S   PARK  '), "people's park")
    assert.equal(venueNameKey('Weathervane Playhouse.'), venueNameKey('Weathervane Playhouse'))
    assert.equal(venueNameKey('Weathervane Playhouse,'), venueNameKey('Weathervane Playhouse'))
  })

  it('strips HTML like ensureVenue does', () => {
    assert.equal(venueNameKey('<p>People&#8217;s Park</p>'), "people's park")
  })

  it('keeps genuinely distinct punctuated names apart (no punctuation stripping)', () => {
    assert.notEqual(venueNameKey("Art's Core"), venueNameKey('Arts Core'))
    assert.notEqual(venueNameKey('First & Main Green'), venueNameKey('First and Main Green'))
    assert.notEqual(venueNameKey('The Nightlight'), venueNameKey('Nightlight'))
  })

  it('interior periods survive — only ONE trailing period is stripped', () => {
    assert.equal(venueNameKey('E.J. Thomas Hall'), 'e.j. thomas hall')
    assert.equal(venueNameKey('Bounce & Co..'), 'bounce & co.')
  })

  it('empty / nullish input → empty string', () => {
    assert.equal(venueNameKey(''), '')
    assert.equal(venueNameKey(null), '')
    assert.equal(venueNameKey(undefined), '')
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
    assert.equal(canonicalVenueName('The Cummings Center for the History of Psychology'), 'Cummings Center for the History of Psychology')
    assert.equal(canonicalVenueName('The University of Akron: The National Museum of Psychology'), 'Cummings Center for the History of Psychology')
    assert.equal(canonicalVenueName('National Museum of Psychology'), 'Cummings Center for the History of Psychology')
    assert.equal(canonicalVenueName('The National Museum of Psychology'), 'Cummings Center for the History of Psychology')
    // Knight Stage — donor name + building-prefixed variant fold onto the canonical (feedback #46).
    assert.equal(canonicalVenueName('John, James and Clara Knight Stage'), 'The Knight Stage')
    assert.equal(canonicalVenueName('Akron Civic Theatre - Knight Stage'), 'The Knight Stage')
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
  it('strips the U+FFFD replacement char from title + description (mojibake, 2026-07-25)', () => {
    const row = sanitizeEventText({
      title: 'Barberton Summer Crawl � Christmas Walk',
      description: 'Saturday, July 25, 2026� 2:00 PM – 10:00 PM',
      source: 'main_street_barberton',
      source_id: 'moji-1',
    })
    assert.ok(!row.title.includes('�'), 'title has no replacement char')
    assert.ok(!row.description.includes('�'), 'description has no replacement char')
    assert.equal(row.title, 'Barberton Summer Crawl Christmas Walk')
    assert.equal(row.description, 'Saturday, July 25, 2026 2:00 PM – 10:00 PM')
  })

  it('leaves a legitimate "???" run alone (not our job to guess apostrophes)', () => {
    const row = sanitizeEventText({ title: 'Who Dun It???', description: null, source: 's', source_id: 'q' })
    assert.equal(row.title, 'Who Dun It???')
  })

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

describe('absoluteUrl', () => {
  it('passes absolute http(s) URLs through untouched', () => {
    assert.equal(
      absoluteUrl('https://example.com/img/poster.jpg', 'https://other.org'),
      'https://example.com/img/poster.jpg'
    )
    assert.equal(
      absoluteUrl('HTTP://example.com/a.png', 'https://other.org'),
      'HTTP://example.com/a.png'
    )
  })

  it('upgrades protocol-relative URLs to https', () => {
    assert.equal(
      absoluteUrl('//cdn.example.com/x.jpg', 'https://base.org'),
      'https://cdn.example.com/x.jpg'
    )
  })

  it('resolves a root-relative path against the base', () => {
    assert.equal(
      absoluteUrl('/uploads/x.jpg', 'https://www.weathervaneplayhouse.com'),
      'https://www.weathervaneplayhouse.com/uploads/x.jpg'
    )
  })

  it('resolves a bare filename against the base', () => {
    assert.equal(
      absoluteUrl('poster.jpg', 'https://example.com/shows/'),
      'https://example.com/shows/poster.jpg'
    )
  })

  it('trims surrounding whitespace before resolving', () => {
    assert.equal(
      absoluteUrl('  /a.png  ', 'https://example.com'),
      'https://example.com/a.png'
    )
  })

  it('returns null for null, undefined, empty, blank, and non-string input', () => {
    assert.equal(absoluteUrl(null, 'https://example.com'), null)
    assert.equal(absoluteUrl(undefined, 'https://example.com'), null)
    assert.equal(absoluteUrl('', 'https://example.com'), null)
    assert.equal(absoluteUrl('   ', 'https://example.com'), null)
    assert.equal(absoluteUrl(42, 'https://example.com'), null)
    assert.equal(absoluteUrl({ url: 'https://x.com/a.jpg' }, 'https://example.com'), null)
  })

  it('returns null when URL resolution throws (garbage/missing base)', () => {
    // Relative path with no usable base — new URL() throws.
    assert.equal(absoluteUrl('/uploads/x.jpg', undefined), null)
    assert.equal(absoluteUrl('a.jpg', 'not a url'), null)
  })
})

// ── upsertEventSafe: event_aliases enforcement at ingest ──────────────────────
// A merged duplicate must NOT resurrect on re-scrape: when a genuinely-new row
// (not already present under its own source/source_id) matches an event_aliases
// row whose canonical is still live, upsertEventSafe returns an error-shaped
// skip and performs NO upsert. It stays self-healing (null/dead canonical → it
// upserts) and never consults aliases for a live event (existed === true) or
// when the DISABLE_ALIAS_SKIP kill-switch is set.
//
// The real function runs offline by injecting a mock client through the
// supabase-admin test seam — the lazy Proxy routes every DB call through it.
const { upsertEventSafe } = await import('../lib/normalize.js')
const { __setClientForTests } = await import('../lib/supabase-admin.js')

// Builds a chainable mock supabase client. `config`:
//   existing       — row returned by the (source,source_id) existence lookup
//                    (non-null ⇒ existed === true)
//   alias          — row returned by the event_aliases lookup (or null)
//   canonicalAlive — whether the alias' canonical_event_id still resolves live
function makeSupabaseMock(config = {}) {
  const calls = { upsert: 0, aliasLookup: 0, canonicalCheck: 0, upsertArgs: null }
  function resolve(st) {
    if (st.op === 'upsert') return { data: { id: config.newId ?? 'new-ev-id' }, error: null }
    if (st.table === 'event_aliases') {
      calls.aliasLookup++
      return { data: config.alias ?? null, error: null }
    }
    if (st.table === 'events') {
      if (st.cols === 'id, manual_overrides') return { data: config.existing ?? null, error: null }
      if (st.cols === 'manual_overrides')     return { data: null, error: null } // syncEventCategories lookup
      if (st.cols === 'id') {
        calls.canonicalCheck++
        return { data: config.canonicalAlive ? { id: config.alias?.canonical_event_id ?? 'canon' } : null, error: null }
      }
    }
    return { data: null, error: null }
  }
  function builder(table) {
    const st = { table, cols: null, op: 'select' }
    const chain = {
      select(cols) { st.cols = cols; return chain },
      eq()  { return chain },
      neq() { return chain },
      insert() { return Promise.resolve({ error: null }) },
      delete() { st.op = 'delete'; return chain },
      upsert(row, opts) { calls.upsert++; calls.upsertArgs = { table, row, opts }; st.op = 'upsert'; return chain },
      maybeSingle() { return Promise.resolve(resolve(st)) },
      single()      { return Promise.resolve(resolve(st)) },
      then(onF, onR) { return Promise.resolve({ error: null }).then(onF, onR) },
    }
    return chain
  }
  return { client: { from: builder }, calls }
}

const futureIso = () => new Date(Date.now() + 7 * 86400000).toISOString()
const baseRow = () => ({ title: 'Aliased Event', source: 'akron_life', source_id: 'evt-1', start_at: futureIso() })

describe('upsertEventSafe — event_aliases enforcement', () => {
  it('(i) new row matching a LIVE-canonical alias → error-shaped skip, no upsert', async () => {
    const { client, calls } = makeSupabaseMock({
      existing: null,
      alias: { canonical_event_id: 'canon-123' },
      canonicalAlive: true,
    })
    __setClientForTests(client)
    try {
      const res = await upsertEventSafe(baseRow())
      assert.equal(res.data, null)
      assert.equal(res.isNew, false)
      assert.match(res.error.message, /^alias-skip: akron_life\/evt-1 → canonical canon-123$/)
      assert.equal(calls.upsert, 0)          // never wrote the event
      assert.equal(calls.aliasLookup, 1)     // consulted aliases
      assert.equal(calls.canonicalCheck, 1)  // verified canonical is live
    } finally {
      __setClientForTests(null)
    }
  })

  it('(ii-a) new row with NO alias → falls through to a normal upsert', async () => {
    const { client, calls } = makeSupabaseMock({ existing: null, alias: null })
    __setClientForTests(client)
    try {
      const res = await upsertEventSafe(baseRow())
      assert.equal(res.error, null)
      assert.equal(res.isNew, true)
      assert.equal(calls.upsert, 1)
      assert.equal(calls.aliasLookup, 1)
    } finally {
      __setClientForTests(null)
    }
  })

  it('(ii-b) new row whose alias canonical is DEAD → self-heals, upserts', async () => {
    const { client, calls } = makeSupabaseMock({
      existing: null,
      alias: { canonical_event_id: 'gone-999' },
      canonicalAlive: false,
    })
    __setClientForTests(client)
    try {
      const res = await upsertEventSafe(baseRow())
      assert.equal(res.error, null)
      assert.equal(res.isNew, true)
      assert.equal(calls.upsert, 1)          // re-entered the feed
      assert.equal(calls.canonicalCheck, 1)  // checked, found it dead
    } finally {
      __setClientForTests(null)
    }
  })

  it('(iii) existing live row (existed===true) → NEVER queries aliases, upserts as update', async () => {
    const { client, calls } = makeSupabaseMock({
      existing: { id: 'live-1', manual_overrides: null },
      alias: { canonical_event_id: 'canon-123' }, // present but must be ignored
      canonicalAlive: true,
    })
    __setClientForTests(client)
    try {
      const res = await upsertEventSafe(baseRow())
      assert.equal(res.error, null)
      assert.equal(calls.aliasLookup, 0)  // guard never fires on a live own-id row
      assert.equal(calls.upsert, 1)
    } finally {
      __setClientForTests(null)
    }
  })

  it('(iv) DISABLE_ALIAS_SKIP kill-switch → never queries aliases, upserts', async () => {
    const { client, calls } = makeSupabaseMock({
      existing: null,
      alias: { canonical_event_id: 'canon-123' },
      canonicalAlive: true,
    })
    __setClientForTests(client)
    process.env.DISABLE_ALIAS_SKIP = '1'
    try {
      const res = await upsertEventSafe(baseRow())
      assert.equal(res.error, null)
      assert.equal(calls.aliasLookup, 0)
      assert.equal(calls.upsert, 1)
    } finally {
      delete process.env.DISABLE_ALIAS_SKIP
      __setClientForTests(null)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// isJunkVenueName + ensureVenue mint-time junk gate
// ════════════════════════════════════════════════════════════════════════════

describe('isJunkVenueName', () => {
  it('flags virtual/placeholder markers (exact, case-insensitive)', () => {
    assert.equal(isJunkVenueName('Virtual'), true)
    assert.equal(isJunkVenueName('ONLINE EVENT'), true)
    assert.equal(isJunkVenueName('  zoom  '), true)
    assert.equal(isJunkVenueName('Webinar'), true)
    assert.equal(isJunkVenueName('TBD'), true)
    assert.equal(isJunkVenueName('tba'), true)
    assert.equal(isJunkVenueName('Livestream'), true)
  })

  it('flags bare US state names', () => {
    assert.equal(isJunkVenueName('Ohio'), true)
    assert.equal(isJunkVenueName('ohio'), true)
    assert.equal(isJunkVenueName('West Virginia'), true)
    assert.equal(isJunkVenueName('New York'), true)
  })

  it('flags house-number-less street fragments (last token is a street suffix)', () => {
    assert.equal(isJunkVenueName('Church Street'), true)
    assert.equal(isJunkVenueName('Main St'), true)
    assert.equal(isJunkVenueName('Kenmore Blvd'), true)
    assert.equal(isJunkVenueName('W Market Street'), true)
  })

  it('does NOT flag real venue names', () => {
    assert.equal(isJunkVenueName('Townhall'), false)           // substring-of-suffix only
    assert.equal(isJunkVenueName('Lock 3'), false)             // digit-bearing
    assert.equal(isJunkVenueName('Front Street Brewing'), false) // suffix not LAST token
    assert.equal(isJunkVenueName("Jilly's Music Room"), false)
    assert.equal(isJunkVenueName('BLU Jazz+'), false)
    assert.equal(isJunkVenueName('Akron Civic Theatre'), false)
    assert.equal(isJunkVenueName('Ohio & Erie Canal Towpath Trailhead'), false) // >3 tokens
  })

  it('digit-bearing strings are looksLikeStreetAddress territory, never junk-name', () => {
    assert.equal(isJunkVenueName('83 Church Street'), false)
    assert.equal(looksLikeStreetAddress('83 Church Street'), true)
    // and the complement: no house number → not an address, but IS junk
    assert.equal(looksLikeStreetAddress('Church Street'), false)
    assert.equal(isJunkVenueName('Church Street'), true)
  })

  it('empty / non-string input → false', () => {
    assert.equal(isJunkVenueName(''), false)
    assert.equal(isJunkVenueName(null), false)
    assert.equal(isJunkVenueName(undefined), false)
    assert.equal(isJunkVenueName(42), false)
  })
})

describe('isProseContactVenueName', () => {
  it('flags emails, URLs, phones, contact phrasing, and sentence-shaped strings', () => {
    assert.equal(isProseContactVenueName('For venue details reach us at: info@kogniora.com'), true)
    assert.equal(isProseContactVenueName('info@kogniora.com'), true)
    assert.equal(isProseContactVenueName('Visit www.kogniora.com for details'), true)
    assert.equal(isProseContactVenueName('Please call (330) 555-1234 to RSVP'), true)
    // sentence-shaped: >=8 tokens AND internal punctuation
    assert.equal(isProseContactVenueName('Doors open at 7, tickets at the door, see you there: Akron'), true)
  })

  it('does NOT flag real venue names, punctuated or digit-bearing', () => {
    assert.equal(isProseContactVenueName("Mrs. B's"), false)      // ". " but only 2 tokens
    assert.equal(isProseContactVenueName('R. Shea Brewing'), false)
    assert.equal(isProseContactVenueName('Lock 3'), false)
    assert.equal(isProseContactVenueName('Musica!'), false)
    assert.equal(isProseContactVenueName("Jilly's Music Room"), false)
    assert.equal(isProseContactVenueName('Akron-Summit County Public Library Main Branch'), false)
    assert.equal(isProseContactVenueName('The 3-2-1 Club'), false) // hyphenated digits ≠ phone
  })

  it('empty / non-string input → false', () => {
    assert.equal(isProseContactVenueName(''), false)
    assert.equal(isProseContactVenueName(null), false)
    assert.equal(isProseContactVenueName(undefined), false)
    assert.equal(isProseContactVenueName(42), false)
  })
})

// Venues mock for ensureVenue: name lookup resolves via .limit(1), insert via
// .insert().select('id').single(). Extended (venue-alias-hop work) to serve:
//   • allVenues  — [{ id, name, address?, neighborhood_slug? }] backing the
//                  exact-name lookup (filtered on .eq('name', …)), the
//                  name-index load (select 'id, name' awaited as a thenable),
//                  the address-index load, and the alias-canonical existence
//                  check (select 'id' + maybeSingle).
//   • aliases    — { alias_venue_id: canonical_venue_id } backing the
//                  venue_aliases hop lookups.
// When allVenues is omitted, `existingRows` backs the name lookup and the
// thenable loads resolve empty — exactly the old mock's behavior.
function makeVenuesMock({ existingRows = [], insertedId = 'v-new', allVenues = null, aliases = {} } = {}) {
  const calls = { insert: 0, insertRow: null, aliasLookups: 0 }
  function builder(table) {
    const st = { table, cols: null, op: null, filters: {} }
    const chain = {
      select(cols) { st.cols = cols; return chain },
      eq(col, val) { st.filters[col] = val; return chain },
      not()    { return chain },
      order()  { return chain },
      update() { st.op = 'update'; return chain },
      limit()  {
        const rows = allVenues
          ? allVenues
              .filter((v) => v.name === st.filters.name)
              .map((v) => ({ id: v.id, neighborhood_slug: v.neighborhood_slug ?? null }))
          : existingRows
        return Promise.resolve({ data: rows, error: null })
      },
      insert(row) { calls.insert++; calls.insertRow = row; return chain },
      single() { return Promise.resolve({ data: { id: insertedId }, error: null }) },
      maybeSingle() {
        if (st.table === 'venue_aliases') {
          calls.aliasLookups++
          const canonical = aliases[st.filters.alias_venue_id]
          return Promise.resolve({ data: canonical ? { canonical_venue_id: canonical } : null, error: null })
        }
        if (st.table === 'venues' && st.cols === 'id') {
          const alive = (allVenues ?? []).some((v) => v.id === st.filters.id)
          return Promise.resolve({ data: alive ? { id: st.filters.id } : null, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      },
      // Awaiting the chain directly serves the index loads (venues id,name /
      // id,address) and the fire-and-forget detail updates.
      then(onF, onR) {
        const data = st.table === 'venues' && st.op !== 'update' ? (allVenues ?? []) : []
        return Promise.resolve({ data, error: null }).then(onF, onR)
      },
    }
    return chain
  }
  return { client: { from: builder }, calls }
}

describe('ensureVenue — junk-name mint gate', () => {
  // NOTE: ensureVenue's per-process name cache has no reset hook, so each test
  // uses a distinct venue name to stay independent.

  it('refuses to MINT a junk-named venue: returns null, no insert', async () => {
    const { client, calls } = makeVenuesMock({ existingRows: [] })
    __setClientForTests(client)
    try {
      const id = await ensureVenue('Church Street')
      assert.equal(id, null)
      assert.equal(calls.insert, 0)
      // rejection is cached — second call short-circuits, still no insert
      assert.equal(await ensureVenue('Church Street'), null)
      assert.equal(calls.insert, 0)
    } finally {
      __setClientForTests(null)
    }
  })

  it('junk name ALREADY in the DB keeps resolving by exact name (gate is mint-time only)', async () => {
    const { client, calls } = makeVenuesMock({
      existingRows: [{ id: 'v-virtual', neighborhood_slug: null }],
    })
    __setClientForTests(client)
    try {
      const id = await ensureVenue('Virtual')
      assert.equal(id, 'v-virtual')
      assert.equal(calls.insert, 0)
    } finally {
      __setClientForTests(null)
    }
  })

  it('opts.allowGenericName bypasses the gate and mints', async () => {
    const { client, calls } = makeVenuesMock({ existingRows: [], insertedId: 'v-ohio' })
    __setClientForTests(client)
    try {
      const id = await ensureVenue('Ohio', {}, { allowGenericName: true })
      assert.equal(id, 'v-ohio')
      assert.equal(calls.insert, 1)
      assert.equal(calls.insertRow.name, 'Ohio')
    } finally {
      __setClientForTests(null)
    }
  })

  it('refuses a prose contact string as a venue name: returns null, no insert', async () => {
    const { client, calls } = makeVenuesMock({ existingRows: [] })
    __setClientForTests(client)
    try {
      const id = await ensureVenue('For venue details reach us at: info@kogniora.com')
      assert.equal(id, null)
      assert.equal(calls.insert, 0)
    } finally {
      __setClientForTests(null)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ensureVenue — comma-split, name-key fallback, venue_aliases hop
// (People's Park incident: Eventbrite's full location string + a
// curly-vs-straight apostrophe mismatch minted a duplicate venue per scrape.)
// ════════════════════════════════════════════════════════════════════════════

describe('ensureVenue — split + name-key + alias-hop resolution', () => {
  // The per-process name cache has no reset hook, so every test uses venue
  // names whose venueNameKey is unique across this file. The lazily cached
  // name/address indexes DO have reset hooks — reset both per test.
  function fresh(config) {
    _resetVenueNameIndex()
    _resetVenueAddressIndex()
    const { client, calls } = makeVenuesMock(config)
    __setClientForTests(client)
    return calls
  }

  it('(1) full Eventbrite location string resolves to the existing canonical venue, no insert', async () => {
    const calls = fresh({
      allVenues: [{ id: 'v-pp', name: "People's Park", address: '760 Elma St' }],
    })
    try {
      const id = await ensureVenue("People's Park, 760 Elma St, Akron, OH, 44310, United States")
      assert.equal(id, 'v-pp')
      assert.equal(calls.insert, 0)
    } finally {
      __setClientForTests(null)
    }
  })

  it('(2) curly-apostrophe input resolves onto the straight-apostrophe DB row', async () => {
    const calls = fresh({
      allVenues: [{ id: 'v-bb', name: "Byron's Bistro" }],
    })
    try {
      const id = await ensureVenue('Byron’s Bistro')
      assert.equal(id, 'v-bb')
      assert.equal(calls.insert, 0)
    } finally {
      __setClientForTests(null)
    }
  })

  it('(3) REGRESSION: DB row curly, input straight — name-key index catches what exact-match cannot', async () => {
    // One-sided normalization: stripHtml folds the INPUT's curly quote but the
    // DB row still carries one, so the exact .eq('name') lookup misses forever
    // and used to mint a duplicate on every scrape.
    const calls = fresh({
      allVenues: [{ id: 'v-on', name: 'O’Neil’s House' }],
    })
    try {
      const id = await ensureVenue("O'Neil's House")
      assert.equal(id, 'v-on')
      assert.equal(calls.insert, 0)
    } finally {
      __setClientForTests(null)
    }
  })

  it('(4a) resolved venue that is an alias returns its canonical instead', async () => {
    const calls = fresh({
      allVenues: [
        { id: 'v-old-hall', name: 'Old Hall' },
        { id: 'v-new-hall', name: 'New Hall' },
      ],
      aliases: { 'v-old-hall': 'v-new-hall' },
    })
    try {
      const id = await ensureVenue('Old Hall')
      assert.equal(id, 'v-new-hall')
      assert.ok(calls.aliasLookups >= 1)
      assert.equal(calls.insert, 0)
    } finally {
      __setClientForTests(null)
    }
  })

  it('(4b) alias whose canonical was deleted fails open to the matched id', async () => {
    const calls = fresh({
      allVenues: [{ id: 'v-ghost', name: 'Ghost Hall' }],
      aliases: { 'v-ghost': 'v-vanished' }, // canonical not in venues
    })
    try {
      const id = await ensureVenue('Ghost Hall')
      assert.equal(id, 'v-ghost')
      assert.equal(calls.insert, 0)
    } finally {
      __setClientForTests(null)
    }
  })

  it('(5a) bare address name + opts.allowAddressName mints an unlisted venue', async () => {
    const calls = fresh({ allVenues: [], insertedId: 'v-race-start' })
    try {
      const id = await ensureVenue('901 Rando Ave', {}, { allowAddressName: true, listed: false })
      assert.equal(id, 'v-race-start')
      assert.equal(calls.insert, 1)
      assert.equal(calls.insertRow.name, '901 Rando Ave')
      assert.equal(calls.insertRow.listed, false)
    } finally {
      __setClientForTests(null)
    }
  })

  it('(5b) bare address name WITHOUT the flag still refuses to mint', async () => {
    const calls = fresh({ allVenues: [] })
    try {
      const id = await ensureVenue('902 Rando Ave')
      assert.equal(id, null)
      assert.equal(calls.insert, 0)
    } finally {
      __setClientForTests(null)
    }
  })

  it('(6) digit-led legit names like "Lock 3" resolve exactly, never split or address-routed', async () => {
    const calls = fresh({
      allVenues: [{ id: 'v-lock3', name: 'Lock 3' }],
    })
    try {
      const id = await ensureVenue('Lock 3')
      assert.equal(id, 'v-lock3')
      assert.equal(calls.insert, 0)
    } finally {
      __setClientForTests(null)
    }
  })

  it('(7) alias hop applies to address-fallback resolutions too', async () => {
    const calls = fresh({
      allVenues: [
        { id: 'v-addr-alias', name: 'Elma Street Pavilion', address: '760 Elma St' },
        { id: 'v-addr-canon', name: 'Elma Street Park' },
      ],
      aliases: { 'v-addr-alias': 'v-addr-canon' },
    })
    try {
      // Name unknown to the DB; the scraper-supplied address matches the
      // aliased row — the returned id must be its canonical.
      const id = await ensureVenue('Neighbors of Elma Green', { address: '760 Elma St' })
      assert.equal(id, 'v-addr-canon')
      assert.equal(calls.insert, 0)
    } finally {
      __setClientForTests(null)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// ORGANIZATION FALLBACK IMAGE
// ════════════════════════════════════════════════════════════════════════════
//
// Replaced the hardcoded per-source SOURCE_FALLBACK_IMAGE map (deleted): an
// event with no photo of its own now borrows the FIRST photo on its linked
// organization, which admins set in the org editor.

const { orgFallbackPhoto, enrichWithImageDimensions } = await import('../lib/normalize.js')

describe('orgFallbackPhoto', () => {
  it('returns null for an org with no photos (the project-wide state today)', () => {
    assert.equal(orgFallbackPhoto([]), null)
  })

  it('returns null for null/undefined rather than throwing', () => {
    // A lazy org read that misses returns no row at all, and the `photos`
    // column is only NOT NULL going forward — never let either crash a scrape.
    assert.equal(orgFallbackPhoto(null), null)
    assert.equal(orgFallbackPhoto(undefined), null)
  })

  it('returns the FIRST photo, not an arbitrary one', () => {
    assert.equal(
      orgFallbackPhoto(['https://example.com/lead.jpg', 'https://example.com/second.jpg']),
      'https://example.com/lead.jpg')
  })
})

// ── enrichWithImageDimensions: the scraped image always wins ────────────────
//
// THE invariant of this feature. A source photo is specific to the event; an
// org photo is generic branding. If the fallback could ever overwrite a real
// image_url, every scraper with a photo would silently regress to a logo.
//
// Runs fully offline: images are served by a throwaway loopback HTTP server
// and every DB call goes through the supabase-admin test seam.
describe('enrichWithImageDimensions — org photo fallback', () => {
  // parseDimensions only reads the PNG signature plus the IHDR width/height
  // words, so a 32-byte stub is a valid probe target without shipping a binary.
  function pngStub(width, height) {
    const buf = Buffer.alloc(32)
    buf.writeUInt8(0x89, 0)
    buf.write('PNG', 1, 'ascii')
    buf.writeUInt32BE(width, 16)
    buf.writeUInt32BE(height, 20)
    return buf
  }

  const IMAGES = {
    '/scraped.png': pngStub(1200, 630),
    '/org.png':     pngStub(800, 800),

    // Bait for the "never normalize an org photo" tests below. Each pair is a
    // URL a per-source transform would mangle, PLUS the URL it would mangle it
    // INTO — both served, with distinct dimensions, so a regression fails on
    // the wrong URL *and* the wrong size rather than incidentally on a 404.
    '/org-300x300.png':                       pngStub(300, 300),   // → /org.png (800×800)
    '/styles/thumb/public/org-drupal.png':    pngStub(150, 150),
    '/org-drupal.png':                        pngStub(900, 900),
  }

  let server, base
  before(async () => {
    server = http.createServer((req, res) => {
      // Key on the path only: one bait URL carries Drupal's ?itok= token.
      const body = IMAGES[req.url.split('?')[0]]
      if (!body) { res.statusCode = 404; res.end(); return }
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Content-Length', String(body.length))
      res.end(body)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
  })
  after(() => new Promise((resolve) => server.close(resolve)))

  // Minimal client: the events probe that gates the dimension columns, the
  // org name and photos/status reads, and the "keep previous dimensions"
  // lookup. Org fixtures state `status` explicitly — the provenance gate below
  // is the whole point, so no fixture may inherit it by default.
  function imageMock({ orgs = {} } = {}) {
    const calls = { orgPhotoReads: 0 }
    function builder(table) {
      const st = { table, cols: null, id: null }
      const chain = {
        select(cols) { st.cols = cols; return chain },
        eq(col, val) { if (col === 'id') st.id = val; return chain },
        limit() { return Promise.resolve({ data: [], error: null }) },
        maybeSingle() {
          if (st.table === 'organizations') {
            if (st.cols === 'photos, status') calls.orgPhotoReads++
            return Promise.resolve({ data: orgs[st.id] ?? null, error: null })
          }
          return Promise.resolve({ data: null, error: null })  // no prior event row
        },
      }
      return chain
    }
    return { client: { from: builder }, calls }
  }

  it('never replaces a real scraped image_url with the org photo', async () => {
    const { client } = imageMock({
      orgs: { 'org-photo-1': { name: 'Cuyahoga Falls Library', photos: [`${base}/org.png`], status: 'published' } },
    })
    __setClientForTests(client)
    try {
      const out = await enrichWithImageDimensions(
        { title: 'T', source: 'cuyahoga_falls_library', source_id: 'a1', image_url: `${base}/scraped.png` },
        { organizationId: 'org-photo-1' })
      assert.equal(out.image_url, `${base}/scraped.png`)
      assert.equal(out.image_width, 1200)
      assert.equal(out.image_height, 630)
    } finally {
      __setClientForTests(null)
    }
  })

  it('uses a PUBLISHED org photo (with dimensions) only when the row has no image', async () => {
    const { client } = imageMock({
      orgs: { 'org-photo-2': { name: 'Cuyahoga Falls Library', photos: [`${base}/org.png`], status: 'published' } },
    })
    __setClientForTests(client)
    try {
      const out = await enrichWithImageDimensions(
        { title: 'T', source: 'cuyahoga_falls_library', source_id: 'a2', image_url: null },
        { organizationId: 'org-photo-2' })
      assert.equal(out.image_url, `${base}/org.png`)
      // Dimensions matter: banner eligibility is computed from them.
      assert.equal(out.image_width, 800)
      assert.equal(out.image_height, 800)
    } finally {
      __setClientForTests(null)
    }
  })

  it('leaves an image-less row image-less when the org has no photos', async () => {
    const { client } = imageMock({
      orgs: { 'org-photo-3': { name: 'Cuyahoga Falls Library', photos: [], status: 'published' } },
    })
    __setClientForTests(client)
    try {
      const out = await enrichWithImageDimensions(
        { title: 'T', source: 'cuyahoga_falls_library', source_id: 'a3', image_url: null },
        { organizationId: 'org-photo-3' })
      assert.equal(out.image_url ?? null, null)
      assert.equal(out.image_width, null)
    } finally {
      __setClientForTests(null)
    }
  })

  it('skips the fallback when the org is the aggregator crediting its own event', async () => {
    // Same condition linkEventOrganization refuses to link under. Borrowing the
    // photo there would brand an event we deliberately will not credit them for.
    const { client, calls } = imageMock({
      orgs: { 'org-photo-4': { name: 'Downtown Akron Partnership', photos: [`${base}/org.png`], status: 'published' } },
    })
    __setClientForTests(client)
    try {
      const out = await enrichWithImageDimensions(
        { title: 'T', source: 'downtown_akron', source_id: 'a4', image_url: null },
        { organizationId: 'org-photo-4' })
      assert.equal(out.image_url ?? null, null)
      assert.equal(calls.orgPhotoReads, 0)  // bailed before even reading photos
    } finally {
      __setClientForTests(null)
    }
  })

  it('omitting opts entirely behaves exactly as before org fallbacks existed', async () => {
    const { client, calls } = imageMock()
    __setClientForTests(client)
    try {
      const out = await enrichWithImageDimensions(
        { title: 'T', source: 'cuyahoga_falls_library', source_id: 'a5', image_url: null })
      assert.equal(out.image_url ?? null, null)
      assert.equal(calls.orgPhotoReads, 0)
    } finally {
      __setClientForTests(null)
    }
  })

  // ── Provenance gate: only a PUBLISHED org may donate a photo ─────────────
  //
  // The RLS policy "Anon can insert pending organizations" checks only
  // `status = 'pending_review'` — it carries NO column allowlist, so anyone
  // with the publishable key can insert an org row bearing an arbitrary
  // `photos` array, and `photos` is not covered by content moderation.
  // `organizations.name` has no unique index either, so such a row can also
  // win ensureOrganization's loose-name probe (findOrgByLooseName's first
  // ilike probe has no ORDER BY) and attach itself to a real event.
  //
  // 'published' is a status only an admin can set, which makes it the one
  // signal that a human curated these photos. Anything else — the
  // anon-reachable 'pending_review', an admin's 'cancelled', or an org id
  // that no longer resolves at all — donates nothing.
  const STATUS_CASES = [
    ['published',      true,  'an admin curated this row'],
    ['pending_review', false, 'the ONLY status anon can insert'],
    ['cancelled',      false, 'deliberately retired by an admin'],
  ]

  for (const [status, shouldUse, why] of STATUS_CASES) {
    it(`org status '${status}' ${shouldUse ? 'DONATES' : 'never donates'} its photo (${why})`, async () => {
      const orgId = `org-status-${status}`
      const { client } = imageMock({
        orgs: { [orgId]: { name: 'Cuyahoga Falls Library', photos: [`${base}/org.png`], status } },
      })
      __setClientForTests(client)
      try {
        const out = await enrichWithImageDimensions(
          { title: 'T', source: 'cuyahoga_falls_library', source_id: `s-${status}`, image_url: null },
          { organizationId: orgId })
        assert.equal(out.image_url ?? null, shouldUse ? `${base}/org.png` : null)
      } finally {
        __setClientForTests(null)
      }
    })
  }

  it('an org id that resolves to no row donates nothing (status reads as null)', async () => {
    const { client } = imageMock({ orgs: {} })
    __setClientForTests(client)
    try {
      const out = await enrichWithImageDimensions(
        { title: 'T', source: 'cuyahoga_falls_library', source_id: 's-missing', image_url: null },
        { organizationId: 'org-status-missing' })
      assert.equal(out.image_url ?? null, null)
    } finally {
      __setClientForTests(null)
    }
  })

  // ── normalizeImageUrl must NEVER run on an org photo ─────────────────────
  //
  // The per-source transforms in image-url-normalizer.js are keyed on `source`
  // alone and are NOT hostname-guarded: wordpressResizedSuffix and
  // drupalImageStyle rewrite ANY URL matching their pattern. They exist to
  // un-resize what a specific SOURCE served us. An org photo is admin-supplied
  // and has no relationship to the source's CDN, so running a transform on it
  // can silently rewrite it into a URL that does not exist — or, worse, into a
  // different real image.
  //
  // These two tests are what makes that invariant enforceable. Collapsing
  // enrichWithImageDimensions' ternary to
  //   const imageUrl = normalizeImageUrl(scrapedUrl ?? orgPhoto, row.source)
  // passes every other test in this repo; it fails these.
  const UNGUARDED_TRANSFORM_CASES = [
    {
      // TRANSFORMS.summit_artspace = wordpressResizedSuffix, which strips a
      // -WxH suffix: /org-300x300.png would become /org.png (a real 800×800).
      source: 'summit_artspace',
      photo:  '/org-300x300.png',
      width:  300,
    },
    {
      // TRANSFORMS.akron_childrens_museum = drupalImageStyle, which strips
      // /styles/<style>/public/ and the ?itok= query: this would become
      // /org-drupal.png (a real 900×900).
      source: 'akron_childrens_museum',
      photo:  '/styles/thumb/public/org-drupal.png?itok=aBcDeF',
      width:  150,
    },
  ]

  for (const { source, photo, width } of UNGUARDED_TRANSFORM_CASES) {
    it(`stores the org photo byte-identically for '${source}' (transform must not touch it)`, async () => {
      const orgId = `org-noxform-${source}`
      const orgPhoto = `${base}${photo}`
      const { client } = imageMock({
        orgs: { [orgId]: { name: 'Cuyahoga Falls Library', photos: [orgPhoto], status: 'published' } },
      })
      __setClientForTests(client)
      try {
        const out = await enrichWithImageDimensions(
          { title: 'T', source, source_id: `x-${source}`, image_url: null },
          { organizationId: orgId })
        // Byte-identical: not merely "resolves to an image".
        assert.equal(out.image_url, orgPhoto)
        // And the dimensions came from THAT file, not the transform's target.
        assert.equal(out.image_width, width)
      } finally {
        __setClientForTests(null)
      }
    })
  }

  it('still normalizes a SCRAPED url for the same sources (the guard is org-photo-only)', async () => {
    // Guards the opposite regression: dropping normalizeImageUrl entirely
    // would also make the two tests above pass.
    const { client } = imageMock({ orgs: {} })
    __setClientForTests(client)
    try {
      const out = await enrichWithImageDimensions(
        { title: 'T', source: 'summit_artspace', source_id: 'x-scraped', image_url: `${base}/org-300x300.png` })
      assert.equal(out.image_url, `${base}/org.png`)
      assert.equal(out.image_width, 800)
    } finally {
      __setClientForTests(null)
    }
  })
})
