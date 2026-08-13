/**
 * test-music-western-reserve.js
 *
 * Unit tests for the Music from The Western Reserve scraper's pure parsers. The
 * load-bearing logic is (1) flattening the fragmented Wix homepage markup into
 * concert lines and parsing month/day/program, and (2) resolving each concert's
 * year within a two-calendar-year season (Sep–Dec → start year, Jan–Aug → +1).
 *
 * Fixture: verbatim markup captured from musicwr.org on 2026-08-12.
 *
 * Run:  node --test scripts/tests/test-music-western-reserve.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  seasonStartYear,
  concertYear,
  parseConcerts,
  buildRow,
  SOURCE_KEY,
} from '../scrape-music-western-reserve.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = readFileSync(resolve(__dirname, 'fixtures/music-western-reserve.html'), 'utf8')

const NOW = new Date('2026-08-12T12:00:00Z')

describe('SOURCE_KEY', () => {
  it('is music_western_reserve', () => assert.equal(SOURCE_KEY, 'music_western_reserve'))
})

describe('seasonStartYear', () => {
  it('reads the start year from a 4-digit "2026–2027" range', () => {
    assert.equal(seasonStartYear('our 2026–2027 concert season'), 2026)
  })
  it('reads the start year from a "26/27 Season" short form', () => {
    assert.equal(seasonStartYear('26/27 Season Schedule'), 2026)
  })
  it('returns null when no season year is present', () => {
    assert.equal(seasonStartYear('welcome to the concert series'), null)
  })
  it('finds the season year in the real fixture', () => {
    assert.equal(seasonStartYear(FIXTURE), 2026)
  })
})

describe('concertYear (two-year season)', () => {
  it('maps Sep–Dec to the start year', () => {
    assert.equal(concertYear(9, 2026), 2026)
    assert.equal(concertYear(12, 2026), 2026)
  })
  it('maps Jan–Aug to the following year', () => {
    assert.equal(concertYear(1, 2026), 2027)
    assert.equal(concertYear(4, 2026), 2027)
  })
})

describe('parseConcerts (real fixture)', () => {
  const concerts = parseConcerts(FIXTURE)

  it('parses all six concerts from the fragmented Wix markup', () => {
    assert.equal(concerts.length, 6)
  })

  it('extracts month, day, and program for each', () => {
    assert.deepEqual(concerts[0], { month: 9, day: 27, program: 'Irwin shung, piano' })
    assert.deepEqual(concerts[1], { month: 10, day: 25, program: 'Harnsberger/jones marimba duo' })
    assert.deepEqual(concerts[2], { month: 11, day: 8, program: 'Callisto Quartet' })
    assert.deepEqual(concerts[3], { month: 2, day: 28, program: 'An evening of chamber music' })
    assert.deepEqual(concerts[4], { month: 3, day: 21, program: 'CLE Concierto' })
    assert.deepEqual(concerts[5], { month: 4, day: 25, program: 'Oberlin Musical Theatre cabaret' })
  })
})

describe('buildRow', () => {
  it('builds a fall concert (2026) with the correct 5pm ET → UTC start', () => {
    const { row, venueSpec } = buildRow({ month: 9, day: 27, program: 'Irwin shung, piano' }, 2026, NOW)
    // 5:00 PM EDT (UTC-4) → 21:00Z
    assert.equal(row.start_at, '2026-09-27T21:00:00.000Z')
    assert.equal(row.title, 'Irwin shung, piano')
    assert.equal(row.source, 'music_western_reserve')
    assert.equal(row.source_id, 'mwr-2026-09-27')
    assert.equal(row.category, 'music')
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, 0)
    assert.equal(row.status, 'published')
    assert.equal(row.featured, false)
    assert.equal(row.ticket_url, 'https://www.musicwr.org/tickets')
    assert.equal(venueSpec.name, 'Christ Church Episcopal')
    assert.equal(venueSpec.city, 'Hudson')
  })

  it('rolls a spring concert into the following year (2027) with EST offset', () => {
    const { row } = buildRow({ month: 2, day: 28, program: 'An evening of chamber music' }, 2026, NOW)
    // 5:00 PM EST (UTC-5) → 22:00Z
    assert.equal(row.start_at, '2027-02-28T22:00:00.000Z')
    assert.equal(row.source_id, 'mwr-2027-02-28')
  })

  it('returns null for an incomplete concert', () => {
    assert.equal(buildRow({ month: 9, day: null, program: 'x' }, 2026, NOW), null)
    assert.equal(buildRow(null, 2026, NOW), null)
  })
})

describe('parseConcerts → buildRow (integration, fixture)', () => {
  it('produces six dated concerts spanning the two season years', () => {
    const rows = parseConcerts(FIXTURE).map((c) => buildRow(c, 2026, NOW)).filter(Boolean)
    assert.equal(rows.length, 6)
    const ids = rows.map((r) => r.row.source_id)
    assert.deepEqual(ids, [
      'mwr-2026-09-27', 'mwr-2026-10-25', 'mwr-2026-11-08',
      'mwr-2027-02-28', 'mwr-2027-03-21', 'mwr-2027-04-25',
    ])
  })
})
