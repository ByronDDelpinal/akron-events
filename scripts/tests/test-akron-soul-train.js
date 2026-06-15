/**
 * test-akron-soul-train.js — the scraper-specific gallery venue fallback.
 * (Generic Wix parsing is covered by test-wix-events.js.)
 *
 * Run:  node --test scripts/tests/test-akron-soul-train.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { venueFor } = await import('../scrape-akron-soul-train.js')

describe('Akron Soul Train venueFor', () => {
  it('uses the event\'s own location when present (partner venue, not gallery)', () => {
    const v = venueFor({
      name: 'Mary Schiller Myers School of Art',
      address: '150 E Exchange St, Akron, OH 44325, USA',
      fullAddress: { city: 'Akron', subdivision: 'OH', postalCode: '44325' },
      coordinates: { lat: 41.0734, lng: -81.5182 },
    })
    assert.equal(v.name, 'Mary Schiller Myers School of Art')
    assert.equal(v.city, 'Akron')
    assert.equal(v.isGallery, false)
    assert.equal(v.neighborhood_slug, undefined) // only the gallery gets the slug
  })

  it('falls back to the gallery (with downtown-akron slug) when no location', () => {
    const v = venueFor(null)
    assert.equal(v.name, 'Akron Soul Train')
    assert.equal(v.address, '191 S Main St')
    assert.equal(v.neighborhood_slug, 'downtown-akron')
    assert.equal(v.isGallery, true)
  })
})
