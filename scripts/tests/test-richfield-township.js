/**
 * test-richfield-township.js
 *
 * Unit tests for the Richfield Township scraper's pure parsers. Richfield
 * Township runs the Revize Calendar JSON feed (NOT CivicPlus — the CivicPlus
 * iCal endpoint returns empty), the same wire format as Bath Township and the
 * Village of Northfield, so the load-bearing logic is the meeting/notice filter
 * that separates the handful of genuine community events from board meetings,
 * zoning commissions, municipal service notices, and governance sessions.
 *
 * The fixture (fixtures/richfield-township.json) is a verbatim subset of rows
 * captured from the live endpoint (calendar_data_handler.php) on 2026-08-05:
 * `desc`/`image` arrive URL-encoded, `start`/`end` are zone-less local-Eastern
 * strings, and `location` is a mix of "Name, Street, City, ST ZIP" and bare
 * "Street, City, ST ZIP" values.
 *
 * Run:
 *   node --test scripts/tests/test-richfield-township.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  isPublicCommunityEvent,
  revizeIsoToUtc,
  extractImageUrl,
  parseLocation,
  resolveVenueSpec,
  normalizeSourceUrl,
  decodeDescription,
  isWithinWindow,
  buildRow,
} from '../scrape-richfield-township.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/richfield-township.json'), 'utf8'),
)
const byTitle = t => FIXTURE.find(e => e.title === t)

// ── isPublicCommunityEvent ───────────────────────────────────────────────────

describe('isPublicCommunityEvent', () => {
  const KEEP = [
    'Community Day',
    'Snowbird Festival',
    'Richfield Community Day',
    'Furnace Run River Health Workshop',
    'Rain Barrell Workshop',
    'Watershed Tour of Furnace Run',
    'Furnace Run Watershed Presentation',
    'Rain Garden Workshop',
    'Akron Symphonic Winds Celebrate The 250th Anniversary of America',
  ]
  const DROP = [
    'Regular Trustee Meeting',
    'Special Trustee Meeting',
    'Zoning Commission Meeting',
    'Board of Zoning Appeals Meeting',
    'Joint Economic Development District Meeting',
    'Content Editing Training (Part 2)',
    'Logo Design Meeting',
    '2026 Property Valuation Meeting',
    'Comprehensive Land Use Plan Community Open House',
    'Comprehensive Land Use Plan North End Public Input Workshop',
    'Brush Chipping Program',
    'Free Brush Chipping Program',
    'Voting - Primary Election',
    'Richfield Village Hummus & Wood Chip Giveaway',
    // Cancelled rows (only the cancel guard catches these).
    'Cancelled - Regular Trustee Meeting',
    'Snowbird Festival - CANCELLED',
  ]

  for (const t of KEEP) {
    it(`keeps community event: ${t}`, () => assert.equal(isPublicCommunityEvent(t), true))
  }
  for (const t of DROP) {
    it(`drops government / notice row: ${t}`, () => assert.equal(isPublicCommunityEvent(t), false))
  }

  it('rejects empty / whitespace / null titles', () => {
    assert.equal(isPublicCommunityEvent(''), false)
    assert.equal(isPublicCommunityEvent('   '), false)
    assert.equal(isPublicCommunityEvent(null), false)
  })

  it('every fixture keeper passes and every fixture non-event fails', () => {
    for (const ev of FIXTURE) {
      const kept = isPublicCommunityEvent(ev.title)
      const expected = KEEP.includes(ev.title)
      assert.equal(kept, expected, `${ev.title} → ${kept}, expected ${expected}`)
    }
  })
})

// ── revizeIsoToUtc ───────────────────────────────────────────────────────────

describe('revizeIsoToUtc', () => {
  it('converts a summer (EDT) local time, offset 4h', () => {
    assert.equal(revizeIsoToUtc('2026-07-14T19:00:00'), '2026-07-14T23:00:00.000Z')
  })
  it('converts a winter (EST) local time, offset 5h', () => {
    assert.equal(revizeIsoToUtc('2026-01-08T18:00:00'), '2026-01-08T23:00:00.000Z')
  })
  it('tolerates a stray trailing Z (feed is always local Eastern)', () => {
    assert.equal(revizeIsoToUtc('2026-07-14T19:00:00Z'), '2026-07-14T23:00:00.000Z')
  })
  it('returns null for empty input', () => {
    assert.equal(revizeIsoToUtc(''), null)
    assert.equal(revizeIsoToUtc(null), null)
  })
})

// ── parseLocation ────────────────────────────────────────────────────────────

describe('parseLocation', () => {
  it('splits a name-first "Name, Street, City, ST ZIP" location', () => {
    assert.deepEqual(
      parseLocation('Revere High School, 3420 Everett Road, Richfield, OH 44286'),
      { name: 'Revere High School', address: '3420 Everett Road' },
    )
  })
  it('keeps a name-first location with no numeric street as name-only', () => {
    assert.deepEqual(
      parseLocation('Brushwood Lodge, Furnace Run Metro Park'),
      { name: 'Brushwood Lodge', address: null },
    )
  })
  it('treats a single-segment place as name-only', () => {
    assert.deepEqual(
      parseLocation('Everett Road Covered Bridge Parking Lot'),
      { name: 'Everett Road Covered Bridge Parking Lot', address: null },
    )
  })
  it('flags a bare address-first location (no venue name)', () => {
    assert.deepEqual(
      parseLocation('3038 Boston Mills Road, Brecksville, OH 44141'),
      { name: null, address: '3038 Boston Mills Road' },
    )
  })
  it('returns null for an empty string', () => {
    assert.equal(parseLocation(''), null)
    assert.equal(parseLocation(null), null)
  })
})

// ── resolveVenueSpec ─────────────────────────────────────────────────────────

describe('resolveVenueSpec', () => {
  it('uses the named venue and pins the city to Summit (Richfield)', () => {
    const v = resolveVenueSpec('Richfield Heritage Preserve, 4374 Broadview Road, Richfield, OH 44286')
    assert.equal(v.name, 'Richfield Heritage Preserve')
    assert.equal(v.address, '4374 Broadview Road')
    assert.equal(v.city, 'Richfield')
  })
  it('keeps a named venue without a numeric street (address null)', () => {
    const v = resolveVenueSpec('Brushwood Lodge, Furnace Run Metro Park')
    assert.equal(v.name, 'Brushwood Lodge')
    assert.equal(v.address, null)
  })
  it('falls back to the township venue for a bare address-first location', () => {
    // The township office carries a Brecksville mailing city; it must still
    // resolve to a Summit-city township venue, never route the event out.
    const v = resolveVenueSpec('3038 Boston Mills Road, Brecksville, OH 44141')
    assert.equal(v.name, 'Richfield Township')
    assert.equal(v.city, 'Richfield')
  })
  it('falls back to the township venue for empty / "Richfield Township"', () => {
    assert.equal(resolveVenueSpec('').name, 'Richfield Township')
    assert.equal(resolveVenueSpec('Richfield Township').name, 'Richfield Township')
    assert.equal(resolveVenueSpec(null).name, 'Richfield Township')
  })
})

// ── normalizeSourceUrl ───────────────────────────────────────────────────────

describe('normalizeSourceUrl', () => {
  it('rewrites the internal Revize builder host to the public origin', () => {
    assert.equal(
      normalizeSourceUrl('https://webgen1.revize.com/revize/richfieldtwpoh/some/page.php'),
      'https://richfield-twp.org/some/page.php',
    )
  })
  it('passes an external URL through unchanged', () => {
    assert.equal(
      normalizeSourceUrl('https://www.bathrichfieldkiwanis.org/community-days/'),
      'https://www.bathrichfieldkiwanis.org/community-days/',
    )
  })
  it('returns null for empty / relative / non-http values', () => {
    assert.equal(normalizeSourceUrl(''), null)
    assert.equal(normalizeSourceUrl('../government/agendas___minutes.php'), null)
    assert.equal(normalizeSourceUrl(null), null)
  })
})

// ── decodeDescription ────────────────────────────────────────────────────────

describe('decodeDescription', () => {
  it('decodes a URL-encoded plain-text desc', () => {
    const text = decodeDescription(byTitle('Snowbird Festival').desc)
    assert.match(text, /Please visit the Richfield Heritage Preserve website/)
    assert.doesNotMatch(text, /%20/)
  })
  it('decodes URL-encoded HTML to plain text (tags stripped)', () => {
    const text = decodeDescription(
      byTitle('Akron Symphonic Winds Celebrate The 250th Anniversary of America').desc,
    )
    assert.match(text, /40-piece Akron Symphonic Winds orchestra/)
    assert.doesNotMatch(text, /<span/)
  })
  it('returns null for empty desc', () => {
    assert.equal(decodeDescription(''), null)
    assert.equal(decodeDescription(null), null)
  })
})

// ── extractImageUrl ──────────────────────────────────────────────────────────

describe('extractImageUrl', () => {
  it('drops the Revize placeholder asset the live feed always ships', () => {
    assert.equal(extractImageUrl(byTitle('Snowbird Festival').image), null)
  })
  it('drops the noimage.gif variant', () => {
    assert.equal(extractImageUrl(byTitle('Community Day').image), null)
  })
  it('passes an absolute http(s) src through unchanged', () => {
    assert.equal(
      extractImageUrl('<img src="https://cdn.example.com/a.jpg"/>'),
      'https://cdn.example.com/a.jpg',
    )
  })
  it('returns null when there is no <img>', () => {
    assert.equal(extractImageUrl(''), null)
    assert.equal(extractImageUrl(null), null)
  })
})

// ── isWithinWindow ───────────────────────────────────────────────────────────

describe('isWithinWindow', () => {
  const now = Date.parse('2026-07-01T12:00:00Z')
  it('keeps a future event inside the 180-day horizon', () => {
    assert.equal(isWithinWindow('2026-07-14T23:00:00.000Z', '2026-07-15T01:00:00.000Z', now), true)
  })
  it('drops an event that ended long ago', () => {
    assert.equal(isWithinWindow('2024-01-21T18:00:00.000Z', '2024-01-21T21:00:00.000Z', now), false)
  })
  it('drops an event beyond the 180-day horizon', () => {
    assert.equal(isWithinWindow('2027-06-01T14:00:00.000Z', null, now), false)
  })
  it('keeps a same-day event within the grace window', () => {
    assert.equal(isWithinWindow('2026-07-01T01:00:00.000Z', '2026-07-01T02:00:00.000Z', now), true)
  })
})

// ── buildRow ─────────────────────────────────────────────────────────────────

describe('buildRow', () => {
  it('returns null for government / notice rows', () => {
    assert.equal(buildRow(byTitle('Regular Trustee Meeting')), null)
    assert.equal(buildRow(byTitle('Zoning Commission Meeting')), null)
    assert.equal(buildRow(byTitle('Board of Zoning Appeals Meeting')), null)
    assert.equal(buildRow(byTitle('Brush Chipping Program')), null)
    assert.equal(buildRow(byTitle('Voting - Primary Election')), null)
    assert.equal(buildRow(byTitle('Logo Design Meeting')), null)
  })

  it('builds a complete row for the Akron Symphonic Winds concert', () => {
    const { row, venueSpec } = buildRow(
      byTitle('Akron Symphonic Winds Celebrate The 250th Anniversary of America'),
    )
    assert.equal(row.title, 'Akron Symphonic Winds Celebrate The 250th Anniversary of America')
    // 7:00 PM ET in July (EDT, UTC-4) → 23:00Z; 9:00 PM → 01:00Z next day.
    assert.equal(row.start_at, '2026-07-14T23:00:00.000Z')
    assert.equal(row.end_at, '2026-07-15T01:00:00.000Z')
    assert.equal(row.source, 'richfield_township')
    assert.equal(row.source_id, 'revize_103')
    assert.equal(row.status, 'published')
    assert.equal(row.price_min, null)
    assert.equal(row.price_max, null)
    assert.equal(row.image_url, null) // placeholder stripped
    assert.deepEqual(row.tags, ['richfield-township', 'summit-county'])
    // No per-event URL → source_url falls back to the public calendar page.
    assert.equal(row.ticket_url, null)
    assert.equal(row.source_url, 'https://richfield-twp.org/calendar.php')
    assert.equal(venueSpec.name, 'Revere High School')
  })

  it('uses the external event URL for both ticket and source when present', () => {
    const { row, venueSpec } = buildRow(byTitle('Community Day'))
    assert.equal(row.ticket_url, 'https://www.bathrichfieldkiwanis.org/community-days/')
    assert.equal(row.source_url, 'https://www.bathrichfieldkiwanis.org/community-days/')
    assert.equal(row.source_id, 'revize_10')
    // Bare address-first location → township-wide default venue.
    assert.equal(venueSpec.name, 'Richfield Township')
  })

  it('resolves a named venue and the calendar-page source_url for a url-less event', () => {
    const { row, venueSpec } = buildRow(byTitle('Snowbird Festival'))
    assert.equal(row.source_id, 'revize_44')
    assert.equal(row.ticket_url, null)
    assert.equal(row.source_url, 'https://richfield-twp.org/calendar.php')
    assert.equal(venueSpec.name, 'Richfield Heritage Preserve')
    assert.equal(venueSpec.city, 'Richfield')
  })

  it('appends the occurrence date to a recurring event source_id', () => {
    // Synthetic: no recurring community events exist in the live feed today, but
    // the id contract must stay collision-free if that changes.
    const { row } = buildRow({
      title: 'Richfield Farmers Market', rid: '900', id: '900',
      rrule: 'DTSTART:20260801T090000\nRRULE:FREQ=WEEKLY',
      start: '2026-08-01T09:00:00', end: '2026-08-01T13:00:00',
      location: 'Richfield Woods Park, 4100 Broadview Road', url: '', desc: '', image: '',
    })
    assert.equal(row.source_id, 'revize_900-2026-08-01')
  })
})
