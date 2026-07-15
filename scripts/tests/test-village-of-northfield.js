/**
 * test-village-of-northfield.js
 *
 * Unit tests for the Village of Northfield scraper's pure parsers. Northfield
 * runs the same Revize JSON feed (calendar_data_handler.php) as the City of
 * Akron and Bath Township, but it is a small VILLAGE GOVERNMENT calendar, so
 * the load-bearing logic is (1) the meeting/closure/service filter that
 * separates the handful of real public events from council meetings, office
 * closures, and municipal service notices, and (2) the title cleanup, which
 * must decode `&nbsp;`, collapse whitespace, and strip the redundant trailing
 * "- <time>" annotation the village duplicates into every event title.
 *
 * The fixture mirrors real feed rows captured from the live endpoint on
 * 2026-07-15: `start`/`end` are zone-less local-Eastern strings, `location` is
 * a bare street address, `image` is always the Revize placeholder, and one row
 * carries the literal "&nbsp;" the previous build worried about. Where a real
 * row does not exercise an edge case (recurring community events, all-day rows
 * with a time only in the title), a clearly-labelled synthetic row is used.
 *
 * Run:
 *   node --test scripts/tests/test-village-of-northfield.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  isPublicCommunityEvent,
  cleanTitle,
  revizeIsoToUtc,
  extractTimeFromText,
  resolveTimes,
  resolveCategories,
  resolveVenueSpec,
  decodeDescription,
  extractImageUrl,
  isWithinWindow,
  buildRow,
} from '../scrape-village-of-northfield.js'

const enc = s => encodeURIComponent(s)
const PLACEHOLDER = '<img src="/revize/plugins/_editforms_/v2/images/placeholder.png" alt="Revize update image"/>'

// ── Realistic feed rows (captured 2026-07-15) ────────────────────────────────
const FIXTURE = [
  // Real public community events -----------------------------------------------
  {
    // The row whose "&nbsp;" the previous build flagged.
    title: 'Movie at Smith Park - at Dark;&nbsp; MATILDA', rid: '166', id: '166',
    start: '2026-08-08T20:00:00', end: '2026-08-08T22:00:00',
    location: '169 Houghton Rd', url: '', desc: '', image: PLACEHOLDER,
  },
  {
    title: 'Movie at Smith Park - at Dark; K-POP DEMON HUNTERS', rid: '169', id: '169',
    start: '2026-09-12T20:00:00', end: '2026-09-12T22:00:00',
    location: '169 Houghton Rd', url: '', desc: '', image: PLACEHOLDER,
  },
  {
    title: 'Community Party & Movie in the Park', rid: '164', id: '164',
    start: '2026-07-11T16:00:00', end: '2026-07-11T20:00:00',
    location: '169 Houghton Rd', url: '', desc: '', image: PLACEHOLDER,
  },
  {
    // Compound title with two times; only the trailing "-5p" is stripped.
    title: 'Trick or Treat-6p - 8p; Haunted House/Party-5p', rid: '171', id: '171',
    start: '2026-10-31T18:00:00', end: '2026-10-31T20:00:00',
    location: '199 Ledge Rd.', url: '', desc: '', image: PLACEHOLDER,
  },
  {
    title: 'Village Tree Lighting Ceremony - 6p', rid: '172', id: '172',
    start: '2026-11-27T18:00:00', end: '2026-11-27T20:00:00',
    location: '10455 Northfield Rd', url: '', desc: '', image: PLACEHOLDER,
  },

  // Government / municipal noise (all must be dropped) --------------------------
  {
    title: 'Village Council Meeting - 7:30P', rid: '184', id: '184',
    start: '2026-09-09T19:30:00', end: '2026-09-09T20:00:00',
    location: '115 LEDGE RD', url: '', desc: '', image: PLACEHOLDER,
  },
  {
    // Meeting flagged all-day at midnight — still a meeting, still dropped.
    title: 'Village Council Meeting - 7:30P', rid: '49', id: '49',
    start: '2026-08-26T00:00:00', end: '', allDay: true,
    location: '115 LEDGE RD', url: '', desc: '', image: PLACEHOLDER,
  },
  {
    title: 'Village Offices Closed-Holiday', rid: '163', id: '163',
    start: '2026-07-03T00:00:00', end: '', allDay: true,
    location: '199 Ledge Rd.', url: '', desc: '', image: PLACEHOLDER,
  },
  {
    title: 'Senior Trash and Snowplow Sign-ups at 199 Ledge-9/1 - 10/31/26', rid: '167', id: '167',
    start: '2026-09-01T00:00:00', end: '2026-10-31T14:31:00', allDay: true,
    rrule: 'DTSTART:20260901T000000\nRDATE:20260901T000000\nRRULE:FREQ=YEARLY;BYMONTH=9;BYMONTHDAY=1',
    location: '199 Ledge Rd.', url: '', desc: '', image: PLACEHOLDER,
  },
  {
    // Leftover Revize demo calendar row.
    title: 'Lorem Ipsum', primary_calendar_name: 'Testing Calendar', rid: '2', id: '2',
    start: '2021-06-16T20:06:22', end: '', allDay: true,
    location: 'Ohio', url: 'www.revize.com', desc: enc('Event Detail goes here!!'), image: PLACEHOLDER,
  },
]

const byTitle = t => FIXTURE.find(e => e.title === t)

// ── isPublicCommunityEvent ───────────────────────────────────────────────────

describe('isPublicCommunityEvent', () => {
  const KEEP = [
    'Movie at Smith Park - at Dark; MATILDA',
    'Community Party & Movie in the Park',
    'Trick or Treat-6p - 8p; Haunted House/Party',
    'Village Tree Lighting Ceremony',
    'NORTHFIELD VILLAGE CORNHOLE TOURNAMENT and PARTY IN THE PARK',
  ]
  const DROP = [
    'Village Council Meeting', 'Caucus', 'Planning Commission',
    'Board of Zoning Appeals', 'Village Offices Closed-Holiday',
    'Leaf Pick-up Begins', 'Senior Trash and Snowplow Sign-ups',
    'Recycling Reminder', 'Daylight Saving Time - Turn Clocks',
    "Valentine's Day", "St. Patrick's Day", 'Presidents Day',
    // Cancelled / postponed public events must drop even though nothing else
    // in the filter would catch them (they are otherwise real community events).
    'Movie at Smith Park - CANCELLED', 'Trick or Treat - CANCELED',
    'Village Tree Lighting Ceremony - Postponed',
  ]

  for (const t of KEEP) {
    it(`keeps community event: ${t}`, () => assert.equal(isPublicCommunityEvent(t), true))
  }
  for (const t of DROP) {
    it(`drops government / service / bare-holiday row: ${t}`, () => assert.equal(isPublicCommunityEvent(t), false))
  }

  it('rejects empty / whitespace / null titles', () => {
    assert.equal(isPublicCommunityEvent(''), false)
    assert.equal(isPublicCommunityEvent('   '), false)
    assert.equal(isPublicCommunityEvent(null), false)
  })

  it('keeps a real named holiday event but drops the bare observance', () => {
    assert.equal(isPublicCommunityEvent("St. Patrick's Day Parade"), true)
    assert.equal(isPublicCommunityEvent("St. Patrick's Day"), false)
  })
})

// ── cleanTitle ───────────────────────────────────────────────────────────────

describe('cleanTitle', () => {
  it('decodes &nbsp; and collapses the resulting whitespace', () => {
    assert.equal(
      cleanTitle('Movie at Smith Park - at Dark;&nbsp; MATILDA'),
      'Movie at Smith Park - at Dark; MATILDA',
    )
  })
  it('strips a trailing "- 6p" time annotation', () => {
    assert.equal(cleanTitle('Village Tree Lighting Ceremony - 6p'), 'Village Tree Lighting Ceremony')
  })
  it('strips a trailing "- 7:30P" time annotation', () => {
    assert.equal(cleanTitle('Village Council Meeting - 7:30P'), 'Village Council Meeting')
  })
  it('strips only the trailing time on a compound title', () => {
    assert.equal(
      cleanTitle('Trick or Treat-6p - 8p; Haunted House/Party-5p'),
      'Trick or Treat-6p - 8p; Haunted House/Party',
    )
  })
  it('does not strip a trailing date (only clock times)', () => {
    assert.equal(cleanTitle('Resident Garage Sale - 10/31/26'), 'Resident Garage Sale - 10/31/26')
  })
  it('leaves the "at Dark" annotation intact (non-numeric)', () => {
    assert.equal(cleanTitle('Movie at Smith Park - at Dark'), 'Movie at Smith Park - at Dark')
  })
  it('tolerates null / empty input', () => {
    assert.equal(cleanTitle(''), '')
    assert.equal(cleanTitle(null), '')
  })
})

// ── revizeIsoToUtc ───────────────────────────────────────────────────────────

describe('revizeIsoToUtc', () => {
  it('converts a summer (EDT) local time, offset 4h', () => {
    assert.equal(revizeIsoToUtc('2026-08-08T20:00:00'), '2026-08-09T00:00:00.000Z')
  })
  it('converts a late-November (EST) local time, offset 5h', () => {
    assert.equal(revizeIsoToUtc('2026-11-27T18:00:00'), '2026-11-27T23:00:00.000Z')
  })
  it('tolerates a stray trailing Z (feed is always local Eastern)', () => {
    assert.equal(revizeIsoToUtc('2026-08-08T20:00:00Z'), '2026-08-09T00:00:00.000Z')
  })
  it('returns null for empty input', () => {
    assert.equal(revizeIsoToUtc(''), null)
    assert.equal(revizeIsoToUtc(null), null)
  })
})

// ── extractTimeFromText ──────────────────────────────────────────────────────

describe('extractTimeFromText', () => {
  it('extracts and normalizes a terse "6p" to "6pm"', () => {
    assert.equal(extractTimeFromText('Tree Lighting - 6p'), '6pm')
  })
  it('extracts and normalizes "7:30 P" to "7:30pm"', () => {
    assert.equal(extractTimeFromText('Council - 7:30 P'), '7:30pm')
  })
  it('normalizes a terse "9a" to "9am"', () => {
    assert.equal(extractTimeFromText('Shred Day 9a'), '9am')
  })
  it('returns null for a non-numeric time phrase ("at Dark")', () => {
    assert.equal(extractTimeFromText('Movie at Smith Park - at Dark'), null)
  })
  it('returns null when there is no time at all', () => {
    assert.equal(extractTimeFromText('Community Party & Movie in the Park'), null)
    assert.equal(extractTimeFromText(''), null)
    assert.equal(extractTimeFromText(null), null)
  })
})

// ── resolveTimes ─────────────────────────────────────────────────────────────

describe('resolveTimes', () => {
  it('trusts the authoritative start/end for a timed row', () => {
    const r = resolveTimes({ start: '2026-08-08T20:00:00', end: '2026-08-08T22:00:00' }, 'Movie - at Dark')
    assert.equal(r.start_at, '2026-08-09T00:00:00.000Z')
    assert.equal(r.end_at, '2026-08-09T02:00:00.000Z')
    assert.equal(r.allDay, false)
  })
  it('drops a non-sensical end that is not strictly after start', () => {
    const r = resolveTimes({ start: '2026-08-08T20:00:00', end: '2026-08-08T20:00:00' }, 'x')
    assert.equal(r.end_at, null)
  })
  it('mines a time from the title when the row is all-day (synthetic)', () => {
    const r = resolveTimes({ start: '2026-11-27T00:00:00', allDay: true }, 'Village Tree Lighting Ceremony - 6p')
    assert.equal(r.start_at, '2026-11-27T23:00:00.000Z') // 6pm EST
    assert.equal(r.allDay, false)
  })
  it('mines a time when start is exactly midnight even without the allDay flag (synthetic)', () => {
    const r = resolveTimes({ start: '2026-11-27T00:00:00' }, 'Something - 6p')
    assert.equal(r.start_at, '2026-11-27T23:00:00.000Z')
    assert.equal(r.allDay, false)
  })
  it('falls back to an honest all-day midnight when no time can be found', () => {
    const r = resolveTimes({ start: '2026-04-08T00:00:00', allDay: true }, 'Total Solar Eclipse-April 8, 2024')
    assert.equal(r.start_at, '2026-04-08T04:00:00.000Z') // midnight EDT, never a synthesized clock time
    assert.equal(r.end_at, null)
    assert.equal(r.allDay, true)
  })
})

// ── resolveCategories ────────────────────────────────────────────────────────

describe('resolveCategories', () => {
  it('maps a park movie night to film + outdoors', () => {
    assert.deepEqual(resolveCategories('Movie at Smith Park - at Dark; MATILDA'), ['film', 'outdoors'])
  })
  it('maps a plain movie (no park cue) to film only', () => {
    assert.deepEqual(resolveCategories('Movie Night: The Sandlot'), ['film'])
  })
  it('maps Trick-or-Treat and the Tree Lighting to festival', () => {
    assert.deepEqual(resolveCategories('Trick or Treat'), ['festival'])
    assert.deepEqual(resolveCategories('Village Tree Lighting Ceremony'), ['festival'])
  })
  it('returns null for events that should defer to inferCategory', () => {
    assert.equal(resolveCategories('Resident Shred Day'), null)
    assert.equal(resolveCategories('Community Garage Sale'), null)
  })
})

// ── resolveVenueSpec ─────────────────────────────────────────────────────────

describe('resolveVenueSpec', () => {
  it('maps 169 Houghton Rd → Smith Park', () => {
    const v = resolveVenueSpec('169 Houghton Rd')
    assert.equal(v.name, 'Smith Park')
    assert.equal(v.city, 'Northfield')
  })
  it('maps 199 Ledge Rd (trailing period tolerated) → Service Department', () => {
    assert.equal(resolveVenueSpec('199 Ledge Rd.').name, 'Northfield Village Service Department')
  })
  it('maps the municipal-building address to the Village default', () => {
    assert.equal(resolveVenueSpec('10455 Northfield Rd').name, 'Village of Northfield')
  })
  it('falls back to the Village default for empty / unmapped locations', () => {
    assert.equal(resolveVenueSpec('').name, 'Village of Northfield')
    assert.equal(resolveVenueSpec(null).name, 'Village of Northfield')
    assert.equal(resolveVenueSpec('115 LEDGE RD').name, 'Village of Northfield')
  })
})

// ── decodeDescription ────────────────────────────────────────────────────────

describe('decodeDescription', () => {
  it('decodes URL-encoded HTML to plain text', () => {
    const text = decodeDescription(enc('<p>Join us for the annual <b>Tree Lighting</b>!</p>'))
    assert.match(text, /Join us for the annual Tree Lighting!/)
    assert.doesNotMatch(text, /<p>|<b>/)
  })
  it('returns null for empty desc', () => {
    assert.equal(decodeDescription(''), null)
    assert.equal(decodeDescription(null), null)
  })
})

// ── extractImageUrl ──────────────────────────────────────────────────────────

describe('extractImageUrl', () => {
  it('drops the Revize placeholder asset', () => {
    assert.equal(extractImageUrl(PLACEHOLDER), null)
  })
  it('resolves a relative "./Events/…" path against the origin', () => {
    assert.equal(
      extractImageUrl('<img src="./Events/Movie/matilda.jpg"/>'),
      'https://www.northfieldvillage-oh.gov/Events/Movie/matilda.jpg',
    )
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
  const now = Date.parse('2026-07-15T12:00:00Z')
  it('keeps a future event inside the 180-day horizon', () => {
    assert.equal(isWithinWindow('2026-08-09T00:00:00.000Z', '2026-08-09T02:00:00.000Z', now), true)
  })
  it('drops an event that ended weeks ago', () => {
    assert.equal(isWithinWindow('2026-06-14T00:00:00.000Z', '2026-06-14T02:00:00.000Z', now), false)
  })
  it('drops an event beyond the 180-day horizon', () => {
    assert.equal(isWithinWindow('2027-06-01T00:00:00.000Z', null, now), false)
  })
  it('keeps a same-day event within the grace window', () => {
    assert.equal(isWithinWindow('2026-07-15T01:00:00.000Z', '2026-07-15T02:00:00.000Z', now), true)
  })
  it('returns false for a missing start', () => {
    assert.equal(isWithinWindow(null, null, now), false)
  })
})

// ── buildRow ─────────────────────────────────────────────────────────────────

describe('buildRow', () => {
  it('drops government / service / closure / demo rows', () => {
    assert.equal(buildRow(byTitle('Village Council Meeting - 7:30P')), null) // rid 184
    assert.equal(buildRow(FIXTURE.find(e => e.rid === '49')), null)          // all-day meeting
    assert.equal(buildRow(byTitle('Village Offices Closed-Holiday')), null)
    assert.equal(buildRow(byTitle('Senior Trash and Snowplow Sign-ups at 199 Ledge-9/1 - 10/31/26')), null)
    assert.equal(buildRow(byTitle('Lorem Ipsum')), null)                     // Testing Calendar
  })

  it('drops rows missing a title or start', () => {
    assert.equal(buildRow(null), null)
    assert.equal(buildRow({ title: '', start: '2026-08-08T20:00:00' }), null)
    assert.equal(buildRow({ title: 'Movie', start: '' }), null)
  })

  it('builds a complete, clean row for the &nbsp; MATILDA movie night', () => {
    const { row, venueSpec, allDay } = buildRow(byTitle('Movie at Smith Park - at Dark;&nbsp; MATILDA'))
    assert.equal(row.title, 'Movie at Smith Park - at Dark; MATILDA')
    assert.equal(row.start_at, '2026-08-09T00:00:00.000Z')
    assert.equal(row.end_at, '2026-08-09T02:00:00.000Z')
    assert.equal(allDay, false)
    assert.equal(row.source, 'village_of_northfield')
    assert.equal(row.source_id, 'revize_166')
    assert.equal(row.status, 'published')
    assert.equal(row.price_min, null)
    assert.equal(row.price_max, null)
    assert.equal(row.ticket_url, null)
    assert.equal(row.image_url, null) // placeholder stripped
    assert.equal(row.source_url, 'https://www.northfieldvillage-oh.gov/calendar.php')
    assert.deepEqual(row.categories, ['film', 'outdoors'])
    assert.equal(venueSpec.name, 'Smith Park')
  })

  it('resolves the Service Department venue and festival category for Trick-or-Treat', () => {
    const { row, venueSpec } = buildRow(byTitle('Trick or Treat-6p - 8p; Haunted House/Party-5p'))
    assert.equal(row.title, 'Trick or Treat-6p - 8p; Haunted House/Party')
    assert.equal(venueSpec.name, 'Northfield Village Service Department')
    assert.deepEqual(row.categories, ['festival'])
    assert.equal(row.source_id, 'revize_171')
  })

  it('uses a stable revize_<rid> source_id for a non-recurring row', () => {
    assert.equal(buildRow(byTitle('Village Tree Lighting Ceremony - 6p')).row.source_id, 'revize_172')
  })

  it('appends the occurrence date to a recurring community event source_id (synthetic)', () => {
    // No recurring PUBLIC event exists in the live feed today (the only rrule
    // rows are service notices, which are filtered out), but the id contract
    // must stay collision-free if that changes.
    const built = buildRow({
      title: 'Movie at Smith Park - at Dark', rid: '900', id: '900',
      rrule: 'DTSTART:20260801T200000\nRRULE:FREQ=MONTHLY',
      start: '2026-08-01T20:00:00', end: '2026-08-01T22:00:00',
      location: '169 Houghton Rd', url: '', desc: '', image: '',
    })
    assert.equal(built.row.source_id, 'revize_900-2026-08-02')
  })
})
