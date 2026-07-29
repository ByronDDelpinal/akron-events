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

const { cleanTitle, isProductRelease, inferYear, parseService, isIngestableService, buildTags, ingestOutcome, SOURCE_KEY } =
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

// The alarm. events_found counts SERVICE PAGES, not events, so a run that
// discovered 6 services and ingested nothing still logged status='success'.
// events_inserted was 0 on all 22 runs since 2026-06-24 and nobody saw it.
describe('ingestOutcome', () => {
  it('reports no-services when the homepage yields no /service-page/ links', () => {
    const o = ingestOutcome({ servicesFound: 0, servicesIngestable: 0, sessionsUpserted: 0 })
    assert.equal(o.kind, 'no-services')
  })

  it('names both suspects (restructure, late Wix hydration) in the no-services message', () => {
    const { message } = ingestOutcome({ servicesFound: 0 })
    assert.match(message, /restructur/i)
    assert.match(message, /wix/i)
    assert.match(message, /hydrat/i)
    assert.match(message, /networkidle2/)
  })

  it('reports no-ingestable when services exist but none pass the filter', () => {
    const o = ingestOutcome({ servicesFound: 6, servicesIngestable: 0, sessionsUpserted: 0 })
    assert.equal(o.kind, 'no-ingestable')
    assert.match(o.message, /\b6\b/)                        // carries the count it saw
    assert.match(o.message, /drift|stopped running/i)       // names both suspects
  })

  it('reports zero-yield when ingestable services produced no surviving session', () => {
    const o = ingestOutcome({ servicesFound: 6, servicesIngestable: 2, sessionsUpserted: 0 })
    assert.equal(o.kind, 'zero-yield')
    assert.match(o.message, /\b2\b/)
    assert.match(o.message, /\b6\b/)
  })

  it('reports ok on a healthy run', () => {
    assert.equal(ingestOutcome({ servicesFound: 6, servicesIngestable: 2, sessionsUpserted: 11 }).kind, 'ok')
  })

  // Every parameter defaults to 0, so a forgotten argument can never read as
  // healthy — that "silent success" is the whole bug this guard exists for.
  it('never falls through to ok when called with no counts', () => {
    assert.equal(ingestOutcome().kind, 'no-services')
    assert.equal(ingestOutcome({}).kind, 'no-services')
    assert.notEqual(ingestOutcome().kind, 'ok')
    assert.notEqual(ingestOutcome({}).kind, 'ok')
  })

  it('does not report ok when only some counts are supplied', () => {
    assert.equal(ingestOutcome({ servicesFound: 6 }).kind, 'no-ingestable')
    assert.equal(ingestOutcome({ servicesFound: 6, servicesIngestable: 2 }).kind, 'zero-yield')
    assert.equal(ingestOutcome({ sessionsUpserted: 11 }).kind, 'no-services')
  })

  it('returns a message for every non-ok kind and none for ok', () => {
    for (const args of [{}, { servicesFound: 6 }, { servicesFound: 6, servicesIngestable: 2 }]) {
      const o = ingestOutcome(args)
      assert.notEqual(o.kind, 'ok')
      assert.equal(typeof o.message, 'string')
      assert.ok(o.message.length > 0)
    }
    assert.equal(ingestOutcome({ servicesFound: 1, servicesIngestable: 1, sessionsUpserted: 1 }).message, undefined)
  })
})
