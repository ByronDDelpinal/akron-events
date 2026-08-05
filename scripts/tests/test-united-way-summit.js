/**
 * test-united-way-summit.js — real parse path for the United Way of Summit &
 * Medina scraper (Tribe iCal feed), exercised against a verbatim capture of the
 * live feed at scripts/tests/fixtures/united-way-summit.ics.
 *
 * Run:  node --test scripts/tests/test-united-way-summit.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const HERE = dirname(fileURLToPath(import.meta.url))
const ICS = readFileSync(join(HERE, 'fixtures', 'united-way-summit.ics'), 'utf8')

const { parseIcs, normaliseIcsEvent, isDateOnlyIcsEvent, DATE_ONLY_TIME_NOTE } =
  await import('../lib/ics.js')
const { parseTribeLocation, summitGate, mapTags, SOURCE_KEY } =
  await import('../scrape-united-way-summit.js')

const EVENTS = parseIcs(ICS)

describe('united-way-summit: feed shape', () => {
  it('parses exactly one VEVENT from the verbatim capture', () => {
    assert.equal(EVENTS.length, 1)
  })
  it('the event is Bold Glow with the expected UID + LOCATION', () => {
    const ev = EVENTS[0]
    assert.equal(ev.SUMMARY, 'Bold Glow')
    assert.equal(ev.UID, '4843-1789689600-1789775999@www.uwsummitmedina.org')
    // ICS text escapes (\,) are unescaped by parseIcs.
    assert.equal(ev.LOCATION, 'J. E. Good Park Golf Course, 530 Nome Ave., Akron, 44320')
  })
  it('is a date-only (VALUE=DATE) all-day event', () => {
    assert.equal(isDateOnlyIcsEvent(EVENTS[0]), true)
  })
})

describe('united-way-summit: parseTribeLocation', () => {
  it('splits the real "Name, Street, City, Zip" LOCATION (no state/country)', () => {
    assert.deepEqual(
      parseTribeLocation(EVENTS[0].LOCATION),
      { name: 'J. E. Good Park Golf Course', details: { address: '530 Nome Ave.', city: 'Akron', state: 'OH', zip: '44320' } })
  })
  it('handles the full "Name, Street, City, ST, Zip, Country" form', () => {
    assert.deepEqual(
      parseTribeLocation('Some Hall, 100 Main St, Akron, OH, 44308, United States'),
      { name: 'Some Hall', details: { address: '100 Main St', city: 'Akron', state: 'OH', zip: '44308' } })
  })
  it('parses a "Name, City, Zip" form (no street/state/country)', () => {
    assert.deepEqual(
      parseTribeLocation('United Way HQ, Akron, 44308'),
      { name: 'United Way HQ', details: { address: null, city: 'Akron', state: 'OH', zip: '44308' } })
  })
  it('returns null for empty input', () => {
    assert.equal(parseTribeLocation(''), null)
    assert.equal(parseTribeLocation(null), null)
  })
})

describe('united-way-summit: summitGate (bi-county)', () => {
  it('keeps the real Akron event (in Summit)', () => {
    assert.equal(summitGate(EVENTS[0]), true)
  })
  it('drops a confirmed Medina-county event (org serves both counties)', () => {
    assert.equal(summitGate({ LOCATION: 'Some Venue, 1 Main St, Medina, OH, 44256' }), false)
    assert.equal(summitGate({ LOCATION: 'Hall, 5 Ave, Wadsworth, OH, 44281' }), false)
  })
  it('drops a confirmed out-of-region (Cleveland) event', () => {
    assert.equal(summitGate({ LOCATION: 'Venue, 2 St, Cleveland, OH, 44101' }), false)
  })
  it('keeps a VEVENT with no LOCATION (falls back to Akron default venue)', () => {
    assert.equal(summitGate({ SUMMARY: 'Board Luncheon' }), true)
  })
  it('keeps an unrecognized-city event (trusted first-party, not a confirmed leak)', () => {
    assert.equal(summitGate({ LOCATION: 'Odd Place, 9 Rd, Nowheresville, OH, 40000' }), true)
  })
})

describe('united-way-summit: normaliseIcsEvent (real row)', () => {
  const row = normaliseIcsEvent(EVENTS[0], { source: SOURCE_KEY, mapTags })

  it('produces a published row with the right title + source_id', () => {
    assert.equal(row.title, 'Bold Glow')
    assert.equal(row.source, 'united_way_summit')
    assert.equal(row.source_id, '4843-1789689600-1789775999@www.uwsummitmedina.org')
    assert.equal(row.status, 'published')
    assert.equal(row.featured, false)
  })
  it('applies the sanctioned noon-ET default to the date-only start (Sept = EDT)', () => {
    // 2026-09-18 noon America/New_York (UTC-4) → 16:00Z.
    assert.equal(row.start_at, '2026-09-18T16:00:00.000Z')
  })
  it('keeps the exclusive next-day end (not inverted by the noon shift)', () => {
    assert.equal(row.end_at, '2026-09-19T04:00:00.000Z')
  })
  it('discloses the invented time in the description', () => {
    assert.ok(row.description.includes(DATE_ONLY_TIME_NOTE))
    assert.ok(row.description.startsWith('Join us on the course'))
  })
  it('carries the ATTACH image and the ticket URL', () => {
    assert.equal(row.image_url, 'https://www.uwsummitmedina.org/wp-content/uploads/2024/11/2026_Website-Graphics_Events_VAR12-scaled.png')
    assert.ok(row.ticket_url.startsWith('https://www.uwsummitmedina.org/calendars/'))
  })
  it('tags united-way + summit-county', () => {
    assert.ok(row.tags.includes('united-way'))
    assert.ok(row.tags.includes('summit-county'))
  })
})

describe('united-way-summit: SOURCE_KEY', () => {
  it('is united_way_summit', () => assert.equal(SOURCE_KEY, 'united_way_summit'))
})
