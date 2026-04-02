/**
 * test-leadership-akron.js
 *
 * Tests for the Leadership Akron scraper — org-specific category/tag mapping,
 * venue resolution, full normalisation pipeline, and batch invariants.
 *
 * Run:
 *   node --test scripts/tests/test-leadership-akron.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Set dummy env vars before any imports ───────────────────────────────────
process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  normaliseSquarespaceEvent,
  parseSquarespaceLocation,
  buildSquarespaceEventUrl,
} from '../lib/squarespace.js'
import { sanitizeEventText } from '../lib/normalize.js'

import {
  COMPLETE_EVENT,
  NO_BODY,
  NO_LOCATION,
  MINIMAL_LOCATION,
  NO_START_DATE,
  FEATURED_EVENT,
  HTML_ENTITIES_TITLE,
  DIFFERENT_VENUE,
  NO_ZIP_IN_ADDRESS,
  UNUSUAL_ADDRESS_FORMAT,
  ALL_FIXTURES,
} from './fixtures/leadership-akron-events.js'

// ════════════════════════════════════════════════════════════════════════════
// RE-IMPLEMENT SCRAPER CONFIG FOR TESTABILITY
// ════════════════════════════════════════════════════════════════════════════

const SOURCE_KEY     = 'leadership_akron'
const SITE_BASE_URL  = 'https://www.leadershipakron.org'

function mapCategory(_item) {
  return 'community'
}

function mapTags(item) {
  const tags = ['leadership', 'networking', 'professional-development', 'akron']
  if (item.title?.toLowerCase().includes('leadership on main')) {
    tags.push('leadership-on-main')
  }
  return [...new Set(tags)]
}

const scraperConfig = {
  source:          SOURCE_KEY,
  mapCategory,
  mapTags,
  defaultPriceMin: 0,
  defaultPriceMax: null,
  ageRestriction:  'all_ages',
}

/** Simulate the full normalisation for one event item (mirrors scraper). */
function normalise(item) {
  const row = normaliseSquarespaceEvent(item, scraperConfig)
  row.ticket_url = buildSquarespaceEventUrl(SITE_BASE_URL, item) || row.ticket_url
  return row
}

// ════════════════════════════════════════════════════════════════════════════
// Category mapping
// ════════════════════════════════════════════════════════════════════════════

describe('Leadership Akron — category mapping', () => {
  it('maps all events to community', () => {
    for (const item of ALL_FIXTURES) {
      const row = normalise(item)
      assert.equal(row.category, 'community')
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Tag mapping
// ════════════════════════════════════════════════════════════════════════════

describe('Leadership Akron — tag mapping', () => {
  it('always includes base tags', () => {
    const row = normalise(COMPLETE_EVENT)
    assert.ok(row.tags.includes('leadership'))
    assert.ok(row.tags.includes('networking'))
    assert.ok(row.tags.includes('professional-development'))
    assert.ok(row.tags.includes('akron'))
  })

  it('adds leadership-on-main tag for LOM events', () => {
    const row = normalise(COMPLETE_EVENT)
    assert.ok(row.tags.includes('leadership-on-main'))
  })

  it('does not add leadership-on-main tag for non-LOM events', () => {
    const row = normalise(NO_LOCATION) // "Virtual Leadership Workshop"
    assert.ok(!row.tags.includes('leadership-on-main'))
  })

  it('featured event gets base tags plus LOM tag (title contains "Leadership on Main")', () => {
    const row = normalise(FEATURED_EVENT)
    assert.ok(row.tags.includes('leadership'))
    // "Leadership on Main: Annual Gala" contains "leadership on main"
    assert.ok(row.tags.includes('leadership-on-main'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Venue resolution
// ════════════════════════════════════════════════════════════════════════════

describe('Leadership Akron — venue resolution', () => {
  it('parses Duck Club venue from complete event', () => {
    const loc = parseSquarespaceLocation(COMPLETE_EVENT.location)
    assert.equal(loc.name, 'The Duck Club by Firestone at 7 17 Credit Union Park')
    assert.equal(loc.address, '300 South Main Street')
    assert.equal(loc.city, 'Akron')
    assert.equal(loc.state, 'OH')
    assert.equal(loc.zip, '44308')
  })

  it('parses different venue for December event', () => {
    const loc = parseSquarespaceLocation(DIFFERENT_VENUE.location)
    assert.equal(loc.name, 'Akron Art Museum')
    assert.equal(loc.address, '1 S High St')
  })

  it('returns null for event with no location', () => {
    const loc = parseSquarespaceLocation(NO_LOCATION.location)
    assert.equal(loc, null)
  })

  it('parses Akron Civic Theatre location', () => {
    const loc = parseSquarespaceLocation(MINIMAL_LOCATION.location)
    assert.equal(loc.name, 'Akron Civic Theatre')
    assert.equal(loc.address, '182 S Main St')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// URL construction
// ════════════════════════════════════════════════════════════════════════════

describe('Leadership Akron — URL construction', () => {
  it('builds correct public URL', () => {
    const row = normalise(COMPLETE_EVENT)
    assert.equal(row.ticket_url, 'https://www.leadershipakron.org/lom-2026/apr-26')
  })

  it('builds URL for different venue event', () => {
    const row = normalise(DIFFERENT_VENUE)
    assert.equal(row.ticket_url, 'https://www.leadershipakron.org/lom-2026/dec-26')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Full normalisation pipeline
// ════════════════════════════════════════════════════════════════════════════

describe('Leadership Akron — full normalisation', () => {
  it('complete event produces valid row', () => {
    const row = normalise(COMPLETE_EVENT)
    assert.equal(row.source, 'leadership_akron')
    assert.equal(row.source_id, '693b06ed3254061779677e65')
    assert.equal(row.title, 'Leadership on Main: April 2026')
    assert.equal(row.start_at, '2026-04-15T11:30:00.311Z')
    assert.equal(row.end_at, '2026-04-15T13:00:00.311Z')
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, null)
    assert.equal(row.age_restriction, 'all_ages')
    assert.equal(row.status, 'published')
    assert.ok(row.description.includes('Alicia Robinson'))
  })

  it('no-body event uses excerpt as description', () => {
    const row = normalise(NO_BODY)
    assert.equal(row.description, 'Details TBA!')
  })

  it('no-start-date event gets null start_at', () => {
    const row = normalise(NO_START_DATE)
    assert.equal(row.start_at, null)
  })

  it('featured event has featured=true', () => {
    const row = normalise(FEATURED_EVENT)
    assert.equal(row.featured, true)
  })

  it('non-featured event has featured=false', () => {
    const row = normalise(COMPLETE_EVENT)
    assert.equal(row.featured, false)
  })

  it('event with image has image_url set', () => {
    const row = normalise(COMPLETE_EVENT)
    assert.ok(row.image_url.includes('squarespace-cdn.com'))
  })

  it('event without image has image_url null', () => {
    const row = normalise(NO_BODY)
    assert.equal(row.image_url, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// HTML entity decoding (via sanitizeEventText chokepoint)
// ════════════════════════════════════════════════════════════════════════════

describe('Leadership Akron — HTML entity handling', () => {
  it('decodes &#8217; in title to apostrophe', () => {
    const row = normalise(HTML_ENTITIES_TITLE)
    // sanitizeEventText runs in upsertEventSafe, but normalise already strips HTML from body
    // Title comes through raw from Squarespace — sanitizeEventText will clean it at upsert time
    const sanitized = sanitizeEventText(row)
    assert.ok(!sanitized.title.includes('&#8217;'), 'numeric entity not decoded')
    assert.ok(sanitized.title.includes("'"), 'apostrophe missing after decode')
  })

  it('decodes &amp; in title', () => {
    const row = normalise(HTML_ENTITIES_TITLE)
    const sanitized = sanitizeEventText(row)
    assert.ok(!sanitized.title.includes('&amp;'), '&amp; not decoded')
    assert.ok(sanitized.title.includes('&'), '& missing after decode')
  })

  it('decodes entities in body/description during normalisation', () => {
    const row = normalise(COMPLETE_EVENT)
    // Body contains &amp; — should be decoded by stripHtml in normalise
    assert.ok(!row.description.includes('&amp;'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Batch invariants
// ════════════════════════════════════════════════════════════════════════════

describe('Leadership Akron — batch invariants', () => {
  it('every fixture normalises without error', () => {
    for (const item of ALL_FIXTURES) {
      assert.doesNotThrow(() => normalise(item))
    }
  })

  it('every normalised row has source=leadership_akron', () => {
    for (const item of ALL_FIXTURES) {
      const row = normalise(item)
      assert.equal(row.source, 'leadership_akron')
    }
  })

  it('every normalised row has non-empty tags array', () => {
    for (const item of ALL_FIXTURES) {
      const row = normalise(item)
      assert.ok(row.tags.length >= 4, `too few tags for "${item.title}"`)
    }
  })

  it('no duplicate tags in any row', () => {
    for (const item of ALL_FIXTURES) {
      const row = normalise(item)
      const unique = new Set(row.tags)
      assert.equal(row.tags.length, unique.size,
        `duplicate tags for "${item.title}": ${row.tags}`)
    }
  })

  it('description never contains raw HTML', () => {
    for (const item of ALL_FIXTURES) {
      const row = normalise(item)
      if (row.description) {
        assert.ok(!/<[a-z][\s\S]*>/i.test(row.description),
          `HTML found in description for "${item.title}"`)
      }
    }
  })

  it('ticket_url is always a full URL or null', () => {
    for (const item of ALL_FIXTURES) {
      const row = normalise(item)
      if (row.ticket_url) {
        assert.ok(row.ticket_url.startsWith('https://'),
          `ticket_url not a full URL for "${item.title}": ${row.ticket_url}`)
      }
    }
  })

  it('start_at is valid ISO 8601 or null', () => {
    for (const item of ALL_FIXTURES) {
      const row = normalise(item)
      if (row.start_at) {
        assert.ok(!isNaN(Date.parse(row.start_at)),
          `Invalid start_at for "${item.title}"`)
      }
    }
  })
})
