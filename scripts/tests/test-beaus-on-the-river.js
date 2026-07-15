/**
 * test-beaus-on-the-river.js — pure helpers for the Beau's on the River Tribe
 * scraper. Fixtures reflect the REAL feed shape captured 2026-07-14: the install
 * timezone is CORRECTLY configured to "America/New_York" (utc_start_date properly
 * offset from start_date), the sole category is "Entertainment" (live music),
 * titles are inconsistently entity-encoded, venue/organizer arrays are empty, and
 * cost is blank.
 *
 * Run:  node --test scripts/tests/test-beaus-on-the-river.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { toEasternIso, parseCategory, shouldSkip, buildSourceId, parseImage, SOURCE_KEY } =
  await import('../scrape-beaus-on-the-river.js')

// Captured 2026-07-14 (trimmed). Correctly-configured install: start_date is the
// Eastern wall-clock show time; utc_start_date is properly +4h (EDT).
const LIVE_MUSIC = {
  id: 7079, title: 'Rolando Pizana',
  start_date: '2026-07-25 19:00:00', end_date: '2026-07-25 22:00:00',
  utc_start_date: '2026-07-25 23:00:00', all_day: false,
  categories: [{ name: 'Entertainment', slug: 'entertainment' }],
  image: { url: 'https://beausontheriver.com/wp-content/uploads/2019/05/Rolando-Pizana.jpg' },
  cost: '',
}
const DINNER = {
  id: 900, title: 'Valentine\'s Wine Dinner',
  start_date: '2027-02-14 18:00:00', all_day: false,
  categories: [{ name: 'Dinner Event', slug: 'dinner-event' }],
}
const HAPPY_HOUR = {
  id: 901, title: 'Happy Hour',
  start_date: '2026-08-01 16:00:00', all_day: false, categories: [],
}

describe('toEasternIso — wall-clock start_date treated as Eastern (robust either way)', () => {
  it('7:00 PM EDT show → 23:00 UTC', () => {
    // Correctly-configured install would also give this via utc_start_date+Z;
    // going through start_date keeps us correct even if the tz is ever broken.
    assert.equal(toEasternIso(LIVE_MUSIC.start_date), '2026-07-25T23:00:00.000Z')
  })
  it('handles the end_date', () => {
    assert.equal(toEasternIso(LIVE_MUSIC.end_date), '2026-07-26T02:00:00.000Z')
  })
  it('a winter EST show (6:00 PM EST → 23:00 UTC)', () => {
    assert.equal(toEasternIso(DINNER.start_date), '2027-02-14T23:00:00.000Z')
  })
  it('returns null for a missing time', () => {
    assert.equal(toEasternIso(undefined), null)
  })
})

describe('parseCategory', () => {
  it('Entertainment maps to music', () => {
    assert.equal(parseCategory(LIVE_MUSIC.categories), 'music')
  })
  it('a dinner/wine event maps to food', () => {
    assert.equal(parseCategory(DINNER.categories), 'food')
  })
  it('empty categories defer to inference (null)', () => {
    assert.equal(parseCategory([]), null)
  })
})

describe('shouldSkip — standing specials are not events', () => {
  it('skips Happy Hour', () => {
    assert.equal(shouldSkip(HAPPY_HOUR.title), true)
  })
  it('keeps a live-music act', () => {
    assert.equal(shouldSkip(LIVE_MUSIC.title), false)
  })
})

describe('buildSourceId', () => {
  it('is per-occurrence so a repeated performer/id stays distinct by date', () => {
    assert.equal(buildSourceId(LIVE_MUSIC), '7079-2026-07-25')
    assert.notEqual(
      buildSourceId(LIVE_MUSIC),
      buildSourceId({ ...LIVE_MUSIC, start_date: '2026-08-22 19:00:00' }),
    )
  })
})

describe('parseImage', () => {
  it('uses the feed image object url', () => {
    assert.equal(parseImage(LIVE_MUSIC.image), LIVE_MUSIC.image.url)
  })
  it('returns null when image is false and no inline img', () => {
    assert.equal(parseImage(false, '<p>no image</p>'), null)
  })
})

describe('module contract', () => {
  it('exports the source key', () => {
    assert.equal(SOURCE_KEY, 'beaus_on_the_river')
  })
})
