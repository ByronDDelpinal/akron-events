/**
 * test-west-side-gymnastics.js
 *
 * Tests for the West Side Gymnastics scraper (Google Calendar iCal feed).
 * Covers: closure filtering, UTC date/time conversion, source_id stability,
 * category/family/tag mapping, ticket-URL routing, price never assumed, and
 * batch invariants against a realistic feed fixture captured from the live
 * calendar.
 *
 * Run:
 *   node --test scripts/tests/test-west-side-gymnastics.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Dummy env vars before any imports ───────────────────────────────────────
process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import { parseIcs } from '../lib/ics.js'
import {
  isPublicSpecialEvent,
  mapTags,
  ticketUrlFor,
  icsEventToRow,
} from '../scrape-west-side-gymnastics.js'

// ── Fixture: verbatim VEVENT blocks from the live Google Calendar feed ──────
const FEED = `BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:westsideoh@gmail.com
X-WR-TIMEZONE:America/New_York
BEGIN:VEVENT
DTSTART:20260715T130000Z
DTEND:20260715T193000Z
DTSTAMP:20260715T114031Z
UID:cdi6ae3460sm6b9m71im2b9k6sr62b9p6cs38b9hcos64p9ickqjgoj66s@google.com
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Disneymania Camp
TRANSP:OPAQUE
END:VEVENT
BEGIN:VEVENT
DTSTART:20260708T140000Z
DTEND:20260708T160000Z
DTSTAMP:20260715T114031Z
UID:6gq3ad1p69h64b9p6koj4b9k69ij6bb165j36b9h75h6cohnckojie1o6c@google.com
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Pre-K Summer Camp: Dinosaur Dig
TRANSP:OPAQUE
END:VEVENT
BEGIN:VEVENT
DTSTART:20260713T130000Z
DTEND:20260713T193000Z
DTSTAMP:20260715T114031Z
UID:60p62e1ic5j3ib9m6komab9k6oq3ab9o74r68b9n71j66cb5clgjge9pcg@google.com
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Picasso Jr Camp
TRANSP:OPAQUE
END:VEVENT
BEGIN:VEVENT
DTSTART:20261230T130000Z
DTEND:20261230T140000Z
DTSTAMP:20260715T114031Z
UID:68om2cppc9j62b9hc4sjeb9k6gojcbb2clhm2bb6c9gj0ob3cgqj4cpk6o@google.com
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Gym Closed (Holiday Break)
TRANSP:OPAQUE
END:VEVENT
END:VCALENDAR`

const events = parseIcs(FEED)
const byTitle = (t) => events.find((e) => e.SUMMARY === t)

// ════════════════════════════════════════════════════════════════════════════
describe('isPublicSpecialEvent — filtering', () => {
  it('keeps camps and programs', () => {
    assert.equal(isPublicSpecialEvent(byTitle('Disneymania Camp')), true)
    assert.equal(isPublicSpecialEvent(byTitle('Pre-K Summer Camp: Dinosaur Dig')), true)
    assert.equal(isPublicSpecialEvent(byTitle('Picasso Jr Camp')), true)
  })

  it('drops "Gym Closed" closure markers', () => {
    assert.equal(isPublicSpecialEvent(byTitle('Gym Closed (Holiday Break)')), false)
  })

  it('drops other closure/cancellation phrasings', () => {
    assert.equal(isPublicSpecialEvent({ SUMMARY: 'CLOSED - Thanksgiving' }), false)
    assert.equal(isPublicSpecialEvent({ SUMMARY: 'No Classes Today' }), false)
    assert.equal(isPublicSpecialEvent({ SUMMARY: '' }), false)
    assert.equal(isPublicSpecialEvent({}), false)
  })

  it('drops the live recurring CANCELED marker (verified in the feed 2026-07-15)', () => {
    // The gym publishes "CANCELED Preschool Open Gym" on the same calendar as
    // real programming; without the cancel guard it would be ingested.
    assert.equal(isPublicSpecialEvent({ SUMMARY: 'CANCELED Preschool Open Gym' }), false)
    assert.equal(isPublicSpecialEvent({ SUMMARY: 'Open Gym - CANCELLED' }), false)
    assert.equal(isPublicSpecialEvent({ SUMMARY: 'Parents Night Out POSTPONED' }), false)
  })

  it('keeps Parents\' Night Out and Open Gym', () => {
    assert.equal(isPublicSpecialEvent({ SUMMARY: "Parents' Night Out" }), true)
    assert.equal(isPublicSpecialEvent({ SUMMARY: 'Open Gym' }), true)
  })
})

describe('icsEventToRow — normalisation', () => {
  it('converts a UTC 9am-3:30pm EDT camp correctly (stored as UTC instants)', () => {
    const row = icsEventToRow(byTitle('Disneymania Camp'))
    assert.equal(row.start_at, '2026-07-15T13:00:00.000Z') // 9:00am EDT
    assert.equal(row.end_at,   '2026-07-15T19:30:00.000Z') // 3:30pm EDT
  })

  it('converts the Pre-K 10am-12pm session correctly', () => {
    const row = icsEventToRow(byTitle('Pre-K Summer Camp: Dinosaur Dig'))
    assert.equal(row.start_at, '2026-07-08T14:00:00.000Z') // 10:00am EDT
    assert.equal(row.end_at,   '2026-07-08T16:00:00.000Z') // 12:00pm EDT
  })

  it('uses the Google UID verbatim as a stable source_id', () => {
    const row = icsEventToRow(byTitle('Disneymania Camp'))
    assert.equal(row.source_id, 'cdi6ae3460sm6b9m71im2b9k6sr62b9p6cs38b9hcos64p9ickqjgoj66s@google.com')
  })

  it('classifies every program as fitness + family', () => {
    for (const title of ['Disneymania Camp', 'Picasso Jr Camp', 'Pre-K Summer Camp: Dinosaur Dig']) {
      const row = icsEventToRow(byTitle(title))
      assert.equal(row.category, 'fitness')
      assert.equal(row.is_family, true)
    }
  })

  it('never assumes a price', () => {
    const row = icsEventToRow(byTitle('Disneymania Camp'))
    assert.equal(row.price_min, null)
    assert.equal(row.price_max, null)
  })

  it('returns null for closures', () => {
    assert.equal(icsEventToRow(byTitle('Gym Closed (Holiday Break)')), null)
  })

  it('returns null when the start time is missing', () => {
    assert.equal(icsEventToRow({ SUMMARY: 'Mystery Event' }), null)
  })

  it('is published with a title and image', () => {
    const row = icsEventToRow(byTitle('Picasso Jr Camp'))
    assert.equal(row.status, 'published')
    assert.equal(row.title, 'Picasso Jr Camp')
    assert.ok(row.image_url && row.image_url.startsWith('https://'))
  })
})

describe('mapTags', () => {
  it('always tags the venue basics', () => {
    const tags = mapTags('Disneymania Camp')
    for (const t of ['gymnastics', 'kids', 'copley', 'summer-camp']) assert.ok(tags.includes(t))
  })

  it('tags Parents\' Night Out and Open Gym by type', () => {
    assert.ok(mapTags("Parents' Night Out").includes('parents-night-out'))
    assert.ok(mapTags('Open Gym').includes('open-gym'))
    assert.ok(mapTags('Tumbling Clinic').includes('clinic'))
  })

  it('de-duplicates', () => {
    const tags = mapTags('Camp')
    assert.equal(tags.length, new Set(tags).size)
  })
})

describe('ticketUrlFor — link routing', () => {
  it('routes camps to /summer-camps', () => {
    assert.equal(ticketUrlFor('Disneymania Camp'), 'https://www.westsidegymnastics.net/summer-camps')
  })
  it('routes Parents\' Night Out to /special-events', () => {
    assert.equal(ticketUrlFor("Parents' Night Out"), 'https://www.westsidegymnastics.net/special-events')
  })
  it('falls back to the calendar page', () => {
    assert.equal(ticketUrlFor('Open Gym'), 'https://www.westsidegymnastics.net/calendar')
  })
})

describe('batch invariants', () => {
  it('yields exactly the 3 real events from the 4-VEVENT fixture', () => {
    const rows = events.map(icsEventToRow).filter(Boolean)
    assert.equal(rows.length, 3)
    for (const row of rows) {
      assert.ok(row.title)
      assert.ok(row.start_at)
      assert.ok(row.source_id)
      assert.equal(row.source, 'west_side_gymnastics')
    }
  })

  it('produces unique source_ids', () => {
    const rows = events.map(icsEventToRow).filter(Boolean)
    const ids = rows.map((r) => r.source_id)
    assert.equal(ids.length, new Set(ids).size)
  })
})
