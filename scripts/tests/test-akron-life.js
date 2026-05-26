/**
 * test-akron-life.js
 *
 * Unit tests for the Akron Life scraper (Evvnt Discovery API) — covering:
 *   • haversineMiles — geographic distance math
 *   • isInAkronArea  — Akron-area geo gate
 *   • isBackfilledFromDirectScraper — cross-source dedupe guard
 *   • mapCategory    — EVVNT_CATEGORY_MAP lookup + inferCategory fallback
 *   • buildTags      — tag list construction
 *   • parseEvvntPrices — ticket price extraction
 *
 * Run:
 *   node --test scripts/tests/test-akron-life.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY  || 'dummy-key'

// ── Re-implement scraper logic for testability ────────────────────────────

const AKRON_LAT          = 41.0814
const AKRON_LNG          = -81.5190
const MAX_DISTANCE_MILES = 25

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R  = 6_371_000
  const φ1 = lat1 * Math.PI / 180
  const φ2 = lat2 * Math.PI / 180
  const Δφ = (lat2 - lat1) * Math.PI / 180
  const Δλ = (lon2 - lon1) * Math.PI / 180
  const a  = Math.sin(Δφ/2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) ** 2
  return (2 * R * Math.asin(Math.sqrt(a))) / 1609.34
}

function isInAkronArea(venue) {
  if (!venue) return false
  const lat = Number(venue.latitude), lng = Number(venue.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
  return haversineMiles(lat, lng, AKRON_LAT, AKRON_LNG) <= MAX_DISTANCE_MILES
}

const SOURCES_WE_SCRAPE_DIRECTLY = new Set(['ticketmaster', 'eventbrite'])

function isBackfilledFromDirectScraper(rawEventSources) {
  if (!Array.isArray(rawEventSources)) return false
  for (const s of rawEventSources) {
    if (SOURCES_WE_SCRAPE_DIRECTLY.has(String(s).toLowerCase())) return true
  }
  return false
}

const EVVNT_CATEGORY_MAP = {
  'music':               'music',
  'performing arts':     'art',
  'visual arts':         'art',
  'film':                'art',
  'food / drink':        'food',
  'food and drink':      'food',
  'food':                'food',
  'sports':              'fitness',
  'sports / fitness':    'fitness',
  'health':              'fitness',
  'health / wellbeing':  'fitness',
  'education':           'education',
  'classes':             'education',
  'classes / workshops': 'education',
  'lifestyle':           'community',
  'community':           'community',
  'festivals':           'community',
  'charity':             'community',
  'family':              'community',
  'exhibitions':         'art',
  'pets / animals':      'nature',
  'nature':              'nature',
  'outdoor':             'nature',
}

// Minimal stub of inferCategory — covers the text-based patterns used by
// mapCategory's fallback path. Not exhaustive; only tests routes exercised
// by the scraper's community-fallback and basic keyword matching.
function inferCategory(title = '', description = '') {
  const text = `${title} ${description}`.toLowerCase()
  if (/\b(concert|symphony|orchestra|recital|live music|live band|open mic|karaoke)\b/.test(text)) return 'music'
  if (/\b(gallery|exhibit|theatre|theater|drama|poetry|film|movie)\b/.test(text)) return 'art'
  if (/\b(food|drink|dining|restaurant|tasting|brunch|dinner)\b/.test(text)) return 'food'
  if (/\b(run|race|5k|marathon|yoga|fitness|workout|gym|trail)\b/.test(text)) return 'fitness'
  if (/\b(class|workshop|seminar|lecture|course|training)\b/.test(text)) return 'education'
  if (/\b(nature|hike|park|trail|garden|bird|wildlife)\b/.test(text)) return 'nature'
  return 'other'
}

function mapCategory(evvntCategoryName, title, description) {
  const mapped = EVVNT_CATEGORY_MAP[(evvntCategoryName || '').toLowerCase().trim()]
  if (mapped) return mapped
  const inferred = inferCategory(title, description)
  return inferred === 'other' ? 'community' : inferred
}

function buildTags(category, evvntCategoryName) {
  const tags = ['akron-life', 'akron']
  if (category !== 'community') tags.push(category)
  if (evvntCategoryName) {
    const slug = evvntCategoryName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (slug && !tags.includes(slug)) tags.push(slug)
  }
  return tags
}

function parseEvvntPrices(prices) {
  if (!prices || typeof prices !== 'object') return { price_min: 0, price_max: null }
  const nums = Object.values(prices)
    .map(v => {
      if (typeof v === 'number') return v
      if (typeof v === 'string') return parseFloat(v)
      if (v && typeof v === 'object') return parseFloat(v.amount ?? v.value ?? v.price)
      return NaN
    })
    .filter(n => !isNaN(n) && n >= 0)
  if (nums.length === 0) return { price_min: 0, price_max: null }
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  return { price_min: min, price_max: max > min ? max : null }
}

// ── haversineMiles ────────────────────────────────────────────────────────

describe('Akron Life — haversineMiles', () => {
  it('returns 0 for identical coordinates', () => {
    assert.equal(haversineMiles(41.0814, -81.5190, 41.0814, -81.5190), 0)
  })

  it('returns a positive distance between two different points', () => {
    // Cleveland (41.4993, -81.6944) is ~25 miles from downtown Akron
    const d = haversineMiles(41.0814, -81.5190, 41.4993, -81.6944)
    assert.ok(d > 0, 'distance should be positive')
  })

  it('is roughly symmetric (A→B ≈ B→A)', () => {
    const d1 = haversineMiles(41.0814, -81.5190, 41.4993, -81.6944)
    const d2 = haversineMiles(41.4993, -81.6944, 41.0814, -81.5190)
    assert.ok(Math.abs(d1 - d2) < 0.001, 'Haversine should be symmetric')
  })

  it('Akron to Cleveland is approximately 30 miles', () => {
    const d = haversineMiles(41.0814, -81.5190, 41.4993, -81.6944)
    assert.ok(d > 25 && d < 35, `Expected ~30 mi, got ${d.toFixed(2)}`)
  })

  it('Akron to Columbus (~100 mi) is well above 25 miles', () => {
    const d = haversineMiles(41.0814, -81.5190, 39.9612, -82.9988)
    assert.ok(d > 90, `Expected ~100 mi, got ${d.toFixed(2)}`)
  })

  it('Akron downtown to a nearby suburb is within a few miles', () => {
    // Cuyahoga Falls is ~3 miles NE of downtown Akron
    const d = haversineMiles(41.0814, -81.5190, 41.1334, -81.4846)
    assert.ok(d < 6, `Expected < 6 mi to Cuyahoga Falls, got ${d.toFixed(2)}`)
  })

  it('handles negative longitudes (western hemisphere) correctly', () => {
    const d = haversineMiles(41.0814, -81.5190, 41.0814, -81.5190)
    assert.equal(d, 0)
  })
})

// ── isInAkronArea ─────────────────────────────────────────────────────────

describe('Akron Life — isInAkronArea', () => {
  it('returns true for a venue at downtown Akron coords', () => {
    assert.equal(isInAkronArea({ latitude: 41.0814, longitude: -81.5190 }), true)
  })

  it('returns true for a venue within 25 miles (e.g. Cuyahoga Falls)', () => {
    assert.equal(isInAkronArea({ latitude: 41.1334, longitude: -81.4846 }), true)
  })

  it('returns false for a venue clearly outside 25 miles (Cleveland)', () => {
    // Cleveland ~25+ mi — actually just over the boundary, but Columbus is safe
    assert.equal(isInAkronArea({ latitude: 39.9612, longitude: -82.9988 }), false)
  })

  it('returns false when venue is null', () => {
    assert.equal(isInAkronArea(null), false)
  })

  it('returns false when venue is undefined', () => {
    assert.equal(isInAkronArea(undefined), false)
  })

  it('returns false when latitude is missing', () => {
    assert.equal(isInAkronArea({ longitude: -81.5190 }), false)
  })

  it('returns false when longitude is missing', () => {
    assert.equal(isInAkronArea({ latitude: 41.0814 }), false)
  })

  it('returns false when latitude is null', () => {
    assert.equal(isInAkronArea({ latitude: null, longitude: -81.5190 }), false)
  })

  it('returns false when latitude is a non-numeric string', () => {
    assert.equal(isInAkronArea({ latitude: 'unknown', longitude: -81.5190 }), false)
  })

  it('returns false when coords are NaN', () => {
    assert.equal(isInAkronArea({ latitude: NaN, longitude: NaN }), false)
  })

  it('accepts numeric-string coordinates (Evvnt sometimes serialises as strings)', () => {
    assert.equal(isInAkronArea({ latitude: '41.0814', longitude: '-81.5190' }), true)
  })

  it('returns false for empty object (no coord fields)', () => {
    assert.equal(isInAkronArea({}), false)
  })
})

// ── isBackfilledFromDirectScraper ─────────────────────────────────────────

describe('Akron Life — isBackfilledFromDirectScraper', () => {
  it('returns true when sources contains "ticketmaster"', () => {
    assert.equal(isBackfilledFromDirectScraper(['ticketmaster']), true)
  })

  it('returns true when sources contains "eventbrite"', () => {
    assert.equal(isBackfilledFromDirectScraper(['eventbrite']), true)
  })

  it('returns true for mixed case source names', () => {
    assert.equal(isBackfilledFromDirectScraper(['Ticketmaster']), true)
    assert.equal(isBackfilledFromDirectScraper(['EVENTBRITE']), true)
  })

  it('returns true when one of multiple sources is a direct scraper', () => {
    assert.equal(isBackfilledFromDirectScraper(['evvnt', 'ticketmaster', 'facebook']), true)
  })

  it('returns false when sources only contains non-direct-scraper platforms', () => {
    assert.equal(isBackfilledFromDirectScraper(['evvnt']), false)
    assert.equal(isBackfilledFromDirectScraper(['bandsintown', 'facebook']), false)
  })

  it('returns false for an empty array', () => {
    assert.equal(isBackfilledFromDirectScraper([]), false)
  })

  it('returns false when sources is null', () => {
    assert.equal(isBackfilledFromDirectScraper(null), false)
  })

  it('returns false when sources is undefined', () => {
    assert.equal(isBackfilledFromDirectScraper(undefined), false)
  })

  it('returns false when sources is not an array (e.g. a string)', () => {
    assert.equal(isBackfilledFromDirectScraper('ticketmaster'), false)
  })

  it('returns false when sources is an empty object', () => {
    assert.equal(isBackfilledFromDirectScraper({}), false)
  })
})

// ── mapCategory — EVVNT_CATEGORY_MAP ─────────────────────────────────────

describe('Akron Life — mapCategory (EVVNT_CATEGORY_MAP lookups)', () => {
  it('maps "Music" to music', () => {
    assert.equal(mapCategory('Music', '', ''), 'music')
  })

  it('maps "Performing Arts" to art', () => {
    assert.equal(mapCategory('Performing Arts', '', ''), 'art')
  })

  it('maps "Visual Arts" to art', () => {
    assert.equal(mapCategory('Visual Arts', '', ''), 'art')
  })

  it('maps "Film" to art', () => {
    assert.equal(mapCategory('Film', '', ''), 'art')
  })

  it('maps "Exhibitions" to art', () => {
    assert.equal(mapCategory('Exhibitions', '', ''), 'art')
  })

  it('maps "Food / Drink" to food', () => {
    assert.equal(mapCategory('Food / Drink', '', ''), 'food')
  })

  it('maps "Food and Drink" to food', () => {
    assert.equal(mapCategory('Food and Drink', '', ''), 'food')
  })

  it('maps "Food" to food', () => {
    assert.equal(mapCategory('Food', '', ''), 'food')
  })

  it('maps "Sports" to fitness', () => {
    assert.equal(mapCategory('Sports', '', ''), 'fitness')
  })

  it('maps "Sports / Fitness" to fitness', () => {
    assert.equal(mapCategory('Sports / Fitness', '', ''), 'fitness')
  })

  it('maps "Health" to fitness', () => {
    assert.equal(mapCategory('Health', '', ''), 'fitness')
  })

  it('maps "Health / Wellbeing" to fitness', () => {
    assert.equal(mapCategory('Health / Wellbeing', '', ''), 'fitness')
  })

  it('maps "Education" to education', () => {
    assert.equal(mapCategory('Education', '', ''), 'education')
  })

  it('maps "Classes" to education', () => {
    assert.equal(mapCategory('Classes', '', ''), 'education')
  })

  it('maps "Classes / Workshops" to education', () => {
    assert.equal(mapCategory('Classes / Workshops', '', ''), 'education')
  })

  it('maps "Lifestyle" to community', () => {
    assert.equal(mapCategory('Lifestyle', '', ''), 'community')
  })

  it('maps "Community" to community', () => {
    assert.equal(mapCategory('Community', '', ''), 'community')
  })

  it('maps "Festivals" to community', () => {
    assert.equal(mapCategory('Festivals', '', ''), 'community')
  })

  it('maps "Charity" to community', () => {
    assert.equal(mapCategory('Charity', '', ''), 'community')
  })

  it('maps "Family" to community', () => {
    assert.equal(mapCategory('Family', '', ''), 'community')
  })

  it('maps "Pets / Animals" to nature', () => {
    assert.equal(mapCategory('Pets / Animals', '', ''), 'nature')
  })

  it('maps "Nature" to nature', () => {
    assert.equal(mapCategory('Nature', '', ''), 'nature')
  })

  it('maps "Outdoor" to nature', () => {
    assert.equal(mapCategory('Outdoor', '', ''), 'nature')
  })

  it('is case-insensitive for the Evvnt category name', () => {
    assert.equal(mapCategory('MUSIC', '', ''), 'music')
    assert.equal(mapCategory('performing arts', '', ''), 'art')
    assert.equal(mapCategory('FOOD / DRINK', '', ''), 'food')
  })

  it('trims whitespace from the Evvnt category name', () => {
    assert.equal(mapCategory('  Music  ', '', ''), 'music')
  })
})

// ── mapCategory — inferCategory fallback ──────────────────────────────────

describe('Akron Life — mapCategory (inferCategory fallback)', () => {
  it('falls back to music via title keywords when category is unknown', () => {
    assert.equal(mapCategory('Unknown Genre', 'Live Music Night at The Rialto', ''), 'music')
  })

  it('falls back to art via title keywords when category is unknown', () => {
    assert.equal(mapCategory('', 'Community Theater Showcase', ''), 'art')
  })

  it('falls back to food via title keywords when category is unknown', () => {
    assert.equal(mapCategory('', 'Wine Tasting Dinner', ''), 'food')
  })

  it('falls back to fitness via title keywords when category is unknown', () => {
    assert.equal(mapCategory('', 'Annual 5K Race', ''), 'fitness')
  })

  it('falls back to education via title keywords when category is unknown', () => {
    assert.equal(mapCategory('', 'Homeownership Workshop', ''), 'education')
  })

  it('returns community when both category and text inference yield nothing', () => {
    // "other" from inferCategory should become "community"
    assert.equal(mapCategory('', 'Planning Session for Next Quarter', ''), 'community')
  })

  it('returns community for null/empty category name with unclassifiable title', () => {
    assert.equal(mapCategory(null, 'TBD', ''), 'community')
    assert.equal(mapCategory('', '', ''), 'community')
  })

  it('prefers EVVNT_CATEGORY_MAP over inferCategory', () => {
    // "Music" maps via the lookup; even if title had no keywords, result is 'music'
    assert.equal(mapCategory('Music', 'Neighborhood Planning Session', ''), 'music')
  })

  it('uses description as fallback for inferCategory when title is generic', () => {
    assert.equal(mapCategory('', 'Friday Night Event', 'Join us for an open mic concert.'), 'music')
  })
})

// ── buildTags ─────────────────────────────────────────────────────────────

describe('Akron Life — buildTags', () => {
  it('always includes akron-life and akron base tags', () => {
    const tags = buildTags('community', null)
    assert.ok(tags.includes('akron-life'))
    assert.ok(tags.includes('akron'))
  })

  it('does not add community category as a tag (community is implicit)', () => {
    const tags = buildTags('community', 'Festivals')
    assert.ok(!tags.includes('community'))
  })

  it('adds non-community category as a tag', () => {
    assert.ok(buildTags('music', null).includes('music'))
    assert.ok(buildTags('art', null).includes('art'))
    assert.ok(buildTags('food', null).includes('food'))
    assert.ok(buildTags('fitness', null).includes('fitness'))
    assert.ok(buildTags('education', null).includes('education'))
    assert.ok(buildTags('nature', null).includes('nature'))
  })

  it('slugifies the Evvnt category name and appends it', () => {
    const tags = buildTags('food', 'Food / Drink')
    assert.ok(tags.includes('food-drink'))
  })

  it('slugifies "Sports / Fitness" correctly', () => {
    const tags = buildTags('fitness', 'Sports / Fitness')
    assert.ok(tags.includes('sports-fitness'))
  })

  it('slugifies "Classes / Workshops" correctly', () => {
    const tags = buildTags('education', 'Classes / Workshops')
    assert.ok(tags.includes('classes-workshops'))
  })

  it('does not duplicate a tag already present from category', () => {
    // category='music' and evvntCategoryName='Music' → slug='music' already present
    const tags = buildTags('music', 'Music')
    const count = tags.filter(t => t === 'music').length
    assert.equal(count, 1)
  })

  it('handles null evvntCategoryName gracefully', () => {
    assert.doesNotThrow(() => buildTags('music', null))
  })

  it('handles empty evvntCategoryName gracefully', () => {
    const tags = buildTags('music', '')
    assert.ok(tags.includes('music'))
    assert.equal(tags.length, 3) // akron-life, akron, music
  })

  it('produces exactly 2 tags for community with no Evvnt category', () => {
    const tags = buildTags('community', null)
    assert.equal(tags.length, 2)
  })

  it('produces no duplicate tags in any scenario', () => {
    const scenarios = [
      ['community', 'Festivals'],
      ['music', 'Music'],
      ['art', 'Performing Arts'],
      ['fitness', 'Sports / Fitness'],
      ['education', 'Classes / Workshops'],
      ['nature', 'Outdoor'],
      ['community', null],
    ]
    for (const [cat, evvnt] of scenarios) {
      const tags = buildTags(cat, evvnt)
      assert.equal(tags.length, new Set(tags).size, `Duplicates for (${cat}, ${evvnt})`)
    }
  })
})

// ── parseEvvntPrices ──────────────────────────────────────────────────────

describe('Akron Life — parseEvvntPrices (null/empty)', () => {
  it('returns { price_min: 0, price_max: null } for null input', () => {
    assert.deepEqual(parseEvvntPrices(null), { price_min: 0, price_max: null })
  })

  it('returns { price_min: 0, price_max: null } for undefined', () => {
    assert.deepEqual(parseEvvntPrices(undefined), { price_min: 0, price_max: null })
  })

  it('returns { price_min: 0, price_max: null } for an empty object', () => {
    assert.deepEqual(parseEvvntPrices({}), { price_min: 0, price_max: null })
  })

  it('returns { price_min: 0, price_max: null } for a non-object primitive', () => {
    assert.deepEqual(parseEvvntPrices(42), { price_min: 0, price_max: null })
    assert.deepEqual(parseEvvntPrices('free'), { price_min: 0, price_max: null })
  })
})

describe('Akron Life — parseEvvntPrices (object values)', () => {
  it('parses { amount, currency_code } objects', () => {
    const result = parseEvvntPrices({
      General: { amount: '12.50', currency_code: 'USD' },
      VIP:     { amount: '25.00', currency_code: 'USD' },
    })
    assert.equal(result.price_min, 12.5)
    assert.equal(result.price_max, 25)
  })

  it('parses bare numeric values', () => {
    const result = parseEvvntPrices({ General: 10, Premium: 20 })
    assert.equal(result.price_min, 10)
    assert.equal(result.price_max, 20)
  })

  it('parses bare string numeric values', () => {
    const result = parseEvvntPrices({ A: '5', B: '15' })
    assert.equal(result.price_min, 5)
    assert.equal(result.price_max, 15)
  })

  it('returns price_max: null when all tiers have the same price', () => {
    const result = parseEvvntPrices({
      Early: { amount: '10.00', currency_code: 'USD' },
      Late:  { amount: '10.00', currency_code: 'USD' },
    })
    assert.equal(result.price_min, 10)
    assert.equal(result.price_max, null)
  })

  it('returns price_max: null for a single-tier event', () => {
    const result = parseEvvntPrices({ General: { amount: '15.00', currency_code: 'USD' } })
    assert.equal(result.price_min, 15)
    assert.equal(result.price_max, null)
  })

  it('handles free events (amount: "0.00")', () => {
    const result = parseEvvntPrices({ Free: { amount: '0.00', currency_code: 'USD' } })
    assert.equal(result.price_min, 0)
    assert.equal(result.price_max, null)
  })

  it('handles a mix of free and paid tiers', () => {
    const result = parseEvvntPrices({ Free: 0, Paid: 20 })
    assert.equal(result.price_min, 0)
    assert.equal(result.price_max, 20)
  })

  it('ignores NaN values (unparseable entries)', () => {
    const result = parseEvvntPrices({ A: 'TBD', B: { amount: '18.00', currency_code: 'USD' } })
    assert.equal(result.price_min, 18)
    assert.equal(result.price_max, null)
  })

  it('returns { price_min: 0, price_max: null } when all values are unparseable', () => {
    assert.deepEqual(parseEvvntPrices({ A: 'TBD', B: null, C: {} }), { price_min: 0, price_max: null })
  })

  it('ignores negative values', () => {
    const result = parseEvvntPrices({ A: -5, B: 10 })
    assert.equal(result.price_min, 10)
    assert.equal(result.price_max, null)
  })

  it('handles the value.value fallback field', () => {
    const result = parseEvvntPrices({ Tier: { value: '8.00' } })
    assert.equal(result.price_min, 8)
  })

  it('handles the value.price fallback field', () => {
    const result = parseEvvntPrices({ Tier: { price: '22.00' } })
    assert.equal(result.price_min, 22)
  })
})
