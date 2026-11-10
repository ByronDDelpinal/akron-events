/**
 * test-fair-housing-akron.js
 *
 * Unit tests for the Fair Housing Contact Service scraper's pure parsers. The
 * load-bearing logic is the per-event Summit gate: Akron events with a real
 * pin publish, a Kent workshop with no usable location is dropped from its
 * text, and a location-less event with no recognizable city goes to
 * pending_review.
 *
 * Fixture: the event objects parsed from the live Wix /event-list
 * #wix-warmup-data blob on 2026-11-10, verbatim except that `calendarLinks`
 * is removed (its .ics link embeds a signed Wix token, and no parser reads
 * it). The calendar held one event that day
 * (the annual event), so the Kent / location-less / free-workshop cases below
 * are VARIANTS built from that real object by changing only the fields under
 * test; each one says what it changed. Replace them with real captures the
 * next time the organizer posts a workshop.
 *
 * Run:  node --test scripts/tests/test-fair-housing-akron.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  parseFairHousingLocation,
  classifyEventLocation,
  isFreeEvent,
  isUpcoming,
  buildRow,
  mapCategory,
  mapTags,
  SOURCE_KEY,
  EVENTS_URL,
} from '../scrape-fair-housing-akron.js'
import { preloadSummitCountyBoundary } from '../lib/summit-county.js'

await preloadSummitCountyBoundary() // coord-based gating needs the polygon loaded

const __dirname = dirname(fileURLToPath(import.meta.url))
const EVENTS = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/fair-housing-akron-wix.json'), 'utf8'))
const annual = EVENTS.find((e) => e.slug === 'fhcs-annual-event')

/** A deep copy of the real event with `patch` shallow-merged over it. */
const variant = (patch) => ({ ...structuredClone(annual), ...patch })

// Variant: location flagged TBD, text names Kent (Portage County).
const kentWorkshop = variant({
  title: "Kent Renter's Rights Workshop",
  slug: 'kent-renters-rights-workshop-1',
  description: 'A FREE workshop at the Kent Free Library.',
  location: { tbd: true },
})
// Variant: no location at all and no city anywhere in the text.
const saveTheDate = variant({ location: null })
// Variant: the real Akron location, workshop wording.
const akronWorkshop = variant({
  title: "Renter's Rights Workshop",
  slug: 'renters-rights-workshop-4',
  description: 'Join us for a FREE workshop on your rights as a tenant.',
})

describe('fixture', () => {
  it('holds the real annual event captured from the live page', () => {
    assert.ok(annual, 'fixture must contain fhcs-annual-event')
    assert.equal(annual.title, 'FHCS Annual Event')
    assert.equal(annual.scheduling.config.startDate, '2026-10-23T22:00:00.000Z')
  })
})

describe('SOURCE_KEY / EVENTS_URL', () => {
  it('is fair_housing_akron', () => assert.equal(SOURCE_KEY, 'fair_housing_akron'))
  it('reads the Wix event list, not the retired Squarespace collection', () => {
    assert.equal(EVENTS_URL, 'https://www.fairhousingakron.org/event-list')
  })
})

describe('parseFairHousingLocation', () => {
  it('parses the real Akron location with its pin', () => {
    const loc = parseFairHousingLocation(annual.location)
    assert.equal(loc.name, '21 W North St')
    assert.equal(loc.address, '21 W North St, Akron, OH 44304, USA')
    assert.equal(loc.city, 'Akron')
    assert.equal(loc.state, 'OH')
    assert.equal(loc.zip, '44304')
    assert.ok(Math.abs(loc.lat - 41.0914) < 0.001)
    assert.ok(Math.abs(loc.lng - -81.5172) < 0.001)
  })

  it('treats an absent, TBD or empty location as null', () => {
    assert.equal(parseFairHousingLocation(null), null)
    assert.equal(parseFairHousingLocation({ tbd: true }), null)
    assert.equal(parseFairHousingLocation({ name: '', coordinates: {} }), null)
  })
})

describe('classifyEventLocation', () => {
  it('classes the real Akron event as in-county from its pin and city', () => {
    assert.equal(classifyEventLocation(annual), 'in')
  })
  it('classes a Kent workshop with no usable location as out-of-county from its text', () => {
    assert.equal(classifyEventLocation(kentWorkshop), 'out')
  })
  it('classes a location-less, city-less event as unknown (→ pending_review)', () => {
    assert.equal(classifyEventLocation(saveTheDate), 'unknown')
  })
  it('classes a location-less event that names Akron as in-county', () => {
    assert.equal(classifyEventLocation(variant({ location: null, description: 'Held in Akron.' })), 'in')
  })
})

describe('isFreeEvent', () => {
  it('detects a FREE workshop', () => assert.equal(isFreeEvent(akronWorkshop), true))
  it('does not assume the save-the-date annual event is free', () => {
    assert.equal(isFreeEvent(annual), false)
  })
})

describe('isUpcoming', () => {
  const start = Date.parse('2026-10-23T22:00:00.000Z')
  const end = Date.parse('2026-10-24T01:00:00.000Z')
  it('is upcoming before the start', () => assert.equal(isUpcoming(annual, start - 1), true))
  it('stays upcoming while the event is in progress', () => assert.equal(isUpcoming(annual, end - 1), true))
  it('is past once the published end has gone', () => assert.equal(isUpcoming(annual, end + 1), false))
  it('judges on the start when the end is hidden', () => {
    const ev = structuredClone(annual)
    ev.scheduling.config.endDateHidden = true
    assert.equal(isUpcoming(ev, start + 1), false)
  })
  it('never treats a schedule-TBD event as upcoming', () => {
    const ev = structuredClone(annual)
    ev.scheduling.config.scheduleTbd = true
    assert.equal(isUpcoming(ev, start - 1), false)
  })
})

describe('mapCategory / mapTags', () => {
  it('categorizes as civic', () => assert.equal(mapCategory(annual), 'civic'))
  it('tags workshops with the workshop tag', () => {
    assert.ok(mapTags(akronWorkshop).includes('workshop'))
    assert.ok(!mapTags(annual).includes('workshop'))
    assert.ok(mapTags(annual).includes('fair-housing'))
  })
})

describe('buildRow', () => {
  it('builds the real annual event with UTC times, its Wix slug and detail URL', () => {
    const row = buildRow(annual)
    assert.equal(row.title, 'FHCS Annual Event')
    assert.equal(row.start_at, '2026-10-23T22:00:00.000Z')
    assert.equal(row.end_at, '2026-10-24T01:00:00.000Z')
    assert.equal(row.source, 'fair_housing_akron')
    assert.equal(row.source_id, 'fhcs-annual-event')
    assert.equal(row.ticket_url, 'https://www.fairhousingakron.org/event-details/fhcs-annual-event')
    assert.equal(row.category, 'civic')
    assert.equal(row.status, 'published')
    assert.equal(row.price_min, null, 'never assume free')
    assert.match(row.image_url, /^https:\/\/static\.wixstatic\.com\//)
  })

  it('prices an explicitly free workshop at 0', () => {
    const row = buildRow(akronWorkshop)
    assert.equal(row.price_min, 0)
    assert.equal(row.price_max, 0)
    assert.equal(row.status, 'published')
  })

  it('sends an ungateable event to review instead of publishing it', () => {
    const row = buildRow(saveTheDate)
    assert.equal(row.status, 'pending_review')
    assert.equal(row.needs_review, true)
  })

  it('returns null for an event with no date', () => {
    const ev = structuredClone(annual)
    ev.scheduling.config.scheduleTbd = true
    assert.equal(buildRow(ev), null)
  })
})
