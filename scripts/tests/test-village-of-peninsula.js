/**
 * test-village-of-peninsula.js
 *
 * Unit tests for the Village of Peninsula scraper's pure parsers. Peninsula runs
 * the Modern Events Calendar (MEC) WordPress plugin, server-rendered, so the
 * load-bearing logic is: (1) parsing the year from the <h5>Month YYYY</h5>
 * heading and joining it with the card's day+month label and start/end time, and
 * (2) the governance filter that drops Planning Commission / Council / meeting
 * rows while keeping genuine community events.
 *
 * The fixture (fixtures/village-of-peninsula-events.html) is verbatim markup
 * captured from the live events archive on 2026-08-05.
 *
 * Run:
 *   node --test scripts/tests/test-village-of-peninsula.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  isPublicEvent,
  slugifyTitle,
  parseCard,
  parseEventsHtml,
  buildRow,
  isWithinWindow,
} from '../scrape-village-of-peninsula.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = readFileSync(
  resolve(__dirname, 'fixtures/village-of-peninsula-events.html'),
  'utf8',
)

// ── isPublicEvent ────────────────────────────────────────────────────────────

describe('isPublicEvent', () => {
  const KEEP = [
    'Summit County Courthouse Invite',
    'Peninsula Music Festival',
    'Holiday Celebrations in Peninsula',
    'Memorial Day Parade',
    'Farmers Market on Main',
  ]
  const DROP = [
    'Rescheduled-Planning Comission Meeting',
    'Planning Commission Meeting',
    'Village Council Meeting',
    'Board of Zoning Appeals',
    'Public Hearing',
    'Council Work Session',
    'Village Offices Closed',
    'Summer Concert - CANCELLED',
  ]
  for (const t of KEEP) {
    it(`keeps community event: ${t}`, () => assert.equal(isPublicEvent(t), true))
  }
  for (const t of DROP) {
    it(`drops governance / notice row: ${t}`, () => assert.equal(isPublicEvent(t), false))
  }
  it('rejects empty / whitespace / null titles', () => {
    assert.equal(isPublicEvent(''), false)
    assert.equal(isPublicEvent('   '), false)
    assert.equal(isPublicEvent(null), false)
  })
})

// ── slugifyTitle ─────────────────────────────────────────────────────────────

describe('slugifyTitle', () => {
  it('slugifies a plain title', () => {
    assert.equal(slugifyTitle('Summit County Courthouse Invite'), 'summit-county-courthouse-invite')
  })
  it('collapses punctuation and trims dashes', () => {
    assert.equal(slugifyTitle('  Peninsula: Music & Arts!  '), 'peninsula-music-arts')
  })
})

// ── parseCard ────────────────────────────────────────────────────────────────

describe('parseCard', () => {
  it('parses title, slug, date, and both times from a card block', () => {
    const block =
      'class="mec-topsec">' +
      '<h3 class="mec-event-title"><a href="https://villageofpeninsula-oh.gov/events/summit-county-courthouse-invite/">Summit County Courthouse Invite</a></h3>' +
      '<div class="mec-event-description"></div>' +
      '<span class="mec-start-date-label">06 Aug</span>' +
      '<span class="mec-start-time">4:00 pm</span><span class="mec-end-time">6:00 pm</span>'
    const card = parseCard(block, 2026)
    assert.equal(card.title, 'Summit County Courthouse Invite')
    assert.equal(card.slug, 'summit-county-courthouse-invite')
    assert.equal(card.year, 2026)
    assert.equal(card.month, 8)
    assert.equal(card.day, 6)
    assert.equal(card.startTime, '4:00 pm')
    assert.equal(card.endTime, '6:00 pm')
    assert.equal(card.description, null)
  })

  it('parses a description and tolerates a missing end time', () => {
    const block =
      'class="mec-topsec">' +
      '<h3 class="mec-event-title"><a href="https://villageofpeninsula-oh.gov/events/planning-meeting/">Rescheduled-Planning Comission Meeting</a></h3>' +
      '<div class="mec-event-description">More information to come!</div>' +
      '<span class="mec-start-date-label">01 Sep</span>' +
      '<span class="mec-start-time">7:00 pm</span>'
    const card = parseCard(block, 2026)
    assert.equal(card.month, 9)
    assert.equal(card.day, 1)
    assert.equal(card.startTime, '7:00 pm')
    assert.equal(card.endTime, null)
    assert.equal(card.description, 'More information to come!')
  })

  it('falls back to a title slug when there is no /events/ href', () => {
    const block =
      'class="mec-topsec">' +
      '<h3 class="mec-event-title"><a href="#">Peninsula Music Festival</a></h3>' +
      '<span class="mec-start-date-label">12 Jul</span>' +
      '<span class="mec-start-time">6:00 pm</span>'
    const card = parseCard(block, 2026)
    assert.equal(card.slug, 'peninsula-music-festival')
  })

  it('returns null when the block has no title or no date label', () => {
    assert.equal(parseCard('class="mec-topsec"><span class="mec-start-date-label">06 Aug</span>', 2026), null)
    assert.equal(parseCard('class="mec-topsec"><h3 class="mec-event-title"><a href="#">No Date</a></h3>', 2026), null)
  })
})

// ── parseEventsHtml (real fixture) ───────────────────────────────────────────

describe('parseEventsHtml (fixture)', () => {
  const cards = parseEventsHtml(FIXTURE)

  it('parses exactly the two live cards', () => {
    assert.equal(cards.length, 2)
  })

  it('stamps the correct year from the preceding <h5> heading', () => {
    const courthouse = cards.find(c => c.title === 'Summit County Courthouse Invite')
    assert.equal(courthouse.year, 2026)
    assert.equal(courthouse.month, 8)
    assert.equal(courthouse.day, 6)
    assert.equal(courthouse.startTime, '4:00 pm')
    assert.equal(courthouse.endTime, '6:00 pm')

    const planning = cards.find(c => c.title.startsWith('Rescheduled'))
    assert.equal(planning.year, 2026) // heading rolled over to September 2026
    assert.equal(planning.month, 9)
    assert.equal(planning.day, 1)
  })
})

// ── buildRow ─────────────────────────────────────────────────────────────────

describe('buildRow (fixture)', () => {
  const rows = parseEventsHtml(FIXTURE).map(buildRow).filter(Boolean)

  it('drops the governance meeting and keeps the community event', () => {
    assert.equal(rows.length, 1)
    assert.equal(rows[0].row.title, 'Summit County Courthouse Invite')
  })

  it('builds a complete row with correct Eastern→UTC times', () => {
    const { row, venueSpec } = rows[0]
    // 4:00 PM ET in August (EDT, UTC-4) → 20:00Z; 6:00 PM → 22:00Z.
    assert.equal(row.start_at, '2026-08-06T20:00:00.000Z')
    assert.equal(row.end_at, '2026-08-06T22:00:00.000Z')
    assert.equal(row.source, 'village_of_peninsula')
    assert.equal(row.source_id, 'peninsula_summit-county-courthouse-invite')
    assert.equal(row.source_url, 'https://villageofpeninsula-oh.gov/events/summit-county-courthouse-invite/')
    assert.equal(row.status, 'published')
    assert.equal(row.featured, false)
    assert.equal(row.price_min, null)
    assert.equal(row.image_url, null)
    assert.deepEqual(row.tags, ['peninsula', 'summit-county'])
    assert.equal(venueSpec.name, 'Village of Peninsula')
    assert.equal(venueSpec.city, 'Peninsula')
  })

  it('returns null for a governance row directly', () => {
    const planning = parseEventsHtml(FIXTURE).find(c => c.title.startsWith('Rescheduled'))
    assert.equal(buildRow(planning), null)
  })

  it('falls back to a noon start when a card has no start time', () => {
    const { row } = buildRow({
      title: 'Peninsula Farmers Market', slug: 'farmers-market',
      year: 2026, month: 7, day: 12, startTime: null, endTime: null, description: null,
    })
    // 12:00 PM ET in July (EDT, UTC-4) → 16:00Z.
    assert.equal(row.start_at, '2026-07-12T16:00:00.000Z')
    assert.equal(row.end_at, null)
  })
})

// ── isWithinWindow ───────────────────────────────────────────────────────────

describe('isWithinWindow', () => {
  const now = Date.parse('2026-08-01T12:00:00Z')
  it('keeps a near-future event', () => {
    assert.equal(isWithinWindow('2026-08-06T20:00:00.000Z', '2026-08-06T22:00:00.000Z', now), true)
  })
  it('drops an event that ended long ago', () => {
    assert.equal(isWithinWindow('2025-08-06T20:00:00.000Z', '2025-08-06T22:00:00.000Z', now), false)
  })
  it('drops an event beyond the 365-day horizon', () => {
    assert.equal(isWithinWindow('2027-09-01T20:00:00.000Z', null, now), false)
  })
  it('keeps a same-day event within the grace window', () => {
    assert.equal(isWithinWindow('2026-08-01T02:00:00.000Z', null, now), true)
  })
})
