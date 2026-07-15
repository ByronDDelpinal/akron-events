/**
 * test-peninsula-coffee-house.js — pure helpers for the Peninsula Coffee House
 * Tribe scraper. Fixtures reflect the REAL feed shape captured 2026-07-14:
 * the install's timezone is misconfigured to "UTC+0" so `start_date` holds the
 * true Eastern wall-clock time, entity-encoded titles, live-music/karaoke/
 * trivia/yoga categories, and an event whose image is `false`.
 *
 * Run:  node --test scripts/tests/test-peninsula-coffee-house.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { toEasternIso, parseCategory, buildSourceId, parseImage, SOURCE_KEY } =
  await import('../scrape-peninsula-coffee-house.js')

// Captured 2026-07-14 (trimmed)
const TRIVIA = {
  id: 650, title: 'Music Decades Trivia @ Peninsula Wine Cellar!',
  start_date: '2026-07-16 18:00:00', end_date: '2026-07-16 20:00:00',
  utc_start_date: '2026-07-16 18:00:00', timezone: 'UTC+0', all_day: false,
  categories: [{ name: 'Trivia Night', slug: 'trivia-night' }],
}
const LIVE_MUSIC = {
  id: 654, title: 'Live Music with Tim Pajk',
  start_date: '2026-07-18 17:00:00', end_date: '2026-07-18 19:00:00', all_day: false,
  categories: [{ name: 'Live Music', slug: 'live-music' }],
}
const YOGA = {
  id: 652, title: 'Deck Yoga @ Peninsula Coffee House!',
  start_date: '2026-07-18 08:00:00', all_day: false,
  categories: [{ name: 'Yoga', slug: 'yoga' }],
}
const KARAOKE = {
  id: 640, title: 'Karaoke Night', start_date: '2026-07-23 18:00:00', all_day: false,
  categories: [], image: false,
}

describe('toEasternIso — misconfigured "UTC+0" feed holds Eastern wall-clock', () => {
  it('treats 18:00 local as 18:00 Eastern (EDT → 22:00 UTC), NOT a raw-Z UTC', () => {
    // Regression guard: appending Z would give 18:00Z; correct is 22:00Z.
    assert.equal(toEasternIso(TRIVIA.start_date), '2026-07-16T22:00:00.000Z')
  })
  it('converts a morning yoga time (08:00 EDT → 12:00 UTC)', () => {
    assert.equal(toEasternIso(YOGA.start_date), '2026-07-18T12:00:00.000Z')
  })
  it('returns null for a missing time', () => {
    assert.equal(toEasternIso(undefined), null)
  })
})

describe('parseCategory', () => {
  it('live music maps to music', () => {
    assert.equal(parseCategory(LIVE_MUSIC.categories), 'music')
  })
  it('trivia maps to games', () => {
    assert.equal(parseCategory(TRIVIA.categories), 'games')
  })
  it('yoga maps to fitness', () => {
    assert.equal(parseCategory(YOGA.categories), 'fitness')
  })
  it('empty categories defer to inference (null)', () => {
    assert.equal(parseCategory(KARAOKE.categories), null)
  })
})

describe('buildSourceId', () => {
  it('is per-occurrence so weekly series with reused ids stay distinct', () => {
    assert.equal(buildSourceId(LIVE_MUSIC), '654-2026-07-18')
    assert.notEqual(
      buildSourceId(LIVE_MUSIC),
      buildSourceId({ ...LIVE_MUSIC, start_date: '2026-07-25 17:00:00' }),
    )
  })
})

describe('parseImage', () => {
  it('handles a feed image object', () => {
    assert.equal(parseImage({ url: 'https://x/livemusic.jpg' }), 'https://x/livemusic.jpg')
  })
  it('handles image === false (Karaoke) → null when no inline img', () => {
    assert.equal(parseImage(KARAOKE.image, '<p>no image</p>'), null)
  })
})

describe('module contract', () => {
  it('exports the source key', () => {
    assert.equal(SOURCE_KEY, 'peninsula_coffee_house')
  })
})
