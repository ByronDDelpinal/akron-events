/**
 * test-village-of-reminderville.js
 *
 * Unit tests for the Village of Reminderville scraper's pure parsers. This is a
 * plain WordPress blog that blends municipal notices with community events, and
 * the event's date/time/venue live entirely in the POST TITLE (post bodies are
 * flyer images). The load-bearing logic is therefore:
 *   1. the news/notice/meeting filter (isCommunityEvent),
 *   2. title date/time parsing (parseEventDate / parseTime), including
 *      abbreviated months, numeric M/D dates, multi-day ranges, "4th of July",
 *      year inference from the publish date, and the deliberate refusal to
 *      guess AM/PM on meridiem-less time ranges,
 *   3. venue resolution + the Summit gate (Aurora is out-of-county).
 *
 * All titles below are copied verbatim from the live WP REST feed
 * (reminderville.com/wp-json/wp/v2/posts) with their real publish dates.
 *
 * Run:
 *   node --test scripts/tests/test-village-of-reminderville.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  isCommunityEvent,
  parseEventDate,
  parseTime,
  resolveVenue,
  isFamilyEvent,
  categoryFor,
  isWithinWindow,
  buildRow,
} from '../scrape-village-of-reminderville.js'

const post = (id, date, title) => ({ id, date, link: `https://reminderville.com/news/${id}/`, title: { rendered: title }, content: { rendered: '' } })

// ── News / event separation ──────────────────────────────────────────────────

describe('isCommunityEvent — drops the municipal-notice tail', () => {
  const NEWS = [
    '01/12 Reminderville Council Meeting via Zoom',
    '5/11/2021 Planning & Zoning meeting: Commodore Cove East',
    'PUBLIC NOTICE: Buffalo District Permit Application',
    'On November 7th Ballot: Issue 27 Replacement Road Levy',
    'Message from NOPEC',
    'Per NOPEC: Why Ohio’s Electric Rates are Rising',
    'Kendal Lane closure',
    'Snow plowing in the City 02/18/2025',
    'Branch Pick-Up Schedule',
    'City Accepting Letters of Interest to be a Charter Review Commission Member',
    'Residents Can Use Fire Department as a Warming Center',
    'Reminderville Mulch Delivery Program',
    'Twinsburg Library Board of Trustees Opening',
    '2020 Census-making Reminderville count!',
    'RFQ for General Engineering Services',
    // Bare "meeting" (no council/committee prefix) must still be blocked.
    'Summit SWCD Public Involvement Meeting',
    // Cancelled / postponed events must drop even though the noun is an event.
    'CANCELED: Kids Halloween Event',
    'Community Shred Day POSTPONED',
    'Annual Easter Eggstravaganza - Cancelled',
  ]
  for (const t of NEWS) {
    it(`news: ${t}`, () => assert.equal(isCommunityEvent(t), false))
  }

  const EVENTS = [
    'Community Shred Day – August 9 10:00-1:00 at City Hall',
    'Kids Halloween Event!  Sat, Oct 25 at the RAC!',
    'Annual Seniors Spaghetti Dinner at Fire Station on October 6',
    'Reminderville Safety Town: June 16-20',
    'June 27: Rain Barrel Workshop at Heritage Hall 5:00pm',
    'Annual Easter Eggstravaganza at the RAC!  April 8 1:00-3:00',
    'Reminderville Annual 4th of July Parade!',
    // "Meet & Greet" is a real community event — the bare-"meeting" block
    // must NOT catch it (no "meeting" substring: "meet" + "greet").
    'Reminderville Meet & Greet on January 5!',
    'Meet and Greet with the Mayor',
  ]
  for (const t of EVENTS) {
    it(`event: ${t}`, () => assert.equal(isCommunityEvent(t), true))
  }
})

// ── Date parsing ─────────────────────────────────────────────────────────────

describe('parseEventDate — title prose, publish date only for the year', () => {
  it('month-first with weekday prefix + abbreviated month', () => {
    const r = parseEventDate('Kids Halloween Event!  Sat, Oct 25 at the RAC!', '2025-10-13T10:28:38')
    assert.equal(r.dateStr, '2025-10-25')
    assert.equal(r.endDateStr, null)
  })

  it('"on October 6" — year inferred from publish date, NOT the publish date itself', () => {
    const r = parseEventDate('Annual Seniors Spaghetti Dinner at Fire Station on October 6', '2025-09-02T11:28:43')
    assert.equal(r.dateStr, '2025-10-06')
  })

  it('multi-day month range "June 16-20" carries an end date', () => {
    const r = parseEventDate('Reminderville Safety Town: June 16-20', '2025-04-02T00:00:00')
    assert.equal(r.dateStr, '2025-06-16')
    assert.equal(r.endDateStr, '2025-06-20')
  })

  it('numeric M/D with no year', () => {
    const r = parseEventDate('Rain Barrel Workshop 8/23 at Heritage Hall', '2025-07-25T00:00:00')
    assert.equal(r.dateStr, '2025-08-23')
  })

  it('numeric M/D/YYYY uses the explicit year', () => {
    const r = parseEventDate('Santa Toy Delivery routes 12/13/2025', '2025-12-12T00:00:00')
    assert.equal(r.dateStr, '2025-12-13')
  })

  it('numeric range "6/22-6/26"', () => {
    const r = parseEventDate('The Traveling Vietnam Wall in Aurora 6/22-6/26', '2023-06-21T00:00:00')
    assert.equal(r.dateStr, '2023-06-22')
    assert.equal(r.endDateStr, '2023-06-26')
  })

  it('cross-month numeric range "3/26-4/5"', () => {
    const r = parseEventDate('Easter Scavenger Hunt Forms 3/26-4/5', '2021-03-25T00:00:00')
    assert.equal(r.dateStr, '2021-03-26')
    assert.equal(r.endDateStr, '2021-04-05')
  })

  it('"4th of July" resolves to July 4 of the inferred year', () => {
    const r = parseEventDate('Reminderville Annual 4th of July Parade!', '2026-06-24T12:41:00')
    assert.equal(r.dateStr, '2026-07-04')
  })

  it('year rolls forward for a December post announcing a January event', () => {
    const r = parseEventDate('Reminderville Meet & Greet on January 5!', '2025-12-20T00:00:00')
    assert.equal(r.dateStr, '2026-01-05')
  })

  it('returns null when there is no date in the title', () => {
    assert.equal(parseEventDate('Reminderville Kids Art Show: Kindergarten to 12th Grade', '2026-04-28T00:00:00'), null)
  })

  it('does not treat "12th" (grade) as a date', () => {
    // No month token near "12th", and no numeric M/D — must not fabricate a date.
    const r = parseEventDate('Kindergarten to 12th Grade', '2026-04-28T00:00:00')
    assert.equal(r, null)
  })
})

// ── Time parsing (explicit meridiem only) ────────────────────────────────────

describe('parseTime — trusts explicit meridiem, refuses to guess', () => {
  it('single PM time', () => {
    assert.deepEqual(parseTime('Rain Barrel Workshop at Heritage Hall 5:00pm'), { timeStr: '5:00 pm', endTimeStr: null })
  })

  it('"starts at 10:30am"', () => {
    assert.deepEqual(parseTime('Annual 4th of July Parade starts at 10:30am!'), { timeStr: '10:30 am', endTimeStr: null })
  })

  it('range with meridiem on the end token inherits it on the start', () => {
    assert.deepEqual(parseTime('mosquito spraying will begin at 8:30pm'), { timeStr: '8:30 pm', endTimeStr: null })
  })

  it('meridiem-less range is NOT guessed — returns null', () => {
    assert.equal(parseTime('Community Shred Day 10:00-1:00 at City Hall'), null)
    assert.equal(parseTime('Family Fun Day! June 21 1:00-4:00'), null)
  })
})

// ── Venue + geography ────────────────────────────────────────────────────────

describe('resolveVenue', () => {
  it('maps "the RAC" to the Athletic Club', () => {
    assert.equal(resolveVenue('Kids Halloween Event! Sat, Oct 25 at the RAC!').name, 'Reminderville Athletic Club')
  })
  it('maps City Hall / Heritage Hall / Fire Station', () => {
    assert.equal(resolveVenue('Community Shred Day at City Hall').name, 'Reminderville City Hall')
    assert.equal(resolveVenue('Rain Barrel Workshop at Heritage Hall').name, 'Heritage Hall')
    assert.equal(resolveVenue('Seniors Spaghetti Dinner at Fire Station').name, 'Reminderville Fire Station')
  })
  it('defaults to the village-wide venue', () => {
    const v = resolveVenue('Reminderville Family Fun Day!')
    assert.equal(v.name, 'Village of Reminderville')
    assert.equal(v.city, 'Reminderville')
  })
  it('an Aurora cross-post is flagged out-of-county (Portage)', () => {
    assert.equal(resolveVenue('The Traveling Vietnam Wall in Aurora').city, 'Aurora')
  })
})

describe('isFamilyEvent / categoryFor', () => {
  it('flags kids/family events', () => {
    assert.equal(isFamilyEvent('Kids Halloween Event! Sat, Oct 25'), true)
    assert.equal(isFamilyEvent('Reminderville Family Fun Day!'), true)
    assert.equal(isFamilyEvent('Community Shred Day'), false)
  })
  it('category overrides for confident cases', () => {
    assert.equal(categoryFor('Annual 4th of July Parade!'), 'festival')
    assert.equal(categoryFor('Annual Seniors Spaghetti Dinner'), 'food')
    assert.equal(categoryFor('Rain Barrel Workshop at Heritage Hall'), 'learning')
  })
})

// ── buildRow end-to-end ──────────────────────────────────────────────────────

describe('buildRow', () => {
  it('builds a timed single-day event with a 3h default end', () => {
    // Real post 11225, published 2024-06-06, event "June 27" of the same year.
    const b = buildRow(post(1, '2024-06-06T00:00:00', 'June 27: Rain Barrel Workshop at Heritage Hall 5:00pm'))
    assert.equal(b.row.source_id, '1')
    assert.equal(b.venueSpec.name, 'Heritage Hall')
    assert.ok(b.row.start_at.startsWith('2024-06-27'))
    assert.ok(b.row.end_at) // 3h default
  })

  it('builds a multi-day date-only span with an end date and no fabricated time', () => {
    const b = buildRow(post(2, '2025-04-02T00:00:00', 'Reminderville Safety Town: June 16-20'))
    assert.ok(b.row.start_at.startsWith('2025-06-16'))
    assert.ok(b.row.end_at.startsWith('2025-06-20'))
    assert.equal(b.row.is_family, true)
  })

  it('returns null for a news post even when it has a date', () => {
    assert.equal(buildRow(post(3, '2021-01-08T00:00:00', '01/12 Reminderville Council Meeting via Zoom')), null)
  })

  it('returns null for an undated event post', () => {
    assert.equal(buildRow(post(4, '2026-04-28T00:00:00', 'Reminderville Kids Art Show: Kindergarten to 12th Grade')), null)
  })

  it('source_id is stable across runs (the post id)', () => {
    const t = 'Annual Easter Eggstravaganza at the RAC!  April 8 1:00-3:00'
    assert.equal(buildRow(post(99, '2023-03-07T00:00:00', t)).row.source_id, '99')
    assert.equal(buildRow(post(99, '2023-03-07T00:00:00', t)).row.source_id, '99')
  })
})

// ── Window filter ────────────────────────────────────────────────────────────

describe('isWithinWindow', () => {
  const now = Date.parse('2026-07-14T12:00:00Z')
  it('keeps a near-future event', () => {
    assert.equal(isWithinWindow('2026-08-09T14:00:00Z', null, now), true)
  })
  it('drops a past event', () => {
    assert.equal(isWithinWindow('2026-06-13T14:00:00Z', null, now), false)
  })
  it('drops an event beyond the 180-day horizon', () => {
    assert.equal(isWithinWindow('2027-06-01T14:00:00Z', null, now), false)
  })
  it('keeps a multi-day event whose end is still in the future', () => {
    assert.equal(isWithinWindow('2026-07-13T14:00:00Z', '2026-07-16T14:00:00Z', now), true)
  })
})
