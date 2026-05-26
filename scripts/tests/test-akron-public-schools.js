/**
 * test-akron-public-schools.js
 *
 * Unit tests for the Akron Public Schools scraper — the public-facing event
 * filter (isPublicFacing), category mapping, and tag mapping.
 *
 * Run:
 *   node --test scripts/tests/test-akron-public-schools.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY  || 'dummy-key'

// ── Re-implement scraper logic for testability ────────────────────────────

const PUBLIC_KEYWORDS = [
  'concert', 'recital', 'performance', 'show', 'play', 'musical', 'band', 'choir', 'orchestra',
  'game', 'match', 'meet', 'tournament', 'scrimmage',
  'open house', 'family night', 'community', 'fair', 'festival',
  'graduation', 'commencement', 'ceremony',
  'board meeting', 'school board', 'public hearing',
  'fundraiser', 'bake sale', 'book fair',
]

const EXCLUDE_KEYWORDS = [
  'staff', 'pd day', 'professional development', 'in-service', 'teacher workday',
  'no school', 'early dismissal', 'late start', 'closed',
  'report cards', 'progress reports', 'conferences only',
]

function isPublicFacing(ev) {
  const hay = `${ev.SUMMARY || ''} ${ev.DESCRIPTION || ''} ${ev.CATEGORIES || ''}`.toLowerCase()
  if (EXCLUDE_KEYWORDS.some(k => hay.includes(k))) return false
  return PUBLIC_KEYWORDS.some(k => hay.includes(k))
}

function mapCategory(ev) {
  const text = `${ev.SUMMARY || ''} ${ev.DESCRIPTION || ''}`.toLowerCase()
  if (/\b(concert|recital|musical|band|choir|orchestra)\b/.test(text)) return 'music'
  if (/\b(game|match|tournament|meet|scrimmage)\b/.test(text))         return 'sports'
  if (/\b(play|show|performance|drama|theater|theatre)\b/.test(text))  return 'art'
  if (/\b(graduation|commencement|ceremony)\b/.test(text))             return 'community'
  if (/\b(fair|festival|open house|family night)\b/.test(text))        return 'community'
  return 'education'
}

function mapTags(ev) {
  const tags = ['schools', 'akron-public-schools', 'education']
  const text = (ev.SUMMARY || '').toLowerCase()
  if (/\b(game|match|tournament)\b/.test(text)) tags.push('athletics')
  if (/\b(concert|recital|band|choir|orchestra)\b/.test(text)) tags.push('music')
  return [...new Set(tags)]
}

// ── isPublicFacing — allow list ───────────────────────────────────────────

describe('Akron Public Schools — isPublicFacing (public events allowed)', () => {
  it('allows concert events', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Spring Concert' }), true)
  })

  it('allows recital events', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Piano Recital' }), true)
  })

  it('allows musical events', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'School Musical' }), true)
  })

  it('allows band events', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Marching Band Performance' }), true)
  })

  it('allows choir events', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Choir Showcase' }), true)
  })

  it('allows orchestra events', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Youth Orchestra Concert' }), true)
  })

  it('allows athletic game events', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Varsity Basketball Game' }), true)
  })

  it('allows tournament events', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Wrestling Tournament' }), true)
  })

  it('allows open house events', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Kindergarten Open House' }), true)
  })

  it('allows family night events', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'STEM Family Night' }), true)
  })

  it('allows graduation events', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Senior Graduation Ceremony' }), true)
  })

  it('allows board meeting events', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'School Board Meeting' }), true)
  })

  it('allows fundraiser events', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Annual Fundraiser Gala' }), true)
  })

  it('allows book fair events', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Scholastic Book Fair' }), true)
  })

  it('matches public keywords in DESCRIPTION when SUMMARY is generic', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Friday Event', DESCRIPTION: 'Join us for the spring concert.' }), true)
  })
})

// ── isPublicFacing — deny list ────────────────────────────────────────────

describe('Akron Public Schools — isPublicFacing (internal events blocked)', () => {
  it('blocks staff events', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Staff Meeting' }), false)
  })

  it('blocks professional development days', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Professional Development Day' }), false)
  })

  it('blocks PD day shorthand', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'PD Day — No Students' }), false)
  })

  it('blocks in-service days', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Teacher In-Service Day' }), false)
  })

  it('blocks no school days', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'No School — Holiday' }), false)
  })

  it('blocks early dismissal notices', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Early Dismissal — 1pm' }), false)
  })

  it('blocks late start notices', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Late Start Wednesday' }), false)
  })

  it('blocks building closed notices', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Building Closed — Spring Break' }), false)
  })

  it('blocks report card notices', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Report Cards Sent Home' }), false)
  })

  it('blocks progress report events', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Progress Reports Due' }), false)
  })

  it('exclude keywords take priority over public keywords', () => {
    // "staff concert" — matches both lists; exclude wins
    assert.equal(isPublicFacing({ SUMMARY: 'Staff Concert Rehearsal' }), false)
  })

  it('blocks events with no matching keywords at all', () => {
    assert.equal(isPublicFacing({ SUMMARY: 'Planning Session' }), false)
  })

  it('blocks empty event', () => {
    assert.equal(isPublicFacing({ SUMMARY: '' }), false)
  })

  it('blocks event with no fields', () => {
    assert.equal(isPublicFacing({}), false)
  })
})

// ── mapCategory ───────────────────────────────────────────────────────────

describe('Akron Public Schools — mapCategory', () => {
  it('returns music for concert events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Spring Concert' }), 'music')
  })

  it('returns music for recital events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Piano Recital' }), 'music')
  })

  it('returns music for band events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Marching Band Night' }), 'music')
  })

  it('returns music for choir events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Choir Performance' }), 'music')
  })

  it('returns music for orchestra events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Youth Orchestra' }), 'music')
  })

  it('returns sports for game events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Varsity Basketball Game' }), 'sports')
  })

  it('returns sports for match events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Soccer Match' }), 'sports')
  })

  it('returns sports for tournament events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Swimming Tournament' }), 'sports')
  })

  it('returns sports for scrimmage events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Football Scrimmage' }), 'sports')
  })

  it('returns art for play events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Fall Play' }), 'art')
  })

  it('returns art for drama events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Drama Club Show' }), 'art')
  })

  it('returns art for theater events', () => {
    assert.equal(mapCategory({ SUMMARY: 'Theater Performance' }), 'art')
  })

  it('returns community for graduation', () => {
    assert.equal(mapCategory({ SUMMARY: 'Graduation Ceremony' }), 'community')
  })

  it('returns community for fair events', () => {
    assert.equal(mapCategory({ SUMMARY: 'School Book Fair' }), 'community')
  })

  it('returns community for open house', () => {
    assert.equal(mapCategory({ SUMMARY: 'Elementary Open House' }), 'community')
  })

  it('returns education as default fallback', () => {
    assert.equal(mapCategory({ SUMMARY: 'School Board Meeting' }), 'education')
  })

  it('matches on DESCRIPTION when SUMMARY is generic', () => {
    assert.equal(mapCategory({ SUMMARY: 'Friday Event', DESCRIPTION: 'Annual orchestra concert.' }), 'music')
  })
})

// ── mapTags ───────────────────────────────────────────────────────────────

describe('Akron Public Schools — mapTags', () => {
  it('always includes base tags', () => {
    const tags = mapTags({ SUMMARY: 'Board Meeting' })
    assert.ok(tags.includes('schools'))
    assert.ok(tags.includes('akron-public-schools'))
    assert.ok(tags.includes('education'))
  })

  it('adds athletics tag for game events', () => {
    assert.ok(mapTags({ SUMMARY: 'Varsity Basketball Game' }).includes('athletics'))
  })

  it('adds athletics tag for match events', () => {
    assert.ok(mapTags({ SUMMARY: 'Soccer Match' }).includes('athletics'))
  })

  it('adds athletics tag for tournament events', () => {
    assert.ok(mapTags({ SUMMARY: 'Wrestling Tournament' }).includes('athletics'))
  })

  it('does not add athletics tag for non-athletic events', () => {
    assert.ok(!mapTags({ SUMMARY: 'Spring Concert' }).includes('athletics'))
  })

  it('adds music tag for concert events', () => {
    assert.ok(mapTags({ SUMMARY: 'Spring Concert' }).includes('music'))
  })

  it('adds music tag for band events', () => {
    assert.ok(mapTags({ SUMMARY: 'Marching Band Show' }).includes('music'))
  })

  it('adds music tag for choir events', () => {
    assert.ok(mapTags({ SUMMARY: 'Choir Performance' }).includes('music'))
  })

  it('does not add music tag for non-music events', () => {
    assert.ok(!mapTags({ SUMMARY: 'Basketball Game' }).includes('music'))
  })

  it('produces no duplicate tags', () => {
    const tags = mapTags({ SUMMARY: 'Concert and Game Night' })
    assert.equal(tags.length, new Set(tags).size)
  })

  it('handles missing SUMMARY gracefully', () => {
    assert.doesNotThrow(() => mapTags({}))
    assert.ok(mapTags({}).includes('schools'))
  })
})
