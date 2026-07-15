/**
 * test-peninsula-art-academy.js — pure-parser coverage for the Peninsula Art
 * Academy Google Calendar (iCal) scraper. Feed parsing / RRULE expansion are
 * covered by the shared lib tests (test-ics.js); here we lock this scraper's
 * category rule, tagging, off-site location parsing, stale-master detection,
 * per-event filtering, and config.
 *
 * Run:  node --test scripts/tests/test-peninsula-art-academy.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  mapCategory, mapTags, parsePeninsulaLocation, findStaleMasterUids,
  makeIncludeEvent, config, SOURCE_KEY,
} = await import('../scrape-peninsula-art-academy.js')

describe('mapCategory', () => {
  it("defaults to visual-art for hands-on studio classes/workshops/camps", () => {
    assert.equal(mapCategory({ SUMMARY: 'Intro to Oil Painting' }), 'visual-art')
    assert.equal(mapCategory({ SUMMARY: 'Drawing from Life' }), 'visual-art')
    assert.equal(mapCategory({ SUMMARY: 'Loom Weaving with Carol' }), 'visual-art')
    assert.equal(mapCategory({ SUMMARY: 'Stained Glass Star Workshop' }), 'visual-art')
    assert.equal(mapCategory({ SUMMARY: "Encore! End of Summer Kids' Art Camp" }), 'visual-art')
    assert.equal(mapCategory({ SUMMARY: 'Watercolor Bird (Titmouse) Workshop' }), 'visual-art')
  })

  it("maps educational-format events to learning", () => {
    assert.equal(mapCategory({ SUMMARY: 'What is Abstract Art? Workshop with George Erwin' }), 'learning')
    assert.equal(mapCategory({ SUMMARY: 'Art Academy Home School' }), 'learning')
    assert.equal(mapCategory({ SUMMARY: 'Home School Academy' }), 'learning')
    assert.equal(mapCategory({ SUMMARY: 'Artist Lecture: Color Theory' }), 'learning')
    assert.equal(mapCategory({ SUMMARY: 'Glassblowing Demo' }), 'learning')
    assert.equal(mapCategory({ SUMMARY: 'Art History Talk' }), 'learning')
  })
})

describe('mapTags', () => {
  it('always includes the base art / peninsula tags', () => {
    const t = mapTags({ SUMMARY: 'Open Studio' })
    assert.ok(t.includes('art') && t.includes('peninsula') && t.includes('peninsula-art-academy'))
  })

  it('detects mediums from the title', () => {
    assert.ok(mapTags({ SUMMARY: 'Stained Glass Star' }).includes('glass-art'))
    assert.ok(mapTags({ SUMMARY: 'Intro to Oil Painting' }).includes('painting'))
    assert.ok(mapTags({ SUMMARY: 'Drawing from Life' }).includes('drawing'))
    assert.ok(mapTags({ SUMMARY: 'Loom Weaving' }).includes('fiber-art'))
    assert.ok(mapTags({ SUMMARY: 'Silk Scarf Painting' }).includes('fiber-art'))
    assert.ok(mapTags({ SUMMARY: 'Photo Zoom with John' }).includes('photography'))
  })

  it('flags kids / camp / age-gated titles', () => {
    assert.ok(mapTags({ SUMMARY: "Kids' Art Camp" }).includes('kids'))
    assert.ok(mapTags({ SUMMARY: 'Wizard Academy, AGE 6-8' }).includes('kids'))
  })

  it('returns a de-duplicated list', () => {
    const t = mapTags({ SUMMARY: 'Oil Painting, Watercolor & Acrylic Painting' })
    assert.equal(new Set(t).size, t.length)
  })
})

describe('parsePeninsulaLocation', () => {
  it('returns null for internal room names (→ fixed Academy venue)', () => {
    assert.equal(parsePeninsulaLocation('white room'), null)
    assert.equal(parsePeninsulaLocation('High Top Area'), null)
    assert.equal(parsePeninsulaLocation('Hot shop (glassblowing studio)'), null)
    assert.equal(parsePeninsulaLocation('Kiln room'), null)
    assert.equal(parsePeninsulaLocation(''), null)
    assert.equal(parsePeninsulaLocation('Zoom online'), null)
  })

  it('returns null for the Academy’s own address form (same venue)', () => {
    assert.equal(
      parsePeninsulaLocation('Peninsula Art Academy, 1600 Mill St W, Peninsula, OH 44264, US'),
      null,
    )
  })

  it('parses a genuine off-site venue with a street address', () => {
    const g = parsePeninsulaLocation('G.A.R. Hall, 1785 Main St, Peninsula, OH 44264, USA')
    assert.equal(g.name, 'G.A.R. Hall')
    assert.equal(g.details.address, '1785 Main St')
    assert.equal(g.details.city, 'Peninsula')
    assert.equal(g.details.state, 'OH')
    assert.equal(g.details.zip, '44264')

    const h = parsePeninsulaLocation('Happy Days Lodge, 500 W Streetsboro St, Peninsula, OH 44264')
    assert.equal(h.name, 'Happy Days Lodge')
    assert.equal(h.details.address, '500 W Streetsboro St')
  })
})

describe('findStaleMasterUids', () => {
  const nowMs = Date.parse('2026-07-13T00:00:00Z')

  it('flags open-ended masters (no UNTIL/COUNT) with an old start date', () => {
    const evs = [{
      UID: 'acrylic@google.com',
      RRULE: 'FREQ=WEEKLY;BYDAY=MO',
      DTSTART: { value: '20190107T190000Z', params: {} },
    }]
    const stale = findStaleMasterUids(evs, { nowMs })
    assert.ok(stale.has('acrylic@google.com'))
  })

  it('does NOT flag bounded masters (UNTIL or COUNT present)', () => {
    const evs = [
      { UID: 'a@g', RRULE: 'FREQ=WEEKLY;UNTIL=20261016T035959Z;BYDAY=TH', DTSTART: { value: '20200101T190000Z' } },
      { UID: 'b@g', RRULE: 'FREQ=WEEKLY;COUNT=4;BYDAY=TH', DTSTART: { value: '20190101T190000Z' } },
    ]
    const stale = findStaleMasterUids(evs, { nowMs })
    assert.equal(stale.size, 0)
  })

  it('does NOT flag a recent open-ended master', () => {
    const evs = [{ UID: 'c@g', RRULE: 'FREQ=WEEKLY;BYDAY=SA', DTSTART: { value: '20260601T140000Z' } }]
    const stale = findStaleMasterUids(evs, { nowMs })
    assert.equal(stale.size, 0)
  })

  it('ignores non-recurring events', () => {
    const evs = [{ UID: 'd@g', DTSTART: { value: '20190101T190000Z' } }]
    assert.equal(findStaleMasterUids(evs, { nowMs }).size, 0)
  })
})

describe('makeIncludeEvent', () => {
  const stale = new Set(['acrylic@google.com'])
  const include = makeIncludeEvent(stale)

  it('drops occurrences of stale masters (suffixed UID)', () => {
    assert.equal(include({ UID: 'acrylic@google.com_20260803', SUMMARY: 'Acrylic Painting I' }), false)
  })

  it('keeps ordinary current events', () => {
    assert.equal(include({ UID: 'live@google.com_20260720', SUMMARY: 'Intro to Oil Painting', LOCATION: 'white room' }), true)
  })

  it('drops private lessons and internal meetings', () => {
    assert.equal(include({ UID: 'p@g', SUMMARY: '(Private Sewing Class--Peggy)' }), false)
    assert.equal(include({ UID: 'v@g', SUMMARY: 'Volunteer Meet-up' }), false)
    assert.equal(include({ UID: 'm@g', SUMMARY: 'Staff Meeting' }), false)
  })

  it('drops off-site events outside Summit County, keeps Peninsula off-site', () => {
    assert.equal(
      include({ UID: 'x@g', SUMMARY: 'Pop-up Show', LOCATION: 'Some Gallery, 123 Main St, Cleveland, OH 44113' }),
      false,
    )
    assert.equal(
      include({ UID: 'y@g', SUMMARY: 'ART THROUGH TIME', LOCATION: 'G.A.R. Hall, 1785 Main St, Peninsula, OH 44264, USA' }),
      true,
    )
  })
})

describe('config', () => {
  it('uses the right source key', () => {
    assert.equal(SOURCE_KEY, 'peninsula_art_academy')
    assert.equal(config.source, 'peninsula_art_academy')
  })

  it('expands recurring masters and skips past events', () => {
    assert.equal(config.expandRecurring, true)
    assert.equal(config.skipPast, true)
    assert.equal(config.recurrenceWindowDays, 180)
  })

  it('never assumes free (price stays null)', () => {
    assert.equal(config.defaultPriceMin, null)
    assert.equal(config.defaultPriceMax, null)
  })

  it('pins the fixed Peninsula (Summit County) Academy venue', () => {
    assert.equal(config.defaultVenueName, 'Peninsula Art Academy')
    assert.equal(config.defaultVenueDetails.address, '1600 W Mill St')
    assert.equal(config.defaultVenueDetails.city, 'Peninsula')
    assert.equal(config.defaultVenueDetails.state, 'OH')
  })
})
