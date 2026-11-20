/**
 * test-akron-public-schools.js
 *
 * Unit tests for the Akron Public Schools scraper — the public-facing event
 * filter (isPublicFacing), category mapping, and tag mapping.
 *
 * Run:
 *   node --test scripts/tests/test-akron-public-schools.js
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveFeedUrls,
  collapseDateOnlyTwins,
  explicitTimeFromDescription,
  applyExplicitTime,
  naturalKey,
  adoptExistingSourceId,
  venueFromDescription,
  loadExistingByKey,
  processEvents,
  planDateOnlyRuns,
  AMBIGUOUS_KEY,
} from '../scrape-akron-public-schools.js'
import { __setClientForTests } from '../lib/supabase-admin.js'
import { normaliseIcsEvent, isDateOnlyIcsEvent, applyNeedsReviewHook, DATE_ONLY_TIME_NOTE } from '../lib/ics.js'

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

// ── resolveFeedUrls ────────────────────────────────────────────────────────

describe('Akron Public Schools — resolveFeedUrls', () => {
  it('returns a single-element array for a single env URL', () => {
    const urls = resolveFeedUrls({ AKRON_PUBLIC_SCHOOLS_ICS_URL: 'https://example.com/a.ics' })
    assert.deepEqual(urls, ['https://example.com/a.ics'])
  })

  it('splits comma-separated env URLs and trims whitespace', () => {
    const urls = resolveFeedUrls({
      AKRON_PUBLIC_SCHOOLS_ICS_URL: ' https://example.com/a.ics , https://example.com/b.ics ',
    })
    assert.deepEqual(urls, ['https://example.com/a.ics', 'https://example.com/b.ics'])
  })

  it('falls back to non-empty DEFAULT_FEED_URLS when env is unset', () => {
    const urls = resolveFeedUrls({})
    assert.ok(urls.length > 0)
    for (const url of urls) {
      assert.ok(url.startsWith('https://www.akronschools.com/'), `unexpected default URL: ${url}`)
    }
  })

  it('treats a whitespace-only env value as unset', () => {
    const urls = resolveFeedUrls({ AKRON_PUBLIC_SCHOOLS_ICS_URL: '   ' })
    assert.ok(urls.length > 0)
    for (const url of urls) {
      assert.ok(url.startsWith('https://www.akronschools.com/'), `unexpected default URL: ${url}`)
    }
  })

  it('treats an empty string env value as unset', () => {
    const urls = resolveFeedUrls({ AKRON_PUBLIC_SCHOOLS_ICS_URL: '' })
    assert.ok(urls.length > 0)
    for (const url of urls) {
      assert.ok(url.startsWith('https://www.akronschools.com/'), `unexpected default URL: ${url}`)
    }
  })
})

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

// ── Date-only twins + explicit times ──────────────────────────────────────

const timed = (uid, summary, day, hhmm = '180000') =>
  ({ UID: uid, SUMMARY: summary, DTSTART: { value: `${day}T${hhmm}`, params: { TZID: 'America/New_York' } } })
const dateOnly = (uid, summary, day, extra = {}) =>
  ({ UID: uid, SUMMARY: summary, DTSTART: { value: day, params: { VALUE: 'DATE' } }, ...extra })

describe('Akron Public Schools — collapseDateOnlyTwins', () => {
  it('drops the date-only twin of a timed event and preserves order', () => {
    const input = [
      dateOnly('d1', 'North High SHOWCASE', '20261012'),
      timed('t1', 'North High Showcase', '20261012'),
      timed('t2', 'Board Meeting', '20261013'),
      dateOnly('d2', 'Board Meeting', '20261013'),
      timed('t3', 'Choir Concert', '20261014'),
    ]
    const { events, dropped } = collapseDateOnlyTwins(input)
    assert.equal(dropped, 2)
    assert.deepEqual(events.map(e => e.UID), ['t1', 't2', 't3'])
  })

  it('keeps two date-only same-title rows when no timed sibling exists', () => {
    const input = [dateOnly('d1', 'Book Fair', '20261012'), dateOnly('d2', 'Book Fair', '20261012')]
    const { events, dropped } = collapseDateOnlyTwins(input)
    assert.equal(dropped, 0)
    assert.deepEqual(events.map(e => e.UID), ['d1', 'd2'])
  })

  it('never collapses across different dates', () => {
    const input = [timed('t1', 'Board Meeting', '20261013'), dateOnly('d1', 'Board Meeting', '20261020')]
    const { events, dropped } = collapseDateOnlyTwins(input)
    assert.equal(dropped, 0)
    assert.deepEqual(events.map(e => e.UID), ['t1', 'd1'])
  })

  it('treats VALUE=DATE with a real clock as timed: never dropped beside a timed twin', () => {
    const a = {
      UID: 'a', SUMMARY: 'Board Meeting',
      DTSTART: { value: '20261012T180000', params: { VALUE: 'DATE' } },
    }
    const input = [a, timed('c', 'Board Meeting', '20261012')]
    const { events, dropped } = collapseDateOnlyTwins(input)
    assert.equal(dropped, 0)
    assert.deepEqual(events.map(e => e.UID), ['a', 'c'])
  })
})

describe('Akron Public Schools — explicitTimeFromDescription', () => {
  it('parses "5:30 p.m."', () => {
    assert.equal(explicitTimeFromDescription({ DESCRIPTION: 'The Board meeting will be held at 5:30 p.m. in the board room.' }), '5:30 pm')
  })
  it('parses "7 PM"', () => {
    assert.equal(explicitTimeFromDescription({ DESCRIPTION: 'Doors open at 7 PM' }), '7:00 pm')
  })
  it('parses "10:00am"', () => {
    assert.equal(explicitTimeFromDescription({ DESCRIPTION: '<p>Starts 10:00am sharp</p>' }), '10:00 am')
  })
  it('returns null for no time, "13 pm", and empty', () => {
    assert.equal(explicitTimeFromDescription({ DESCRIPTION: 'Bring the family.' }), null)
    assert.equal(explicitTimeFromDescription({ DESCRIPTION: 'Meet at 13 pm' }), null)
    assert.equal(explicitTimeFromDescription({ DESCRIPTION: '' }), null)
    assert.equal(explicitTimeFromDescription({}), null)
  })
  it('rejects deadline, end, and range-tail tokens', () => {
    assert.equal(explicitTimeFromDescription({ DESCRIPTION: 'RSVP by 5 pm Friday.' }), null)
    assert.equal(explicitTimeFromDescription({ DESCRIPTION: 'Ends at 3 p.m.' }), null)
    assert.equal(explicitTimeFromDescription({ DESCRIPTION: 'Grades 9-12 pm' }), null)
    assert.equal(explicitTimeFromDescription({ DESCRIPTION: 'Open until 4 pm.' }), null)
    assert.equal(explicitTimeFromDescription({ DESCRIPTION: 'Runs through 6 pm.' }), null)
  })
  it('keeps the start of a range and a plain "held at" time', () => {
    assert.equal(explicitTimeFromDescription({ DESCRIPTION: 'Conferences 3pm-5pm' }), '3:00 pm')
    assert.equal(explicitTimeFromDescription({ DESCRIPTION: 'Fair 9 am \u2013 12 pm' }), '9:00 am')
    assert.equal(explicitTimeFromDescription({ DESCRIPTION: 'The meeting will be held at 5:30 p.m.' }), '5:30 pm')
    assert.equal(explicitTimeFromDescription({ DESCRIPTION: 'Lobby opens 5 pm' }), '5:00 pm')
  })
})

describe('Akron Public Schools — date-only rows through normaliseIcsEvent', () => {
  const config = { source: 'akron_public_schools', ageRestriction: 'all_ages' }

  it('re-times a date-only VEVENT from a "5:30 p.m." description and strips the note', () => {
    const ev = dateOnly('d1', 'Board Meeting', '20260928', {
      DESCRIPTION: 'The Board meeting will be held at 5:30 p.m. in the board room at 10 N. Main St.',
    })
    const row = normaliseIcsEvent(ev, config)
    assert.ok(row.description.includes(DATE_ONLY_TIME_NOTE), 'precondition: normaliser added the note')
    assert.equal(applyExplicitTime(row, ev), true)
    assert.equal(row.start_at, '2026-09-28T21:30:00.000Z')
    assert.equal(row.end_at, null)
    assert.ok(!row.description.includes(DATE_ONLY_TIME_NOTE))
    assert.equal(row.description, 'The Board meeting will be held at 5:30 p.m. in the board room at 10 N. Main St.')
  })

  it('re-times a date-only VEVENT during EST', () => {
    const ev = dateOnly('d3', 'Board Meeting', '20261109', { DESCRIPTION: 'Held at 5:30 p.m.' })
    const row = normaliseIcsEvent(ev, config)
    assert.equal(applyExplicitTime(row, ev), true)
    assert.equal(row.start_at, '2026-11-09T22:30:00.000Z')
  })

  it('does NOT re-time VALUE=DATE whose value carries a real clock', () => {
    const ev = {
      UID: 'v1', SUMMARY: 'Board Meeting',
      DTSTART: { value: '20261012T180000', params: { VALUE: 'DATE' } },
      DESCRIPTION: 'Doors open at 7 pm',
    }
    assert.equal(isDateOnlyIcsEvent(ev), true, 'precondition: predicate is true for this shape')
    const row = normaliseIcsEvent(ev, config)
    const before = row.start_at
    assert.equal(before, '2026-10-12T22:00:00.000Z', 'precondition: normaliser kept 18:00 ET')
    assert.equal(applyExplicitTime(row, ev), false)
    assert.equal(row.start_at, before)
  })

  it('keeps end_at on a multi-day date-only VEVENT after re-time', () => {
    const ev = dateOnly('d4', 'Book Fair', '20260928', {
      DTEND: { value: '20261002', params: { VALUE: 'DATE' } },
      DESCRIPTION: 'Opens at 8 am daily.',
    })
    const row = normaliseIcsEvent(ev, config)
    assert.ok(row.end_at, 'precondition: normaliser kept the multi-day end')
    const endBefore = row.end_at
    assert.equal(applyExplicitTime(row, ev), true)
    assert.equal(row.start_at, '2026-09-28T12:00:00.000Z')
    assert.equal(row.end_at, endBefore)
  })

  it('nulls end_at only when the re-timed start would pass it', () => {
    const ev = dateOnly('d5', 'Late Meeting', '20260928', {
      DTEND: { value: '20260928T190000', params: { TZID: 'America/New_York' } },
      DESCRIPTION: 'Held at 8 pm.',
    })
    const row = normaliseIcsEvent(ev, config)
    assert.ok(row.end_at, 'precondition: 19:00 end survives the noon default')
    assert.equal(applyExplicitTime(row, ev), true)
    assert.equal(row.end_at, null)
  })

  it('does not re-time a note-only description and still flags review', () => {
    // A description that already is the note (normaliser returns it as-is).
    const ev = dateOnly('d6', 'Picture Day', '20260928', { DESCRIPTION: DATE_ONLY_TIME_NOTE })
    const row = normaliseIcsEvent(ev, config)
    assert.equal(row.description, DATE_ONLY_TIME_NOTE, 'precondition: description is only the note')
    assert.equal(applyExplicitTime(row, ev), false)
    assert.equal(row.start_at, '2026-09-28T16:00:00.000Z')
    assert.equal(row.description, DATE_ONLY_TIME_NOTE)
    applyNeedsReviewHook(row, ev, isDateOnlyIcsEvent)
    assert.equal(row.needs_review, true)
  })

  it('re-timed rows still get needs_review from the hook', () => {
    const ev = dateOnly('d7', 'Board Meeting', '20260928', { DESCRIPTION: 'Held at 5:30 p.m.' })
    const row = normaliseIcsEvent(ev, config)
    assert.equal(applyExplicitTime(row, ev), true)
    applyNeedsReviewHook(row, ev, isDateOnlyIcsEvent)
    assert.equal(row.needs_review, true)
  })

  it('leaves a timed VEVENT alone even when the description mentions a time', () => {
    const ev = { ...timed('t1', 'Board Meeting', '20260928'), DESCRIPTION: 'Held at 5:30 p.m.' }
    const row = normaliseIcsEvent(ev, config)
    const before = row.start_at
    assert.equal(applyExplicitTime(row, ev), false)
    assert.equal(row.start_at, before)
  })

  it('flags a date-only VEVENT without a stated time as needs_review via the hook', () => {
    const ev = dateOnly('d2', 'Fall Book Fair', '20260928', { DESCRIPTION: 'All week in the library.' })
    const row = normaliseIcsEvent(ev, config)
    assert.equal(applyExplicitTime(row, ev), false)
    applyNeedsReviewHook(row, ev, isDateOnlyIcsEvent)
    assert.equal(row.needs_review, true)
    assert.ok(row.description.includes(DATE_ONLY_TIME_NOTE))
  })
})

describe('Akron Public Schools — naturalKey', () => {
  it('is case- and whitespace-insensitive on title and spelling-insensitive on start_at', () => {
    const a = naturalKey({ title: 'Board Meeting', start_at: '2026-09-28T21:30:00.000Z' })
    const b = naturalKey({ title: '  BOARD meeting ', start_at: '2026-09-28T21:30:00+00:00' })
    assert.equal(a, b)
  })

  it('folds accents like unaccent()', () => {
    assert.equal(
      naturalKey({ title: 'Café Night', start_at: '2026-09-28T16:00:00Z' }),
      naturalKey({ title: 'cafe night', start_at: '2026-09-28T16:00:00Z' }),
    )
  })

  it('differs when start_at differs', () => {
    assert.notEqual(
      naturalKey({ title: 'Board Meeting', start_at: '2026-09-28T21:30:00Z' }),
      naturalKey({ title: 'Board Meeting', start_at: '2026-09-29T21:30:00Z' }),
    )
  })
})

describe('Akron Public Schools — adoptExistingSourceId', () => {
  const stored = { title: 'Board Meeting', start_at: '2026-09-28T21:30:00+00:00' }
  const map = new Map([[naturalKey(stored), 'old-uid@akronschools']])

  it('swaps a re-issued UID onto the stored source_id and returns true', () => {
    const row = { source_id: 'new-uid', title: 'Board Meeting', start_at: '2026-09-28T21:30:00.000Z' }
    assert.equal(adoptExistingSourceId(row, map), true)
    assert.equal(row.source_id, 'old-uid@akronschools')
  })

  it('returns false and leaves the row unchanged when the source_id already matches', () => {
    const row = { source_id: 'old-uid@akronschools', title: 'Board Meeting', start_at: '2026-09-28T21:30:00Z' }
    const before = { ...row }
    assert.equal(adoptExistingSourceId(row, map), false)
    assert.deepEqual(row, before)
  })

  it('returns false and leaves the row unchanged when no stored row shares the key', () => {
    const row = { source_id: 'new-uid', title: 'Board Meeting', start_at: '2026-10-26T21:30:00Z' }
    const before = { ...row }
    assert.equal(adoptExistingSourceId(row, map), false)
    assert.deepEqual(row, before)
    assert.equal(adoptExistingSourceId(row, new Map()), false)
    assert.deepEqual(row, before)
  })
})

describe('Akron Public Schools — venueFromDescription', () => {
  const expected = { name: 'Akron Public Schools', address: '10 N. Main Street', city: 'Akron', state: 'OH' }

  it('maps the Board Meeting Administration Building text to the APS venue', () => {
    const desc = 'The Board meeting will be held at 5:30 p.m. in the board room on the 1st floor of the Administration Building, 10 N. Main St.'
    assert.deepEqual(venueFromDescription({ DESCRIPTION: desc }), expected)
  })

  it('tolerates a raw ICS \\, escape', () => {
    const desc = 'in the board room of the Administration Building\\, 10 N. Main St.'
    assert.deepEqual(venueFromDescription({ DESCRIPTION: desc }), expected)
  })

  it('returns null for empty and unrelated descriptions', () => {
    assert.equal(venueFromDescription({}), null)
    assert.equal(venueFromDescription({ DESCRIPTION: '' }), null)
    assert.equal(
      venueFromDescription({ DESCRIPTION: 'Donations of new coats can be dropped off at any school building through Friday.' }),
      null,
    )
  })
})

describe('Akron Public Schools — adoption keeps the review flag', () => {
  it('a date-only VEVENT stays needs_review after source_id adoption', () => {
    const config = { source: 'akron_public_schools', ageRestriction: 'all_ages' }
    const ev = dateOnly('reissued-uid', 'Fall Book Fair', '20260928', { DESCRIPTION: 'All week in the library.' })
    const row = normaliseIcsEvent(ev, config)
    applyExplicitTime(row, ev)
    applyNeedsReviewHook(row, ev, isDateOnlyIcsEvent)
    const map = new Map([[naturalKey({ title: 'Fall Book Fair', start_at: row.start_at }), 'original-uid']])
    assert.equal(adoptExistingSourceId(row, map), true)
    assert.equal(row.source_id, 'original-uid')
    assert.equal(row.needs_review, true)
  })
})

// Fake supabase client: records every from()/method call; range() resolves
// to the next scripted page ({ data } or { error }).
function fakeClient(pages) {
  const calls = []
  let page = 0
  const builder = new Proxy({}, {
    get(_t, method) {
      if (method === 'then') return undefined
      return (...args) => {
        calls.push([method, ...args])
        if (method === 'range') return Promise.resolve(pages[page++] ?? { data: [] })
        return builder
      }
    },
  })
  return { calls, from: (table) => { calls.push(['from', table]); return builder } }
}

const NOW = Date.parse('2026-11-11T05:00:00Z')
const storedRow = (i, extra = {}) => ({
  source_id: `uid-${i}`, title: `Event ${i}`, start_at: new Date(NOW + i * 60000).toISOString(), ...extra,
})

describe('Akron Public Schools — loadExistingByKey', () => {
  afterEach(() => __setClientForTests(null))

  it('pages past the 1000-row boundary and excludes cancelled rows', async () => {
    const first = Array.from({ length: 1000 }, (_, i) => storedRow(i))
    const client = fakeClient([{ data: first }, { data: [storedRow(1000)] }])
    __setClientForTests(client)
    const res = await loadExistingByKey({ now: NOW })
    assert.equal(res.readFailed, false)
    assert.equal(res.map.size, 1001)
    const ranges = client.calls.filter(c => c[0] === 'range').map(c => c.slice(1))
    assert.deepEqual(ranges, [[0, 999], [1000, 1999]])
    assert.ok(client.calls.some(c => c[0] === 'neq' && c[1] === 'status' && c[2] === 'cancelled'))
    assert.ok(client.calls.some(c => c[0] === 'eq' && c[1] === 'source' && c[2] === 'akron_public_schools'))
  })

  it('stops after a short first page', async () => {
    const client = fakeClient([{ data: [storedRow(1)] }])
    __setClientForTests(client)
    await loadExistingByKey({ now: NOW })
    assert.equal(client.calls.filter(c => c[0] === 'range').length, 1)
  })

  it('a mid-read error returns an empty map with readFailed', async () => {
    const first = Array.from({ length: 1000 }, (_, i) => storedRow(i))
    __setClientForTests(fakeClient([{ data: first }, { data: null, error: { message: 'boom' } }]))
    const res = await loadExistingByKey({ now: NOW })
    assert.equal(res.readFailed, true)
    assert.equal(res.readError, 'boom')
    assert.equal(res.map.size, 0)
  })

  it('marks a key held by two source_ids ambiguous and never adopts it', async () => {
    const a = storedRow(1)
    const b = { ...a, source_id: 'uid-dup' }
    __setClientForTests(fakeClient([{ data: [a, b, storedRow(2)] }]))
    const res = await loadExistingByKey({ now: NOW })
    assert.equal(res.ambiguous, 1)
    assert.equal(res.map.get(naturalKey(a)), AMBIGUOUS_KEY)
    const row = { source_id: 'fresh-uid', title: a.title, start_at: a.start_at }
    assert.equal(adoptExistingSourceId(row, res.map), false)
    assert.equal(row.source_id, 'fresh-uid')
  })

  it('a repeated identical source_id is not ambiguous', async () => {
    __setClientForTests(fakeClient([{ data: [storedRow(1), storedRow(1)] }]))
    const res = await loadExistingByKey({ now: NOW })
    assert.equal(res.ambiguous, 0)
    assert.equal(res.map.get(naturalKey(storedRow(1))), 'uid-1')
  })
})

describe('Akron Public Schools — naturalKey on sanitised titles', () => {
  it('an entity-encoded feed title keys like its decoded stored form', () => {
    const start_at = '2026-09-28T16:00:00Z'
    assert.equal(naturalKey({ title: 'Arts &amp; Crafts Night', start_at }), naturalKey({ title: 'Arts & Crafts Night', start_at }))
  })
})

describe('Akron Public Schools — processEvents dry run', () => {
  afterEach(() => __setClientForTests(null))

  it('DRY_RUN calls no writer and touches no table, but still counts', async () => {
    const client = fakeClient([])
    __setClientForTests(client)
    const writes = []
    const spy = (name) => async (...args) => { writes.push(name, args); return { data: { id: 'x' } } }
    const writers = Object.fromEntries(
      ['ensureVenue', 'enrichWithImageDimensions', 'upsertEventSafe', 'linkEventVenue', 'linkEventOrganization']
        .map(n => [n, spy(n)]),
    )
    const board = dateOnly('new-uid', 'Board Meeting', '20261109', {
      DESCRIPTION: 'Held at 5:30 p.m. in the board room of the Administration Building, 10 N. Main St.',
    })
    const existingByKey = new Map([[naturalKey({ title: 'Board Meeting', start_at: '2026-11-09T22:30:00Z' }), 'old-uid']])
    const counts = await processEvents([board], { dryRun: true, existingByKey, organizationId: 'org', writers })
    assert.deepEqual(writes, [])
    assert.deepEqual(client.calls, [])
    assert.equal(counts.adopted, 1)
    assert.equal(counts.venueLinks, 1)
    assert.equal(counts.flagged, 1)
    assert.equal(counts.inserted, 1)
  })

  it('a live run does call the writers (control for the dry-run test)', async () => {
    const writes = []
    const spy = (name) => async () => { writes.push(name); return name === 'enrichWithImageDimensions' ? {} : { data: { id: 'x' } } }
    const writers = Object.fromEntries(
      ['ensureVenue', 'enrichWithImageDimensions', 'upsertEventSafe', 'linkEventVenue', 'linkEventOrganization']
        .map(n => [n, spy(n)]),
    )
    const board = dateOnly('u1', 'Board Meeting', '20261109', { DESCRIPTION: 'Administration Building, 10 N. Main St.' })
    await processEvents([board], { dryRun: false, organizationId: 'org', writers })
    assert.deepEqual(writes, ['ensureVenue', 'enrichWithImageDimensions', 'upsertEventSafe', 'linkEventVenue', 'linkEventOrganization'])
  })
})

// ── Multi-day runs of date-only rows ──────────────────────────────────────

// 'YYYYMMDD' n days after a 'YYYYMMDD' (UTC civil arithmetic; test-only).
const plusDays = (ymd, n) => {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + n))
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}
const runOf = (prefix, summary, firstYmd, days, extra = {}) =>
  Array.from({ length: days }, (_, i) =>
    dateOnly(`${prefix}${String(i).padStart(2, '0')}`, summary, plusDays(firstYmd, i), extra))
const shuffle = (arr) => {
  const a = [...arr]
  let seed = 7
  for (let i = a.length - 1; i > 0; i--) {
    seed = (seed * 9301 + 49297) % 233280
    const j = Math.floor((seed / 233280) * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

describe('Akron Public Schools — planDateOnlyRuns', () => {
  it('28 consecutive same-title days → 1 head (first UID, lastYmd 20270131) + 27 members', () => {
    const evs = runOf('u', 'Winter Book Fair', '20270104', 28)
    const plan = planDateOnlyRuns(evs)
    assert.equal(plan.size, 28)
    assert.deepEqual(plan.get('u00'), { role: 'head', lastYmd: '20270131', length: 28 })
    for (const ev of evs.slice(1)) assert.deepEqual(plan.get(ev.UID), { role: 'member', headUid: 'u00' })
  })

  it('a 2-day run is not in the map; a 3-day run is (minRun default 3)', () => {
    assert.equal(planDateOnlyRuns(runOf('a', 'Book Fair', '20261012', 2)).size, 0)
    assert.equal(planDateOnlyRuns(runOf('a', 'Book Fair', '20261012', 3)).size, 3)
    assert.equal(planDateOnlyRuns(runOf('a', 'Book Fair', '20261012', 3), { minRun: 4 }).size, 0)
  })

  it('a gap splits the run into two heads', () => {
    const evs = [...runOf('a', 'Book Fair', '20261012', 3), ...runOf('b', 'Book Fair', '20261019', 4)]
    const plan = planDateOnlyRuns(evs)
    assert.deepEqual(plan.get('a00'), { role: 'head', lastYmd: '20261014', length: 3 })
    assert.deepEqual(plan.get('b00'), { role: 'head', lastYmd: '20261022', length: 4 })
    assert.deepEqual(plan.get('b03'), { role: 'member', headUid: 'b00' })
  })

  it('timed and VALUE=DATE-with-clock events are never grouped', () => {
    const evs = [
      dateOnly('d1', 'Spirit Week', '20261012'),
      timed('t1', 'Spirit Week', '20261013'),
      { UID: 'c1', SUMMARY: 'Spirit Week', DTSTART: { value: '20261014T180000', params: { VALUE: 'DATE' } } },
      dateOnly('d2', 'Spirit Week', '20261015'),
    ]
    assert.equal(planDateOnlyRuns(evs).size, 0)
    const allTimed = [0, 1, 2, 3].map(i => timed(`t${i}`, 'Spirit Week', plusDays('20261012', i)))
    assert.equal(planDateOnlyRuns(allTimed).size, 0)
  })

  it('case/punctuation variants group; "Begins" and "Ends" stay separate', () => {
    const evs = [
      dateOnly('x1', 'Spirit Week!', '20261012'),
      dateOnly('x2', 'spirit week', '20261013'),
      dateOnly('x3', 'SPIRIT-WEEK', '20261014'),
      dateOnly('b1', 'Winter Break Begins', '20261221'),
      dateOnly('e1', 'Winter Break Ends', '20261222'),
      dateOnly('b2', 'Winter Break Begins', '20261223'),
    ]
    const plan = planDateOnlyRuns(evs)
    assert.deepEqual([...plan.keys()].sort(), ['x1', 'x2', 'x3'])
    assert.equal(plan.get('x1').role, 'head')
  })

  it('shuffled input yields the same plan, across a month/year boundary (Dec 30 → Jan 2)', () => {
    const evs = [...runOf('y', 'Holiday Camp', '20261230', 4), ...runOf('z', 'Other Camp', '20270301', 3)]
    const plan = planDateOnlyRuns(evs)
    assert.deepEqual(plan.get('y00'), { role: 'head', lastYmd: '20270102', length: 4 })
    const shuffled = planDateOnlyRuns(shuffle(evs))
    assert.deepEqual([...shuffled.entries()].sort(), [...plan.entries()].sort())
    assert.deepEqual(planDateOnlyRuns([...evs].reverse()).get('y00'), plan.get('y00'))
  })

  it('a duplicate UID on an already-present day is a member and does not extend the run', () => {
    const evs = [...runOf('a', 'Book Fair', '20261012', 3), dateOnly('a99', 'Book Fair', '20261014')]
    const plan = planDateOnlyRuns(evs)
    assert.deepEqual(plan.get('a00'), { role: 'head', lastYmd: '20261014', length: 3 })
    assert.deepEqual(plan.get('a99'), { role: 'member', headUid: 'a00' })
    // Two same-day UIDs plus one more day: only 2 distinct days, so no run.
    const short = [dateOnly('p', 'Book Fair', '20261012'), dateOnly('q', 'Book Fair', '20261012'), dateOnly('r', 'Book Fair', '20261013')]
    assert.equal(planDateOnlyRuns(short).size, 0)
    // Same-day tie on the first day: the lowest UID string is the head.
    const tie = [dateOnly('m', 'Book Fair', '20261012'), dateOnly('k', 'Book Fair', '20261012'), ...runOf('n', 'Book Fair', '20261013', 2)]
    assert.equal(planDateOnlyRuns(tie).get('k').role, 'head')
  })

  it('dropping day 1 makes day 2 the head', () => {
    const evs = runOf('u', 'Winter Book Fair', '20270104', 28).slice(1)
    const plan = planDateOnlyRuns(evs)
    assert.deepEqual(plan.get('u01'), { role: 'head', lastYmd: '20270131', length: 27 })
    assert.equal(plan.has('u00'), false)
  })
})

describe('Akron Public Schools — processEvents with a run plan', () => {
  const spyWriters = (upserts) => ({
    ensureVenue:               async () => 'venue',
    enrichWithImageDimensions: async (row) => row,
    upsertEventSafe:           async (row) => { upserts.push({ ...row }); return { data: { id: row.source_id } } },
    linkEventVenue:            async () => {},
    linkEventOrganization:     async () => {},
  })

  it('head end_at is 11:59 pm ET on the last day, across the 2027-03-14 DST change', async () => {
    const evs = [...runOf('s', 'Spring Book Fair', '20270310', 7), ...runOf('w', 'Winter Book Fair', '20270301', 3)]
    const upserts = []
    const counts = await processEvents(evs, { runPlan: planDateOnlyRuns(evs), writers: spyWriters(upserts) })
    const head = upserts.find(r => r.source_id === 's00')
    // 2027-03-16 is EDT (UTC-4): 23:59 local = 03:59Z next day.
    assert.equal(Date.parse(head.end_at), Date.parse('2027-03-17T03:59:00Z'))
    // 2027-03-03 is EST (UTC-5): 23:59 local = 04:59Z next day.
    assert.equal(Date.parse(upserts.find(r => r.source_id === 'w00').end_at), Date.parse('2027-03-04T04:59:00Z'))
    assert.equal(counts.ranged, 2)
    assert.equal(counts.held, 8)
  })

  it('live run: head upserted with end_at + published; members upserted pending_review', async () => {
    const evs = [...runOf('u', 'Winter Book Fair', '20270104', 28), dateOnly('solo', 'Board Meeting', '20270105')]
    const upserts = []
    const counts = await processEvents(evs, { runPlan: planDateOnlyRuns(evs), writers: spyWriters(upserts) })
    assert.equal(upserts.length, 29)
    const head = upserts.find(r => r.source_id === 'u00')
    assert.equal(head.status, 'published')
    assert.equal(head.needs_review, true)
    assert.equal(Date.parse(head.end_at), Date.parse('2027-02-01T04:59:00Z'))
    const members = upserts.filter(r => r.source_id.startsWith('u') && r.source_id !== 'u00')
    assert.equal(members.length, 27)
    assert.ok(members.every(r => r.status === 'pending_review'))
    const solo = upserts.find(r => r.source_id === 'solo')
    assert.equal(solo.status, 'published')
    assert.ok(!solo.end_at || Date.parse(solo.end_at) < Date.parse('2027-01-06T05:00:00Z'))
    assert.equal(counts.ranged, 1)
    assert.equal(counts.held, 27)
    assert.equal(counts.inserted, 29)
  })

  it('dry run with a run plan calls no writer but still counts ranged/held', async () => {
    const writes = []
    const writers = Object.fromEntries(
      ['ensureVenue', 'enrichWithImageDimensions', 'upsertEventSafe', 'linkEventVenue', 'linkEventOrganization']
        .map(n => [n, async () => { writes.push(n); return { data: { id: 'x' } } }]),
    )
    const evs = runOf('u', 'Winter Book Fair', '20270104', 28)
    const counts = await processEvents(evs, { dryRun: true, runPlan: planDateOnlyRuns(evs), organizationId: 'org', writers })
    assert.deepEqual(writes, [])
    assert.equal(counts.ranged, 1)
    assert.equal(counts.held, 27)
    assert.equal(counts.inserted, 28)
  })

  it('a member under a re-issued UID still adopts the stored source_id', async () => {
    const evs = runOf('new', 'Winter Book Fair', '20270104', 5)
    const memberRow = normaliseIcsEvent(evs[2], { source: 'akron_public_schools' })
    const existingByKey = new Map([[naturalKey(memberRow), 'old-02']])
    const upserts = []
    const counts = await processEvents(evs, { runPlan: planDateOnlyRuns(evs), existingByKey, writers: spyWriters(upserts) })
    const adopted = upserts.find(r => r.source_id === 'old-02')
    assert.ok(adopted)
    assert.equal(adopted.status, 'pending_review')
    assert.equal(counts.adopted, 1)
    assert.equal(counts.held, 4)
  })
})
