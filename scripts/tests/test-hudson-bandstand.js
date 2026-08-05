/**
 * test-hudson-bandstand.js — pure parsers for the Hudson Bandstand scraper.
 *
 * The Hudson Bandstand summer concert series moved (2026-08) from a removed
 * WordPress page to the Localist "Hudson Happenings" calendar. The scraper now
 * consumes the whole-calendar iCalendar feed and selects the concert subset by
 * venue (LOCATION + GEO). The fixture is a verbatim slice of that real feed
 * (events.hudsonhappenings.org/calendar/1.ics): four Bandstand concerts plus
 * three non-Bandstand events that must be filtered out.
 *
 * Run:  node --test scripts/tests/test-hudson-bandstand.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseIcs } = await import('../lib/ics.js')
const { isBandstandConcert, buildRow, easternDateOf, cleanDescription } =
  await import('../scrape-hudson-bandstand.js')

const ICS = readFileSync(new URL('./fixtures/hudson-bandstand-calendar.ics', import.meta.url), 'utf8')
const EVENTS = parseIcs(ICS)

/** Eastern wall-clock time ("6:30 PM") for an ISO instant. */
function easternTime(iso) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso))
}

const bySummary = (summary) => EVENTS.find((e) => e.SUMMARY === summary)

describe('Hudson Bandstand: fixture parses', () => {
  it('reads the real feed slice into VEVENTs', () => {
    assert.equal(EVENTS.length, 7)
  })
})

describe('Hudson Bandstand: isBandstandConcert', () => {
  it('keeps concerts at the bandstand gazebo (LOCATION + GEO both match)', () => {
    const concerts = EVENTS.filter(isBandstandConcert).map((e) => e.SUMMARY).sort()
    assert.deepEqual(concerts, [
      "80's Vinyl Arcade",
      'Clocktower',
      'Freedom Brass Band',
      'LaFlavour',
    ])
  })

  it('excludes the art festival that shares the LOCATION but has a different GEO', () => {
    assert.equal(isBandstandConcert(bySummary('Destination Hudson Art & Wine')), false)
  })

  it('excludes the ribbon cutting at "Main Green with Gazebo"', () => {
    assert.equal(isBandstandConcert(bySummary("Hudson's Back to the Bandstand Ribbon Cutting")), false)
  })

  it('excludes an unrelated town-hall meeting', () => {
    assert.equal(isBandstandConcert(bySummary('Hudson Environmental Awareness Committee')), false)
  })

  it('is defensive against a missing GEO or LOCATION', () => {
    assert.equal(isBandstandConcert({}), false)
    assert.equal(isBandstandConcert({ LOCATION: 'Gazebo and Clocktower Greens' }), false)
  })
})

describe('Hudson Bandstand: buildRow', () => {
  it('titles, dates, and times a concert in America/New_York (6:30 p.m. ET)', () => {
    const { row, startMs } = buildRow(bySummary('LaFlavour'))
    assert.equal(row.title, 'Hudson Bandstand: LaFlavour')
    // Feed encodes 6:30 p.m. EDT as 20260712T223000Z.
    assert.equal(row.start_at, '2026-07-12T22:30:00.000Z')
    assert.equal(row.end_at, '2026-07-12T23:30:00.000Z')
    assert.equal(easternDateOf(row.start_at), '2026-07-12')
    assert.equal(easternTime(row.start_at), '6:30 PM')
    assert.equal(row.source_id, 'hudson-bandstand-2026-07-12')
    assert.ok(Number.isFinite(startMs))
  })

  it('asserts categories:[music] and never adds games from "Arcade"', () => {
    const { row } = buildRow(bySummary("80's Vinyl Arcade"))
    assert.deepEqual(row.categories, ['music'])
    assert.equal(row.title, "Hudson Bandstand: 80's Vinyl Arcade")
    assert.ok(!row.categories.includes('games'))
  })

  it('scopes to the fixed Hudson Green / Summit County venue', () => {
    const { row } = buildRow(bySummary('Clocktower'))
    assert.match(row.description, /Hudson Green in downtown Hudson, Ohio/)
    assert.ok(row.tags.includes('summit-county'))
    assert.ok(row.tags.includes('hudson-ohio'))
  })

  it('sets the series as free and family-friendly and publishes directly', () => {
    const { row } = buildRow(bySummary('Freedom Brass Band'))
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, 0)
    assert.equal(row.is_family, true)
    assert.equal(row.age_restriction, 'all_ages')
    assert.equal(row.status, 'published')
    assert.equal(row.source, 'hudson_bandstand')
  })

  it('uses the Localist per-event URL as the ticket link', () => {
    const { row } = buildRow(bySummary('LaFlavour'))
    assert.equal(row.ticket_url, 'https://events.hudsonhappenings.org/event/laflavour')
  })

  it('folds the feed sponsor/description text into the prose', () => {
    const { row } = buildRow(bySummary('LaFlavour'))
    assert.match(row.description, /Sponsored by S\. J\. Hasbrouck Family/)
    assert.match(row.description, /All concerts begin at 6:30 p\.m\./)
  })

  it('drops a cancelled/postponed concert', () => {
    assert.equal(buildRow({ SUMMARY: 'Some Band (CANCELED)', DTSTART: { value: '20260712T223000Z' } }), null)
    assert.equal(buildRow({
      SUMMARY: 'Some Band',
      DTSTART: { value: '20260712T223000Z' },
      DESCRIPTION: 'This concert has been postponed.',
    }), null)
  })

  it('skips an event with no parseable start', () => {
    assert.equal(buildRow({ SUMMARY: 'No Date Band' }), null)
    assert.equal(buildRow({}), null)
  })
})

describe('Hudson Bandstand: helpers', () => {
  it('easternDateOf renders the Eastern calendar date', () => {
    // 00:30 UTC on 2026-08-24 is still 2026-08-23 in Eastern.
    assert.equal(easternDateOf('2026-08-24T00:30:00.000Z'), '2026-08-23')
    assert.equal(easternDateOf(null), null)
  })

  it('cleanDescription collapses folded whitespace to single spaces', () => {
    assert.equal(cleanDescription('a\n\n  b   c'), 'a b c')
    assert.equal(cleanDescription(''), '')
  })
})
