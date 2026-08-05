/**
 * test-village-of-mogadore.js — real parse path for the Village of Mogadore
 * scraper (Tribe / The Events Calendar iCal feed).
 *
 * The fixture (fixtures/village-of-mogadore.ics) is a verbatim capture of the
 * live feed (https://mogadorevillage.org/events/list/?ical=1&eventDisplay=past),
 * so these assertions exercise the actual runIcsScraper primitives — parseIcs +
 * normaliseIcsEvent — plus the scraper's own pure helpers (parseTribeLocation,
 * the Summit gate, the governance filter).
 *
 * Run:  node --test scripts/tests/test-village-of-mogadore.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseIcs, normaliseIcsEvent } = await import('../lib/ics.js')
const {
  parseTribeLocation,
  eventCity,
  isInSummitCounty,
  isGovernanceMeeting,
  includeEvent,
  mapCategory,
  SOURCE_KEY,
} = await import('../scrape-village-of-mogadore.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = readFileSync(resolve(__dirname, 'fixtures/village-of-mogadore.ics'), 'utf8')
const EVENTS = parseIcs(FIXTURE)
const bySummary = (s) => EVENTS.find((e) => e.SUMMARY === s)

describe('fixture parses as a valid Tribe VCALENDAR', () => {
  it('extracts all 10 VEVENTs', () => {
    assert.equal(EVENTS.length, 10)
  })
  it('parses TZID-qualified DTSTART/URL/LOCATION', () => {
    const fw = bySummary('Fireworks')
    assert.equal(fw.DTSTART.params.TZID, 'America/New_York')
    assert.equal(fw.URL, 'https://mogadorevillage.org/event/fireworks-3/')
    assert.equal(fw.LOCATION, 'Lions Park, 158 Hale St, Mogadore, OH, 44260, United States')
  })
})

describe('parseTribeLocation', () => {
  it('splits a venue name + street + city/state/zip/country', () => {
    const r = parseTribeLocation('Lions Park, 158 Hale St, Mogadore, OH, 44260, United States')
    assert.equal(r.name, 'Lions Park')
    assert.deepEqual(r.details, { address: '158 Hale St', city: 'Mogadore', state: 'OH', zip: '44260' })
  })
  it('handles a name with no separate street', () => {
    const r = parseTribeLocation('Village of Mogadore, Mogadore, OH, 44260, United States')
    assert.equal(r.name, 'Village of Mogadore')
    assert.equal(r.details.address, null)
    assert.equal(r.details.city, 'Mogadore')
  })
  it('returns null for a bare state ("OH") — caller falls back to default venue', () => {
    assert.equal(parseTribeLocation('OH'), null)
  })
  it('returns null for empty input', () => {
    assert.equal(parseTribeLocation(''), null)
    assert.equal(parseTribeLocation(null), null)
  })
})

describe('Summit County gate', () => {
  it('keeps Mogadore (on the Summit allowlist)', () => {
    assert.equal(eventCity(bySummary('Fireworks')), 'Mogadore')
    assert.equal(isInSummitCounty(bySummary('Fireworks')), true)
  })
  it('defaults a city-less "LOCATION:OH" row to Mogadore → in-county', () => {
    const tot = bySummary('TRICK OR TREAT')
    assert.equal(tot.LOCATION, 'OH')
    assert.equal(eventCity(tot), 'Mogadore')
    assert.equal(isInSummitCounty(tot), true)
  })
  it('drops a Portage-side city (Kent)', () => {
    const kent = { LOCATION: 'Kent Stage, 175 E Main St, Kent, OH, 44240, United States' }
    assert.equal(eventCity(kent), 'Kent')
    assert.equal(isInSummitCounty(kent), false)
    assert.equal(includeEvent(kent), false)
  })
})

describe('governance filter + includeEvent', () => {
  it('drops the Council Meeting', () => {
    const cm = bySummary('Council Meeting')
    assert.equal(isGovernanceMeeting(cm), true)
    assert.equal(includeEvent(cm), false)
  })
  it('keeps community events (parade, festival, bazaar, luncheon)', () => {
    for (const s of ['Parade', 'Mogadore Summer Festival', 'HOLIDAY BAZAAR', 'Soup & Sandwich Luncheon']) {
      assert.equal(includeEvent(bySummary(s)), true, `${s} should be kept`)
    }
  })
  it('keeps exactly 9 of the 10 fixture events', () => {
    assert.equal(EVENTS.filter(includeEvent).length, 9)
  })
})

describe('normaliseIcsEvent — real parse path', () => {
  it('converts an EDT evening start to the right UTC instant', () => {
    const row = normaliseIcsEvent(bySummary('Fireworks'), { source: SOURCE_KEY, mapCategory })
    assert.equal(row.title, 'Fireworks')
    // 2026-07-17 21:30 America/New_York (EDT, UTC-4) → 2026-07-18T01:30:00Z
    assert.equal(row.start_at, '2026-07-18T01:30:00.000Z')
    assert.equal(row.ticket_url, 'https://mogadorevillage.org/event/fireworks-3/')
    assert.equal(row.source, 'village_of_mogadore')
    assert.equal(row.category, 'festival')
  })
  it('converts a morning start (Memorial Day parade)', () => {
    const row = normaliseIcsEvent(bySummary('MEMORIAL DAY PARADE/CEMETERY CEREMONY'), { source: SOURCE_KEY })
    // 2026-05-25 10:00 EDT → 2026-05-25T14:00:00Z
    assert.equal(row.start_at, '2026-05-25T14:00:00.000Z')
  })
})

describe('SOURCE_KEY', () => {
  it('is village_of_mogadore', () => assert.equal(SOURCE_KEY, 'village_of_mogadore'))
})
