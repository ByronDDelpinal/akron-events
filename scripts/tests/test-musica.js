/**
 * test-musica.js — Musica (DICE partner API) scraper parsing.
 *
 * Run:
 *   node --test scripts/tests/test-musica.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { normaliseDiceEvent, diceDateToIso, diceVenue } = await import('../lib/dice.js')
const { mapTags } = await import('../scrape-musica.js')

import {
  MAC_SATURN,
  COMEDY_NIGHT,
  NAIVE_TIME,
  CANCELLED,
  NO_DATE,
  ALL_FIXTURES,
} from './fixtures/musica-events.js'

const normalise = (ev) => normaliseDiceEvent(ev, { source: 'musica', category: 'music', mapTags })

describe('DICE — diceDateToIso', () => {
  it('keeps a UTC "Z" instant as-is', () => {
    assert.equal(diceDateToIso('2026-06-14T00:00:00Z'), '2026-06-14T00:00:00.000Z')
  })
  it('converts an offset timestamp to UTC', () => {
    // 8:00 PM EDT → 00:00 UTC next day
    assert.equal(diceDateToIso('2026-06-20T20:00:00-04:00'), '2026-06-21T00:00:00.000Z')
  })
  it('treats a naive (offset-less) string as Eastern wall-clock, not UTC', () => {
    // 7:30 PM ET (EDT) → 23:30 UTC — NOT 19:30 UTC
    assert.equal(diceDateToIso('2026-06-25 19:30:00'), '2026-06-25T23:30:00.000Z')
  })
  it('returns null for empty/garbage', () => {
    assert.equal(diceDateToIso(null), null)
    assert.equal(diceDateToIso('not-a-date'), null)
  })
})

describe('Musica — authoritative showtime', () => {
  it('stores Mac Saturn at the real 8:00 PM ET (not a 9 AM placeholder)', () => {
    const row = normalise(MAC_SATURN)
    assert.equal(row.start_at, '2026-06-14T00:00:00.000Z')
    assert.equal(
      new Date(row.start_at).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }),
      '20:00',
    )
  })
})

describe('Musica — normalization', () => {
  it('maps to music + venue base tags', () => {
    const row = normalise(MAC_SATURN)
    assert.equal(row.category, 'music')
    assert.ok(row.tags.includes('live-music'))
    assert.ok(row.tags.includes('musica'))
    assert.ok(row.tags.includes('akron'))
  })
  it('adds DICE genre tags (gig:indierock → indierock)', () => {
    assert.ok(normalise(MAC_SATURN).tags.includes('indierock'))
  })
  it('adds a comedy tag for comedy shows', () => {
    assert.ok(normalise(COMEDY_NIGHT).tags.includes('comedy'))
  })
  it('populates the image from event_images (the bug that left cards bare)', () => {
    const row = normalise(MAC_SATURN)
    assert.ok(row.image_url, 'image_url should not be null')
    assert.ok(row.image_url.includes('mac-saturn-landscape'))
  })
  it('maps "All ages" to all_ages', () => {
    assert.equal(normalise(MAC_SATURN).age_restriction, 'all_ages')
  })
  it('falls back to raw_description when description is empty', () => {
    assert.equal(normalise(COMEDY_NIGHT).description, 'A night of stand-up comedy.')
  })
  it('sets source, source_id, status, and ticket_url', () => {
    const row = normalise(MAC_SATURN)
    assert.equal(row.source, 'musica')
    assert.equal(row.source_id, 'm75971a5058a')
    assert.equal(row.status, 'published')
    assert.equal(row.ticket_url, 'https://link.dice.fm/m75971a5058a')
  })
  it('strips HTML from the description', () => {
    assert.ok(!/<[a-z]/i.test(normalise(MAC_SATURN).description))
  })
  it('handles the naive-time fixture via Eastern conversion', () => {
    assert.equal(normalise(NAIVE_TIME).start_at, '2026-06-25T23:30:00.000Z')
  })
  it('returns null for an event with no start date', () => {
    assert.equal(normalise(NO_DATE), null)
  })
})

describe('DICE — diceVenue', () => {
  it('flattens the first venue (DICE provides name + city, no street address)', () => {
    const v = diceVenue(MAC_SATURN)
    assert.equal(v.name, 'Musica')
    assert.equal(v.city, 'Akron')
    assert.equal(v.address, null) // DICE venue payload has no street address
  })
})

describe('Musica — batch invariants', () => {
  it('normalises every dated fixture without throwing; null only for no-date', () => {
    for (const ev of ALL_FIXTURES) {
      assert.doesNotThrow(() => normalise(ev))
    }
    assert.equal(normalise(NO_DATE), null)
    assert.ok(normalise(CANCELLED)) // lib normalises; the scraper filters cancelled
  })
})
