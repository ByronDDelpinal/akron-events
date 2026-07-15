/**
 * test-raintree-golf.js — pure helpers for the Raintree Golf & Event Center
 * Tribe scraper. Fixtures reflect the REAL feed shape captured 2026-07-14:
 * golf outings stored as all_day with the tee-off time only in the description
 * prose, a MIXED timezone config (one legacy event reports "UTC+0" with
 * utc_start_date === start_date; newer events report "America/New_York"), a
 * timed (non-all-day) event, entity-encoded titles, and an event whose `image`
 * is `false` but whose description embeds a banner <img>.
 *
 * Run:  node --test scripts/tests/test-raintree-golf.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  parseCategory, shouldSkip, extractTimeToken, resolveStartEnd,
  buildSourceId, parseImage, SOURCE_KEY,
} = await import('../scrape-raintree-golf.js')

// ── Fixtures (trimmed from the live feed 2026-07-14) ─────────────────────────

// Legacy event: timezone MISCONFIGURED to "UTC+0" (utc_start_date === start_date).
// all_day, tee-off time only in the prose. Also image:false + inline banner img.
const JUSTIN_MILLER = {
  id: 2351, title: 'Justin Miller Memorial Golf Outing', all_day: true,
  start_date: '2026-07-18 00:00:00', end_date: '2026-07-18 23:59:59',
  utc_start_date: '2026-07-18 00:00:00', timezone: 'UTC+0',
  description: '<p><img src="https://x/Justin-Miller-2023-Banner.jpg?w=300" /></p>\n<h3>Saturday, July 18, 2026 at Raintree Golf &amp; Event Center</h3>\n<h3>9:00 AM Shotgun Start </h3>',
  image: false,
  categories: [{ name: 'Golf Outing', slug: 'golf-outing' }],
  tags: [{ name: 'Golf Outing', slug: 'golf-outing' }, { name: 'Outing', slug: 'outing' }],
  website: 'https://www.facebook.com/people/Justin-Miller-Memorial-Golf-Outing/100078659689512/',
}
// Newer event: timezone CORRECT ("America/New_York"), still all_day with the
// time only in prose. image is a real object.
const WQMX = {
  id: 3160, title: 'WQMX Golf Outing', all_day: true,
  start_date: '2026-08-03 00:00:00', end_date: '2026-08-03 23:59:59',
  utc_start_date: '2026-08-03 04:00:00', timezone: 'America/New_York',
  description: '<h3>Monday, August 3, 2026</h3>\n<h3>9:00 AM Shotgun</h3>\n<h3>$125 per person</h3>',
  image: { url: 'https://x/WQMXlogo.jpg' },
  categories: [{ name: 'Golf Outing', slug: 'golf-outing' }], tags: [],
}
// Timed (NOT all_day) event — the feed time is real and used directly.
const OHIO_HEROES = {
  id: 2957, title: 'Ohio Heroes Golf Outing', all_day: false,
  start_date: '2026-09-11 09:00:00', end_date: '2026-09-11 17:00:00',
  utc_start_date: '2026-09-11 13:00:00', timezone: 'America/New_York',
  description: '<h4>September 11, 2026, 9 a.m. Shotgun Start</h4>', image: false,
  categories: [{ name: 'Golf Outing', slug: 'golf-outing' }], tags: [],
}
// Hypothetical all-day event with NO time anywhere → documented midnight fallback.
const NO_TIME = {
  id: 999, title: 'Fall Scramble', all_day: true,
  start_date: '2026-10-05 00:00:00', description: '<p>Join us for a fun round.</p>',
  categories: [{ name: 'Golf Outing', slug: 'golf-outing' }],
}

describe('resolveStartEnd — start_date is Eastern wall-clock in every tz config', () => {
  it('misconfigured "UTC+0" all-day: date + prose 9:00 AM → 13:00 UTC (NOT raw utc field)', () => {
    const r = resolveStartEnd(JUSTIN_MILLER)
    assert.equal(r.start_at, '2026-07-18T13:00:00.000Z')
    assert.equal(r.end_at, null)
    assert.equal(r.timeSource, 'prose')
  })
  it('correct-tz all-day: date + prose 9:00 AM → 13:00 UTC', () => {
    const r = resolveStartEnd(WQMX)
    assert.equal(r.start_at, '2026-08-03T13:00:00.000Z')
    assert.equal(r.timeSource, 'prose')
  })
  it('timed event uses the feed start/end wall-clock directly', () => {
    const r = resolveStartEnd(OHIO_HEROES)
    assert.equal(r.start_at, '2026-09-11T13:00:00.000Z')
    assert.equal(r.end_at, '2026-09-11T21:00:00.000Z')
    assert.equal(r.timeSource, 'feed')
  })
  it('all-day with no prose time falls back to documented midnight-Eastern', () => {
    const r = resolveStartEnd(NO_TIME)
    assert.equal(r.start_at, '2026-10-05T04:00:00.000Z') // 00:00 EDT
    assert.equal(r.timeSource, 'all_day')
  })
})

describe('extractTimeToken', () => {
  it('grabs the time before a "Shotgun Start" cue', () => {
    assert.match(extractTimeToken('<h3>9:00 AM Shotgun Start</h3>'), /^9:00\s*AM$/i)
  })
  it('handles "9 a.m." with periods', () => {
    assert.match(extractTimeToken('September 11, 2026, 9 a.m. Shotgun Start'), /^9\s*a\.m\.$/i)
  })
  it('handles lowercase "9:00am shotgun"', () => {
    assert.match(extractTimeToken('Friday, 9:00am shotgun'), /^9:00am$/i)
  })
  it('returns null when there is no time in the prose', () => {
    assert.equal(extractTimeToken('<p>Join us for a fun round.</p>'), null)
  })
})

describe('parseCategory', () => {
  it('golf outings map to sports', () => {
    assert.equal(parseCategory(JUSTIN_MILLER), 'sports')
  })
  it('a dinner event maps to food', () => {
    assert.equal(parseCategory({ title: 'Thanksgiving Dinner Buffet', categories: [] }), 'food')
  })
  it('an unclassifiable event defers to inference (null)', () => {
    assert.equal(parseCategory({ title: 'Live Music Night', categories: [] }), null)
  })
})

describe('shouldSkip — private rentals only', () => {
  it('skips a private wedding', () => {
    assert.equal(shouldSkip('Smith Wedding Reception'), true)
  })
  it('keeps a public bridal resale SHOW (a market, not a private wedding)', () => {
    assert.equal(shouldSkip('Bridal Resale Show 2026'), false)
  })
  it('keeps golf outings', () => {
    assert.equal(shouldSkip(JUSTIN_MILLER.title), false)
  })
})

describe('buildSourceId', () => {
  it('is the stable one-off Tribe post id', () => {
    assert.equal(buildSourceId(OHIO_HEROES), '2957')
  })
})

describe('parseImage', () => {
  it('uses a real image object', () => {
    assert.equal(parseImage(WQMX.image), 'https://x/WQMXlogo.jpg')
  })
  it('falls back to an inline <img> when image === false', () => {
    assert.equal(parseImage(JUSTIN_MILLER.image, JUSTIN_MILLER.description),
      'https://x/Justin-Miller-2023-Banner.jpg?w=300')
  })
  it('returns null when neither is present', () => {
    assert.equal(parseImage(false, '<p>no image</p>'), null)
  })
})

describe('module contract', () => {
  it('exports the source key', () => {
    assert.equal(SOURCE_KEY, 'raintree_golf')
  })
})
