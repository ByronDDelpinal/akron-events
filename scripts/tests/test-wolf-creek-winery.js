/**
 * test-wolf-creek-winery.js — pure parsers of scrape-wolf-creek-winery.js.
 *
 * Run:  node --test scripts/tests/test-wolf-creek-winery.js
 *
 * Fixtures are shapes captured from wineryatwolfcreek.com, 2026-07-14.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  parseEventSitemapSlugs, slugFromEventUrl, eventInfoUrl, slugStartMs, tailSlugs,
  cleanTitle, isFamilyTitle, mapTags, parseOffers, eventFromJsonLd, rowFromWarmup,
  warmupIsSummit, SOURCE_KEY,
} = await import('../scrape-wolf-creek-winery.js')

// ── Fixtures ────────────────────────────────────────────────────────────────

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" generatedBy="WIX">
<url><loc>https://www.wineryatwolfcreek.com/event-info/eccentric-panda-food-truck-2026-07-14-17-00</loc><lastmod>2026-04-28</lastmod></url>
<url><loc>https://www.wineryatwolfcreek.com/event-info/pressed-flower-workshop</loc></url>
<url><loc>https://www.wineryatwolfcreek.com/event-info/eccentric-panda-food-truck-2026-07-14-17-00</loc></url>
</urlset>`

// A schema.org Event block as emitted on each detail page.
const LD = {
  '@context': 'https://schema.org',
  '@type': 'Event',
  name: 'Eccentric Panda Food Truck',
  description: 'Asian-inspired flavors with a tropical Hawaiian twist!',
  startDate: '2026-07-14T17:00:00-04:00',
  endDate:   '2026-07-14T21:00:00-04:00',
  eventStatus: 'https://schema.org/EventScheduled',
  location: {
    '@type': 'Place',
    url: 'https://www.wineryatwolfcreek.com/event-info/eccentric-panda-food-truck-2026-07-14-17-00',
    name: '2637 S Cleveland Massillon Rd',
    address: '2637 S Cleveland Massillon Rd, Barberton, OH 44203, USA',
  },
  image: {
    '@type': 'ImageObject',
    url: 'https://static.wixstatic.com/media/784938_32~mv2.jpg/v1/fill/w_2048,h_1536,al_c,q_90/784938_32~mv2.jpg',
    width: '2048', height: '1536',
  },
}
const PANDA_URL = 'https://www.wineryatwolfcreek.com/event-info/eccentric-panda-food-truck-2026-07-14-17-00'

// A raw Wix warmup event object (scheduling.config carries UTC ISO strings).
const WARMUP_EV = {
  id: 'f573fae5', title: 'Live Music with Jim Gill',
  description: 'An evening of acoustic favorites on the patio.',
  slug: 'live-music-with-jim-gill-2026-07-29-18-30',
  scheduling: { config: {
    scheduleTbd: false,
    startDate: '2026-07-29T22:30:00.000Z',   // 6:30 PM ET
    endDate:   '2026-07-30T02:30:00.000Z',
    endDateHidden: false,
  } },
  location: {
    name: 'Barberton',
    coordinates: { lat: 41.0672546, lng: -81.6374887 },
    address: '2637 S Cleveland Massillon Rd, Barberton, OH 44203, USA',
    fullAddress: { city: 'Barberton', subdivision: 'OH', postalCode: '44203' },
  },
  mainImage: { id: '784938_ab~mv2.jpg', url: 'https://static.wixstatic.com/media/784938_ab~mv2.jpg' },
}

// ── Sitemap + slug helpers ──────────────────────────────────────────────────

describe('parseEventSitemapSlugs', () => {
  it('extracts /event-info/ slugs, de-duped', () => {
    assert.deepEqual(parseEventSitemapSlugs(SITEMAP),
      ['eccentric-panda-food-truck-2026-07-14-17-00', 'pressed-flower-workshop'])
  })
  it('returns [] for an empty urlset (legit zero events)', () => {
    assert.deepEqual(parseEventSitemapSlugs('<urlset xmlns="x"></urlset>'), [])
  })
  it('throws on structurally-wrong input (not a urlset)', () => {
    assert.throws(() => parseEventSitemapSlugs('<html>maintenance</html>'))
    assert.throws(() => parseEventSitemapSlugs(''))
  })
})

describe('slugFromEventUrl / eventInfoUrl', () => {
  it('round-trips the slug', () => {
    assert.equal(slugFromEventUrl(PANDA_URL), 'eccentric-panda-food-truck-2026-07-14-17-00')
    assert.equal(slugFromEventUrl(`${PANDA_URL}?utm=x`), 'eccentric-panda-food-truck-2026-07-14-17-00')
    assert.equal(slugFromEventUrl('https://www.wineryatwolfcreek.com/other'), null)
    assert.equal(eventInfoUrl('pressed-flower-workshop'),
      'https://www.wineryatwolfcreek.com/event-info/pressed-flower-workshop')
  })
})

describe('slugStartMs', () => {
  it('parses the Eastern date/time stamp as UTC epoch ms', () => {
    // 2026-07-14 17:00 EDT → 21:00Z
    assert.equal(slugStartMs('eccentric-panda-food-truck-2026-07-14-17-00'),
      Date.parse('2026-07-14T21:00:00.000Z'))
  })
  it('returns null for an un-dated slug', () => {
    assert.equal(slugStartMs('pressed-flower-workshop'), null)
    assert.equal(slugStartMs('yappy-hour-tuesdays-12'), null)   // trailing count, not a date
  })
})

describe('tailSlugs', () => {
  const now = Date.parse('2026-07-14T12:00:00Z')
  const horizon = now + 180 * 86_400_000
  const slugs = [
    'live-music-with-jim-gill-2026-07-29-18-30',  // future, dated → keep
    'ladies-night-2022-03-22-17-00',              // past dated → drop
    'pressed-flower-workshop',                    // undated → drop (self-heals)
    'already-in-warmup-2026-08-01-19-00',         // in warmup → drop
  ]
  it('keeps only future-dated slugs not already covered by the warmup', () => {
    assert.deepEqual(
      tailSlugs(slugs, ['already-in-warmup-2026-08-01-19-00'], now, horizon),
      ['live-music-with-jim-gill-2026-07-29-18-30'],
    )
  })
  it('drops events beyond the horizon', () => {
    assert.deepEqual(tailSlugs(['x-2030-01-01-12-00'], [], now, horizon), [])
  })
})

// ── Categorisation ──────────────────────────────────────────────────────────

describe('cleanTitle', () => {
  it('decodes HTML entities and strips the Wix (n) duplicate suffix', () => {
    assert.equal(cleanTitle('Roll Call Burgers &amp; Fries Food Truck'), 'Roll Call Burgers & Fries Food Truck')
    assert.equal(cleanTitle('Live Music with Robin Roseberry (1)'), 'Live Music with Robin Roseberry')
    assert.equal(cleanTitle('Vuj&#39;s Hot Dog&#39;s'), "Vuj's Hot Dog's")
  })
  it('leaves a legitimate parenthetical intact', () => {
    assert.equal(cleanTitle('Wine (and Cheese) Night'), 'Wine (and Cheese) Night')
  })
})

describe('isFamilyTitle', () => {
  it('is title-scoped, word-boundary matched', () => {
    assert.ok(isFamilyTitle('Family Craft Night'))
    assert.ok(isFamilyTitle("Kids' Painting Party"))
    assert.ok(!isFamilyTitle('Live Music with Jim Gill'))
    assert.ok(!isFamilyTitle('Kidney Benefit'))
  })
})

describe('mapTags', () => {
  it('always carries the source tags', () => {
    assert.ok(mapTags('Anything').includes('wolf-creek-winery'))
    assert.ok(mapTags('Anything').includes('winery'))
  })
  it('derives topic tags from the title', () => {
    assert.ok(mapTags('Live Music with Jim Gill').includes('live-music'))
    assert.ok(mapTags('Eccentric Panda Food Truck').includes('food-truck'))
    assert.ok(mapTags('Pressed Flower Workshop').includes('workshop'))
    assert.ok(mapTags('Yappy Hours').includes('dogs'))
    assert.ok(mapTags('Paws & Prayers Fundraiser').includes('fundraiser'))
    assert.ok(mapTags('Yoga on the Lawn').includes('yoga'))
  })
})

describe('parseOffers', () => {
  it('reads AggregateOffer / plain Offer; equal bounds collapse; never assume free', () => {
    assert.deepEqual(parseOffers({ '@type': 'AggregateOffer', lowPrice: '10', highPrice: '25' }),
      { price_min: 10, price_max: 25 })
    assert.deepEqual(parseOffers({ '@type': 'Offer', price: '35' }), { price_min: 35, price_max: null })
    assert.deepEqual(parseOffers({ lowPrice: '18.45', highPrice: '18.45' }), { price_min: 18.45, price_max: null })
    assert.deepEqual(parseOffers(null), { price_min: null, price_max: null })
    assert.deepEqual(parseOffers({ price: '0' }), { price_min: null, price_max: null })
  })
})

// ── eventFromJsonLd ─────────────────────────────────────────────────────────

describe('eventFromJsonLd', () => {
  it('maps a detail-page Event to a row, converting the TZ offset to UTC', () => {
    const row = eventFromJsonLd(LD, PANDA_URL)
    assert.equal(row.title, 'Eccentric Panda Food Truck')
    assert.equal(row.start_at, '2026-07-14T21:00:00.000Z')  // 17:00 EDT → UTC
    assert.equal(row.end_at,   '2026-07-15T01:00:00.000Z')
    assert.equal(row.price_min, null)                        // no offers → never assume free
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'eccentric-panda-food-truck-2026-07-14-17-00')
    assert.equal(row.ticket_url, PANDA_URL)
    assert.equal(row.status, 'published')
    assert.match(row.image_url, /^https:\/\/static\.wixstatic\.com\//)
    assert.ok(row.tags.includes('food-truck'))
  })
  it('returns null without a name or parseable startDate', () => {
    assert.equal(eventFromJsonLd({ ...LD, name: undefined }, PANDA_URL), null)
    assert.equal(eventFromJsonLd({ ...LD, startDate: 'TBD' }, PANDA_URL), null)
  })
  it('drops an endDate not after startDate', () => {
    assert.equal(eventFromJsonLd({ ...LD, endDate: LD.startDate }, PANDA_URL).end_at, null)
  })
  it('drops a cancelled/postponed detail-page event by title', () => {
    assert.equal(eventFromJsonLd({ ...LD, name: 'Eccentric Panda Food Truck - CANCELLED' }, PANDA_URL), null)
  })
})

// ── rowFromWarmup ───────────────────────────────────────────────────────────

describe('rowFromWarmup', () => {
  it('maps a warmup event, fixing the detail URL to /event-info/', () => {
    const row = rowFromWarmup(WARMUP_EV)
    assert.equal(row.title, 'Live Music with Jim Gill')
    assert.equal(row.start_at, '2026-07-29T22:30:00.000Z')
    assert.equal(row.source_id, 'live-music-with-jim-gill-2026-07-29-18-30')
    assert.equal(row.ticket_url,
      'https://www.wineryatwolfcreek.com/event-info/live-music-with-jim-gill-2026-07-29-18-30')
    assert.equal(row.source_url, row.ticket_url)
    assert.equal(row.price_min, null)
    assert.ok(row.tags.includes('live-music'))
    assert.ok(row.category)   // inferred, not null
  })
  it('returns null when title or start time is missing', () => {
    assert.equal(rowFromWarmup({ ...WARMUP_EV, title: undefined }), null)
    assert.equal(rowFromWarmup({ ...WARMUP_EV, scheduling: { config: { scheduleTbd: true } } }), null)
  })
  it('returns null for a cancelled/postponed warmup title', () => {
    assert.equal(rowFromWarmup({ ...WARMUP_EV, title: 'Live Music with Jim Gill (CANCELLED)' }), null)
  })
})

// ── warmupIsSummit (strict-mandate guard) ───────────────────────────────────

describe('warmupIsSummit', () => {
  it('passes an event whose city is in Summit County (coord-less)', () => {
    assert.ok(warmupIsSummit({ location: { fullAddress: { city: 'Barberton' } } }))
  })
  it('passes an unknown/absent location (pins to the winery)', () => {
    assert.ok(warmupIsSummit({}))
    assert.ok(warmupIsSummit({ location: { fullAddress: {} } }))
  })
  it('rejects an event whose city is a known non-Summit locality', () => {
    assert.ok(!warmupIsSummit({ location: { fullAddress: { city: 'Cleveland' } } }))
  })
})
