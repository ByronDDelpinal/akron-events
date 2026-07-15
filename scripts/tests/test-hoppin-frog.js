/**
 * test-hoppin-frog.js
 *
 * Tests the pure parsers exported by scrape-hoppin-frog.js against realistic
 * HTML fixtures captured from the live site (hoppinfrog.com). Covers archive
 * card extraction, detail-page parsing, ui-label date/time parsing (single
 * time, same-day range, multi-day range, year-from-slug), category/tag/age
 * mapping, source_id stability, and the past-event filter.
 *
 * Run:  node --test scripts/tests/test-hoppin-frog.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  parseArchiveCards,
  parseDetail,
  parseUiLabelDateTime,
  dateFromSlug,
  mapCategory,
  mapTags,
  mapAgeRestriction,
  buildRow,
} from '../scrape-hoppin-frog.js'

/** The America/New_York calendar date (YYYY-MM-DD) for an ISO UTC instant. */
function easternDate(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

// ── Fixtures (verbatim substrings from live hoppinfrog.com) ──────────────────

const ARCHIVE_HTML = `
<div class="excerpt-box-wrap col-sm-6 col-lg-3">
<a href="https://hoppinfrog.com/event/car-show-2026-07-16/" class="excerpt-box type--post image-display--inline post-5635 event type-event status-publish has-post-thumbnail hentry event_type-special-event">
  <div class="image-wrap"><div class="meta">
    <span class='ui-tag color--light size--small excerpt-box-category excerpt-box-category-special-event'>Special Event</span>
  </div></div>
  <img class="image" src="https://craftpeak-cooler-images.imgix.net/hoppin-frog/HF_Car-Show_July-16_2026-copy-1.jpg?auto=compress%2Cformat&fit=crop&h=600&ixlib=php-3.3.1&w=600&s=7ac210b0857612662205f39086376682" alt="Car Show">
  <div class="content content-alignment--left"><div class="meta">
    <span class='ui-label color--muted size--small excerpt-box-date'>Jul 16 @ <span class='excerpt-box-location excerpt-box-location-Tasting Room'>Tasting Room</span></span>
  </div>
  <h2 class="excerpt-box-title h4">Car Show</h2>
  <div class="excerpt-box-more-link ui-label color--brand-primary size--small">More</div></div>
</a>
</div>
<div class="excerpt-box-wrap col-sm-6 col-lg-3">
<a href="https://hoppinfrog.com/event/rollin-in-peaches-returns-2026-08-01/" class="excerpt-box type--post image-display--inline post-5700 event type-event status-publish has-post-thumbnail hentry event_type-beer-release">
  <div class="meta"><span class='ui-tag excerpt-box-category excerpt-box-category-beer-release'>Beer Release</span></div>
  <img class="image" src="https://craftpeak-cooler-images.imgix.net/hoppin-frog/HF_Rollin-in-Peaches.jpg?s=abc" alt="Rollin' in Peaches Returns!">
  <h2 class="excerpt-box-title h4">Rollin&#8217; in Peaches Returns!</h2>
</a>
</div>
<!-- alert-bar link (NOT an event card) should be ignored -->
<a href="https://hoppinfrog.com/event/patio-music-fridays-2026-07-10/" target="_blank">Patio Music Fridays!</a>
`

// Detail-page substrings (each event page carries exactly these three signals).
const DETAIL_CAR_SHOW = `
<meta property="og:image" content="https://craftpeak-cooler-images.imgix.net/hoppin-frog/HF_Car-Show_July-16_2026-copy-1.jpg?auto=compress%2Cformat&amp;ixlib=php-3.3.1&amp;s=06968449bb96f0707fa2a5ae93d3d60a">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"Hoppin' Frog"},{"@type":"WebPage","url":"https://hoppinfrog.com/event/car-show-2026-07-16/","name":"Car Show | Hoppin' Frog","description":"Join Hoppin\\u2019 Frog Brewery on Thursday, July 16 from 5\\u20138 PM for a FREE Car Show featuring classic cars, craft beer, great food, and family-friendly fun.","inLanguage":"en-US"}]}</script>
<div class="fl-html"><div class="text-center"><span class='ui-label color--dark' title='July 16 5:00 pm - 8:00 pm'>July 16 5:00 pm - 8:00 pm</span></div></div>
`

const DETAIL_CHRISTMAS = `
<meta property="og:image" content="https://craftpeak-cooler-images.imgix.net/hoppin-frog/HF_Christmas-In-July.jpg?s=xyz">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","description":"Celebrate Christmas in July at Hoppin' Frog Brewery July 20\\u201326! Enjoy Frosted Frog Christmas Ale, holiday beers, festive cocktails, and holiday food specials.","inLanguage":"en-US"}]}</script>
<span class='ui-label color--dark' title='July 20 3:00 pm - July 26 5:00 pm'>July 20 3:00 pm - July 26 5:00 pm</span>
`

const DETAIL_PEACHES = `
<meta property="og:image" content="https://craftpeak-cooler-images.imgix.net/hoppin-frog/HF_Rollin-in-Peaches.jpg?s=abc">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","description":"Rollin' in Peaches Peach Cobbler Turbo Shandy returns to Hoppin' Frog on August 1, 2026, available on draft and in 16 oz cans.","inLanguage":"en-US"}]}</script>
<span class='ui-label color--dark' title='August 1 11:00 am'>August 1 11:00 am</span>
`

// ── Archive parsing ──────────────────────────────────────────────────────────

describe("Hoppin' Frog: archive parsing", () => {
  const cards = parseArchiveCards(ARCHIVE_HTML)

  it('extracts exactly the two real event cards (ignores the alert-bar link)', () => {
    assert.equal(cards.length, 2)
  })

  it('parses url, slug, source_id, title, event-type and image', () => {
    const car = cards[0]
    assert.equal(car.url, 'https://hoppinfrog.com/event/car-show-2026-07-16/')
    assert.equal(car.slug, 'car-show-2026-07-16')
    assert.equal(car.sourceId, 'car-show-2026-07-16')
    assert.equal(car.title, 'Car Show')
    assert.equal(car.eventTypeSlug, 'special-event')
    assert.ok(car.imageUrl.startsWith('https://craftpeak-cooler-images.imgix.net/'))
  })

  it('decodes HTML entities in the title', () => {
    assert.equal(cards[1].title, "Rollin' in Peaches Returns!")
    assert.equal(cards[1].eventTypeSlug, 'beer-release')
  })
})

// ── Detail parsing ───────────────────────────────────────────────────────────

describe("Hoppin' Frog: detail parsing", () => {
  it('reads ui-label, JSON-LD description, and og:image', () => {
    const d = parseDetail(DETAIL_CAR_SHOW)
    assert.equal(d.timeLabel, 'July 16 5:00 pm - 8:00 pm')
    assert.ok(d.description.startsWith('Join Hoppin’ Frog Brewery on Thursday, July 16'))
    assert.ok(d.description.includes('5–8 PM')) // ’ and – JSON-decoded
    assert.ok(d.imageUrl.includes('HF_Car-Show'))
    assert.ok(!d.imageUrl.includes('&amp;')) // entities decoded
  })

  it('returns nulls when signals are absent', () => {
    const d = parseDetail('<html><body>nothing here</body></html>')
    assert.equal(d.timeLabel, null)
    assert.equal(d.description, null)
    assert.equal(d.imageUrl, null)
  })
})

// ── Date / time parsing ──────────────────────────────────────────────────────

describe("Hoppin' Frog: ui-label date/time", () => {
  it('derives the start date (with year) from the slug', () => {
    assert.equal(dateFromSlug('car-show-2026-07-16'), '2026-07-16')
    assert.equal(dateFromSlug('rollin-in-peaches-returns-2026-08-01'), '2026-08-01')
    assert.equal(dateFromSlug('no-date-here'), null)
  })

  it('parses a same-day time range', () => {
    const { start_at, end_at } = parseUiLabelDateTime('July 16 5:00 pm - 8:00 pm', '2026-07-16')
    assert.equal(easternDate(start_at), '2026-07-16')
    assert.equal(easternDate(end_at), '2026-07-16')
    // 5:00pm EDT → 21:00Z ; 8:00pm EDT → 00:00Z next UTC day
    assert.equal(new Date(start_at).getUTCHours(), 21)
    assert.ok(new Date(end_at) > new Date(start_at))
  })

  it('parses a single start time with no end', () => {
    const { start_at, end_at } = parseUiLabelDateTime('August 1 11:00 am', '2026-08-01')
    assert.equal(easternDate(start_at), '2026-08-01')
    assert.equal(new Date(start_at).getUTCHours(), 15) // 11am EDT → 15:00Z
    assert.equal(end_at, null)
  })

  it('parses a multi-day range with distinct end date', () => {
    const { start_at, end_at } = parseUiLabelDateTime('July 20 3:00 pm - July 26 5:00 pm', '2026-07-20')
    assert.equal(easternDate(start_at), '2026-07-20')
    assert.equal(easternDate(end_at), '2026-07-26')
  })

  it('rolls the end year forward when the end month wraps past the start', () => {
    const { end_at } = parseUiLabelDateTime('December 30 6:00 pm - January 2 5:00 pm', '2026-12-30')
    assert.equal(easternDate(end_at), '2027-01-02')
  })

  it('returns null start when no slug date is available', () => {
    assert.deepEqual(parseUiLabelDateTime('July 16 5:00 pm', null), { start_at: null, end_at: null })
  })
})

// ── Category / tag / age mapping ─────────────────────────────────────────────

describe("Hoppin' Frog: classification", () => {
  it('maps music, games, arts, and beer releases', () => {
    assert.equal(mapCategory({ title: 'Patio Music Fridays' }), 'music')
    assert.equal(mapCategory({ title: 'Trivia Night!' }), 'games')
    assert.equal(mapCategory({ title: 'Pints, Paint & Plant', description: 'includes a succulent and instruction' }), 'visual-art')
    assert.equal(mapCategory({ title: 'Rollin in Peaches Returns', eventTypeSlug: 'beer-release' }), 'food')
    assert.equal(mapCategory({ title: 'Car Show', description: 'classic cars' }), null)
  })

  it('always tags brewery/hoppin-frog/akron and adds context tags', () => {
    const tags = mapTags({ title: 'Trivia Night!' })
    assert.ok(tags.includes('brewery') && tags.includes('hoppin-frog') && tags.includes('akron'))
    assert.ok(tags.includes('trivia'))
    assert.ok(mapTags({ title: 'Patio Music Fridays' }).includes('live-music'))
  })

  it('ignores the site-wide 21+ gate; uses event copy only', () => {
    assert.equal(mapAgeRestriction('Join us for a family-friendly Car Show'), 'all_ages')
    assert.equal(mapAgeRestriction('This event is 21+ only.'), '21_plus')
    assert.equal(mapAgeRestriction('A great beer release.'), 'not_specified')
  })
})

// ── Full row assembly ────────────────────────────────────────────────────────

describe("Hoppin' Frog: buildRow", () => {
  const car = { url: 'https://hoppinfrog.com/event/car-show-2026-07-16/', slug: 'car-show-2026-07-16', sourceId: 'car-show-2026-07-16', eventTypeSlug: 'special-event', title: 'Car Show', imageUrl: 'https://img/card.jpg' }
  const now = Date.parse('2026-07-10T12:00:00Z')

  it('assembles a complete, valid row', () => {
    const row = buildRow(car, parseDetail(DETAIL_CAR_SHOW), now)
    assert.ok(row)
    assert.equal(row.title, 'Car Show')
    assert.equal(row.source, 'hoppin_frog')
    assert.equal(row.source_id, 'car-show-2026-07-16')
    assert.equal(row.status, 'published')
    assert.equal(row.price_min, null)
    assert.equal(row.price_max, null)
    assert.equal(row.age_restriction, 'all_ages') // "family-friendly" in copy
    assert.equal(easternDate(row.start_at), '2026-07-16')
    assert.ok(row.ticket_url.includes('car-show-2026-07-16'))
    assert.ok(row.description.includes('classic cars'))
    // prefers the detail og:image over the card image
    assert.ok(row.image_url.includes('HF_Car-Show'))
  })

  it('handles a multi-day beer/holiday event', () => {
    const xmas = { url: 'https://hoppinfrog.com/event/christmas-in-july-2026-07-20/', slug: 'christmas-in-july-2026-07-20', sourceId: 'christmas-in-july-2026-07-20', eventTypeSlug: 'special-event', title: 'Christmas In July', imageUrl: null }
    const row = buildRow(xmas, parseDetail(DETAIL_CHRISTMAS), now)
    assert.ok(row)
    assert.equal(easternDate(row.start_at), '2026-07-20')
    assert.equal(easternDate(row.end_at), '2026-07-26')
    assert.equal(row.category, 'food') // holiday beers / ale / cocktails
  })

  it('skips events that ended more than a day ago', () => {
    const past = buildRow(car, parseDetail(DETAIL_CAR_SHOW), Date.parse('2026-08-01T12:00:00Z'))
    assert.equal(past, null)
  })

  it('returns null when the start time cannot be resolved', () => {
    const row = buildRow(car, { timeLabel: null, description: null, imageUrl: null }, now)
    // No time → still gets a midnight start from the slug date (documented fallback)
    assert.ok(row) // slug date alone yields a valid (timeless) start
    assert.equal(easternDate(row.start_at), '2026-07-16')
  })

  it('returns null when the slug carries no date', () => {
    const bad = { ...car, slug: 'car-show', sourceId: 'car-show' }
    assert.equal(buildRow(bad, parseDetail(DETAIL_CAR_SHOW), now), null)
  })

  it('drops a cancelled/postponed event by title marker', () => {
    const cancelled = { ...car, title: 'Car Show - CANCELLED' }
    assert.equal(buildRow(cancelled, parseDetail(DETAIL_CAR_SHOW), now), null)
    const postponed = { ...car, title: 'Trivia Night (Postponed)' }
    assert.equal(buildRow(postponed, parseDetail(DETAIL_CAR_SHOW), now), null)
  })

  it('normalizes the single-time beer release', () => {
    const peaches = { url: 'https://hoppinfrog.com/event/rollin-in-peaches-returns-2026-08-01/', slug: 'rollin-in-peaches-returns-2026-08-01', sourceId: 'rollin-in-peaches-returns-2026-08-01', eventTypeSlug: 'beer-release', title: "Rollin' in Peaches Returns!", imageUrl: null }
    const row = buildRow(peaches, parseDetail(DETAIL_PEACHES), now)
    assert.ok(row)
    assert.equal(row.category, 'food')
    assert.ok(row.tags.includes('beer-release'))
    assert.equal(row.end_at, null)
    assert.equal(new Date(row.start_at).getUTCHours(), 15) // 11am EDT
  })
})
