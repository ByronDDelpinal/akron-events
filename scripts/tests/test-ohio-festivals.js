/**
 * test-ohio-festivals.js — pure parsers for the Ohio Festivals scraper.
 * Fixtures are real lines from ohiofestivals.net/ohio-festivals/ (en-dash
 * separated: "M/D[-M/D][*] – Name – City [– My Review]").
 *
 * Run:  node --test scripts/tests/test-ohio-festivals.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseFestivalLine, parseFestivals, buildYmd, SOURCE_KEY } =
  await import('../scrape-ohio-festivals.js')
const { isSummitCountyLocation } = await import('../lib/summit-county.js')

const NOW = new Date('2026-06-19T12:00:00Z')  // month = June (6)

describe('buildYmd', () => {
  it('keeps this year for current/future months, rolls earlier months to next year', () => {
    assert.equal(buildYmd(7, 10, NOW), '2026-07-10')   // July ≥ June
    assert.equal(buildYmd(6, 25, NOW), '2026-06-25')   // June = June
    assert.equal(buildYmd(1, 15, NOW), '2027-01-15')   // January < June → next year
  })
})

describe('parseFestivalLine', () => {
  it('parses a date range + name + city + "My Review"', () => {
    const f = parseFestivalLine('7/10-7/11 – Summit County Italian American Festival – Akron – My Review', NOW)
    assert.equal(f.name, 'Summit County Italian American Festival')
    assert.equal(f.city, 'Akron')
    assert.equal(f.startYmd, '2026-07-10')
    assert.equal(f.endYmd, '2026-07-11')
    assert.equal(f.unconfirmed, false)
  })
  it('parses a single date and flags an unconfirmed (*) date', () => {
    const f = parseFestivalLine('7/18* – Halfway to Christmas – Akron', NOW)
    assert.equal(f.name, 'Halfway to Christmas')
    assert.equal(f.startYmd, '2026-07-18')
    assert.equal(f.endYmd, null)
    assert.equal(f.unconfirmed, true)
  })
  it('returns null for non-festival lines', () => {
    assert.equal(parseFestivalLine('2026 Ohio Festival Guide'), null)
    assert.equal(parseFestivalLine(''), null)
  })
})

describe('parseFestivals + Summit County gate', () => {
  const text = [
    '6/30-7/4 – Ashville 4th of July Celebration – Ashville',           // not Summit
    '7/10-7/11 – Summit County Italian American Festival – Akron',      // Summit
    '7/11 – The Fairlawn Fest – Fairlawn',                              // Summit
    '7/5 – Peninsula Flea at Heritage Farms III – Peninsula',           // Summit
    '7/11-7/12 – Barnstorming Carnival – Springfield',                  // Clark County — excluded
  ].join('\n')

  const all = parseFestivals(text, NOW)
  const summit = all.filter((f) => isSummitCountyLocation({ city: f.city }))

  it('parses every line, then the gate keeps only Summit County cities', () => {
    assert.equal(all.length, 5)
    assert.deepEqual(summit.map((f) => f.city).sort(), ['Akron', 'Fairlawn', 'Peninsula'])
    assert.ok(!summit.some((f) => f.city === 'Springfield'))   // Clark County dropped
    assert.ok(!summit.some((f) => f.city === 'Ashville'))
  })
})

describe('SOURCE_KEY', () => {
  it('is ohio_festivals', () => assert.equal(SOURCE_KEY, 'ohio_festivals'))
})
