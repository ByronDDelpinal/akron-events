/**
 * test-akron-ymca.js
 *
 * Covers the Akron Area YMCA JSON:API parsers (scrape-akron-ymca.js) against a
 * REAL /jsonapi/node/event collection response captured 2026-07-15 with branch
 * + image resources sideloaded (scripts/tests/fixtures/akron-ymca-jsonapi-
 * 2026-07-15.json): five upcoming events across four branches, including one
 * out-of-county (Wadsworth/Medina) and one with no branch reference.
 *
 * Locality assertions preload the Summit County polygon (local GeoJSON, no
 * network) so the coordinate gate runs exactly as it does live.
 *
 * Run:  node --test scripts/tests/test-akron-ymca.js
 */
import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  parseCollection, parseEventNode, indexIncluded, isoFromEventDate,
  parseCategory, parseIsFundraiser, isFamilyEvent, resolveLocality,
} = await import('../scrape-akron-ymca.js')
const { preloadSummitCountyBoundary } = await import('../lib/summit-county.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/akron-ymca-jsonapi-2026-07-15.json'), 'utf8'),
)

const records = parseCollection(fixture)
const byTitle = Object.fromEntries(records.map((r) => [r.title, r]))

describe('parseCollection (real JSON:API fixture)', () => {
  it('flattens every event node', () => {
    assert.equal(records.length, 5)
  })
  it('uses the Drupal internal nid as a stable source_id', () => {
    assert.equal(byTitle['Wadsworth Y Tri'].sourceId, '750')
    assert.equal(byTitle['P.S. I Love You 2026'].sourceId, '435')
  })
  it('carries through the offset-aware start/end and the path alias', () => {
    const r = byTitle["Green Y's Dry Tri"]
    assert.equal(r.startRaw, '2026-08-08T07:00:00-04:00')
    assert.equal(r.endRaw, '2026-08-08T10:00:00-04:00')
    assert.equal(r.url, 'https://www.akronymca.org/events/green-ys-dry-tri')
  })
  it('absolutizes the sideloaded image URL', () => {
    assert.equal(
      byTitle['Grape Falls & Craft Brews 2026'].imageUrl,
      'https://www.akronymca.org/sites/default/files/2026-06/grape_falls_22nd.jpg',
    )
  })
  it('strips HTML from the description to plain text', () => {
    const desc = byTitle["Green Y's Dry Tri"].description
    assert.ok(!/[<>]/.test(desc))
    assert.match(desc, /Dry Tri/i)
  })
})

describe('parseEventNode edge cases', () => {
  it('returns null for a node with no title or no start date', () => {
    const included = indexIncluded([])
    assert.equal(parseEventNode({ attributes: {} }, included), null)
    assert.equal(
      parseEventNode({ attributes: { title: 'X', field_event_dates: {} } }, included),
      null,
    )
  })
  it('tolerates empty / malformed collections', () => {
    assert.deepEqual(parseCollection(null), [])
    assert.deepEqual(parseCollection({}), [])
    assert.deepEqual(parseCollection({ data: [] }), [])
  })
})

describe('isoFromEventDate — offset-aware normalisation', () => {
  it('converts an EDT (-04:00) timestamp to UTC exactly', () => {
    assert.equal(isoFromEventDate('2026-08-02T16:00:00-04:00'), '2026-08-02T20:00:00.000Z')
  })
  it('converts an EST (-05:00) timestamp to UTC exactly', () => {
    assert.equal(isoFromEventDate('2026-12-05T09:00:00-05:00'), '2026-12-05T14:00:00.000Z')
  })
  it('returns null on empty or unparseable input', () => {
    assert.equal(isoFromEventDate(''), null)
    assert.equal(isoFromEventDate(null), null)
    assert.equal(isoFromEventDate('not-a-date'), null)
  })
})

describe('resolveBranches', () => {
  it('resolves a branch reference to a full address + coords record', () => {
    const b = byTitle["Green Y's Dry Tri"].branches
    assert.equal(b.length, 1)
    assert.deepEqual(b[0], {
      name: 'Green Family YMCA',
      address: '3800 Massillon Road',
      city: 'Uniontown',
      state: 'OH',
      zip: '44685',
      lat: 40.95738,
      lng: -81.46685,
    })
  })
  it('returns an empty array when an event has no branch reference', () => {
    assert.deepEqual(byTitle['Fore the Kids Golf Outing'].branches, [])
  })
  it('trims a trailing space off the branch locality', () => {
    assert.equal(byTitle['Wadsworth Y Tri'].branches[0].city, 'Wadsworth')
  })
})

describe('resolveLocality — strict Summit County gate', () => {
  before(async () => { await preloadSummitCountyBoundary() })

  it('publishes an in-county branch (Green / Uniontown)', () => {
    const { locality, branch } = resolveLocality(byTitle["Green Y's Dry Tri"].branches)
    assert.equal(locality, 'in')
    assert.equal(branch.name, 'Green Family YMCA')
  })
  it('skips an out-of-county branch (Wadsworth / Medina County)', () => {
    const { locality, branch } = resolveLocality(byTitle['Wadsworth Y Tri'].branches)
    assert.equal(locality, 'out')
    assert.equal(branch, null)
  })
  it('routes a branch-less event to review (unknown)', () => {
    const { locality, branch } = resolveLocality(byTitle['Fore the Kids Golf Outing'].branches)
    assert.equal(locality, 'unknown')
    assert.equal(branch, null)
  })
  it('prefers an in-county branch when multiple are referenced', () => {
    const branches = [
      { name: 'Wadsworth YMCA', lat: 41.021863, lng: -81.711975, city: 'Wadsworth' },
      { name: 'Kohl Family YMCA', lat: 41.079574, lng: -81.50249, city: 'Akron' },
    ]
    const { locality, branch } = resolveLocality(branches)
    assert.equal(locality, 'in')
    assert.equal(branch.name, 'Kohl Family YMCA')
  })
})

describe('parseCategory — explicit athletic/food mapping', () => {
  it('maps triathlons and dry tris to fitness', () => {
    assert.equal(parseCategory("Green Y's Dry Tri", 'annual Dry Triathlon'), 'fitness')
    assert.equal(parseCategory('Wadsworth Y Tri', 'Youth Triathlon race in the water'), 'fitness')
  })
  it('maps a charity golf outing to fitness', () => {
    assert.equal(parseCategory('Fore the Kids Golf Outing', 'playing Portage Country Club'), 'fitness')
  })
  it('maps a 5K run/walk to fitness (not the music mis-inference)', () => {
    assert.equal(parseCategory('P.S. I Love You 2026', 'Run or Walk the engaging 5K or 1M trek'), 'fitness')
  })
  it('maps a wine / craft-brew benefit to food', () => {
    assert.equal(parseCategory('Grape Falls & Craft Brews 2026', 'wine and craft beer benefit'), 'food')
  })
  it('falls back to other for an unrecognised event', () => {
    assert.equal(parseCategory('New Member Welcome', 'open house'), 'other')
  })
})

describe('parseIsFundraiser', () => {
  it('flags charity golf outings and campaign benefits', () => {
    assert.equal(parseIsFundraiser('Fore the Kids Golf Outing', 'supporting the Y'), true)
    assert.equal(parseIsFundraiser('Grape Falls', 'benefitting the Annual Campaign'), true)
  })
  it('returns undefined (not false) with no fundraiser signal', () => {
    assert.equal(parseIsFundraiser("Green Y's Dry Tri", 'three athletic events'), undefined)
  })
})

describe('isFamilyEvent — noun-phrase gated', () => {
  it('flags genuine youth programming', () => {
    assert.equal(isFamilyEvent('Wadsworth Y Tri', 'Youth Triathlon for kids'), true)
    assert.equal(isFamilyEvent('Summer Day Camp', 'day camp for children'), true)
  })
  it('does NOT flag an adult golf outing merely named "for the Kids"', () => {
    assert.equal(isFamilyEvent('Fore the Kids Golf Outing', 'adult scramble at the country club'), false)
  })
})
