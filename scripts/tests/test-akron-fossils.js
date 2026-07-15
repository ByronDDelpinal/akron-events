/**
 * test-akron-fossils.js
 *
 * Unit tests for the Akron Fossils & Science Center scraper — kids'-program
 * detection, category/tag mapping, price parsing from prose, the full
 * normalisation pipeline, venue resolution, and batch invariants.
 *
 * Run:
 *   node --test scripts/tests/test-akron-fossils.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Dummy env vars before any imports ───────────────────────────────────────
process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  isKidsProgram,
  mapCategory,
  mapTags,
  parsePrice,
  buildRow,
} from '../scrape-akron-fossils.js'
import { parseSquarespaceLocation } from '../lib/squarespace.js'
import { sanitizeEventText } from '../lib/normalize.js'

import {
  CAMP,
  STEAM_CAMP,
  SUPER_SCIENCE,
  ADULT_CRAFT,
  GOLF,
  CANOE,
  NO_BODY_EVENT,
  NO_START_DATE,
  HTML_ENTITIES_TITLE,
  ALL_FIXTURES,
} from './fixtures/akron-fossils-events.js'

// ════════════════════════════════════════════════════════════════════════════
// Kids' / family program detection
// ════════════════════════════════════════════════════════════════════════════

describe('Akron Fossils — kids-program detection', () => {
  it('flags a themed day camp', () => {
    assert.equal(isKidsProgram(CAMP), true)
  })

  it('flags the dotted S.T.E.A.M. Camp title', () => {
    assert.equal(isKidsProgram(STEAM_CAMP), true)
  })

  it('flags Super Science Saturday', () => {
    assert.equal(isKidsProgram(SUPER_SCIENCE), true)
  })

  it('flags a homeschool program', () => {
    assert.equal(isKidsProgram(NO_BODY_EVENT), true) // "Homeschool Science Day"
  })

  it('does NOT flag the adults-only craft night', () => {
    assert.equal(isKidsProgram(ADULT_CRAFT), false)
  })

  it('does NOT flag the golf-outing fundraiser', () => {
    assert.equal(isKidsProgram(GOLF), false)
  })

  it('does NOT flag the wilderness canoe trip', () => {
    assert.equal(isKidsProgram(CANOE), false)
  })

  it('handles a missing/undefined title gracefully', () => {
    assert.doesNotThrow(() => isKidsProgram({}))
    assert.equal(isKidsProgram({}), false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Category mapping
// ════════════════════════════════════════════════════════════════════════════

describe('Akron Fossils — category mapping', () => {
  it('maps kids camps to the learning hint', () => {
    assert.equal(mapCategory(CAMP), 'learning')
    assert.equal(mapCategory(STEAM_CAMP), 'learning')
  })

  it('maps Super Science Saturday to the learning hint', () => {
    assert.equal(mapCategory(SUPER_SCIENCE), 'learning')
  })

  it('hints adult craft classes to visual-art', () => {
    assert.equal(mapCategory(ADULT_CRAFT), 'visual-art')
  })

  it('hints the golf outing to sports', () => {
    assert.equal(mapCategory(GOLF), 'sports')
  })

  it('leaves other general events to inference (null hint)', () => {
    assert.equal(mapCategory(CANOE), null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Tag mapping
// ════════════════════════════════════════════════════════════════════════════

describe('Akron Fossils — tag mapping', () => {
  it('every event carries the four base tags', () => {
    for (const item of ALL_FIXTURES) {
      const tags = mapTags(item)
      for (const base of ['akron-fossils', 'copley', 'museum', 'science']) {
        assert.ok(tags.includes(base), `missing "${base}" tag for "${item.title}"`)
      }
    }
  })

  it('camp gets summer-camp + kids tags', () => {
    const tags = mapTags(CAMP)
    assert.ok(tags.includes('summer-camp'))
    assert.ok(tags.includes('kids'))
  })

  it('Super Science Saturday gets family + science-program tags', () => {
    const tags = mapTags(SUPER_SCIENCE)
    assert.ok(tags.includes('family'))
    assert.ok(tags.includes('science-program'))
  })

  it('golf outing gets golf + fundraiser tags', () => {
    const tags = mapTags(GOLF)
    assert.ok(tags.includes('golf'))
    assert.ok(tags.includes('fundraiser'))
  })

  it('canoe trip gets outdoors + adventure tags', () => {
    const tags = mapTags(CANOE)
    assert.ok(tags.includes('outdoors'))
    assert.ok(tags.includes('adventure'))
  })

  it('produces no duplicate tags for any fixture', () => {
    for (const item of ALL_FIXTURES) {
      const tags = mapTags(item)
      assert.equal(tags.length, new Set(tags).size, `dup tags for "${item.title}"`)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Price parsing
// ════════════════════════════════════════════════════════════════════════════

describe('Akron Fossils — price parsing', () => {
  it('parses member/non-member pricing into min/max', () => {
    assert.deepEqual(parsePrice('Cost is $18 per non-member/$12 per member'), {
      price_min: 12, price_max: 18,
    })
  })

  it('returns nulls when no price is stated', () => {
    assert.deepEqual(parsePrice('More details to come, so check back soon.'), {
      price_min: null, price_max: null,
    })
  })

  it('handles a single price (max stays null)', () => {
    assert.deepEqual(parsePrice('Admission is $10.'), { price_min: 10, price_max: null })
  })

  it('parses cents', () => {
    assert.deepEqual(parsePrice('Tickets $12.50 each'), { price_min: 12.5, price_max: null })
  })

  it('handles empty input', () => {
    assert.deepEqual(parsePrice(''), { price_min: null, price_max: null })
    assert.deepEqual(parsePrice(), { price_min: null, price_max: null })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Full normalisation pipeline (buildRow)
// ════════════════════════════════════════════════════════════════════════════

describe('Akron Fossils — buildRow', () => {
  it('camp produces a valid learning + family row', () => {
    const row = buildRow(CAMP)
    assert.equal(row.source, 'akron_fossils')
    assert.equal(row.source_id, '6980e02e6bcfd20edbf3d036')
    assert.equal(row.title, 'Aspiring Artists Camp')
    assert.equal(row.category, 'learning')
    assert.equal(row.is_family, true)
    assert.equal(row.status, 'published')
    assert.ok(!isNaN(Date.parse(row.start_at)))
    assert.ok(!isNaN(Date.parse(row.end_at)))
  })

  it('Super Science Saturday carries parsed price + family flag', () => {
    const row = buildRow(SUPER_SCIENCE)
    assert.equal(row.is_family, true)
    assert.equal(row.category, 'learning')
    assert.equal(row.price_min, 12)
    assert.equal(row.price_max, 18)
  })

  it('preserves the real feed time (no midnight synthesis)', () => {
    const row = buildRow(SUPER_SCIENCE)
    // 10:30am ET on 2026-07-18 → 14:30 UTC (EDT), whole-second floored.
    assert.equal(row.start_at, '2026-07-18T14:30:00.000Z')
    assert.equal(new Date(row.start_at).getUTCMilliseconds(), 0)
  })

  it('adult craft night is not family and has no assumed price', () => {
    const row = buildRow(ADULT_CRAFT)
    assert.notEqual(row.is_family, true) // undefined → inference decides downstream
    assert.equal(row.category, 'visual-art')
    assert.equal(row.price_min, null)
    assert.equal(row.price_max, null)
  })

  it('golf outing leaves price null and category to inference', () => {
    const row = buildRow(GOLF)
    assert.equal(row.category, 'sports')
    assert.equal(row.price_min, null)
    assert.equal(row.price_max, null)
    assert.notEqual(row.is_family, true)
  })

  it('builds the full public detail URL', () => {
    const row = buildRow(CAMP)
    assert.equal(row.ticket_url, 'https://www.akronfossils.org/events/aspiring-artists-camp-1')
  })

  it('sets image_url to the Squarespace CDN asset', () => {
    const row = buildRow(SUPER_SCIENCE)
    assert.ok(row.image_url?.includes('squarespace-cdn.com'))
  })

  it('no-body event uses the excerpt as description', () => {
    const row = buildRow(NO_BODY_EVENT)
    assert.equal(row.description, 'Details coming soon.')
  })

  it('no-start-date event has null start_at (will be skipped)', () => {
    const row = buildRow(NO_START_DATE)
    assert.equal(row.start_at, null)
  })

  it('strips HTML tags out of the description', () => {
    const row = buildRow(CAMP)
    assert.ok(!/<[a-z][\s\S]*?>/i.test(row.description))
    assert.ok(row.description.includes('Examine how art'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Venue resolution
// ════════════════════════════════════════════════════════════════════════════

describe('Akron Fossils — venue resolution', () => {
  it('parses the museum name from the feed (raw, entity-encoded)', () => {
    // The feed's addressTitle carries a raw &amp; entity; the scraper does NOT
    // use this value — it mints the venue from the clean hardcoded VENUE_INFO
    // name. ensureVenue would additionally stripHtml/decode any name it received.
    const loc = parseSquarespaceLocation(SUPER_SCIENCE.location)
    assert.equal(loc.name, 'Akron Fossils &amp; Science Center')
  })

  it('parses street, city, state, zip', () => {
    const loc = parseSquarespaceLocation(SUPER_SCIENCE.location)
    assert.equal(loc.address, '2080 South Cleveland Massillon Road')
    assert.equal(loc.city, 'Akron')
    assert.equal(loc.state, 'OH')
    assert.equal(loc.zip, '44321')
  })

  it('parses lat/lng from the marker', () => {
    const loc = parseSquarespaceLocation(SUPER_SCIENCE.location)
    assert.equal(loc.lat, 41.0814904)
    assert.equal(loc.lng, -81.6433838)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// HTML entity handling
// ════════════════════════════════════════════════════════════════════════════

describe('Akron Fossils — HTML entity handling', () => {
  it('decodes &amp; and &#8217; in the title', () => {
    const row       = buildRow(HTML_ENTITIES_TITLE)
    const sanitized = sanitizeEventText(row)
    assert.ok(!sanitized.title.includes('&amp;'))
    assert.ok(!sanitized.title.includes('&#8217;'))
    assert.ok(sanitized.title.includes('&'))
    assert.ok(sanitized.title.includes("'"))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Batch invariants
// ════════════════════════════════════════════════════════════════════════════

describe('Akron Fossils — batch invariants', () => {
  it('every fixture builds without throwing', () => {
    for (const item of ALL_FIXTURES) {
      assert.doesNotThrow(() => buildRow(item), `threw for "${item.title}"`)
    }
  })

  it('every row has source=akron_fossils and a stable source_id', () => {
    for (const item of ALL_FIXTURES) {
      const row = buildRow(item)
      assert.equal(row.source, 'akron_fossils')
      assert.ok(row.source_id != null && row.source_id !== '', `null source_id for "${item.title}"`)
      assert.equal(row.source_id, item.id) // stable per-event id
    }
  })

  it('source_id is unique across the batch', () => {
    const ids = ALL_FIXTURES.map((i) => buildRow(i).source_id)
    assert.equal(ids.length, new Set(ids).size)
  })

  it('start_at is valid ISO 8601 or null', () => {
    for (const item of ALL_FIXTURES) {
      const { start_at } = buildRow(item)
      if (start_at) assert.ok(!isNaN(Date.parse(start_at)), `bad start_at for "${item.title}"`)
    }
  })

  it('price fields are null or non-negative numbers', () => {
    for (const item of ALL_FIXTURES) {
      const { price_min, price_max } = buildRow(item)
      for (const p of [price_min, price_max]) {
        assert.ok(p === null || (typeof p === 'number' && p >= 0), `bad price for "${item.title}"`)
      }
    }
  })

  it('description never contains raw HTML tags', () => {
    for (const item of ALL_FIXTURES) {
      const { description } = buildRow(item)
      if (description) {
        assert.ok(!/<[a-z][\s\S]*?>/i.test(description), `HTML in description for "${item.title}"`)
      }
    }
  })

  it('status is always published', () => {
    for (const item of ALL_FIXTURES) {
      assert.equal(buildRow(item).status, 'published')
    }
  })
})
