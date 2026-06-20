/**
 * test-gather-round-games.js — pure parsers for the Gather Round Games scraper
 * (grgcollect.com Wix Bookings). Fixtures are the real rendered page text
 * captured from the live service pages. Puppeteer render is an integration
 * concern and isn't unit-tested.
 *
 * Run:  node --test scripts/tests/test-gather-round-games.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { cleanTitle, isProductRelease, inferYear, parseService, isIngestableService, buildTags, SOURCE_KEY } =
  await import('../scrape-gather-round-games.js')

// Real rendered text from grgcollect.com/service-page/friday-night-magic-2
// (+ a synthetic Jan session to exercise the cross-year inference).
const FNM = {
  title: 'Friday Night Magic | Gather Round Games',
  text: [
    'This course can no longer be booked.', 'Friday Night Magic', 'Standard Draft',
    'Started Jun 5', '20 US dollars', '$20', 'Ghent Road',
    'Service Description',
    'Join us for a draft of the latest set in a casual, beginner friendly format!',
    'Upcoming Sessions',
    'Dates: Jun 5, 2026 - Jan 1, 2027', '15 / 16 sessions left',
    'Time Zone: Eastern Daylight Time (EDT)',
    'Friday, Jun 19', '7:00 PM', '4 hr', '4 hours', 'Business Owner',
    'Friday, Jul 3', '7:00 PM', '4 hr', '4 hours', 'Business Owner',
    'Friday, Jan 1', '7:00 PM', '4 hr', '4 hours', 'Business Owner',
    'Contact Details', '121 Ghent Rd, Fairlawn, OH 44333, USA',
  ].join('\n'),
}

// Real rendered text from grgcollect.com/service-page/trade-night-june-13th
const TRADE = {
  title: 'Trade Night (June 13th) | Gather Round Games',
  text: [
    'Trade Night (June 13th)', 'Come join the Pokemon Community and trade!',
    'Started May 9', 'Ghent Road',
    'Service Description', 'A night of fun trading, pizza, and prizes!',
    'Upcoming Sessions', 'Dates: May 9, 2026 - Dec 26, 2026', '20 / 25 sessions left',
    'Saturday, Jun 20', '5:00 PM', '3 hr', '3 hours', 'Business Owner',
    'Saturday, Jun 27', '5:00 PM', '2 hr', '2 hours', 'Business Owner',
    'Contact Details', '121 Ghent Rd, Fairlawn, OH 44333, USA',
  ].join('\n'),
}

// A one-time product-release service (single session).
const PRERELEASE = {
  title: 'Marvel Two headed Giant Prerelease | Gather Round Games',
  text: [
    'Marvel Two headed Giant Prerelease', '40 US dollars', '$40',
    'Service Description', 'Crack packs and battle!', 'Upcoming Sessions',
    'Dates: Jul 11, 2026 - Jul 11, 2026', '8 / 8 sessions left',
    'Saturday, Jul 11', '12:00 PM', '4 hr', '4 hours', 'Business Owner',
    'Contact Details',
  ].join('\n'),
}

describe('cleanTitle', () => {
  it('strips the store suffix and trailing "(date)" note', () => {
    assert.equal(cleanTitle('Trade Night (June 13th) | Gather Round Games'), 'Trade Night')
    assert.equal(cleanTitle('Friday Night Magic | Gather Round Games'), 'Friday Night Magic')
  })
})

describe('isProductRelease', () => {
  it('flags set-launch / release titles', () => {
    assert.equal(isProductRelease('Marvel Two headed Giant Prerelease'), true)
    assert.equal(isProductRelease('The Hobbit Commander Party'), true)
    assert.equal(isProductRelease('Marvel Super Heroes Booster Draft'), true)
    assert.equal(isProductRelease('The Hobbit Prerelease Draft'), true)
  })
  it('does not flag recurring community nights', () => {
    assert.equal(isProductRelease('Friday Night Magic'), false)
    assert.equal(isProductRelease('Trade Night'), false)
  })
})

describe('inferYear', () => {
  it('rolls months before the range-start month into the end year', () => {
    assert.equal(inferYear(6, 6, 2026, 2027), 2026)   // Jun
    assert.equal(inferYear(1, 6, 2026, 2027), 2027)   // Jan → next year
    assert.equal(inferYear(5, 5, 2026, 2026), 2026)   // single-year range
  })
})

describe('parseService', () => {
  it('parses Friday Night Magic (price, description, sessions w/ cross-year)', () => {
    const s = parseService(FNM)
    assert.equal(s.title, 'Friday Night Magic')
    assert.equal(s.priceMin, 20)
    assert.match(s.description, /draft of the latest set/)
    assert.deepEqual(s.sessions[0], { dateYmd: '2026-06-19', time: '7:00 PM' })
    assert.ok(s.sessions.some((x) => x.dateYmd === '2027-01-01'))   // Jan → 2027
  })
  it('parses Trade Night (free → null price)', () => {
    const s = parseService(TRADE)
    assert.equal(s.title, 'Trade Night')
    assert.equal(s.priceMin, null)
    assert.match(s.description, /trading, pizza, and prizes/)
    assert.deepEqual(s.sessions[0], { dateYmd: '2026-06-20', time: '5:00 PM' })
    assert.equal(s.sessions.length, 2)
  })
})

describe('isIngestableService', () => {
  it('keeps recurring community nights, drops releases + one-time events', () => {
    assert.equal(isIngestableService(parseService(FNM)), true)
    assert.equal(isIngestableService(parseService(TRADE)), true)
    assert.equal(isIngestableService(parseService(PRERELEASE)), false) // keyword + one-time
  })
})

describe('buildTags', () => {
  it('derives game + format tags', () => {
    assert.ok(buildTags('Friday Night Magic', 'draft of the latest set').includes('magic-the-gathering'))
    assert.ok(buildTags('Trade Night', 'Pokemon community trade').includes('pokemon'))
  })
})

describe('SOURCE_KEY', () => {
  it('is gather_round_games', () => assert.equal(SOURCE_KEY, 'gather_round_games'))
})
