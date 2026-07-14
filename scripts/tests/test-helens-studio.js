/**
 * test-helens-studio.js — pure parsers of scrape-helens-studio.js.
 *
 * Run:  node --test scripts/tests/test-helens-studio.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  parseSitemapUrls, slugFromUrl, parseOffers, isFamilyTitle, cleanTitle,
  eventFromJsonLd, eventFromDetailPage, SOURCE_KEY,
} = await import('../scrape-helens-studio.js')

// ── Fixtures (shapes captured from helens.studio, 2026-07-10) ───────────────

const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" generatedBy="WIX">
<url><loc>https://www.helens.studio/event-details-registration/mermaid-kids-paint-camp</loc><lastmod>2026-07-08</lastmod></url>
<url><loc>https://www.helens.studio/event-details-registration/christmas-tree-in-july</loc></url>
<url><loc>https://www.helens.studio/event-details-registration/mermaid-kids-paint-camp</loc></url>
<url><loc>https://www.helens.studio/some-other-page</loc></url>
</urlset>`

const LD = {
  '@context': 'https://schema.org',
  '@type': 'Event',
  name: "Mermaid Kid's Paint Camp",
  description: 'Join us for a fun morning of painting, a story and a snack at the end!',
  startDate: '2026-07-13T10:00:00-04:00',
  endDate: '2026-07-13T11:30:00-04:00',
  location: { '@type': 'Place', name: '2102 State Rd', address: '2102 State Rd, Cuyahoga Falls, OH 44223, USA' },
  offers: {
    '@type': 'AggregateOffer', highPrice: '18.45', lowPrice: '18.45', priceCurrency: 'USD',
    offers: [{ '@type': 'offer', price: '18.45' }],
  },
  image: { '@type': 'ImageObject', url: 'https://static.wixstatic.com/media/9f8bf0_e1.png/v1/fill/w_1024,h_1536,al_c/9f8bf0_e1.png' },
}

const PAGE_URL = 'https://www.helens.studio/event-details-registration/mermaid-kids-paint-camp'

// ── parseSitemapUrls ─────────────────────────────────────────────────────────

describe('parseSitemapUrls', () => {
  it('extracts event-details URLs, de-duped, dropping non-event pages', () => {
    const urls = parseSitemapUrls(SITEMAP)
    assert.equal(urls.length, 2)
    assert.ok(urls.every((u) => u.includes('/event-details-registration/')))
  })

  it('returns [] for an empty urlset (legit zero events)', () => {
    assert.deepEqual(parseSitemapUrls('<urlset xmlns="x"></urlset>'), [])
  })

  it('throws on structurally-wrong input (not a urlset)', () => {
    assert.throws(() => parseSitemapUrls('<html>maintenance page</html>'))
    assert.throws(() => parseSitemapUrls(''))
  })
})

// ── slugFromUrl / parseOffers / isFamilyTitle ───────────────────────────────

describe('slugFromUrl', () => {
  it('takes the last path segment of a detail URL', () => {
    assert.equal(slugFromUrl(PAGE_URL), 'mermaid-kids-paint-camp')
    assert.equal(slugFromUrl(`${PAGE_URL}?utm=x`), 'mermaid-kids-paint-camp')
    assert.equal(slugFromUrl('https://www.helens.studio/other'), null)
  })
})

describe('parseOffers', () => {
  it('reads AggregateOffer low/high; equal bounds collapse to price_min only', () => {
    assert.deepEqual(parseOffers(LD.offers), { price_min: 18.45, price_max: null })
    assert.deepEqual(
      parseOffers({ '@type': 'AggregateOffer', lowPrice: '10', highPrice: '25' }),
      { price_min: 10, price_max: 25 },
    )
  })

  it('reads a plain Offer price; null when absent or zero (never assume free)', () => {
    assert.deepEqual(parseOffers({ '@type': 'Offer', price: '12.50' }), { price_min: 12.5, price_max: null })
    assert.deepEqual(parseOffers(null), { price_min: null, price_max: null })
    assert.deepEqual(parseOffers({ price: '0' }), { price_min: null, price_max: null })
  })
})

describe('cleanTitle', () => {
  it("strips Wix's duplicate-title '(n)' suffix only", () => {
    assert.equal(cleanTitle("Silly Snake Kid's Painting Camp (1)"), "Silly Snake Kid's Painting Camp")
    assert.equal(cleanTitle('Christmas (tree) in July!'), 'Christmas (tree) in July!')
  })
})

describe('isFamilyTitle', () => {
  it('is title-scoped per repo policy', () => {
    assert.ok(isFamilyTitle("Mermaid Kid's Paint Camp"))
    assert.ok(isFamilyTitle('Family Clay Night'))
    assert.ok(!isFamilyTitle('Wine & Paint Evening'))
    // "kid" must be a word, not a substring
    assert.ok(!isFamilyTitle('Kidney Foundation Benefit Paint Night'))
  })
})

// ── eventFromJsonLd ─────────────────────────────────────────────────────────

describe('eventFromJsonLd', () => {
  it('maps a complete schema.org Event to an events row', () => {
    const row = eventFromJsonLd(LD, PAGE_URL)
    assert.equal(row.title, "Mermaid Kid's Paint Camp")
    assert.equal(row.start_at, '2026-07-13T14:00:00.000Z') // 10:00 EDT → UTC
    assert.equal(row.end_at,   '2026-07-13T15:30:00.000Z')
    assert.equal(row.price_min, 18.45)
    assert.equal(row.price_max, null)
    assert.equal(row.is_family, true)
    assert.equal(row.source, SOURCE_KEY)
    assert.equal(row.source_id, 'mermaid-kids-paint-camp')
    assert.equal(row.ticket_url, PAGE_URL)
    assert.match(row.image_url, /^https:\/\/static\.wixstatic\.com\//)
    assert.equal(row.age_restriction, 'not_specified')
  })

  it('returns null without a name or parseable startDate', () => {
    assert.equal(eventFromJsonLd({ ...LD, name: undefined }, PAGE_URL), null)
    assert.equal(eventFromJsonLd({ ...LD, startDate: 'TBD' }, PAGE_URL), null)
  })

  it('drops an endDate that is not after startDate', () => {
    const row = eventFromJsonLd({ ...LD, endDate: LD.startDate }, PAGE_URL)
    assert.equal(row.end_at, null)
  })
})

// ── eventFromDetailPage (JSON-LD path + warmup fallback) ────────────────────

describe('eventFromDetailPage', () => {
  const ldHtml = `<html><head><script type="application/ld+json">${JSON.stringify(LD)}</script></head></html>`

  const warmup = { appData: { events: [{
    id: 'w1', title: "Mermaid Kid's Paint Camp", slug: 'mermaid-kids-paint-camp',
    description: 'Fallback description.',
    scheduling: { config: { scheduleTbd: false, startDate: '2026-07-13T14:00:00.000Z', endDate: '2026-07-13T15:30:00.000Z', endDateHidden: false } },
  }] } }
  const warmupHtml = `<html><head><script id="wix-warmup-data" type="application/json">${JSON.stringify(warmup)}</script></head></html>`

  it('prefers JSON-LD when present', () => {
    const row = eventFromDetailPage(ldHtml, PAGE_URL)
    assert.equal(row.price_min, 18.45)
    assert.equal(row.source_id, 'mermaid-kids-paint-camp')
  })

  it('falls back to the warmup blob, correcting url + source_id for this site', () => {
    const row = eventFromDetailPage(warmupHtml, PAGE_URL)
    assert.equal(row.title, "Mermaid Kid's Paint Camp")
    assert.equal(row.start_at, '2026-07-13T14:00:00.000Z')
    assert.equal(row.ticket_url, PAGE_URL)     // not the /event-details/ default
    assert.equal(row.source_url, PAGE_URL)
    assert.equal(row.source_id, 'mermaid-kids-paint-camp')
    assert.equal(row.is_family, true)
  })

  it('returns null when the page has neither', () => {
    assert.equal(eventFromDetailPage('<html></html>', PAGE_URL), null)
  })
})
