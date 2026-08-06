/**
 * test-bath-business-assoc.js — Bath Business Association Wix Events scraper.
 *
 * Validates the REAL ingest path against the captured live fixture:
 *   - isPublicEvent keeps the 5 public events, drops the 4 members-only/meeting.
 *   - venueFor derives per-event venue + city; the Summit gate returns 'in'.
 *   - normaliseWixEvent maps source/title/start_at(ET)/ticket_url for a public
 *     event (Wye Road Bridge Lighting, Bath America 250 Road Rally).
 *
 * Run:  node --test scripts/tests/test-bath-business-assoc.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { SOURCE_KEY, isPublicEvent, venueFor, cityFromFormatted } =
  await import('../scrape-bath-business-assoc.js')
const { normaliseWixEvent } = await import('../lib/wix-events.js')
const { classifySummitLocation } = await import('../lib/summit-county.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = JSON.parse(
  await readFile(resolve(__dirname, 'fixtures/bath-business-events.json'), 'utf8'),
)
const bySlug = Object.fromEntries(FIXTURE.map((e) => [e.slug, e]))

describe('bath_business_assoc — source key', () => {
  it('is bath_business_assoc', () => {
    assert.equal(SOURCE_KEY, 'bath_business_assoc')
  })
})

describe('isPublicEvent — public vs internal', () => {
  const kept = FIXTURE.filter((e) => isPublicEvent(e.title)).map((e) => e.title)
  const dropped = FIXTURE.filter((e) => !isPublicEvent(e.title)).map((e) => e.title)

  it('keeps exactly the 5 public events', () => {
    assert.equal(kept.length, 5)
    assert.deepEqual(kept.sort(), [
      'Bath America 250 Road Rally',
      'Bath Township Employee Appreciation Brunch',
      'Garage Sale Map and Listings HERE',
      'Open House & Scholarship Award Announcement',
      'Wye Road Bridge Lighting',
    ])
  })

  it('drops exactly the 4 members-only / meeting items', () => {
    assert.equal(dropped.length, 4)
    assert.deepEqual(dropped.sort(), [
      'BBA Member Only Picnic',
      'BUSINESS MEETING - Members Only (1)',
      'General Meeting',
      'Guest Speaker, Bath Township Administrator Vito Sinopoli - Members Only',
    ])
  })

  it('is shape-based, not a hardcoded list', () => {
    assert.equal(isPublicEvent('Committee Meeting'), false)
    assert.equal(isPublicEvent('Holiday Party - Members Only'), false)
    assert.equal(isPublicEvent('Summer Concert on the Green'), true)
    assert.equal(isPublicEvent(''), false)
    assert.equal(isPublicEvent(null), false)
  })
})

describe('cityFromFormatted — parse city out of the formatted address', () => {
  it('handles the formatted-address shapes in the feed', () => {
    assert.equal(cityFromFormatted('3864 W Bath Rd, Akron, OH 44333, USA'), 'Akron')
    assert.equal(cityFromFormatted('Bath Township, OH, USA'), 'Bath Township')
    assert.equal(cityFromFormatted('Bath Township'), 'Bath Township')
    assert.equal(cityFromFormatted('3864 W. BATH ROAD, AKRON OH 44333'), 'AKRON')
    assert.equal(cityFromFormatted(null), null)
  })
})

describe('venueFor + Summit gate', () => {
  it('every kept public event resolves to an in-county venue', () => {
    for (const ev of FIXTURE.filter((e) => isPublicEvent(e.title))) {
      const v = venueFor(ev.location)
      assert.ok(v && v.name, `venue for ${ev.title}`)
      assert.equal(
        classifySummitLocation({ lat: v.lat, lng: v.lng, city: v.city }), 'in',
        `${ev.title} @ ${v.city}`,
      )
    }
  })

  it('maps the Road Rally to Crown Point Ecology Center in Akron', () => {
    const v = venueFor(bySlug['bath-america-250-road-rally'].location)
    assert.equal(v.name, 'Crown Point Ecology Center')
    assert.equal(v.address, '3220 Ira Rd, Akron, OH 44333, USA')
    assert.equal(v.city, 'Akron')
    assert.equal(v.state, 'OH')
    assert.equal(v.zip, '44333')
  })

  it('maps the Bridge Lighting to Bake Shop In Ghent', () => {
    const v = venueFor(bySlug['wye-road-bridge-lighting'].location)
    assert.equal(v.name, 'Bake Shop In Ghent')
    assert.equal(v.city, 'Akron')
  })
})

describe('normaliseWixEvent — real row mapping', () => {
  const opts = {
    source: SOURCE_KEY,
    siteBaseUrl: 'https://www.bathbusinessassociation.com',
    mapTags: () => ['bath-business-association'],
  }

  it('maps the Wye Road Bridge Lighting (5:30 PM ET)', () => {
    const r = normaliseWixEvent(bySlug['wye-road-bridge-lighting'], opts)
    assert.equal(r.source, 'bath_business_assoc')
    assert.equal(r.title, 'Wye Road Bridge Lighting')
    // Stored as the UTC instant; that is 5:30 PM ET (EST, UTC-5) on Nov 27.
    assert.equal(r.start_at, '2026-11-27T22:30:00.000Z')
    assert.equal(
      new Date(r.start_at).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }),
      '5:30 PM',
    )
    assert.equal(
      r.ticket_url,
      'https://www.bathbusinessassociation.com/event-details/wye-road-bridge-lighting',
    )
    assert.equal(r.source_id, 'wye-road-bridge-lighting')
    assert.equal(r.price_min, null) // never assume free
    assert.equal(r.status, 'published')
  })

  it('maps the Bath America 250 Road Rally (2:30 PM ET)', () => {
    const r = normaliseWixEvent(bySlug['bath-america-250-road-rally'], opts)
    assert.equal(r.title, 'Bath America 250 Road Rally')
    assert.equal(r.start_at, '2026-09-20T18:30:00.000Z') // 2:30 PM EDT (UTC-4)
    assert.equal(
      new Date(r.start_at).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }),
      '2:30 PM',
    )
    assert.equal(
      r.ticket_url,
      'https://www.bathbusinessassociation.com/event-details/bath-america-250-road-rally',
    )
  })
})
