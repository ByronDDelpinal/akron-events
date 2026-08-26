/**
 * test-community-legal-aid.js
 *
 * Unit tests for the Community Legal Aid scraper's pure parsers. The load-bearing
 * logic is (1) the messy time-string parser, (2) location→city extraction, and
 * (3) the strict Summit gate — this regional legal-aid org runs mostly out-of-
 * county and Online clinics; only Akron/Stow/Twinsburg (Summit) events publish.
 *
 * Fixture: real /events list markup captured 2026-08-24.
 *
 * Run:  node --test scripts/tests/test-community-legal-aid.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  parseDate,
  parseStartTime,
  parseLocation,
  parseEventsHtml,
  buildRow,
  SOURCE_KEY,
} from '../scrape-community-legal-aid.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = readFileSync(resolve(__dirname, 'fixtures/community-legal-aid.html'), 'utf8')

describe('SOURCE_KEY', () => {
  it('is community_legal_aid', () => assert.equal(SOURCE_KEY, 'community_legal_aid'))
})

describe('parseDate', () => {
  it('parses "Aug 25, 2026"', () => assert.equal(parseDate('Aug 25, 2026'), '2026-08-25'))
  it('parses "Sep 01, 2026"', () => assert.equal(parseDate('Sep 01, 2026'), '2026-09-01'))
  it('returns null for junk', () => assert.equal(parseDate('someday'), null))
})

describe('parseStartTime', () => {
  it('"9 a.m. to noon" → 9:00 am', () => assert.equal(parseStartTime('9 a.m. to noon'), '9:00 am'))
  it('"11:00 AM"', () => assert.equal(parseStartTime('11:00 AM'), '11:00 am'))
  it('"1:00 - 4:00 PM" inherits pm', () => assert.equal(parseStartTime('1:00 - 4:00 PM'), '1:00 pm'))
  it('"9:00 AM - 12:00 PM"', () => assert.equal(parseStartTime('9:00 AM - 12:00 PM'), '9:00 am'))
  it('"7:45 to 9 a.m." inherits am', () => assert.equal(parseStartTime('7:45 to 9 a.m.'), '7:45 am'))
  it('"10 a.m. to 4 p.m."', () => assert.equal(parseStartTime('10 a.m. to 4 p.m.'), '10:00 am'))
  it('"6:00 PM"', () => assert.equal(parseStartTime('6:00 PM'), '6:00 pm'))
  it('does not flip a real evening range ("6 - 8 pm")', () => assert.equal(parseStartTime('6 - 8 pm'), '6:00 pm'))
  it('returns null for no time', () => assert.equal(parseStartTime('TBD'), null))
})

describe('parseLocation', () => {
  it('extracts the city from "Venue, Street, City"', () => {
    assert.deepEqual(parseLocation('Family Matters Resource Center, 425 E. Market St., Alliance'),
      { online: false, name: 'Family Matters Resource Center', address: '425 E. Market St.', city: 'Alliance', state: 'OH', zip: null })
  })
  it('strips a trailing "Ohio 44224" segment', () => {
    const l = parseLocation('Stow Municipal Court, 4400 Courthouse Blvd., Stow, Ohio 44224')
    assert.equal(l.city, 'Stow')
    assert.equal(l.name, 'Stow Municipal Court')
    assert.equal(l.address, '4400 Courthouse Blvd.')
  })
  it('flags Online as virtual', () => assert.deepEqual(parseLocation('Online'), { online: true }))
})

describe('parseEventsHtml (real fixture)', () => {
  const items = parseEventsHtml(FIXTURE)
  it('parses all seven event blocks', () => assert.equal(items.length, 7))
  it('reads title/date/time/location/href per item', () => {
    const stow = items.find((i) => /Stow Municipal Court/.test(i.title))
    assert.equal(stow.dateStr, '2026-09-16')
    assert.equal(stow.startTime, '9:00 am')
    assert.equal(stow.location.city, 'Stow')
    assert.match(stow.href, /stow-municipal-court/)
  })
})

describe('buildRow — the Summit gate', () => {
  const items = parseEventsHtml(FIXTURE)
  const byTitle = (re) => buildRow(items.find((i) => re.test(i.title)))

  it('publishes the three Summit-County events (Stow, Twinsburg, Akron)', () => {
    assert.ok(byTitle(/Stow Municipal Court/).row)
    assert.ok(byTitle(/Twinsburg/).row)
    assert.ok(byTitle(/Rise for Justice/).row)
  })

  it('drops out-of-county events (Alliance, Canton, Ravenna)', () => {
    assert.equal(byTitle(/Family Matters/).skip, 'out')
    assert.equal(byTitle(/Canton for All People/).skip, 'out')
    assert.equal(byTitle(/Credit card lawsuits/).skip, 'out')
  })

  it('drops Online clinics', () => {
    assert.equal(byTitle(/Parent's rights/).skip, 'online')
  })

  it('builds a complete Summit row with correct UTC time, free price, civic category', () => {
    const { row, venueSpec } = byTitle(/Stow Municipal Court/)
    // 9:00 AM EDT (UTC-4) → 13:00Z
    assert.equal(row.start_at, '2026-09-16T13:00:00.000Z')
    assert.equal(row.source, 'community_legal_aid')
    assert.equal(row.source_id, 'events-expungement-and-record-sealing-stow-municipal-court-2026-09-16')
    assert.equal(row.category, 'civic')
    assert.equal(row.price_min, 0)
    assert.equal(row.featured, false)
    assert.equal(venueSpec.name, 'Stow Municipal Court')
    assert.equal(venueSpec.city, 'Stow')
  })
})
