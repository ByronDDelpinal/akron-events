/**
 * test-magic-city-drivein.js — pure parsers for the Magic City Drive-In
 * scraper. The fixture reconstructs the REAL page structure captured from
 * magiccitydrive-in.com on 2026-07-08 (div/span layout with no <br>/<p>
 * between logical lines — the reason htmlToText is not used here).
 *
 * Run:  node --test scripts/tests/test-magic-city-drivein.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { htmlToLines, parseShowDates, parseBoxOffice, parseScreens, buildEvents, SOURCE_KEY } =
  await import('../scrape-magic-city-drivein.js')

const NOW = new Date('2026-07-08T12:00:00Z')

// RAW-SOURCE line layout verified against the live page 2026-07-08 by running
// htmlToLines inside the browser against fetch('/').text(): title, "Rated:",
// and "Starts:" are THREE separate lines (the rendered DOM merges the last
// two — the first version of this fixture copied the DOM and shipped a parser
// that found 0 events live).
const PAGE = `
<div>Magic City Drive-In Theater 5602 S.Cleveland Barberton, OH 44203</div>
<div>Welcome to the Magic City Drive-In Theater. Opened in 1953, now offering the finest double features.</div>
<span>Showing:</span>
<div>THURSDAY, Friday, Saturday, Sunday</div>
<div>July 9, 10, 11, 12</div>
<div>Box office opens: 8:25</div>
<div>Screen 1</div>
<img src="poster1.jpg"><div>Moana</div>
<div>Rated: PG | <a>Movie Info</a></div>
<div>Starts: 9:30</div>
<img src="poster2.jpg"><div>Toy Story 5</div>
<div>Rated: PG | <a>Movie Info</a></div>
<div>Starts: 11:40</div>
<div>Screen 2</div>
<img src="poster3.jpg"><div>Minions &amp; Monsters</div>
<div>Rated: PG | <a>Movie Info</a></div>
<div>Starts: 9:25</div>
<img src="poster4.jpg"><div>Disclosure Day</div>
<div>Rated: PG13 | <a>Movie Info</a></div>
<div>Starts: 11:10</div>
<div>We Recommend Arriving Early. Thank You!</div>
<div>We also accept: Admission & Concession</div>
<p>-Features Subject To Change Without Notice-</p>
`

// The rendered-DOM merged form (Rated + Starts on one line) must ALSO parse —
// the site template could collapse either way after a redesign.
const PAGE_MERGED_FORM = `
<div>Showing:</div><div>THURSDAY, Friday July 9, 10</div>
<div>Box office opens: 8:25</div>
<div>Screen 1</div>
<div>Moana</div><div>Rated: PG | <a>Movie Info</a> Starts: 9:30</div>
<div>Toy Story 5</div><div>Rated: PG | <a>Movie Info</a> Starts: 11:40</div>
`

describe('htmlToLines', () => {
  it('splits on closing div/span and decodes basic entities', () => {
    const lines = htmlToLines(PAGE)
    assert.ok(lines.includes('Screen 1'))
    assert.ok(lines.includes('Minions & Monsters'))
    assert.ok(lines.some((l) => l.startsWith('Showing:')))
  })
})

describe('parseShowDates', () => {
  it('extracts the full night list with the current year', () => {
    assert.deepEqual(parseShowDates(htmlToLines(PAGE), NOW),
      ['2026-07-09', '2026-07-10', '2026-07-11', '2026-07-12'])
  })
  it('rolls a stale-looking December window into the next year when scraped in January', () => {
    const dates = parseShowDates(['FRIDAY, Saturday December 3, 4'], new Date('2027-01-05T12:00:00Z'))
    assert.deepEqual(dates, ['2027-12-03', '2027-12-04'])
  })
  it('returns [] for the off-season page with no date block', () => {
    assert.deepEqual(parseShowDates(['Closed for the season. See you in spring!'], NOW), [])
  })
})

describe('parseBoxOffice', () => {
  it('reads the evening box-office time', () => {
    assert.equal(parseBoxOffice(htmlToLines(PAGE)), '8:25 pm')
  })
})

describe('parseScreens', () => {
  it('pairs titles with split-line Rated/Starts details (raw-source form)', () => {
    const screens = parseScreens(htmlToLines(PAGE))
    assert.equal(screens.length, 2)
    assert.deepEqual(screens[0].features.map((f) => f.title), ['Moana', 'Toy Story 5'])
    assert.equal(screens[0].features[0].starts, '9:30 pm')
    assert.equal(screens[0].features[0].rating, 'PG')
    assert.equal(screens[1].features[1].rating, 'PG13')
  })
  it('also handles the merged Rated+Starts single-line form', () => {
    const screens = parseScreens(htmlToLines(PAGE_MERGED_FORM))
    assert.equal(screens.length, 1)
    assert.deepEqual(screens[0].features.map((f) => f.title), ['Moana', 'Toy Story 5'])
    assert.equal(screens[0].features[1].starts, '11:40 pm')
  })
})

describe('buildEvents', () => {
  const events = buildEvents(htmlToLines(PAGE), 'https://www.magiccitydrive-in.com/', NOW)

  it('creates one event per night per screen (4 nights × 2 screens)', () => {
    assert.equal(events.length, 8)
  })
  it('titles the double feature and starts at the FIRST feature time (EDT → UTC)', () => {
    const s1 = events.find((e) => e.screen === 1 && e.ymd === '2026-07-09')
    assert.equal(s1.title, 'Drive-In Double Feature: Moana + Toy Story 5')
    // 9:30 PM EDT on Jul 9 = 01:30 UTC Jul 10
    assert.equal(s1.startIso, '2026-07-10T01:30:00.000Z')
  })
  it('description carries both features and the box-office time', () => {
    const s2 = events.find((e) => e.screen === 2 && e.ymd === '2026-07-09')
    assert.match(s2.description, /Minions & Monsters \(Rated PG\)/)
    assert.match(s2.description, /Disclosure Day \(Rated PG13\)/)
    assert.match(s2.description, /Box office opens 8:25 PM/)
  })
  it('yields nothing off-season', () => {
    assert.deepEqual(buildEvents(['Closed for the season'], 'https://x.test/', NOW), [])
  })
})

describe('module contract', () => {
  it('exports the manifest source key', () => {
    assert.equal(SOURCE_KEY, 'magic_city_drivein')
  })
})
