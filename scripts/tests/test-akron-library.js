/**
 * test-akron-library.js
 *
 * Integration tests for the Akron Library scraper's data processing pipeline.
 * Tests every permutation of the API response structure to ensure proper
 * normalization, category mapping, tag parsing, venue resolution, and
 * error handling.
 *
 * Strategy: We import the pure logic from the scraper and mock the database
 * layer. This validates that every data shape the API could return gets
 * correctly transformed into our normalized schema.
 *
 * Run:
 *   node --test scripts/tests/test-akron-library.js
 */

import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'

// ── Set dummy env vars before any imports ────────────────────────────────────
process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

// ── Import fixtures ──────────────────────────────────────────────────────────
import {
  COMPLETE_EVENT,
  HTML_ENTITY_TITLE,
  NO_DESCRIPTION,
  MISSING_START_TIME,
  EMPTY_STRINGS,
  UNKNOWN_VENUE,
  DUPLICATE_SLASHES_URL,
  RICH_HTML_DESCRIPTION,
  SHORT_DESCRIPTION_ONLY,
  DST_BOUNDARY_EVENT,
  ALL_AGE_GROUPS,
  NULL_LOCATION_NAME,
  FOOD_EVENT,
  ALL_FIXTURES,
} from './fixtures/library-events.js'

// ── Import shared utilities (pure functions) ─────────────────────────────────
import { stripHtml, easternToIso } from '../lib/normalize.js'

// ════════════════════════════════════════════════════════════════════════════
// RE-IMPLEMENT SCRAPER LOGIC FOR TESTABILITY
// ════════════════════════════════════════════════════════════════════════════
//
// The scraper file (scrape-akron-library.js) defines these functions locally.
// We replicate them here for isolated testing. In a production codebase, you'd
// extract these into a separate module. For now, this tests the LOGIC not the
// module boundary.

// ── Category mapping (mirrors scraper) ───────────────────────────────────────

const LIBRARY_CATEGORY_MAP = {
  'arts & crafts':        'art',
  'art':                  'art',
  'music':                'music',
  'concert':              'music',
  'performance':          'music',
  'film':                 'art',
  'movie':                'art',
  'storytime':            'community',
  'story time':           'community',
  'games & gaming':       'community',
  'gaming':               'community',
  'book':                 'education',
  'book sale':            'community',
  'education':            'education',
  'computer':             'education',
  'technology':           'education',
  'stem':                 'education',
  'science':              'education',
  'financial':            'education',
  'job':                  'education',
  'career':               'education',
  'health':               'community',
  'wellness':             'community',
  'yoga':                 'community',
  'fitness':              'sports',
  'volunteer':            'nonprofit',
  'fundrais':             'nonprofit',
  'nonprofit':            'nonprofit',
  'family':               'community',
  'kids':                 'community',
  'teen':                 'community',
  'senior':               'community',
  'community':            'community',
  'food':                 'food',
  'cooking':              'food',
}

function parseCategory(tagStr = '', title = '') {
  const combined = (tagStr + ' ' + title).toLowerCase()
  for (const [keyword, cat] of Object.entries(LIBRARY_CATEGORY_MAP)) {
    if (combined.includes(keyword)) return cat
  }
  return 'community'
}

function parseTags(tagStr = '', ageStr = '') {
  const tags = []
  if (tagStr) tags.push(...tagStr.toLowerCase().split(',').map(t => t.trim()).filter(Boolean))
  if (ageStr) {
    const ages = ageStr.toLowerCase().split(',').map(a => a.trim()).filter(Boolean)
    for (const age of ages) {
      if (age.includes('baby') || age.includes('toddler') || age.includes('preschool')) tags.push('kids')
      if (age.includes('teen') || age.includes('tween')) tags.push('teens')
      if (age.includes('adult')) tags.push('adults')
      if (age.includes('senior') || age.includes('older')) tags.push('seniors')
    }
  }
  tags.push('free', 'library')
  return [...new Set(tags)]
}

function sanitizeUrl(url) {
  if (!url) return null
  try {
    const u = new URL(url)
    u.pathname = u.pathname.replace(/\/+/g, '/')
    return u.toString()
  } catch {
    return url
  }
}

// Known branch libraries (subset for testing)
const BRANCH_INFO = {
  'Main Library':                   { address: '60 S High St',      zip: '44326' },
  'Highland Square Branch Library': { address: '807 W Market St',   zip: '44303' },
  'Kenmore Branch Library':         { address: '969 Kenmore Blvd',  zip: '44314' },
  'Firestone Park Branch Library':  { address: '1486 Aster Ave',    zip: '44301' },
  'Ellet Branch Library':           { address: '2470 E Market St',  zip: '44312' },
}

/**
 * Simulate the full event-processing pipeline for one raw API event.
 * Returns the normalized row that would be upserted, or null if skipped.
 */
function normalizeLibraryEvent(ev) {
  const title    = stripHtml(ev.title || '')
  const category = parseCategory(ev.tags, title)
  const tags     = parseTags(ev.tags, ev.age)
  const startAt  = easternToIso(ev.raw_start_time)
  const endAt    = easternToIso(ev.raw_end_time)
  const descText = stripHtml(ev.long_description || ev.description || '')

  if (!startAt) return null

  return {
    title,
    description:     descText || null,
    start_at:        startAt,
    end_at:          endAt,
    category,
    tags,
    price_min:       0,
    price_max:       null,
    age_restriction: 'not_specified',
    image_url:       ev.image ? `https://services.akronlibrary.org/images/events/akronlibrary/${ev.image}` : null,
    ticket_url:      sanitizeUrl(ev.url),
    source:          'akron_library',
    source_id:       String(ev.id),
    status:          'published',
    featured:        false,
  }
}

function resolveVenueType(locationName) {
  if (!locationName) return 'fallback'
  return BRANCH_INFO[locationName] ? 'known_branch' : 'external'
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Category Mapping
// ════════════════════════════════════════════════════════════════════════════

describe('Library: Category Mapping', () => {
  it('maps technology/stem tags to education', () => {
    assert.equal(parseCategory('technology,stem', 'Maker Monday'), 'education')
  })

  it('maps book tags to education', () => {
    assert.equal(parseCategory('book', 'Author Talk'), 'education')
  })

  it('maps storytime to community', () => {
    assert.equal(parseCategory('storytime', 'Drop-In Storytime'), 'community')
  })

  it('maps wellness/yoga to community', () => {
    assert.equal(parseCategory('wellness,yoga', ''), 'community')
  })

  it('maps gaming to community', () => {
    assert.equal(parseCategory('gaming,games & gaming', ''), 'community')
  })

  it('maps food/cooking to food', () => {
    assert.equal(parseCategory('cooking,food', ''), 'food')
  })

  it('maps fitness to sports', () => {
    assert.equal(parseCategory('fitness', ''), 'sports')
  })

  it('maps volunteer/fundrais to nonprofit', () => {
    assert.equal(parseCategory('volunteer', ''), 'nonprofit')
    assert.equal(parseCategory('fundraiser event', ''), 'nonprofit')
  })

  it('defaults to community for unknown tags', () => {
    assert.equal(parseCategory('', ''), 'community')
    assert.equal(parseCategory('random-stuff', 'Unknown Event'), 'community')
  })

  it('checks title for category keywords too', () => {
    assert.equal(parseCategory('', 'Live Music at the Library'), 'music')
  })

  it('maps art/arts & crafts to art', () => {
    assert.equal(parseCategory('arts & crafts', ''), 'art')
  })

  it('maps job/career to education', () => {
    assert.equal(parseCategory('job,career', ''), 'education')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Tag Parsing
// ════════════════════════════════════════════════════════════════════════════

describe('Library: Tag Parsing', () => {
  it('splits comma-separated tags and lowercases them', () => {
    const tags = parseTags('Technology,STEM', '')
    assert.ok(tags.includes('technology'))
    assert.ok(tags.includes('stem'))
  })

  it('maps baby/toddler/preschool ages to kids tag', () => {
    const tags = parseTags('', 'Baby & Toddler,Preschool')
    assert.ok(tags.includes('kids'))
  })

  it('maps teen/tween ages to teens tag', () => {
    const tags = parseTags('', 'Teens,Tweens')
    assert.ok(tags.includes('teens'))
  })

  it('maps adult ages to adults tag', () => {
    const tags = parseTags('', 'Adults')
    assert.ok(tags.includes('adults'))
  })

  it('maps senior/older ages to seniors tag', () => {
    const tags = parseTags('', 'Older Adults')
    assert.ok(tags.includes('seniors'))
  })

  it('always includes free and library tags', () => {
    const tags = parseTags('', '')
    assert.ok(tags.includes('free'))
    assert.ok(tags.includes('library'))
  })

  it('deduplicates tags', () => {
    const tags = parseTags('free,library', '')
    const freeCount = tags.filter(t => t === 'free').length
    assert.equal(freeCount, 1)
  })

  it('handles all age groups simultaneously', () => {
    const tags = parseTags('community', 'Baby & Toddler,Preschool,Kids,Tweens,Teens,Adults,Older Adults')
    assert.ok(tags.includes('kids'))
    assert.ok(tags.includes('teens'))
    assert.ok(tags.includes('adults'))
    assert.ok(tags.includes('seniors'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: URL Sanitization
// ════════════════════════════════════════════════════════════════════════════

describe('Library: URL Sanitization', () => {
  it('collapses duplicate slashes in path', () => {
    const result = sanitizeUrl('https://akronlibrary.libnet.info//event/10007')
    assert.equal(result, 'https://akronlibrary.libnet.info/event/10007')
  })

  it('leaves correct URLs unchanged', () => {
    const url = 'https://akronlibrary.libnet.info/event/10001'
    assert.equal(sanitizeUrl(url), url)
  })

  it('returns null for null/empty input', () => {
    assert.equal(sanitizeUrl(null), null)
    assert.equal(sanitizeUrl(''), null)
  })

  it('returns invalid URLs as-is', () => {
    assert.equal(sanitizeUrl('not a url'), 'not a url')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Venue Resolution
// ════════════════════════════════════════════════════════════════════════════

describe('Library: Venue Resolution', () => {
  it('identifies known branch libraries', () => {
    assert.equal(resolveVenueType('Main Library'), 'known_branch')
    assert.equal(resolveVenueType('Highland Square Branch Library'), 'known_branch')
    assert.equal(resolveVenueType('Kenmore Branch Library'), 'known_branch')
  })

  it('identifies external/unknown venues', () => {
    assert.equal(resolveVenueType('Hardesty Park'), 'external')
    assert.equal(resolveVenueType('Some Random Place'), 'external')
  })

  it('handles null/missing location name', () => {
    assert.equal(resolveVenueType(null), 'fallback')
    assert.equal(resolveVenueType(undefined), 'fallback')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Full Event Normalization Pipeline
// ════════════════════════════════════════════════════════════════════════════

describe('Library: Event Normalization', () => {
  it('normalizes a complete event correctly', () => {
    const row = normalizeLibraryEvent(COMPLETE_EVENT)
    assert.ok(row, 'should not be null')
    assert.equal(row.title, 'Maker Monday: 3D Printing Intro')
    assert.equal(row.source, 'akron_library')
    assert.equal(row.source_id, '10001')
    assert.equal(row.category, 'education') // technology,stem → education
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, null) // library events are free
    assert.ok(row.start_at.includes('2026-05-15'))
    assert.ok(row.end_at.includes('2026-05-15'))
    assert.ok(row.tags.includes('technology'))
    assert.ok(row.tags.includes('stem'))
    assert.ok(row.tags.includes('adults'))
    assert.ok(row.tags.includes('teens'))
    assert.ok(row.tags.includes('free'))
    assert.ok(row.tags.includes('library'))
    // Uses long_description over short description
    assert.ok(row.description.includes('hands-on'))
    assert.ok(!row.description.includes('<strong>'))
    // Image URL construction
    assert.equal(row.image_url, 'https://services.akronlibrary.org/images/events/akronlibrary/maker-monday.jpg')
    // Ticket URL
    assert.equal(row.ticket_url, 'https://akronlibrary.libnet.info/event/10001')
  })

  it('decodes HTML entities in title', () => {
    const row = normalizeLibraryEvent(HTML_ENTITY_TITLE)
    assert.ok(row)
    // &#8217; → right single quote → normalized to ASCII apostrophe by stripHtml
    assert.equal(row.title, "Books & Beyond: Author's Talk")
    assert.equal(row.category, 'education') // 'book' tag → education
  })

  it('handles event with no description', () => {
    const row = normalizeLibraryEvent(NO_DESCRIPTION)
    assert.ok(row)
    assert.equal(row.description, null)
    assert.equal(row.category, 'community') // 'storytime' → community
    assert.ok(row.tags.includes('kids')) // Baby & Toddler, Preschool → kids
  })

  it('skips event with missing start time', () => {
    const row = normalizeLibraryEvent(MISSING_START_TIME)
    assert.equal(row, null, 'event without start_at should be skipped')
  })

  it('handles empty strings for optional fields', () => {
    const row = normalizeLibraryEvent(EMPTY_STRINGS)
    assert.ok(row)
    assert.equal(row.description, null) // empty string → null
    assert.equal(row.end_at, null)      // empty string → easternToIso returns null
    assert.equal(row.image_url, null)   // empty string image → null
    assert.equal(row.ticket_url, null)  // empty string → sanitizeUrl returns null
    assert.equal(row.category, 'education') // title "Mystery Book Club" contains 'book' → education
  })

  it('handles unknown venue location', () => {
    const row = normalizeLibraryEvent(UNKNOWN_VENUE)
    assert.ok(row)
    // The event itself normalizes fine — venue resolution is separate
    assert.equal(row.category, 'community') // wellness,yoga → community
    assert.equal(resolveVenueType(UNKNOWN_VENUE.location), 'external')
  })

  it('sanitizes duplicate slashes in URL', () => {
    const row = normalizeLibraryEvent(DUPLICATE_SLASHES_URL)
    assert.ok(row)
    assert.equal(row.ticket_url, 'https://akronlibrary.libnet.info/event/10007')
    assert.equal(row.category, 'education') // job,career → education
  })

  it('strips rich HTML from long_description', () => {
    const row = normalizeLibraryEvent(RICH_HTML_DESCRIPTION)
    assert.ok(row)
    assert.ok(row.description, 'should have description')
    assert.ok(!row.description.includes('<h2>'))
    assert.ok(!row.description.includes('<em>'))
    assert.ok(!row.description.includes('<ul>'))
    assert.ok(!row.description.includes('<li>'))
    assert.ok(row.description.includes('Summer Reading'))
    assert.ok(row.description.includes('prizes'))
    assert.ok(row.description.includes('all ages'))
    // &rsquo; should be decoded
    assert.ok(!row.description.includes('&rsquo;'))
  })

  it('falls back to short description when no long_description', () => {
    const row = normalizeLibraryEvent(SHORT_DESCRIPTION_ONLY)
    assert.ok(row)
    assert.equal(row.description, 'Play video games at the library! Snacks provided.')
    assert.equal(row.category, 'community') // gaming → community
  })

  it('handles DST boundary times', () => {
    const row = normalizeLibraryEvent(DST_BOUNDARY_EVENT)
    assert.ok(row)
    // March 8, 2026 1:30 AM — DST transition day, treated as EDT → UTC-4 → 05:30 UTC
    assert.equal(row.start_at, '2026-03-08T05:30:00.000Z')
    assert.equal(row.category, 'art') // 'arts & crafts' → art
  })

  it('includes all age-derived tags', () => {
    const row = normalizeLibraryEvent(ALL_AGE_GROUPS)
    assert.ok(row)
    assert.ok(row.tags.includes('kids'))
    assert.ok(row.tags.includes('teens'))
    assert.ok(row.tags.includes('adults'))
    assert.ok(row.tags.includes('seniors'))
    assert.ok(row.tags.includes('free'))
    assert.ok(row.tags.includes('library'))
  })

  it('handles null location gracefully', () => {
    const row = normalizeLibraryEvent(NULL_LOCATION_NAME)
    assert.ok(row)
    // Event should still normalize — venue resolution handled separately
    assert.equal(row.source_id, '10012')
    assert.equal(resolveVenueType(NULL_LOCATION_NAME.location), 'fallback')
  })

  it('categorizes food events correctly', () => {
    const row = normalizeLibraryEvent(FOOD_EVENT)
    assert.ok(row)
    assert.equal(row.category, 'food')
    assert.ok(row.image_url.includes('chef-marcus.jpg'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Batch Processing Invariants
// ════════════════════════════════════════════════════════════════════════════

describe('Library: Batch Processing', () => {
  it('every fixture produces a consistent source field', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeLibraryEvent(fixture)
      if (row) {
        assert.equal(row.source, 'akron_library', `source wrong for fixture id=${fixture.id}`)
      }
    }
  })

  it('every non-null row has required fields', () => {
    const REQUIRED = ['title', 'start_at', 'category', 'source', 'source_id', 'status']
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeLibraryEvent(fixture)
      if (!row) continue
      for (const field of REQUIRED) {
        assert.ok(row[field] != null, `fixture id=${fixture.id} missing required field '${field}'`)
      }
    }
  })

  it('every non-null row has price_min as a number', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeLibraryEvent(fixture)
      if (!row) continue
      assert.equal(typeof row.price_min, 'number', `fixture id=${fixture.id} price_min not a number`)
    }
  })

  it('tags array is always an array with at least "free" and "library"', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeLibraryEvent(fixture)
      if (!row) continue
      assert.ok(Array.isArray(row.tags), `fixture id=${fixture.id} tags not an array`)
      assert.ok(row.tags.includes('free'), `fixture id=${fixture.id} missing 'free' tag`)
      assert.ok(row.tags.includes('library'), `fixture id=${fixture.id} missing 'library' tag`)
    }
  })

  it('no row has HTML in its title or description', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeLibraryEvent(fixture)
      if (!row) continue
      assert.ok(!/<[a-zA-Z]/.test(row.title), `fixture id=${fixture.id} has HTML in title`)
      if (row.description) {
        assert.ok(!/<[a-zA-Z]/.test(row.description), `fixture id=${fixture.id} has HTML in description`)
      }
    }
  })

  it('exactly one fixture should be skipped (missing start time)', () => {
    const skipped = ALL_FIXTURES.filter(f => normalizeLibraryEvent(f) === null)
    assert.equal(skipped.length, 1)
    assert.equal(skipped[0].id, MISSING_START_TIME.id)
  })

  it('all start_at values are valid ISO 8601 strings', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeLibraryEvent(fixture)
      if (!row) continue
      const parsed = new Date(row.start_at)
      assert.ok(!isNaN(parsed.getTime()), `fixture id=${fixture.id} has invalid start_at: ${row.start_at}`)
      assert.ok(row.start_at.endsWith('Z'), `fixture id=${fixture.id} start_at should end with Z`)
    }
  })

  it('source_id is always a string', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeLibraryEvent(fixture)
      if (!row) continue
      assert.equal(typeof row.source_id, 'string', `fixture id=${fixture.id} source_id not a string`)
    }
  })

  it('category is always one of the allowed values', () => {
    const ALLOWED = ['music', 'art', 'community', 'education', 'sports', 'food', 'nonprofit', 'other']
    for (const fixture of ALL_FIXTURES) {
      const row = normalizeLibraryEvent(fixture)
      if (!row) continue
      assert.ok(ALLOWED.includes(row.category), `fixture id=${fixture.id} has invalid category: ${row.category}`)
    }
  })
})
