/**
 * test-downtown-cf.js
 *
 * Unit tests for the Downtown Cuyahoga Falls (downtowncf.com, Drupal) scraper's
 * pure parsers. The load-bearing logic is: (1) enumerating event slugs from the
 * server-rendered /events list anchors (dropping the community-calendar pointer
 * and de-duping the image+text links), and (2) reading each field from the
 * server-rendered detail page — title, date (no year → inferred), time range
 * ("3-8PM", "Varies"), description (meta), and the optional GPS-LOCATION address.
 *
 * Fixtures are verbatim markup captured from the live site on 2026-08-05:
 *   downtown-cf-list.html                    — the /events list anchors
 *   downtown-cf-detail-nightmare.html        — single day + "3-8PM" + GPS
 *   downtown-cf-detail-oktoberfest.html      — multi-day "Sept 18-20" + "Varies"
 *   downtown-cf-detail-trick-or-treat.html   — single day + "2-4PM"
 *
 * Run:
 *   node --test scripts/tests/test-downtown-cf.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  SOURCE_KEY,
  parseListItems,
  parseDetail,
  parseGpsLocation,
  parseDateRange,
  parseTimeRange,
  parseCategory,
  buildRow,
  slugify,
} from '../scrape-downtown-cf.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fx = (name) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf8')
const LIST = fx('downtown-cf-list.html')
const NIGHTMARE = fx('downtown-cf-detail-nightmare.html')
const OKTOBERFEST = fx('downtown-cf-detail-oktoberfest.html')
const TRICK = fx('downtown-cf-detail-trick-or-treat.html')

// Fixed "now" so year inference is deterministic. Aug 1 2026 → Sep/Oct 2026.
const NOW = new Date('2026-08-01T12:00:00Z')

describe('SOURCE_KEY', () => {
  it('is downtown_cf', () => assert.equal(SOURCE_KEY, 'downtown_cf'))
})

// ── parseListItems ───────────────────────────────────────────────────────────

describe('parseListItems (real list fixture)', () => {
  const items = parseListItems(LIST)

  it('enumerates the three real event slugs, de-duped', () => {
    assert.deepEqual(items.map(i => i.slug), [
      'oktoberfest',
      'downtown-trick-or-treat',
      'nightmare-front-street',
    ])
  })

  it('drops the community-calendar pointer and the bare /events nav link', () => {
    const slugs = items.map(i => i.slug)
    assert.ok(!slugs.includes('community-calendar'))
    assert.ok(!slugs.includes('events'))
  })
})

// ── parseDetail ──────────────────────────────────────────────────────────────

describe('parseDetail (real detail fixtures)', () => {
  it('reads title/date/time/description/GPS from the nightmare page', () => {
    const d = parseDetail(NIGHTMARE)
    assert.equal(d.title, 'Nightmare on Front Street')
    assert.equal(d.dateText, 'Oct 17')
    assert.equal(d.timeText, '3-8PM')
    assert.match(d.description, /5-hour Halloween inspired event/)
    assert.equal(d.gps, '2085 Front Street, Cuyahoga Falls OH 44221')
  })

  it('reads a multi-day date and "Varies" time from the oktoberfest page', () => {
    const d = parseDetail(OKTOBERFEST)
    assert.equal(d.title, 'Oktoberfest')
    assert.equal(d.dateText, 'Sept 18-20')
    assert.equal(d.timeText, 'Varies')
    assert.equal(d.gps, null)
  })
})

describe('parseGpsLocation', () => {
  it('extracts the address from an italic GPS line', () => {
    assert.equal(
      parseGpsLocation('<p><em>GPS LOCATION: 2085 Front Street, Cuyahoga Falls OH 44221</em></p>'),
      '2085 Front Street, Cuyahoga Falls OH 44221',
    )
  })
  it('returns null when no GPS line is present', () => {
    assert.equal(parseGpsLocation('<p>no location here</p>'), null)
  })
})

// ── parseDateRange ───────────────────────────────────────────────────────────

describe('parseDateRange', () => {
  it('parses a single day (year inferred forward)', () => {
    assert.deepEqual(parseDateRange('Oct 17', NOW), { startYmd: '2026-10-17', endYmd: null })
  })
  it('parses a same-month range as multi-day', () => {
    assert.deepEqual(parseDateRange('Sept 18-20', NOW), { startYmd: '2026-09-18', endYmd: '2026-09-20' })
  })
  it('parses a cross-month range defensively', () => {
    assert.deepEqual(parseDateRange('Sept 30-Oct 2', NOW), { startYmd: '2026-09-30', endYmd: '2026-10-02' })
  })
  it('returns null for VARIOUS / unparseable', () => {
    assert.equal(parseDateRange('VARIOUS', NOW), null)
    assert.equal(parseDateRange('', NOW), null)
  })
  // Year inference uses the shared nearest-year rule (scripts/lib/year-inference.js,
  // ±182 days): a just-past listing stays this year rather than jumping ~12
  // months ahead; only a date well behind today rolls forward.
  it('keeps a recently-past month/day in the current year (nearest year)', () => {
    const decNow = new Date('2026-12-01T12:00:00-05:00')
    assert.deepEqual(parseDateRange('Oct 17', decNow), { startYmd: '2026-10-17', endYmd: null })
  })
  it('keeps a one-day-old listing in the current year', () => {
    assert.deepEqual(parseDateRange('Oct 11', new Date('2026-10-12T12:00:00-04:00')), { startYmd: '2026-10-11', endYmd: null })
    assert.deepEqual(parseDateRange('Oct 11', new Date('2026-10-25T12:00:00-04:00')), { startYmd: '2026-10-11', endYmd: null })
  })
  it('rolls forward when next year is the nearer occurrence', () => {
    assert.deepEqual(parseDateRange('Feb 10', new Date('2026-11-14T12:00:00-05:00')), { startYmd: '2027-02-10', endYmd: null })
    assert.deepEqual(parseDateRange('Jan 10', new Date('2026-12-20T12:00:00-05:00')), { startYmd: '2027-01-10', endYmd: null })
  })
  it('rolls back across New Year ("Dec 30" seen Jan 3 → previous year)', () => {
    assert.deepEqual(parseDateRange('Dec 30', new Date('2027-01-03T12:00:00-05:00')), { startYmd: '2026-12-30', endYmd: null })
  })
  it('anchors a Dec→Jan cross-month range on the start year, before and during the run', () => {
    const expected = { startYmd: '2026-12-30', endYmd: '2027-01-02' }
    assert.deepEqual(parseDateRange('Dec 30-Jan 2', new Date('2026-12-15T12:00:00-05:00')), expected)
    assert.deepEqual(parseDateRange('Dec 30-Jan 2', new Date('2027-01-01T12:00:00-05:00')), expected)
  })
  it('keeps a long range in progress in the current year (overlap-aware)', () => {
    assert.deepEqual(parseDateRange('Mar 1-Oct 31', new Date('2026-10-15T12:00:00-04:00')), { startYmd: '2026-03-01', endYmd: '2026-10-31' })
    assert.deepEqual(parseDateRange('Jun 1-Dec 31', new Date('2026-12-20T12:00:00-05:00')), { startYmd: '2026-06-01', endYmd: '2026-12-31' })
  })
  it('returns null for an impossible date (Feb 29 in a non-leap year)', () => {
    assert.equal(parseDateRange('Feb 29', new Date('2026-11-14T12:00:00-05:00')), null)
    assert.equal(parseDateRange('Feb 27-29', new Date('2026-11-14T12:00:00-05:00')), null)
  })
})

// ── parseTimeRange ───────────────────────────────────────────────────────────

describe('parseTimeRange', () => {
  it('applies the end meridiem to a bare start ("3-8PM")', () => {
    assert.deepEqual(parseTimeRange('3-8PM'), { startTime: '15:00', endTime: '20:00' })
  })
  it('parses "2-4PM"', () => {
    assert.deepEqual(parseTimeRange('2-4PM'), { startTime: '14:00', endTime: '16:00' })
  })
  it('returns nulls for "Varies"', () => {
    assert.deepEqual(parseTimeRange('Varies'), { startTime: null, endTime: null })
  })
})

// ── parseCategory ────────────────────────────────────────────────────────────

describe('parseCategory', () => {
  it('defaults downtown street events to festival', () => {
    assert.equal(parseCategory('Nightmare on Front Street'), 'festival')
    assert.equal(parseCategory('Oktoberfest'), 'festival')
  })
})

describe('slugify', () => {
  it('slugifies titles for the fallback slug', () => {
    assert.equal(slugify('Nightmare on Front Street'), 'nightmare-on-front-street')
    assert.equal(slugify('Rock & Roll'), 'rock-and-roll')
  })
})

// ── buildRow (detail → row) ──────────────────────────────────────────────────

describe('buildRow', () => {
  it('builds a single-day row with correct Eastern→UTC times', () => {
    const d = parseDetail(NIGHTMARE)
    const row = buildRow({ slug: 'nightmare-front-street', ...d }, { now: NOW })
    // 3:00 PM ET (EDT, UTC-4) → 19:00Z; 8:00 PM → 00:00Z next day.
    assert.equal(row.start_at, '2026-10-17T19:00:00.000Z')
    assert.equal(row.end_at, '2026-10-18T00:00:00.000Z')
    assert.equal(row.title, 'Nightmare on Front Street')
    assert.equal(row.source, 'downtown_cf')
    assert.equal(row.source_id, 'nightmare-front-street-2026-10-17')
    assert.equal(row.status, 'published')
    assert.equal(row.featured, false)
    assert.equal(row.needs_review, undefined) // stated time → no review flag
    assert.match(row.description, /5-hour Halloween/)
  })

  it('multi-day "Varies" event uses the sanctioned default time + time_inferred', () => {
    const d = parseDetail(OKTOBERFEST)
    const row = buildRow({ slug: 'oktoberfest', ...d }, { now: NOW })
    // 12:00 PM ET default start → 16:00Z on the first day; 8:00 PM default end
    // → 00:00Z after the LAST day.
    assert.equal(row.start_at, '2026-09-18T16:00:00.000Z')
    assert.equal(row.end_at, '2026-09-21T00:00:00.000Z')
    // buildRow no longer sets needs_review itself — it flags the transient
    // time_inferred key and upsertEventSafe (scripts/lib/inferred-time.js)
    // derives needs_review centrally, unless a human has locked start_at.
    assert.equal(row.time_inferred, true)
    assert.equal(row.source_id, 'oktoberfest-2026-09-18')
    assert.equal(row.category, 'festival')
  })

  it('trick-or-treat single day, stated 2-4PM', () => {
    const d = parseDetail(TRICK)
    const row = buildRow({ slug: 'downtown-trick-or-treat', ...d }, { now: NOW })
    assert.equal(row.start_at, '2026-10-11T18:00:00.000Z') // 2 PM EDT → 18:00Z
    assert.equal(row.end_at, '2026-10-11T20:00:00.000Z')   // 4 PM EDT → 20:00Z
    assert.equal(row.needs_review, undefined)
  })

  it('keeps the same source_id when re-scraped the day after the event', () => {
    const d = parseDetail(TRICK)
    const row = buildRow({ slug: 'downtown-trick-or-treat', ...d }, { now: new Date('2026-10-12T12:00:00-04:00') })
    assert.equal(row.source_id, 'downtown-trick-or-treat-2026-10-11')
    assert.equal(row.start_at, '2026-10-11T18:00:00.000Z')
  })

  it('keeps the same source_id for an upcoming event inside the window', () => {
    const row = buildRow({ slug: 'tree-lighting', title: 'Tree Lighting', dateText: 'Nov 28', timeText: '4:30-7PM' },
      { now: new Date('2026-11-14T12:00:00-05:00') })
    assert.equal(row.source_id, 'tree-lighting-2026-11-28')
  })

  it('returns null when the date cannot be parsed', () => {
    assert.equal(buildRow({ slug: 'x', title: 'X', dateText: 'VARIOUS', timeText: '' }, { now: NOW }), null)
  })
})
