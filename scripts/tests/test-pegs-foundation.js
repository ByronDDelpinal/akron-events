/**
 * test-pegs-foundation.js — Peg's Foundation scraper (WordPress + The Events
 * Calendar / Tribe iCal). Exercises the REAL parse path (lib/ics.js parseIcs +
 * normaliseIcsEvent) against a verbatim capture of the live feed
 * (fixtures/pegs-foundation.ics), plus the scraper's pure helpers.
 *
 * Run:  node --test scripts/tests/test-pegs-foundation.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseIcs, normaliseIcsEvent } = await import('../lib/ics.js')
const {
  parsePegsFoundationLocation,
  includeEvent,
  mapCategory,
  mapTags,
  SOURCE_KEY,
} = await import('../scrape-pegs-foundation.js')
const { CATEGORY_SLUGS } = await import('../../src/lib/categories.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = readFileSync(resolve(__dirname, 'fixtures/pegs-foundation.ics'), 'utf8')
const EVENTS = parseIcs(FIXTURE)

/** Find a parsed VEVENT by (a prefix of) its SUMMARY. */
const bySummary = (prefix) => EVENTS.find((e) => (e.SUMMARY || '').startsWith(prefix))

// ── Fixture / parse sanity ───────────────────────────────────────────────────

describe('pegs: fixture parses', () => {
  it('yields all 10 VEVENTs', () => {
    assert.equal(EVENTS.length, 10)
  })
  it('SOURCE_KEY is pegs_foundation', () => {
    assert.equal(SOURCE_KEY, 'pegs_foundation')
  })
})

// ── Location parsing (Tribe "Name, Street, City, <full state>, Zip") ─────────

describe('pegs: parsePegsFoundationLocation', () => {
  it('splits a plain venue LOCATION with a spelled-out state', () => {
    assert.deepEqual(
      parsePegsFoundationLocation('Baldwin Buss Merino House, 53 First Street, Hudson, Ohio, 44236'),
      { name: 'Baldwin Buss Merino House', details: { address: '53 First Street', city: 'Hudson', state: 'OH', zip: '44236' } })
  })

  it('preserves a venue name containing a pipe/subroom', () => {
    const r = parsePegsFoundationLocation('Peg’s Gallery | Multi-Purpose Room, 53 First Street, Hudson, Ohio, 44236')
    assert.equal(r.name, 'Peg’s Gallery | Multi-Purpose Room')
    assert.equal(r.details.address, '53 First Street')
    assert.equal(r.details.city, 'Hudson')
    assert.equal(r.details.state, 'OH')
    assert.equal(r.details.zip, '44236')
  })

  it('reads the verbatim LOCATION straight off a parsed VEVENT', () => {
    const ev = bySummary('Eighty-Six Reasons')
    const r = parsePegsFoundationLocation(ev.LOCATION)
    assert.equal(r.name, 'Baldwin Buss Merino House')
    assert.equal(r.details.city, 'Hudson')
  })

  it('tolerates a trailing "United States" and a 2-letter state code', () => {
    assert.deepEqual(
      parsePegsFoundationLocation('Some Venue, 1 Main St, Hudson, OH, 44236, United States'),
      { name: 'Some Venue', details: { address: '1 Main St', city: 'Hudson', state: 'OH', zip: '44236' } })
  })

  it('returns null for empty input', () => {
    assert.equal(parsePegsFoundationLocation(''), null)
    assert.equal(parsePegsFoundationLocation(null), null)
  })
})

// ── includeEvent: Summit-County geo gate + non-event filter ──────────────────

describe('pegs: includeEvent', () => {
  it('keeps in-county (Hudson) events from the fixture', () => {
    assert.equal(includeEvent(bySummary('Eighty-Six Reasons')), true)
    assert.equal(includeEvent(bySummary('25 Years of Impact')), true)
    assert.equal(includeEvent(bySummary('Making Meaning')), true)
    assert.equal(includeEvent(bySummary('Looking Back')), true)
  })

  it('keeps Peg\'s own events that carry no LOCATION', () => {
    assert.equal(includeEvent(bySummary('Exploring the Inner Critic')), true)
    assert.equal(includeEvent(bySummary('Whitney Stained Glass')), true)
  })

  it('drops the "Campus Closed" administrative notice', () => {
    assert.equal(includeEvent(bySummary('Campus Closed')), false)
  })

  it('drops an out-of-county LOCATION (Cleveland, Cuyahoga County)', () => {
    assert.equal(
      includeEvent({ SUMMARY: 'Offsite Talk', LOCATION: 'Some Venue, 1 Main St, Cleveland, Ohio, 44101' }),
      false)
  })

  it('every non-Campus-Closed fixture event survives the gate', () => {
    const kept = EVENTS.filter(includeEvent)
    assert.equal(kept.length, 9) // 10 total − 1 "Campus Closed"
  })
})

// ── Real normalisation (lib/ics.js) of a timed Eastern event ─────────────────

describe('pegs: normaliseIcsEvent (real parse path)', () => {
  it('converts an EDT wall-clock start to the correct UTC instant', () => {
    const ev = bySummary('Exploring the Inner Critic')
    const row = normaliseIcsEvent(ev, { source: SOURCE_KEY, mapCategory, mapTags })
    // 2026-08-06 17:30 America/New_York (EDT, -04:00) → 21:30Z
    assert.equal(row.start_at, '2026-08-06T21:30:00.000Z')
    assert.equal(row.end_at,   '2026-08-06T23:00:00.000Z')
    assert.equal(row.title, 'Exploring the Inner Critic with an Art Therapist')
    assert.equal(row.source, 'pegs_foundation')
    assert.equal(row.source_id, '2704-1786037400-1786042800@pegs.org')
    assert.equal(row.status, 'published')
  })

  it('pulls the per-event image from ATTACH', () => {
    const ev = bySummary('Exploring the Inner Critic')
    const row = normaliseIcsEvent(ev, { source: SOURCE_KEY, mapCategory, mapTags })
    assert.equal(row.image_url, 'https://pegs.org/wp-content/uploads/2026/06/Pegs-Gallery-Event-FB-cover-photo-2.png')
  })

  it('every kept fixture event normalises to a row with a start + source_id', () => {
    for (const ev of EVENTS.filter(includeEvent)) {
      const row = normaliseIcsEvent(ev, { source: SOURCE_KEY, mapCategory, mapTags })
      assert.ok(row, `row for "${ev.SUMMARY}"`)
      assert.ok(row.start_at, `start_at for "${ev.SUMMARY}"`)
      assert.ok(row.source_id, `source_id for "${ev.SUMMARY}"`)
    }
  })
})

// ── Category / tag mapping ───────────────────────────────────────────────────

describe('pegs: mapCategory', () => {
  it('maps gallery exhibits / sculpture / stained-glass to visual-art', () => {
    assert.equal(mapCategory(bySummary('Eighty-Six Reasons')), 'visual-art')
    assert.equal(mapCategory(bySummary('Making Meaning')), 'visual-art')
    assert.equal(mapCategory(bySummary('Whitney Stained Glass')), 'visual-art')
  })
  it('maps the NAMI support group to civic', () => {
    assert.equal(mapCategory(bySummary('NAMI Family Support Group')), 'civic')
  })
  it('only ever returns a valid category slug or null', () => {
    for (const ev of EVENTS) {
      const cat = mapCategory(ev)
      if (cat !== null) assert.ok(CATEGORY_SLUGS.includes(cat), `"${cat}" is a valid slug`)
    }
  })
})

describe('pegs: mapTags', () => {
  it('always carries the org/geo base tags', () => {
    const tags = mapTags(bySummary('NAMI Family Support Group'))
    for (const t of ['pegs-foundation', 'hudson-ohio', 'summit-county', 'mental-health', 'nonprofit']) {
      assert.ok(tags.includes(t), `tag "${t}"`)
    }
    assert.ok(tags.includes('support-group'))
  })
  it('returns a de-duplicated array', () => {
    const tags = mapTags(bySummary('Eighty-Six Reasons'))
    assert.equal(tags.length, new Set(tags).size)
  })
})
