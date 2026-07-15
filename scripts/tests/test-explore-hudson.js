/**
 * test-explore-hudson.js — pure parsers for the Explore Hudson scraper
 * (Hudson Area Chamber of Commerce / ChamberMate JSON API).
 *
 * Fixture: scripts/tests/fixtures/explore-hudson-events.json — a 7-event
 * slice captured from the live getEventsInfo feed, chosen to exercise every
 * location shape (structured address with/without a venue name, the chamber's
 * PO-Box fallback, freeform custom text) plus the within-feed cross-reference
 * recovery.
 *
 * Run:  node --test scripts/tests/test-explore-hudson.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  buildEventsUrl,
  buildImageUrl,
  parseDateTimes,
  isIngestable,
  parsePrice,
  buildLocationIndexes,
  resolveLocation,
  toEventRow,
} = await import('../scrape-explore-hudson.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const EVENTS = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/explore-hudson-events.json'), 'utf8'),
)
const byName = (n) => EVENTS.filter((e) => e.eventName === n)
const RIBBON   = byName('Ribbon Cutting to Welcome ivory & birch!')[0]
const BREW     = byName('Professional Power Hour')[0]          // 11 Atterbury, name present
const BREW_2   = byName('Professional Power Hour')[1]          // 11 Atterbury, name null
const FREEFORM = byName("The Professional Women's Network")[0] // customAddress "Lager and Vine"
const POBOX    = byName('Sidewalk Sale')[0]                    // PO Box 305
const LUNCH    = byName('Membership Luncheon')[0]              // 2155 Middleton Rd, name null

const INDEXES = buildLocationIndexes(EVENTS)

describe('buildEventsUrl', () => {
  it('targets the chamber getEventsInfo endpoint with tenant params', () => {
    const url = buildEventsUrl()
    assert.match(url, /api\.chambermate\.com\/core\/biz\/webPresence\/getEventsInfo/)
    assert.match(url, /websiteShorthand=explorehudson/)
    assert.match(url, /includePastEvents=false/)
  })
})

describe('parseDateTimes', () => {
  it('converts naive Eastern EDT (summer) to UTC', () => {
    const { start_at, end_at } = parseDateTimes(RIBBON)
    assert.equal(start_at, '2026-07-14T20:00:00.000Z') // 16:00 EDT → 20:00 UTC
    assert.equal(end_at,   '2026-07-14T21:00:00.000Z')
  })

  it('converts naive Eastern EST (winter) to UTC', () => {
    const { start_at, end_at } = parseDateTimes(FREEFORM_DEC())
    assert.equal(start_at, '2026-12-09T21:30:00.000Z') // 16:30 EST → 21:30 UTC
    assert.equal(end_at,   '2026-12-09T23:00:00.000Z')
  })

  it('returns null end_at when noEndTime is set', () => {
    const { start_at, end_at } = parseDateTimes({ ...RIBBON, noEndTime: true })
    assert.ok(start_at)
    assert.equal(end_at, null)
  })

  it('drops the time for all-day (noTimes) events', () => {
    const { start_at, end_at } = parseDateTimes({ ...RIBBON, noTimes: true })
    assert.equal(start_at, '2026-07-14T04:00:00.000Z') // midnight ET
    assert.equal(end_at, null)
  })

  it('returns nulls when startDateTime is missing', () => {
    assert.deepEqual(parseDateTimes({}), { start_at: null, end_at: null })
  })
})

function FREEFORM_DEC() {
  return byName("The Professional Women's Network")[1] // Dec event, curly-quote name
}

describe('isIngestable', () => {
  const now = Date.parse('2026-07-14T12:00:00.000Z')
  it('accepts a near-future event', () => {
    assert.equal(isIngestable('2026-07-20T20:00:00.000Z', null, now), true)
  })
  it('rejects an event that ended more than a day ago', () => {
    assert.equal(isIngestable('2026-07-10T20:00:00.000Z', '2026-07-10T22:00:00.000Z', now), false)
  })
  it('keeps a same-day event that already started', () => {
    assert.equal(isIngestable('2026-07-14T10:00:00.000Z', '2026-07-14T14:00:00.000Z', now), true)
  })
  it('rejects an event beyond the horizon', () => {
    assert.equal(isIngestable('2028-01-01T00:00:00.000Z', null, now), false)
  })
  it('rejects a null start', () => {
    assert.equal(isIngestable(null, null, now), false)
  })
})

describe('parsePrice', () => {
  it('maps explicit free markers to 0', () => {
    assert.deepEqual(parsePrice('Free'), { price_min: 0, price_max: 0 })
    assert.deepEqual(parsePrice('0'),    { price_min: 0, price_max: 0 })
    assert.deepEqual(parsePrice('$0'),   { price_min: 0, price_max: 0 })
  })
  it('parses a clean dollar amount', () => {
    assert.deepEqual(parsePrice('$25'),  { price_min: 25, price_max: 25 })
    assert.deepEqual(parsePrice('10.50'), { price_min: 10.5, price_max: 10.5 })
  })
  it('leaves null / ambiguous admission as null (never assumes free)', () => {
    assert.deepEqual(parsePrice(null),        { price_min: null, price_max: null })
    assert.deepEqual(parsePrice(''),          { price_min: null, price_max: null })
    assert.deepEqual(parsePrice('Members only'), { price_min: null, price_max: null })
    assert.deepEqual(parsePrice('$10-$20'),   { price_min: null, price_max: null })
  })
})

describe('buildImageUrl', () => {
  it('builds a stable avatarDirectView URL, URL-encoding the entity key', () => {
    const url = buildImageUrl(RIBBON)
    assert.match(url, /\/core\/shared\/query\/avatarDirectView\?/)
    assert.match(url, /entityName=Event/)
    assert.match(url, /noFallback=true/)
    // activityKey "Hi_|s2..." must be percent-encoded ("|" → %7C).
    assert.ok(url.includes(encodeURIComponent(RIBBON.activityKey)))
    assert.ok(!url.includes('|'))
    // avatarStorageKey passes through (path form).
    assert.ok(url.includes(RIBBON.avatarStorageKey))
  })
  it('returns null when there is no avatar', () => {
    assert.equal(buildImageUrl({ ...RIBBON, avatarStorageKey: null }), null)
  })
})

describe('buildLocationIndexes + resolveLocation', () => {
  it('uses the structured venue name when present', () => {
    const loc = resolveLocation(BREW, INDEXES)
    assert.equal(loc.venueName, 'The Brew Kettle')
    assert.equal(loc.address, '11 Atterbury Boulevard')
    assert.equal(loc.city, 'Hudson')
    assert.equal(loc.state, 'OH')
  })

  it('recovers a blank venue name from a sibling event at the same street', () => {
    // BREW_2 (a later Power Hour) has no address.name; the earlier Brew Kettle
    // event seeds the street index, so the name is recovered.
    const loc = resolveLocation(BREW_2, INDEXES)
    assert.equal(loc.address, '11 Atterbury Boulevard')
    assert.equal(loc.venueName, 'The Brew Kettle')
  })

  it('recovers city/address for a freeform-text venue from the name index', () => {
    // FREEFORM has customAddress "Lager and Vine" and no structured address;
    // a sibling event names that venue with a real address → city recovered.
    const loc = resolveLocation(FREEFORM, INDEXES)
    assert.equal(loc.venueName, 'Lager and Vine')
    assert.equal(loc.city, 'Hudson')
    assert.equal(loc.address, '30 West Streetsboro Street')
  })

  it('treats the chamber PO-Box fallback as no venue but keeps the city', () => {
    const loc = resolveLocation(POBOX, INDEXES)
    assert.equal(loc.venueName, null)
    assert.equal(loc.address, null)
    assert.equal(loc.city, 'Hudson') // real city preserved for the geo gate
  })

  it('leaves a bare unnamed street address venue-less (no name to recover)', () => {
    const loc = resolveLocation(LUNCH, INDEXES)
    assert.equal(loc.venueName, null)
    assert.equal(loc.address, '2155 Middleton Road')
    assert.equal(loc.city, 'Hudson')
  })
})

describe('toEventRow', () => {
  it('produces a published row with a stable source_id from activityKey', () => {
    const row = toEventRow(BREW, INDEXES, 'in')
    assert.equal(row.source, 'explore_hudson')
    assert.equal(row.source_id, BREW.activityKey)
    assert.equal(row.title, 'Professional Power Hour')
    assert.equal(row.status, 'published')
    assert.equal(row.needs_review, undefined)
    assert.equal(row.price_min, 0) // "Free"
    assert.equal(row.source_url, BREW.eventDetailUrl)
    assert.equal(row.age_restriction, 'not_specified')
  })

  it('routes an unknown-geo event to the review queue', () => {
    const row = toEventRow(RIBBON, INDEXES, 'unknown')
    assert.equal(row.status, 'pending_review')
    assert.equal(row.needs_review, true)
  })

  it('leaves price null when admission is absent', () => {
    const row = toEventRow(RIBBON, INDEXES, 'in')
    assert.equal(row.price_min, null)
    assert.equal(row.price_max, null)
  })

  it('returns null when the event has no start time', () => {
    assert.equal(toEventRow({ ...BREW, startDateTime: null }, INDEXES, 'in'), null)
  })

  it('drops a cancelled/postponed event by title marker', () => {
    assert.equal(toEventRow({ ...BREW, eventName: 'Professional Power Hour - CANCELLED' }, INDEXES, 'in'), null)
    assert.equal(toEventRow({ ...BREW, eventName: 'Sidewalk Sale (Postponed)' }, INDEXES, 'in'), null)
  })
})
