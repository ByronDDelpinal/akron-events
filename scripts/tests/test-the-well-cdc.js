/**
 * test-the-well-cdc.js — The Well CDC (Divi blurb HTML) scraper.
 *
 * Covers both markup generations:
 *   • legacy:  <strong>JUNE 4, 2026 | 5:30PM</strong> + <strong>VENUE – ADDR</strong>
 *   • current: <strong>THURSDAY, JUNE 18</strong> + <strong>4 – 7PM</strong>
 *              (no year, weekday prefix, time in its own bold run)
 *
 * Run:
 *   node --test scripts/tests/test-the-well-cdc.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseDate, parseTime, parseEvents, isTimeOnly } =
  await import('../scrape-the-well-cdc.js')

// Fixed "now" so year inference is deterministic: 2026-07-01.
const NOW = new Date(2026, 6, 1)

// ── parseDate ─────────────────────────────────────────────────────────────

describe('The Well CDC — parseDate', () => {
  it('parses the legacy full form "JUNE 4, 2026"', () => {
    assert.equal(parseDate('JUNE 4, 2026', NOW), '2026-06-04')
  })

  it('parses with a trailing time segment "JUNE 4, 2026 | 5:30PM"', () => {
    assert.equal(parseDate('JUNE 4, 2026 | 5:30PM', NOW), '2026-06-04')
  })

  it('tolerates a leading weekday: "THURSDAY, JUNE 18"', () => {
    assert.equal(parseDate('THURSDAY, JUNE 18', NOW), '2026-06-18')
  })

  it('infers the current year for an upcoming year-less date', () => {
    assert.equal(parseDate('AUGUST 22', NOW), '2026-08-22')
  })

  it('keeps a recently-past year-less date in the current year (so the past filter drops it)', () => {
    // June 18 is 13 days before NOW — must NOT roll to 2027.
    assert.equal(parseDate('JUNE 18', NOW), '2026-06-18')
  })

  it('rolls far-past year-less dates to next year (Dec page listing a Jan event)', () => {
    const december = new Date(2026, 11, 10)
    assert.equal(parseDate('JANUARY 15', december), '2027-01-15')
  })

  it('supports month abbreviations', () => {
    assert.equal(parseDate('SEPT 9, 2026', NOW), '2026-09-09')
  })

  it('handles ordinal day suffixes: "JUNE 18TH"', () => {
    assert.equal(parseDate('JUNE 18th', NOW), '2026-06-18')
  })

  it('returns null for junk', () => {
    assert.equal(parseDate('', NOW), null)
    assert.equal(parseDate('COMING SOON', NOW), null)
    assert.equal(parseDate('4 – 7PM', NOW), null)
  })
})

// ── parseTime / isTimeOnly ────────────────────────────────────────────────

describe('The Well CDC — parseTime', () => {
  it('parses "5:30PM"',       () => assert.equal(parseTime('5:30PM'), '17:30:00'))
  it('parses "6 – 8PM"',      () => assert.equal(parseTime('6 – 8PM'), '18:00:00'))
  it('parses "10 – 11:30AM"', () => assert.equal(parseTime('10 – 11:30AM'), '10:00:00'))
  it('parses "4 – 7PM"',      () => assert.equal(parseTime('4 – 7PM'), '16:00:00'))
  it('parses "12PM" as noon', () => assert.equal(parseTime('12PM'), '12:00:00'))
  it('parses "12AM" as midnight', () => assert.equal(parseTime('12AM'), '00:00:00'))
  it('empty → all-day 00:00', () => assert.equal(parseTime(''), '00:00:00'))
})

describe('The Well CDC — isTimeOnly', () => {
  it('accepts standalone times',       () => {
    assert.ok(isTimeOnly('4 – 7PM'))
    assert.ok(isTimeOnly('5:30PM'))
    assert.ok(isTimeOnly('10 – 11:30 AM'))
  })
  it('rejects venue/address lines',    () => {
    assert.ok(!isTimeOnly('THE EAST END – 1200 E MARKET ST'))
    assert.ok(!isTimeOnly('700 E. Exchange St.'))
  })
  it('rejects date lines',             () => {
    assert.ok(!isTimeOnly('THURSDAY, JUNE 18'))
  })
})

// ── parseEvents: legacy markup ────────────────────────────────────────────

const LEGACY_HTML = `
<div class="et_pb_blurb">
  <h4 class="et_pb_module_header"><span>TASTE OF MIDDLEBURY</span></h4>
  <div class="et_pb_blurb_description">
    <p><strong>JUNE 4, 2026 | 5:30PM</strong></p>
    <p><strong>THE EAST END – 1200 E MARKET ST</strong></p>
    <p>Join us for our annual fundraiser featuring local restaurants and live music.</p>
    <a href="https://example.com/register">Learn more and register!</a>
  </div>
</div>`

describe('The Well CDC — parseEvents (legacy markup)', () => {
  const events = parseEvents(LEGACY_HTML, NOW)

  it('parses one event', () => assert.equal(events.length, 1))
  it('extracts title',   () => assert.equal(events[0].title, 'TASTE OF MIDDLEBURY'))
  it('extracts date',    () => assert.equal(events[0].dateStr, '2026-06-04'))
  it('extracts time',    () => assert.equal(events[0].timeStr, '17:30:00'))
  it('extracts venue',   () => assert.equal(events[0].venueName, 'The East End'))
  it('extracts link',    () => assert.equal(events[0].ticketUrl, 'https://example.com/register'))
  it('extracts description', () => assert.match(events[0].description, /annual fundraiser/))
})

// ── parseEvents: current (2026) markup ────────────────────────────────────

const CURRENT_HTML = `
<div class="et_pb_blurb">
  <h4 class="et_pb_module_header"><span>JUNETEENTH COMMUNITY CELEBRATION</span></h4>
  <div class="et_pb_blurb_description">
    <p><em><strong>Bring your family to join us with interactive art, line dancing, a DJ, and FREE food!</strong></em></p>
    <p><strong>THURSDAY, JUNE 18</strong></p>
    <p><strong>4 – 7PM</strong></p>
    <p><strong>Located at Mason Park Community Center</strong></p>
    <p>700 E. Exchange St.</p>
  </div>
</div>
<div class="et_pb_blurb">
  <h4 class="et_pb_module_header"><span>MIDDLEBURY FALL FEST</span></h4>
  <div class="et_pb_blurb_description">
    <p><strong>SATURDAY, OCTOBER 3</strong></p>
    <p><strong>12 – 4PM</strong></p>
    <p><strong>THE WELL – 647 E MARKET ST</strong></p>
    <p>Celebrate autumn in Middlebury with games, food trucks, and neighbors.</p>
  </div>
</div>`

describe('The Well CDC — parseEvents (current year-less markup)', () => {
  const events = parseEvents(CURRENT_HTML, NOW)

  it('parses both events', () => assert.equal(events.length, 2))

  it('infers year and skips the weekday prefix', () => {
    assert.equal(events[0].dateStr, '2026-06-18')
    assert.equal(events[1].dateStr, '2026-10-03')
  })

  it('reads the standalone time strong', () => {
    assert.equal(events[0].timeStr, '16:00:00')
    assert.equal(events[1].timeStr, '12:00:00')
  })

  it('strips "Located at" from the venue', () => {
    assert.equal(events[0].venueName, 'Mason Park Community Center')
  })

  it('still handles VENUE – ADDRESS venue lines', () => {
    assert.equal(events[1].venueName, 'The Well')
  })

  it('does not mistake bolded description copy for the venue', () => {
    assert.doesNotMatch(events[0].venueName, /family|interactive/i)
  })

  it('finds the description paragraph', () => {
    assert.match(events[1].description, /autumn in Middlebury/)
  })
})

// ── parseEvents: no-date blurbs are skipped, not crashed ──────────────────

describe('The Well CDC — parseEvents (degenerate blurbs)', () => {
  it('skips blurbs without a recognisable date', () => {
    const html = `
      <h4 class="et_pb_module_header"><span>COMING SOON</span></h4>
      <p><strong>Details to follow</strong></p>`
    assert.equal(parseEvents(html, NOW).length, 0)
  })

  it('returns [] for empty input', () => {
    assert.equal(parseEvents('', NOW).length, 0)
  })
})
