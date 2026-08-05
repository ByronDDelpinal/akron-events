/**
 * test-city-of-macedonia.js
 *
 * Pins the source-specific behavior of the Macedonia (macrec.com) govAccess
 * calendar-grid scraper against a fixture captured from the live August 2026
 * grid (2026-08-05) as the RAW <td> HTML the production `res.text()` receives —
 * NOT WebFetch's markdown reduction, which strips the calendar_eventtime /
 * calendar_eventlink hooks the parser depends on:
 *   • parseCalendarMonth — pulls day/time/title/id from each
 *     td.calendar_day > div.calendar_item > span.calendar_eventtime +
 *     a.calendar_eventlink[href=…/Event/{id}/{n}]. The day comes from the cell's
 *     leading number; month & year are supplied by the caller (the page it
 *     fetched), so dating no longer depends on the link's ?curm/&cury query.
 *   • isPublicMacedoniaEvent — drops Mayor's Court, Planning Commission, and
 *     Board of Zoning Appeals rows; keeps public programming (Touch-a-Truck,
 *     Food Truck Thursdays).
 *   • buildEventRow — correct ET timestamps (no accidental midnights for timed
 *     events), stable source_id, and reconstructed detail URL.
 *   • monthsToFetch — ET-anchored month window.
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
  SOURCE_KEY, parseCalendarMonth, monthsToFetch,
  isPublicMacedoniaEvent, buildEventRow, mapCategory, resolveVenue,
} = await import('../scrape-city-of-macedonia.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = readFileSync(join(__dirname, 'fixtures/city-of-macedonia-calendar.html'), 'utf8')
const RECS = parseCalendarMonth(FIXTURE, { month: 8, year: 2026 })
const byId = Object.fromEntries(RECS.map(r => [r.eventId, r]))

describe('city_of_macedonia: source key', () => {
  it('is city_of_macedonia', () => {
    assert.equal(SOURCE_KEY, 'city_of_macedonia')
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

describe('city_of_macedonia: parseCalendarMonth (real raw August 2026 grid)', () => {
  it('extracts every calendar item, including two-event days', () => {
    // 8 event links across the month: four Mayor's Court sessions, a Planning
    // Commission and a BZA meeting, plus Touch-a-Truck and Food Truck Thursdays.
    assert.equal(RECS.length, 8)
    // Aug 6 carries both a Mayor's Court session and Touch-a-Truck.
    const aug6 = RECS.filter(r => r.date === '2026-08-06').map(r => r.title).sort()
    assert.deepEqual(aug6, ['Mayor\'s Court', 'Touch-a-Truck'])
    // Aug 27 carries Mayor's Court and Food Truck Thursdays.
    const aug27 = RECS.filter(r => r.date === '2026-08-27').map(r => r.title).sort()
    assert.deepEqual(aug27, ['Food Truck Thursdays', 'Mayor\'s Court'])
  })

  it('reads the time, reconstructs a clean detail URL, and dates from the fetched month/year', () => {
    const ttt = byId['3924'] // Touch-a-Truck
    assert.equal(ttt.title, 'Touch-a-Truck')
    assert.equal(ttt.timeText, '5:30 PM')
    assert.equal(ttt.date, '2026-08-06')
    assert.equal(ttt.detailUrl, 'https://www.macrec.com/Home/Components/Calendar/Event/3924/74')

    const ftt = byId['3914'] // Food Truck Thursdays
    assert.equal(ftt.title, 'Food Truck Thursdays')
    assert.equal(ftt.timeText, '5:00 PM')
    assert.equal(ftt.date, '2026-08-27')
  })

  it('captures the interleaved civic meetings too (filtering happens later)', () => {
    assert.equal(byId['3842'].title, 'Planning Commission Meeting')
    assert.equal(byId['3864'].title, 'Board of Zoning Appeals (BZA) Meeting')
    // Every Mayor's Court session is present pre-filter.
    const courts = RECS.filter(r => r.title === 'Mayor\'s Court')
    assert.equal(courts.length, 4)
  })

  it('returns [] for empty input or a missing month/year', () => {
    assert.deepEqual(parseCalendarMonth('', { month: 8, year: 2026 }), [])
    assert.deepEqual(parseCalendarMonth('<td class="calendar_day">6</td>', { month: 8, year: 2026 }), [])
    assert.deepEqual(parseCalendarMonth(FIXTURE), []) // no month/year → nothing datable
  })
})

describe('city_of_macedonia: isPublicMacedoniaEvent filter', () => {
  it('drops government / court / commission / board rows from the real grid', () => {
    for (const s of [
      'Mayor\'s Court',
      'Planning Commission Meeting',
      'Board of Zoning Appeals (BZA) Meeting',
    ]) assert.equal(isPublicMacedoniaEvent(s), false, `should drop: ${s}`)
  })

  it('keeps the public rec / community programming from the real grid', () => {
    for (const s of [
      'Touch-a-Truck',
      'Food Truck Thursdays',
    ]) assert.equal(isPublicMacedoniaEvent(s), true, `should keep: ${s}`)
  })

  it('drops a Mayor\'s Court row even when HTML-entity-encoded', () => {
    assert.equal(isPublicMacedoniaEvent('Mayor&#39;s Court'), false)
  })

  it('over the whole parsed month, keeps only the two public events', () => {
    const kept = RECS.filter(r => isPublicMacedoniaEvent(r.title)).map(r => r.title).sort()
    assert.deepEqual(kept, ['Food Truck Thursdays', 'Touch-a-Truck'])
  })
})

describe('city_of_macedonia: buildEventRow', () => {
  it('builds a correct ET timestamp for a timed evening event (no midnight)', () => {
    const row = buildEventRow(byId['3924']) // Touch-a-Truck, 5:30 PM
    // 5:30 PM ET on 2026-08-06 (EDT, UTC-4) → 21:30Z.
    assert.equal(row.start_at, '2026-08-06T21:30:00.000Z')
    assert.equal(row.source_id, '3924')
    assert.equal(row.status, 'published')
    assert.equal(row.needs_review, undefined) // has a real time → not flagged
    assert.equal(row.price_min, null)
    assert.equal(row.price_max, null)
    assert.equal(row.ticket_url, 'https://www.macrec.com/Home/Components/Calendar/Event/3924/74')
  })

  it('builds a correct ET timestamp for Food Truck Thursdays', () => {
    const row = buildEventRow(byId['3914']) // 5:00 PM
    assert.equal(row.start_at, '2026-08-27T21:00:00.000Z')
    assert.equal(row.source_id, '3914')
  })

  it('keeps source_id stable and equal to the numeric event id', () => {
    assert.equal(buildEventRow(byId['3842']).source_id, '3842') // Planning Commission
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
    assert.equal(resolveVenue('Touch-a-Truck').name, 'Longwood Park')
    // An unknown "at ..." target also falls back rather than minting junk.
    assert.equal(resolveVenue('Yoga at the Pavilion').name, 'Longwood Park')
  })
})
