/**
 * test-akron-roller-derby.js — pure parsers for the Akron Roller Derby scraper.
 *
 * The fixture below is a trimmed but faithful copy of the real
 * akronrollerderby.net/games-events markup: a "Home Games" section with date
 * <h2>s, matchup <h2>s, the "Summit County Fairgrounds" link and a
 * "Tallmadge, Ohio" <h1>; the "Detailed Schedule" doors/first-whistle
 * paragraph; and an "Away Games" section with out-of-state cities. The scraper
 * must KEEP the home games and DROP every away game.
 *
 * Run:  node --test scripts/tests/test-akron-roller-derby.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseEvents, parseDateHeading, parseDetailedTimes, isHomeGame, inferYear, SOURCE_KEY } =
  await import('../scrape-akron-roller-derby.js')

const NOW = new Date('2026-01-15T12:00:00Z')  // month = January → spring games this year

// Faithful excerpt of the live page's HTML structure.
const HTML = `
<h2>Season 2026</h2>
<h1>Home Games</h1>

<h2>APRIL 11</h2>
<a href="https://www.google.com/maps/place/229+E+Howe+Rd,+Tallmadge,+OH+44278">map</a>
<a href="https://akronrollerderby.net/presale-tickets#ticket-landing-page-1">tickets</a>
<h2>All Stars vs. Black Rose B   AkRowdies vs. Black Rose C</h2>
<a href="https://www.akronrollerderby.net/scf-info">Summit County Fairgrounds</a>
<h1>Tallmadge, Ohio</h1>

<h2>MAY 16 - Triple Header</h2>
<a href="https://www.google.com/maps/place/229+E+Howe+Rd,+Tallmadge,+OH+44278">map</a>
<a href="https://akronrollerderby.net/presale-tickets#ticket-landing-page-1">tickets</a>
<h2>AkRowdies vs. Downriver Roller Dolls   All Stars vs. Chemical Valley   AkAlignments vs. Glass City</h2>
<a href="https://www.akronrollerderby.net/scf-info">Summit County Fairgrounds</a>
<h1>Tallmadge, Ohio</h1>

<h2>JUNE 13th - Triple Header</h2>
<a href="https://www.google.com/maps/place/229+E+Howe+Rd,+Tallmadge,+OH+44278">map</a>
<a href="https://akronrollerderby.net/presale-tickets#ticket-landing-page-1">tickets</a>
<h2>AkRowdies vs. Gem City B   All Stars vs. Gem City A   AkAlignments vs. Gem City C</h2>
<a href="https://www.akronrollerderby.net/scf-info">Summit County Fairgrounds</a>
<h1>Tallmadge, Ohio</h1>

<h1>Detailed Schedule</h1>
<h2>4/11   Summit County Fairgrounds Bout Schedule:  Doors open at 5PM.   First whistle at 6PM.   Second bout will begin at roughly 8PM.  5/16 &amp; 6/13   Summit County Fairgrounds Bout Schedule:   Doors open at 3PM.   First whistle at 4PM.   Second bout will begin at roughly 6PM and third bout will begin roughly 8PM.</h2>

<h1>Away Games</h1>
<h2>April 3-5 All Stars</h2>
<p>Danville, Indiana</p>
<h2>All Stars Tournament</h2>
<h2>April 25 All Stars</h2>
<p>Grand Rapids, Michigan</p>
<h2>vs. Grand Raggedy</h2>
<h2>May 2 AkRowdies &amp; Alignments</h2>
<p>Warren, Pennsylvania</p>
<h2>Wreckin Dolls</h2>
`

describe('inferYear', () => {
  it('keeps this year for current/future months, rolls earlier months to next year', () => {
    assert.equal(inferYear(4, NOW), 2026)   // April ≥ January
    assert.equal(inferYear(1, NOW), 2026)   // January = January
    const nov = new Date('2026-11-15T12:00:00Z')
    assert.equal(inferYear(4, nov), 2027)   // April < November → next year
  })
})

describe('parseDateHeading', () => {
  it('parses a plain date heading', () => {
    const h = parseDateHeading('APRIL 11', NOW)
    assert.equal(h.ymd, '2026-04-11')
    assert.equal(h.tripleHeader, false)
  })
  it('parses an ordinal + triple-header heading', () => {
    const h = parseDateHeading('JUNE 13th - Triple Header', NOW)
    assert.equal(h.ymd, '2026-06-13')
    assert.equal(h.tripleHeader, true)
  })
  it('returns null for non-date lines', () => {
    assert.equal(parseDateHeading('Summit County Fairgrounds'), null)
    assert.equal(parseDateHeading(''), null)
  })
})

describe('parseDetailedTimes', () => {
  it('maps every M/D to its first-whistle time (shared dates included)', () => {
    const t = parseDetailedTimes(
      '4/11 … Doors open at 5PM. First whistle at 6PM. 5/16 & 6/13 … First whistle at 4PM.',
    )
    assert.equal(t['4/11'], '6:00 PM')
    assert.equal(t['5/16'], '4:00 PM')
    assert.equal(t['6/13'], '4:00 PM')
  })
})

describe('isHomeGame (Summit County gate)', () => {
  it('keeps Summit County cities, drops out-of-state', () => {
    assert.equal(isHomeGame('Tallmadge, Ohio'), true)
    assert.equal(isHomeGame('Akron'), true)
    assert.equal(isHomeGame('Danville, Indiana'), false)
    assert.equal(isHomeGame('Grand Rapids, Michigan'), false)
    assert.equal(isHomeGame('Warren, Pennsylvania'), false)
  })
})

describe('parseEvents', () => {
  const games = parseEvents(HTML, NOW)

  it('keeps only the three Summit County home games', () => {
    assert.equal(games.length, 3)
    // Every kept game is in Tallmadge, Ohio — no away game leaked through.
    assert.ok(games.every((g) => /Tallmadge, Ohio/i.test(g.city)))
    assert.ok(!games.some((g) => /Indiana|Michigan|Pennsylvania/i.test(g.city || '')))
  })

  it('parses the first home game (April 11) with matchups and 6PM first whistle', () => {
    const apr = games.find((g) => g.date === '2026-04-11')
    assert.ok(apr)
    assert.match(apr.title, /All Stars vs\. Black Rose B/)
    assert.equal(apr.time, '6:00 PM')
    assert.equal(apr.tripleHeader, false)
  })

  it('parses the triple-header dates with a 4PM first whistle', () => {
    const may = games.find((g) => g.date === '2026-05-16')
    assert.ok(may)
    assert.equal(may.time, '4:00 PM')
    assert.equal(may.tripleHeader, true)
    assert.match(may.title, /^Akron Roller Derby Triple Header:/)
  })

  it('drops every away game (none of the away cities survive)', () => {
    assert.ok(!games.some((g) => /Grand Raggedy|Wreckin Dolls|Tournament/i.test(g.matchups || '')))
  })
})

describe('SOURCE_KEY', () => {
  it('is akron_roller_derby', () => assert.equal(SOURCE_KEY, 'akron_roller_derby'))
})
