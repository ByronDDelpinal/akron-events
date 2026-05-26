/**
 * test-rialto.js
 *
 * Unit tests for the Rialto Theatre scraper — title cleaning, category/tag
 * mapping, URL construction, full normalisation pipeline, and batch invariants.
 *
 * Run:
 *   node --test scripts/tests/test-rialto.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Set dummy env vars before any imports ───────────────────────────────────
process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY  || 'dummy-key'

import {
  normaliseSquarespaceEvent,
  parseSquarespaceLocation,
  buildSquarespaceEventUrl,
} from '../lib/squarespace.js'
import { sanitizeEventText } from '../lib/normalize.js'

import {
  MUSIC_SHOW,
  LIVING_ROOM_SHOW,
  POETRY_EVENT,
  IMPROV_EVENT,
  IRISH_SESSION,
  TRIVIA_EVENT,
  OPEN_MIC_EVENT,
  FEATURED_EVENT,
  NO_BODY_EVENT,
  NO_START_DATE,
  HTML_ENTITIES_TITLE,
  ALL_FIXTURES,
} from './fixtures/rialto-events.js'

// ════════════════════════════════════════════════════════════════════════════
// RE-IMPLEMENT SCRAPER LOGIC FOR TESTABILITY
// (mirrors scrape-rialto.js exactly — keep in sync if scraper changes)
// ════════════════════════════════════════════════════════════════════════════

const SOURCE_KEY    = 'rialto'
const SITE_BASE_URL = 'https://www.therialtotheatre.com'

function cleanTitle(raw) {
  return (raw ?? '')
    .replace(/\s*-\s*\d{2}\/\d{2}\/\d{4}\s*$/, '')
    .trim()
}

function mapCategory(item) {
  const t = item.title ?? ''
  if (/poetry|spoken word|angry cow/i.test(t))       return 'art'
  if (/improv|comedy|stand[- ]?up|trivia/i.test(t))  return 'community'
  if (/irish session|jam session/i.test(t))           return 'music'
  return 'music'
}

function mapTags(item) {
  const t = item.title ?? ''
  const tags = ['rialto', 'kenmore', 'live-music', 'akron']
  if (/living room/i.test(t))                             tags.push('acoustic', 'intimate')
  if (/emerging sounds/i.test(t))                         tags.push('emerging-sounds', 'local-artists')
  if (/irish/i.test(t))                                   tags.push('irish', 'traditional')
  if (/poetry|spoken word|angry cow/i.test(t))            tags.push('poetry', 'spoken-word')
  if (/improv/i.test(t))                                  tags.push('improv', 'comedy')
  if (/trivia/i.test(t))                                  tags.push('trivia')
  if (/open mic/i.test(t))                                tags.push('open-mic')
  return [...new Set(tags)]
}

const SCRAPER_CONFIG = {
  source:          SOURCE_KEY,
  mapCategory,
  mapTags,
  defaultPriceMin: 0,
  defaultPriceMax: null,
  ageRestriction:  'all_ages',
}

/** Full normalisation pipeline — mirrors processEvents() in the scraper. */
function normalise(item) {
  const row = normaliseSquarespaceEvent(item, SCRAPER_CONFIG)
  row.title      = cleanTitle(row.title)
  row.ticket_url = buildSquarespaceEventUrl(SITE_BASE_URL, item) || row.ticket_url
  return row
}

// ════════════════════════════════════════════════════════════════════════════
// Title cleaning
// ════════════════════════════════════════════════════════════════════════════

describe('Rialto — title cleaning', () => {
  it('strips trailing date stamp from music show', () => {
    const row = normalise(MUSIC_SHOW)
    assert.equal(row.title, 'Stay Gone / STMNTS / Bury The Pines')
  })

  it('strips trailing date stamp from Living Room show', () => {
    const row = normalise(LIVING_ROOM_SHOW)
    assert.equal(row.title, 'Colin John - The Transpacific Bluesman in The Rialto Living Room')
  })

  it('strips trailing date stamp from poetry event', () => {
    const row = normalise(POETRY_EVENT)
    assert.equal(row.title, 'Angry Cow Poetry Ft. Raja Belle Freeman')
  })

  it('does not strip hyphens that are not date stamps', () => {
    // "Colin John - The Transpacific..." — the first hyphen should remain
    const row = normalise(LIVING_ROOM_SHOW)
    assert.ok(row.title.includes(' - The Transpacific'))
  })

  it('handles title with no date stamp gracefully', () => {
    const item = { ...MUSIC_SHOW, title: 'No Date Show' }
    const row  = normalise(item)
    assert.equal(row.title, 'No Date Show')
  })

  it('handles null title gracefully', () => {
    const item = { ...MUSIC_SHOW, title: null }
    assert.doesNotThrow(() => normalise(item))
    const row = normalise(item)
    assert.equal(row.title, '')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Category mapping
// ════════════════════════════════════════════════════════════════════════════

describe('Rialto — category mapping', () => {
  it('maps standard music show to music', () => {
    assert.equal(normalise(MUSIC_SHOW).category, 'music')
  })

  it('maps Living Room acoustic show to music', () => {
    assert.equal(normalise(LIVING_ROOM_SHOW).category, 'music')
  })

  it('maps Irish session to music', () => {
    assert.equal(normalise(IRISH_SESSION).category, 'music')
  })

  it('maps open mic to music', () => {
    assert.equal(normalise(OPEN_MIC_EVENT).category, 'music')
  })

  it('maps Angry Cow Poetry to art', () => {
    assert.equal(normalise(POETRY_EVENT).category, 'art')
  })

  it('maps improv show to community', () => {
    assert.equal(normalise(IMPROV_EVENT).category, 'community')
  })

  it('maps trivia night to community', () => {
    assert.equal(normalise(TRIVIA_EVENT).category, 'community')
  })

  it('maps featured show to music', () => {
    assert.equal(normalise(FEATURED_EVENT).category, 'music')
  })

  it('every category is one of the valid values', () => {
    const VALID = ['music', 'art', 'community', 'nature', 'food', 'sports',
                   'fitness', 'education', 'nonprofit']
    for (const item of ALL_FIXTURES) {
      const { category } = normalise(item)
      assert.ok(VALID.includes(category), `Unexpected category "${category}" for "${item.title}"`)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Tag mapping
// ════════════════════════════════════════════════════════════════════════════

describe('Rialto — tag mapping', () => {
  it('every event includes the four base tags', () => {
    for (const item of ALL_FIXTURES) {
      const { tags } = normalise(item)
      assert.ok(tags.includes('rialto'),      `missing "rialto" tag for "${item.title}"`)
      assert.ok(tags.includes('kenmore'),     `missing "kenmore" tag for "${item.title}"`)
      assert.ok(tags.includes('live-music'),  `missing "live-music" tag for "${item.title}"`)
      assert.ok(tags.includes('akron'),       `missing "akron" tag for "${item.title}"`)
    }
  })

  it('Living Room show gets acoustic and intimate tags', () => {
    const { tags } = normalise(LIVING_ROOM_SHOW)
    assert.ok(tags.includes('acoustic'))
    assert.ok(tags.includes('intimate'))
  })

  it('standard music show does not get acoustic tag', () => {
    const { tags } = normalise(MUSIC_SHOW)
    assert.ok(!tags.includes('acoustic'))
  })

  it('Irish session gets irish and traditional tags', () => {
    const { tags } = normalise(IRISH_SESSION)
    assert.ok(tags.includes('irish'))
    assert.ok(tags.includes('traditional'))
  })

  it('poetry event gets poetry and spoken-word tags', () => {
    const { tags } = normalise(POETRY_EVENT)
    assert.ok(tags.includes('poetry'))
    assert.ok(tags.includes('spoken-word'))
  })

  it('improv event gets improv and comedy tags', () => {
    const { tags } = normalise(IMPROV_EVENT)
    assert.ok(tags.includes('improv'))
    assert.ok(tags.includes('comedy'))
  })

  it('trivia event gets trivia tag', () => {
    const { tags } = normalise(TRIVIA_EVENT)
    assert.ok(tags.includes('trivia'))
  })

  it('open mic event gets open-mic tag', () => {
    const { tags } = normalise(OPEN_MIC_EVENT)
    assert.ok(tags.includes('open-mic'))
  })

  it('no fixture produces duplicate tags', () => {
    for (const item of ALL_FIXTURES) {
      const { tags } = normalise(item)
      const unique = new Set(tags)
      assert.equal(tags.length, unique.size,
        `Duplicate tags for "${item.title}": ${tags}`)
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Venue resolution
// ════════════════════════════════════════════════════════════════════════════

describe('Rialto — venue resolution', () => {
  it('parses venue name from location', () => {
    const loc = parseSquarespaceLocation(MUSIC_SHOW.location)
    assert.equal(loc.name, 'The Rialto Theatre')
  })

  it('parses street address', () => {
    const loc = parseSquarespaceLocation(MUSIC_SHOW.location)
    assert.equal(loc.address, '1000 Kenmore Boulevard')
  })

  it('parses city, state, and zip', () => {
    const loc = parseSquarespaceLocation(MUSIC_SHOW.location)
    assert.equal(loc.city,  'Akron')
    assert.equal(loc.state, 'OH')
    assert.equal(loc.zip,   '44314')
  })

  it('parses lat/lng coordinates', () => {
    const loc = parseSquarespaceLocation(MUSIC_SHOW.location)
    assert.equal(loc.lat, 41.0534)
    assert.equal(loc.lng, -81.5598)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// URL construction
// ════════════════════════════════════════════════════════════════════════════

describe('Rialto — URL construction', () => {
  it('builds full HTTPS URL for music show', () => {
    const row = normalise(MUSIC_SHOW)
    assert.equal(
      row.ticket_url,
      'https://www.therialtotheatre.com/calendar/2026/5/27/stay-gone-stmnts-bury-the-pines-05272026'
    )
  })

  it('all fixture URLs start with the site base URL', () => {
    for (const item of ALL_FIXTURES) {
      const { ticket_url } = normalise(item)
      if (ticket_url) {
        assert.ok(
          ticket_url.startsWith('https://www.therialtotheatre.com'),
          `ticket_url "${ticket_url}" does not start with site base for "${item.title}"`
        )
      }
    }
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Full normalisation pipeline
// ════════════════════════════════════════════════════════════════════════════

describe('Rialto — full normalisation', () => {
  it('music show produces a valid row', () => {
    const row = normalise(MUSIC_SHOW)
    assert.equal(row.source,         'rialto')
    assert.equal(row.source_id,      'rialto-001')
    assert.equal(row.title,          'Stay Gone / STMNTS / Bury The Pines')
    assert.equal(row.price_min,      0)
    assert.equal(row.price_max,      null)
    assert.equal(row.age_restriction,'all_ages')
    assert.equal(row.status,         'published')
    assert.equal(row.featured,       false)
    assert.ok(!isNaN(Date.parse(row.start_at)))
    assert.ok(!isNaN(Date.parse(row.end_at)))
  })

  it('event with image has image_url set to Squarespace CDN URL', () => {
    const row = normalise(MUSIC_SHOW)
    assert.ok(row.image_url?.includes('squarespace-cdn.com'))
  })

  it('event without image has image_url as null', () => {
    const row = normalise(POETRY_EVENT)
    assert.equal(row.image_url, null)
  })

  it('featured event has featured=true', () => {
    const row = normalise(FEATURED_EVENT)
    assert.equal(row.featured, true)
  })

  it('non-featured event has featured=false', () => {
    const row = normalise(MUSIC_SHOW)
    assert.equal(row.featured, false)
  })

  it('no-body event uses excerpt as description', () => {
    const row = normalise(NO_BODY_EVENT)
    assert.equal(row.description, 'Details coming soon.')
  })

  it('event with body strips HTML tags from description', () => {
    const row = normalise(MUSIC_SHOW)
    assert.ok(!/<[a-z]/i.test(row.description))
    assert.ok(row.description.includes('Three great bands'))
  })

  it('no-start-date event has null start_at', () => {
    const row = normalise(NO_START_DATE)
    assert.equal(row.start_at, null)
  })

  it('event with null endDate has null end_at', () => {
    const row = normalise(IRISH_SESSION)
    assert.equal(row.end_at, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// HTML entity handling
// ════════════════════════════════════════════════════════════════════════════

describe('Rialto — HTML entity handling', () => {
  it('decodes &amp; in body description', () => {
    const row = normalise(HTML_ENTITIES_TITLE)
    assert.ok(!row.description.includes('&amp;'))
    assert.ok(row.description.includes('&'))
  })

  it('sanitizeEventText decodes &#8217; in title to apostrophe', () => {
    const row       = normalise(HTML_ENTITIES_TITLE)
    const sanitized = sanitizeEventText(row)
    assert.ok(!sanitized.title.includes('&#8217;'))
    assert.ok(sanitized.title.includes("'"))
  })

  it('sanitizeEventText decodes &amp; in title', () => {
    const row       = normalise(HTML_ENTITIES_TITLE)
    const sanitized = sanitizeEventText(row)
    assert.ok(!sanitized.title.includes('&amp;'))
    assert.ok(sanitized.title.includes('&'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Batch invariants (all fixtures)
// ════════════════════════════════════════════════════════════════════════════

describe('Rialto — batch invariants', () => {
  it('every fixture normalises without throwing', () => {
    for (const item of ALL_FIXTURES) {
      assert.doesNotThrow(() => normalise(item), `threw for "${item.title}"`)
    }
  })

  it('every normalised row has source=rialto', () => {
    for (const item of ALL_FIXTURES) {
      assert.equal(normalise(item).source, 'rialto')
    }
  })

  it('every normalised row has a non-null source_id', () => {
    for (const item of ALL_FIXTURES) {
      assert.ok(normalise(item).source_id != null, `source_id null for "${item.title}"`)
    }
  })

  it('title is always a string (never null)', () => {
    for (const item of ALL_FIXTURES) {
      assert.equal(typeof normalise(item).title, 'string')
    }
  })

  it('no fixture title contains a trailing date stamp after cleaning', () => {
    for (const item of ALL_FIXTURES) {
      const { title } = normalise(item)
      assert.ok(
        !/- \d{2}\/\d{2}\/\d{4}$/.test(title),
        `Date stamp not stripped from "${title}"`
      )
    }
  })

  it('description never contains raw HTML tags', () => {
    for (const item of ALL_FIXTURES) {
      const { description } = normalise(item)
      if (description) {
        assert.ok(
          !/<[a-z][\s\S]*?>/i.test(description),
          `HTML found in description for "${item.title}"`
        )
      }
    }
  })

  it('start_at is valid ISO 8601 or null', () => {
    for (const item of ALL_FIXTURES) {
      const { start_at } = normalise(item)
      if (start_at) {
        assert.ok(!isNaN(Date.parse(start_at)), `Invalid start_at for "${item.title}"`)
      }
    }
  })

  it('price_min is always 0', () => {
    for (const item of ALL_FIXTURES) {
      assert.equal(normalise(item).price_min, 0)
    }
  })

  it('age_restriction is always all_ages', () => {
    for (const item of ALL_FIXTURES) {
      assert.equal(normalise(item).age_restriction, 'all_ages')
    }
  })

  it('status is always published', () => {
    for (const item of ALL_FIXTURES) {
      assert.equal(normalise(item).status, 'published')
    }
  })
})
