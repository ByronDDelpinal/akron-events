/**
 * test-city-of-macedonia.js
 *
 * Pins the source-specific behavior of the Macedonia (macrec.com) Vision
 * calendar-grid scraper against a fixture captured from the live site:
 *   • parseCalendarMonth — pulls date/time/title/id from real grid cells,
 *     including a two-event day and query-string hrefs.
 *   • parseAriaDate / monthsToFetch — date parsing + ET-anchored month window.
 *   • isPublicMacedoniaEvent — drops Mayor's Court, board/commission meetings,
 *     office closures, and cancelled rows; keeps public programming.
 *   • buildEventRow — correct ET timestamps (no accidental midnights for timed
 *     events), date-only + needs_review fallback for the timeless WinterFest,
 *     stable source_id, and reconstructed detail URL.
 *   • mapCategory / resolveVenue — the concert→music override, food/festival
 *     inference, and "at Longwood Manor" venue extraction.
 *
 * Run:  node --test scripts/tests/test-city-of-macedonia.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  SOURCE_KEY, parseCalendarMonth, parseAriaDate, monthsToFetch,
  isPublicMacedoniaEvent, buildEventRow, mapCategory, resolveVenue,
} = await import('../scrape-city-of-macedonia.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = readFileSync(join(__dirname, 'fixtures/city-of-macedonia-calendar.html'), 'utf8')
const RECS = parseCalendarMonth(FIXTURE)
const byId = Object.fromEntries(RECS.map(r => [r.eventId, r]))

describe('city_of_macedonia: source key', () => {
  it('is city_of_macedonia', () => {
    assert.equal(SOURCE_KEY, 'city_of_macedonia')
  })
})

describe('city_of_macedonia: parseAriaDate', () => {
  it('parses a weekday-prefixed long date', () => {
    assert.equal(parseAriaDate('Friday, July 3, 2026'), '2026-07-03')
    assert.equal(parseAriaDate('Saturday, September 26, 2026'), '2026-09-26')
    assert.equal(parseAriaDate('Wednesday, December 4, 2026'), '2026-12-04')
  })
  it('returns null for junk', () => {
    assert.equal(parseAriaDate(''), null)
    assert.equal(parseAriaDate('no date here'), null)
    assert.equal(parseAriaDate('Bogusmonth 3, 2026'), null)
  })
})

describe('city_of_macedonia: monthsToFetch', () => {
  it('anchors to the ET month and walks forward, rolling the year', () => {
    const months = monthsToFetch(new Date('2026-11-15T12:00:00Z'), 4)
    assert.deepEqual(months, [
      { month: 11, year: 2026 }, { month: 12, year: 2026 },
      { month: 1, year: 2027 },  { month: 2, year: 2027 },
    ])
  })
  it('uses ET, not UTC, at a late-evening boundary', () => {
    // 2026-06-30 23:30 ET is still June; naive UTC would read July 1.
    const months = monthsToFetch(new Date('2026-07-01T03:30:00Z'), 1)
    assert.deepEqual(months, [{ month: 6, year: 2026 }])
  })
})

describe('city_of_macedonia: parseCalendarMonth', () => {
  it('extracts every calendar item, including two-event days', () => {
    // 11 items in the fixture across 10 populated day cells.
    assert.equal(RECS.length, 11)
    // July 16 has both Mayor's Court and the Symphonic Band concert.
    const jul16 = RECS.filter(r => r.date === '2026-07-16').map(r => r.title).sort()
    assert.deepEqual(jul16, ['Mayor\'s Court', 'University Heights Symphonic Band at Longwood Manor'])
  })

  it('decodes entities, reads the time, and rebuilds a clean detail URL', () => {
    const concert = byId['4026']
    assert.equal(concert.title, 'University Heights Symphonic Band at Longwood Manor')
    assert.equal(concert.timeText, '7:00 PM')
    assert.equal(concert.date, '2026-07-16')
    assert.equal(concert.detailUrl, 'https://www.macrec.com/Home/Components/Calendar/Event/4026/74')
  })

  it('captures timeless (all-day) rows with an empty timeText', () => {
    assert.equal(byId['3932'].title, 'WinterFest')
    assert.equal(byId['3932'].timeText, '')
    assert.equal(byId['3884'].timeText, '') // office-closure row
  })
})

describe('city_of_macedonia: isPublicMacedoniaEvent filter', () => {
  it('drops government / court / closure / cancelled rows', () => {
    for (const s of [
      'Mayor\'s Court',
      'CANCELLED - Mayor\'s Court',
      'Planning Commission Meeting',
      'Board of Zoning Appeals (BZA) Meeting',
      'City of Macedonia Offices Closed for Independence Day',
    ]) assert.equal(isPublicMacedoniaEvent(s), false, `should drop: ${s}`)
  })

  it('keeps public rec / community programming', () => {
    for (const s of [
      'University Heights Symphonic Band at Longwood Manor',
      'Car Cruise',
      'Touch-a-Truck',
      'Food Truck Thursdays',
      'FallFest',
      'WinterFest',
      'Haunted Manor',
    ]) assert.equal(isPublicMacedoniaEvent(s), true, `should keep: ${s}`)
  })

  it('drops a Mayor\'s Court row even when HTML-entity-encoded', () => {
    assert.equal(isPublicMacedoniaEvent('Mayor&#39;s Court'), false)
  })
})

describe('city_of_macedonia: buildEventRow', () => {
  it('builds a correct ET timestamp for a timed evening event (no midnight)', () => {
    const row = buildEventRow(byId['4026'])
    // 7:00 PM ET on 2026-07-16 (EDT, UTC-4) → 23:00Z.
    assert.equal(row.start_at, '2026-07-16T23:00:00.000Z')
    assert.equal(row.source_id, '4026')
    assert.equal(row.status, 'published')
    assert.equal(row.needs_review, undefined) // has a real time → not flagged
    assert.equal(row.price_min, null)
    assert.equal(row.price_max, null)
    assert.equal(row.ticket_url, 'https://www.macrec.com/Home/Components/Calendar/Event/4026/74')
  })

  it('falls back to date-only (midnight ET) + needs_review for a timeless event', () => {
    const row = buildEventRow(byId['3932']) // WinterFest, no grid time
    // Date-only: midnight ET on 2026-12-04 (EST, UTC-5) → 05:00Z. NOT a
    // synthesized clock time — the time is genuinely unknown.
    assert.equal(row.start_at, '2026-12-04T05:00:00.000Z')
    assert.equal(row.needs_review, true)
    assert.equal(row.source_id, '3932')
  })

  it('keeps source_id stable and equal to the numeric event id', () => {
    assert.equal(buildEventRow(byId['3922']).source_id, '3922') // Car Cruise
  })
})

describe('city_of_macedonia: mapCategory', () => {
  it('forces the band series to music', () => {
    assert.equal(mapCategory('University Heights Symphonic Band at Longwood Manor'), 'music')
  })
  it('infers food and festival from the title', () => {
    assert.equal(mapCategory('Food Truck Thursdays'), 'food')
    assert.equal(mapCategory('FallFest'), 'festival')
    assert.equal(mapCategory('WinterFest'), 'festival')
  })
})

describe('city_of_macedonia: resolveVenue', () => {
  it('extracts a known "... at <Venue>" sub-venue', () => {
    const v = resolveVenue('University Heights Symphonic Band at Longwood Manor')
    assert.equal(v.name, 'Longwood Manor')
    assert.equal(v.details.address, '1566 East Aurora Road')
    assert.equal(v.details.city, 'Macedonia')
  })
  it('falls back to Longwood Park when no known venue is named', () => {
    assert.equal(resolveVenue('Car Cruise').name, 'Longwood Park')
    // An unknown "at ..." target also falls back rather than minting junk.
    assert.equal(resolveVenue('Yoga at the Pavilion').name, 'Longwood Park')
  })
})
