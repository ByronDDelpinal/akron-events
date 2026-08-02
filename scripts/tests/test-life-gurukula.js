/**
 * test-life-gurukula.js — locks the Life Gurukula ICS scraper's real config and
 * its date-only needs_review wiring.
 *
 * Why this file exists: test-ics.js proves `applyNeedsReviewHook` and
 * `isDateOnlyIcsEvent` work in isolation. That is exactly the false-confidence
 * shape of the test-eventbrite.js fork landmine — logic verified, wiring not.
 * These tests import the REAL scraper module and use ITS config object, so a
 * dropped or renamed `flagNeedsReview` fails CI.
 *
 * Run:  node --test scripts/tests/test-life-gurukula.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

// ── Import-safety probe ─────────────────────────────────────────────────────
// The module used to call runIcsScraper() unguarded at top level, so merely
// importing it kicked off a live fetch + Supabase upsert. Trap fetch before the
// import so we can assert nothing reaches the network on import.
const realFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = (...args) => { fetchCalls++; return realFetch(...args) }

const mod = await import('../scrape-life-gurukula.js')

globalThis.fetch = realFetch

const { config } = mod
// Reached through the config so these assertions also prove the mappers are
// actually wired into it, not merely present in the module.
const { mapCategory, mapTags } = config

import { parseIcs, normaliseIcsEvent, applyNeedsReviewHook, DATE_ONLY_TIME_NOTE } from '../lib/ics.js'
import { isDateOnlyIcsEvent } from '../lib/civicplus.js'

// ── Fixture provenance (be honest about what this is) ───────────────────────
// This is NOT a captured live response. lifegurukula.org sits behind a Sucuri
// "Smart Guard" JS challenge, so the raw feed could not be fetched to disk.
// The VEVENT shape below is reconstructed from two things we DO have:
//   1. The stored `source_id`s for source='life_gurukula' in Supabase, which are
//      The Events Calendar (Tribe) UIDs of the form
//      `<postId>-<startEpoch>-<endEpoch>@lifegurukula.org`. Tribe derives those
//      epochs from the event's LOCAL wall clock treated as UTC, so they read
//      straight back out as the feed's DTSTART/DTEND values:
//        1257-1782345600-1782691199  → 2026-06-25T00:00:00 .. 2026-06-28T23:59:59
//          (exact local-midnight/end-of-day boundaries = an all-day retreat)
//        1333-1782034200-1782041400  → 2026-06-21T09:30:00 .. 2026-06-21T11:30:00
//          (a genuinely timed 9:30am event)
//   2. Tribe's documented iCal output: all-day events emit
//      `DTSTART;VALUE=DATE:` / `DTEND;VALUE=DATE:` (exclusive end date), timed
//      events emit `DTSTART;TZID=America/New_York:`.
// If the live byte shape ever turns out to differ, `isDateOnlyIcsEvent` also
// accepts a bare 8-char DTSTART, and this fixture should be replaced with a
// real capture the first time one can be obtained.
const GURUKULA_FEED = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Life Gurukula - ECPv6.8.2//NONSGML v1.0//EN',
  'X-WR-CALNAME:Events',
  'BEGIN:VEVENT',
  'UID:1257-1782345600-1782691199@lifegurukula.org',
  'SUMMARY:Experimenting Youth\\, Exploring Adults\\, and Evolving Adults Retreat (JCHYK\\, CHYK\\, CHYSK)',
  'DESCRIPTION:A multi-day residential retreat at the ashrama.',
  'DTSTART;VALUE=DATE:20260625',
  'DTEND;VALUE=DATE:20260629',
  'URL:https://lifegurukula.org/event/jchyk-chyk-chysk-retreat/',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:1333-1782034200-1782041400@lifegurukula.org',
  'SUMMARY:International Day of Yoga',
  'DESCRIPTION:Join us for a morning of yoga and meditation.',
  'DTSTART;TZID=America/New_York:20260621T093000',
  'DTEND;TZID=America/New_York:20260621T113000',
  'URL:https://lifegurukula.org/event/international-day-of-yoga/',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const [RETREAT_EV, TIMED_EV] = parseIcs(GURUKULA_FEED)

describe('Life Gurukula: module is import-safe', () => {
  it('importing the module does not trigger a scrape', () => {
    assert.equal(fetchCalls, 0, 'importing scrape-life-gurukula.js hit the network')
  })

  it('exports config rather than calling runIcsScraper at import time', () => {
    assert.equal(typeof config, 'object')
    assert.equal(config.source, 'life_gurukula')
    assert.equal(typeof config.getIcsText, 'function')
  })
})

describe('Life Gurukula: needs_review wiring', () => {
  it('config.flagNeedsReview is exactly isDateOnlyIcsEvent', () => {
    // Identity, not shape: a look-alike predicate would be a different bug.
    assert.equal(config.flagNeedsReview, isDateOnlyIcsEvent)
  })

  it('a date-only retreat row is flagged needs_review and defaults to noon ET', () => {
    const row = normaliseIcsEvent(RETREAT_EV, config)
    applyNeedsReviewHook(row, RETREAT_EV, config.flagNeedsReview)
    // Noon is a default, not a confirmed door time, so the flag still stands.
    assert.equal(row.needs_review, true)
    // SANCTIONED-DEFAULT-TIME. This is the second of the two call paths that
    // reach a date-only DTSTART (the other is lib/civicplus.js). Fixing only
    // one is what left life_gurukula stranded at midnight before 2026-07-31,
    // so this asserts the real timestamp, not just the date: noon ET on
    // 2026-06-25 is 16:00Z in EDT.
    assert.equal(row.start_at, '2026-06-25T16:00:00.000Z')
    // The multi-day DTEND still follows the shifted start, so it survives.
    assert.equal(row.end_at, '2026-06-29T04:00:00.000Z')
    // …and the invented time is disclosed in the prose, exactly once.
    assert.ok(row.description.endsWith(DATE_ONLY_TIME_NOTE))
    assert.equal(row.description.split(DATE_ONLY_TIME_NOTE).length - 1, 1)
    assert.equal(row.source_id, '1257-1782345600-1782691199@lifegurukula.org')
    assert.equal(row.featured, false)
  })

  it('a genuinely timed row is left alone (never stamped false)', () => {
    const row = normaliseIcsEvent(TIMED_EV, config)
    applyNeedsReviewHook(row, TIMED_EV, config.flagNeedsReview)
    // Must be absent, not false: a literal false is written into
    // manual_overrides and becomes a permanent lock.
    assert.equal(row.needs_review, undefined)
    assert.equal(Object.hasOwn(row, 'needs_review'), false)
    // The real 9:30am ET start and its prose are untouched by the noon default.
    assert.equal(row.start_at, '2026-06-21T13:30:00.000Z')
    assert.equal(row.description, 'Join us for a morning of yoga and meditation.')
    // 09:30 America/New_York on 2026-06-21 (EDT) = 13:30Z, matching the epoch
    // encoded in the stored source_id.
    assert.equal(new Date(row.start_at).toISOString(), '2026-06-21T13:30:00.000Z')
  })
})

describe('Life Gurukula: mapping', () => {
  it('tags retreats and yoga from the real fixture events', () => {
    const retreatTags = mapTags(RETREAT_EV)
    assert.ok(retreatTags.includes('retreat'))
    assert.ok(retreatTags.includes('youth'))
    assert.ok(retreatTags.includes('vedanta'))

    const yogaTags = mapTags(TIMED_EV)
    assert.ok(yogaTags.includes('yoga'))
    assert.ok(yogaTags.includes('meditation'))
  })

  it('mapCategory returns a string or null, never throws', () => {
    for (const ev of [RETREAT_EV, TIMED_EV]) {
      const c = mapCategory(ev)
      assert.ok(c === null || typeof c === 'string')
    }
  })
})
