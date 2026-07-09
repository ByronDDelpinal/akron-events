/**
 * test-portage-lakes-kiwanis.js — the rental-hall ALLOWLIST filter.
 * Titles are REAL entries captured from the live Tribe feed on 2026-07-08.
 *
 * Run:  node --test scripts/tests/test-portage-lakes-kiwanis.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { includeEvent, skipReason, SOURCE_KEY } =
  await import('../scrape-portage-lakes-kiwanis.js')

describe('rental-hall allowlist', () => {
  it('ingests the real public events', () => {
    assert.equal(includeEvent({ title: 'Portage Lakes Fireworks', venue: { venue: 'Portage Lakes State Park', city: 'New Franklin' } }), true)
    assert.equal(includeEvent({ title: 'Kiwanis Pancake Breakfast' }), true)
    assert.equal(includeEvent({ title: 'Holiday Craft Show' }), true)
  })
  it('skips member/club bookings by default (no public signal)', () => {
    assert.equal(includeEvent({ title: 'Kiwanis meeting' }), false)
    assert.equal(includeEvent({ title: 'Sea Scout Meeting' }), false)
    assert.equal(includeEvent({ title: 'AARP Members Meeting' }), false)
    assert.equal(includeEvent({ title: 'Orchid Society' }), false)
    assert.equal(includeEvent({ title: 'Purple Martin Club' }), false)
    assert.equal(includeEvent({ title: 'Astronomy Club of Akron (ACA) Monthly Meeting' }), false)
  })
  it('hard private markers always win, even with a public-looking word', () => {
    assert.equal(includeEvent({ title: 'POWELL MEMORIAL' }), false)
    assert.equal(includeEvent({ title: 'HUNTER MEMORIAL' }), false)
    assert.equal(includeEvent({ title: 'Wedding Shower — Smith Party' }), false)
    assert.equal(includeEvent({ title: 'Memorial Craft Show' }), false, 'private marker beats allowlist')
  })
  it('"Memorial Day" is not a private memorial', () => {
    assert.equal(includeEvent({ title: 'Memorial Day Pancake Breakfast' }), true)
  })
  it('out-of-county explicit venues are gated', () => {
    assert.equal(includeEvent({ title: 'Fireworks Watch Party', venue: { venue: 'Canton Palace', city: 'Canton' } }), false)
  })
  it('skipReason labels the buckets for the run log', () => {
    assert.equal(skipReason({ title: 'POWELL MEMORIAL' }), 'private booking')
    assert.equal(skipReason({ title: 'Orchid Society' }), 'no public-event signal (rental-hall default)')
  })
})

describe('module contract', () => {
  it('exports the manifest source key', () => {
    assert.equal(SOURCE_KEY, 'portage_lakes_kiwanis')
  })
})

describe('closure notices (live-run fix 2026-07-08)', () => {
  it('"CLOSED SANTA DELIEVERY" is a facility closure, not an event', () => {
    assert.equal(includeEvent({ title: 'CLOSED SANTA DELIEVERY' }), false)
  })
  it('the real Santa Delivery still ingests', () => {
    assert.equal(includeEvent({ title: 'Santa Delivery' }), true)
  })
})
