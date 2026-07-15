/**
 * test-bath-township.js
 *
 * Unit tests for the Bath Township scraper's pure parsers. Bath Township runs
 * the same Revize JSON feed as the City of Akron, but it is a TOWNSHIP
 * GOVERNMENT calendar, so the load-bearing logic is the meeting/closure filter
 * that separates the handful of genuine community events from board meetings,
 * zoning commissions, committee sessions, and holiday office closures.
 *
 * The fixture mirrors real feed rows captured from the live endpoint
 * (calendar_data_handler.php): `desc`/`image` arrive URL-encoded, `start`/`end`
 * are zone-less local-Eastern strings, and `location` is usually a bare street
 * address. Encoded fields are built with encodeURIComponent so the fixture
 * matches the wire format exactly.
 *
 * Run:
 *   node --test scripts/tests/test-bath-township.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  isPublicCommunityEvent,
  revizeIsoToUtc,
  extractImageUrl,
  resolveVenueSpec,
  normalizeSourceUrl,
  decodeDescription,
  isWithinWindow,
  buildRow,
} from '../scrape-bath-township.js'

const enc = s => encodeURIComponent(s)
const PLACEHOLDER = '<img src="/revize/plugins/_editforms_/v2/images/placeholder.png" alt="Revize update image"/>'

// ── Realistic feed rows ──────────────────────────────────────────────────────
// Seven genuine community events + a representative slice of the government
// noise the feed is dominated by.
const FIXTURE = [
  // Real community events ------------------------------------------------------
  {
    title: 'Bath Art Festival', rid: '77', id: '77',
    start: '2026-06-07T10:00:00', end: '2026-06-07T17:00:00',
    location: '1615 N Cleveland-Massillon Rd', url: 'https://www.bathartfestival.com/',
    desc: '', image: enc(PLACEHOLDER),
  },
  {
    title: 'Celebrate America 250', rid: '75', id: '75',
    start: '2026-06-06T10:00:00', end: '2026-06-06T20:00:00',
    location: '1615 N Cleveland-Massillon Rd',
    url: 'https://builder1.revize.com/revize/bathtownshipoh/celebrate_america_250/index.php',
    desc: '', image: enc('<img src="./Events/America 250/AM 250 logo - tight borders.png" alt="logo"/>'),
  },
  {
    title: '24th Annual Barn Social', rid: '54', id: '54',
    start: '2026-09-16T18:00:00', end: '2026-09-16T20:00:00',
    location: '', url: '',
    desc: enc('<p>The 24th Annual Heritage Corridors of Bath Barn Social is scheduled to take place on Wednesday, September 16th from 6:00pm-8:00pm.</p>'),
    image: enc(PLACEHOLDER),
  },
  {
    title: 'Project Pride', rid: '68', id: '68',
    start: '2026-04-25T09:00:00', end: '2026-04-25T12:00:00',
    location: '', url: '',
    desc: enc('<p>More details to come!</p>'),
    image: enc('<img src="./Events/Project Pride/2024 Project Pride.jpg" alt="Project Pride"/>'),
  },
  {
    title: 'Memorial Day Observance Program', rid: '62', id: '62',
    start: '2026-05-25T12:00:00', end: '2026-05-25T12:30:00',
    location: '1241 N. Cleveland Massillon Road', url: '',
    desc: enc('<p>Bath Township will host the 24th Annual Memorial Day Observance Ceremony on Monday, May 25, 2026 at 12:00 noon at the Bath Township Veterans Memorial.</p>'),
    image: enc(PLACEHOLDER),
  },
  {
    title: 'Spring Into Nature w/STEM', rid: '71', id: '71',
    start: '2026-05-17T13:00:00', end: '2026-05-17T16:00:00',
    location: '4160 Ira Road', url: '',
    desc: enc('<p>More details to come!</p>'), image: enc(PLACEHOLDER),
  },
  {
    title: 'BBA - Bath Garage Sale', rid: '72', id: '72',
    start: '2026-01-10T12:00:00', end: '2026-01-10T16:00:00',
    location: 'Bath Township', url: '',
    desc: enc('<p>Come enjoy the Bath Business Association Garage Sale!</p>'), image: enc(PLACEHOLDER),
  },

  // Government noise (all must be dropped) --------------------------------------
  {
    title: 'Board of Trustees - Regular Meeting', rid: '10', id: '10',
    start: '2026-09-08T18:30:00', end: '2026-09-08T19:30:00',
    location: '3864 West Bath Road', url: '', desc: '', image: enc(PLACEHOLDER),
  },
  {
    title: 'Zoning Commission', rid: '11', id: '11', rrule: 'DTSTART:20260108T180000\nRRULE:FREQ=MONTHLY',
    start: '2026-09-10T18:00:00', end: '2026-09-10T19:00:00',
    location: '3864 West Bath Road', url: '', desc: '', image: enc(PLACEHOLDER),
  },
  {
    title: "NEW YEAR'S EVE", rid: '1', id: '1',
    start: '2026-12-31T15:39:00', end: '', location: '', url: '', desc: '', image: enc(PLACEHOLDER),
  },
  {
    title: "NEW YEAR'S DAY / Township Offices Closed", rid: '2', id: '2',
    start: '2027-01-01T00:00:00', end: '', location: '', url: '', desc: '', image: enc(PLACEHOLDER),
  },
  {
    title: 'Heritage Corridors of Bath', rid: '20', id: '20',
    start: '2026-11-04T16:30:00', end: '2026-11-04T17:30:00',
    location: '3864 West Bath Road', url: '', desc: '', image: enc(PLACEHOLDER),
  },
  {
    title: 'Content Editing Training (Part 1)', rid: '13', id: '13',
    start: '2026-08-20T13:00:00', end: '2026-08-20T14:25:00',
    location: '', url: '', desc: '', image: enc(PLACEHOLDER),
  },
  {
    title: '**CANCELLED**&nbsp; Water and Sewer District Board', rid: '30', id: '30',
    start: '2026-09-20T18:00:00', end: '2026-09-20T19:00:00',
    location: '3864 West Bath Road', url: '', desc: '', image: enc(PLACEHOLDER),
  },
  {
    title: 'Discover Bath Barns Committee', rid: '40', id: '40',
    start: '2026-08-11T17:00:00', end: '2026-08-11T18:00:00',
    location: '1104 W Bath Road', url: '', desc: '', image: enc(PLACEHOLDER),
  },
]

const byTitle = t => FIXTURE.find(e => e.title === t)

// ── isPublicCommunityEvent ───────────────────────────────────────────────────

describe('isPublicCommunityEvent', () => {
  const KEEP = [
    'Bath Art Festival', 'Celebrate America 250', '24th Annual Barn Social',
    'Project Pride', 'Memorial Day Observance Program', 'Spring Into Nature w/STEM',
    'BBA - Bath Garage Sale',
  ]
  const DROP = [
    'Board of Trustees - Regular Meeting', 'Board of Trustees - Work Session',
    'Zoning Commission', 'Board of Zoning Appeals', 'Appearance Review Commission',
    'Water and Sewer District Board', 'Park Board', 'Bath Business Association Meeting',
    'Heritage Corridors of Bath', 'Discover Bath Barns Committee',
    'Content Editing Training (Part 1)', "NEW YEAR'S EVE",
    "MARTIN LUTHER KING JR DAY / Township Offices Closed",
    'Board of Trustees - Public Hearing', 'Zoning Commission - CANCELED',
    '**CANCELLED**&nbsp; Water and Sewer District Board',
    // Cancelled / postponed COMMUNITY events (nothing but the cancel guard
    // catches these — they are otherwise real, keepable events).
    'Bath Art Festival - CANCELLED', 'Project Pride - CANCELED',
    'Memorial Day Observance Program - Postponed',
  ]

  for (const t of KEEP) {
    it(`keeps community event: ${t}`, () => assert.equal(isPublicCommunityEvent(t), true))
  }
  for (const t of DROP) {
    it(`drops government row: ${t}`, () => assert.equal(isPublicCommunityEvent(t), false))
  }

  it('rejects empty / whitespace titles', () => {
    assert.equal(isPublicCommunityEvent(''), false)
    assert.equal(isPublicCommunityEvent('   '), false)
    assert.equal(isPublicCommunityEvent(null), false)
  })

  it('does not confuse "BBA Garage Sale" with the Business Association MEETING', () => {
    assert.equal(isPublicCommunityEvent('BBA - Bath Garage Sale'), true)
    assert.equal(isPublicCommunityEvent('Bath Business Association Meeting'), false)
  })
})

// ── revizeIsoToUtc ───────────────────────────────────────────────────────────

describe('revizeIsoToUtc', () => {
  it('converts a summer (EDT) local time, offset 4h', () => {
    assert.equal(revizeIsoToUtc('2026-06-07T10:00:00'), '2026-06-07T14:00:00.000Z')
  })
  it('converts a winter (EST) local time, offset 5h', () => {
    assert.equal(revizeIsoToUtc('2026-01-10T12:00:00'), '2026-01-10T17:00:00.000Z')
  })
  it('tolerates a stray trailing Z (feed is always local Eastern)', () => {
    assert.equal(revizeIsoToUtc('2026-06-07T10:00:00Z'), '2026-06-07T14:00:00.000Z')
  })
  it('returns null for empty input', () => {
    assert.equal(revizeIsoToUtc(''), null)
    assert.equal(revizeIsoToUtc(null), null)
  })
})

// ── extractImageUrl ──────────────────────────────────────────────────────────

describe('extractImageUrl', () => {
  it('drops Revize placeholder assets', () => {
    assert.equal(extractImageUrl(enc(PLACEHOLDER)), null)
  })
  it('resolves a "./Events/…" relative path and percent-encodes spaces', () => {
    assert.equal(
      extractImageUrl(byTitle('Celebrate America 250').image),
      'https://www.bathtownship.org/Events/America%20250/AM%20250%20logo%20-%20tight%20borders.png',
    )
  })
  it('resolves the Project Pride relative jpg', () => {
    assert.equal(
      extractImageUrl(byTitle('Project Pride').image),
      'https://www.bathtownship.org/Events/Project%20Pride/2024%20Project%20Pride.jpg',
    )
  })
  it('passes an absolute http(s) src through unchanged', () => {
    assert.equal(
      extractImageUrl(enc('<img src="https://cdn.example.com/a.jpg"/>')),
      'https://cdn.example.com/a.jpg',
    )
  })
  it('upgrades a protocol-relative src to https', () => {
    assert.equal(extractImageUrl(enc('<img src="//cdn.example.com/a.jpg"/>')), 'https://cdn.example.com/a.jpg')
  })
  it('returns null when there is no <img>', () => {
    assert.equal(extractImageUrl(''), null)
    assert.equal(extractImageUrl(null), null)
  })
})

// ── resolveVenueSpec ─────────────────────────────────────────────────────────

describe('resolveVenueSpec', () => {
  it('maps 4160 Ira Road → Bath Nature Preserve', () => {
    assert.equal(resolveVenueSpec('4160 Ira Road').name, 'Bath Nature Preserve')
  })
  it('maps 1615 N Cleveland-Massillon Rd → Bath Community Park', () => {
    const v = resolveVenueSpec('1615 N Cleveland-Massillon Rd')
    assert.equal(v.name, 'Bath Community Park')
    assert.equal(v.address, '1615 N Cleveland-Massillon Rd')
  })
  it('maps 1241 N. Cleveland Massillon Road → Veterans Memorial (trailing period tolerated)', () => {
    assert.equal(resolveVenueSpec('1241 N. Cleveland Massillon Road').name, 'Bath Township Veterans Memorial')
  })
  it('falls back to the township venue for empty or "Bath Township" location', () => {
    assert.equal(resolveVenueSpec('').name, 'Bath Township')
    assert.equal(resolveVenueSpec('Bath Township').name, 'Bath Township')
    assert.equal(resolveVenueSpec(null).name, 'Bath Township')
  })
  it('passes an unmapped named place through as its own venue', () => {
    assert.equal(resolveVenueSpec('Revere High School').name, 'Revere High School')
  })
})

// ── normalizeSourceUrl ───────────────────────────────────────────────────────

describe('normalizeSourceUrl', () => {
  it('rewrites the internal Revize builder host to the public origin', () => {
    assert.equal(
      normalizeSourceUrl('https://builder1.revize.com/revize/bathtownshipoh/celebrate_america_250/index.php'),
      'https://www.bathtownship.org/celebrate_america_250/index.php',
    )
  })
  it('passes an external URL through unchanged', () => {
    assert.equal(normalizeSourceUrl('https://www.bathartfestival.com/'), 'https://www.bathartfestival.com/')
  })
  it('returns null for empty / non-http values', () => {
    assert.equal(normalizeSourceUrl(''), null)
    assert.equal(normalizeSourceUrl('/relative/path'), null)
    assert.equal(normalizeSourceUrl(null), null)
  })
})

// ── decodeDescription ────────────────────────────────────────────────────────

describe('decodeDescription', () => {
  it('decodes URL-encoded HTML to plain text', () => {
    const text = decodeDescription(byTitle('Memorial Day Observance Program').desc)
    assert.match(text, /24th Annual Memorial Day Observance Ceremony/)
    assert.doesNotMatch(text, /<p>/)
  })
  it('returns null for empty desc', () => {
    assert.equal(decodeDescription(''), null)
    assert.equal(decodeDescription(null), null)
  })
})

// ── isWithinWindow ───────────────────────────────────────────────────────────

describe('isWithinWindow', () => {
  const now = Date.parse('2026-07-14T12:00:00Z')
  it('keeps a future event inside the 180-day horizon', () => {
    assert.equal(isWithinWindow('2026-09-16T22:00:00.000Z', '2026-09-17T00:00:00.000Z', now), true)
  })
  it('drops an event that ended weeks ago', () => {
    assert.equal(isWithinWindow('2026-06-07T14:00:00.000Z', '2026-06-07T21:00:00.000Z', now), false)
  })
  it('drops an event beyond the 180-day horizon', () => {
    assert.equal(isWithinWindow('2027-06-01T14:00:00.000Z', null, now), false)
  })
  it('keeps a same-day event within the grace window', () => {
    assert.equal(isWithinWindow('2026-07-14T01:00:00.000Z', '2026-07-14T02:00:00.000Z', now), true)
  })
})

// ── buildRow ─────────────────────────────────────────────────────────────────

describe('buildRow', () => {
  it('returns null for a government meeting row', () => {
    assert.equal(buildRow(byTitle('Board of Trustees - Regular Meeting')), null)
    assert.equal(buildRow(byTitle('Zoning Commission')), null)
    assert.equal(buildRow(byTitle("NEW YEAR'S EVE")), null)
  })

  it('builds a complete row for the Bath Art Festival', () => {
    const { row, venueSpec } = buildRow(byTitle('Bath Art Festival'))
    assert.equal(row.title, 'Bath Art Festival')
    assert.equal(row.start_at, '2026-06-07T14:00:00.000Z')
    assert.equal(row.end_at, '2026-06-07T21:00:00.000Z')
    assert.equal(row.source, 'bath_township')
    assert.equal(row.source_id, 'revize_77')
    assert.equal(row.status, 'published')
    assert.equal(row.price_min, null)
    assert.equal(row.price_max, null)
    // External festival site is the outbound URL for both source + ticket.
    assert.equal(row.ticket_url, 'https://www.bathartfestival.com/')
    assert.equal(row.source_url, 'https://www.bathartfestival.com/')
    assert.equal(venueSpec.name, 'Bath Community Park')
  })

  it('rewrites the builder URL and keeps the landing page only when no url', () => {
    const ca = buildRow(byTitle('Celebrate America 250'))
    assert.equal(ca.row.source_url, 'https://www.bathtownship.org/celebrate_america_250/index.php')

    const barn = buildRow(byTitle('24th Annual Barn Social'))
    assert.equal(barn.row.ticket_url, null)
    assert.equal(
      barn.row.source_url,
      'https://www.bathtownship.org/residents/stay_informed/community_events/index.php',
    )
    assert.equal(barn.venueSpec.name, 'Bath Township')
  })

  it('uses a stable revize_<rid> source_id and no fabricated price', () => {
    const { row } = buildRow(byTitle('Memorial Day Observance Program'))
    assert.equal(row.source_id, 'revize_62')
    assert.equal(row.image_url, null) // placeholder stripped
    assert.equal(row.venueSpec, undefined)
  })

  it('appends the occurrence date to a recurring event source_id', () => {
    // Synthetic: no recurring community events exist in the live feed today,
    // but the id contract must stay collision-free if that changes.
    const built = buildRow({
      title: 'Bath Farmers Market', rid: '999', id: '999',
      rrule: 'DTSTART:20260801T090000\nRRULE:FREQ=WEEKLY',
      start: '2026-08-01T09:00:00', end: '2026-08-01T13:00:00',
      location: '1615 N Cleveland-Massillon Rd', url: '', desc: '', image: '',
    })
    assert.equal(built.row.source_id, 'revize_999-2026-08-01')
  })
})
