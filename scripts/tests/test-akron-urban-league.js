/**
 * test-akron-urban-league.js
 *
 * Unit tests for the Akron Urban League scraper's pure parsers (ADR-070).
 *
 * The load-bearing logic is the date choice. AUL runs WordPress + Divi, and the
 * Divi hero prints the POST PUBLISH DATE ("September 2, 2026") above the article
 * body, so "first Month D, YYYY on the page" can silently ingest the publish
 * date as the event date. `pickEventDate()` drops any candidate equal to the
 * REST `date` and prefers the first future one.
 *
 * EVENT_FIXTURE is trimmed verbatim from the live post at
 *   /sealing-the-past-breaking-barriers-expungement-day-at-the-akron-urban-league/
 * (fetched 2026-09-11): the hero h1 + publish date, the article body paragraph,
 * the "Event Details" list, the registration CTA, and the site-footer address.
 * The footer address is kept on purpose — it is the wrong address block, and
 * narrowing to <article> is what keeps it from winning. Note this page has NO
 * <main> element and no og:description.
 *
 * Run:
 *   node --test scripts/tests/test-akron-urban-league.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  SOURCE_KEY,
  deriveSourceId,
  extractDateCandidates,
  extractTime,
  isWithinWindow,
  mapTags,
  parseDetailPage,
  parseMeta,
  pickEventDate,
} from '../scrape-akron-urban-league.js'

const EVENT_URL = 'https://www.akronurbanleague.org/sealing-the-past-breaking-barriers-expungement-day-at-the-akron-urban-league/'
const EVENT_PUBLISHED = '2026-09-02T12:37:46'
// Frozen "Eastern today" so the tests never drift with the calendar.
const TODAY = '2026-09-11'

const EVENT_FIXTURE = `<!DOCTYPE html><html lang="en-US"><head>
<meta charset="UTF-8" />
<meta property="og:locale" content="en_US" />
<meta property="og:type" content="article" />
<meta property="og:title" content="Sealing the Past &amp; Breaking Barriers: Expungement Day at the Akron Urban League | Akron Urban League" />
<meta property="og:url" content="${EVENT_URL}" />
<meta property="og:image" content="https://www.akronurbanleague.org/wp-content/uploads/Akron-Urban-League-Logo.svg" />
</head><body>
<div class="et_pb_section et_pb_fullwidth_section event-hero"><div class="et_pb_heading_container"><h1 class="et_pb_module_header">Sealing the Past &#038; Breaking Barriers: Expungement Day at the Akron Urban League</h1></div>

<div class="et_pb_text_4_tb_body et_pb_text et_pb_bg_layout_dark et_pb_module et_block_module text-container event-hero-text"><div class="et_pb_text_inner"><p>September 2, 2026</p>
</div></div>

<div class="et_pb_text_5_tb_body et_pb_text text-container event-hero-text"><div class="et_pb_text_inner"><p><a href="https://www.akronurbanleague.org/category/blog/">Blog</a></p></div></div></div>

<div class="et_pb_text_inner">
<article style="max-width: 960px; margin: 0 auto; line-height: 1.7;">
<h1>Sealing the Past &amp; Breaking Barriers: Expungement Day</h1>
<figure style="margin: 24px 0;"><img decoding="async" src="https://www.akronurbanleague.org/wp-content/uploads/Expongement-day2026-new-scaled.jpg" alt="Expungement Day at the Akron Urban League on November 6, 2026, featuring Judge David Hamilton and guest speaker Maurice Clarett." /></figure>
<p>A past mistake can create lasting barriers to employment, housing, and opportunity. The Akron Urban League is helping community members take a step toward a fresh start through <strong>Expungement Day on Friday, November 6, 2026, from 9 a.m. to 3 p.m.</strong>, at <strong>440 Vernon Odom Boulevard in Akron</strong>.</p>
<div style="background: #f5f5f5; border-left: 5px solid #b5121b; padding: 24px; margin: 28px 0;">
<h2 style="margin-top: 0;">Event Details</h2>
<ul>
<li><strong>Date:</strong> Friday, November 6, 2026</li>
<li><strong>Time:</strong> 9 a.m. to 3 p.m.</li>
<li><strong>Location:</strong> Akron Urban League, 440 Vernon Odom Boulevard, Akron</li>
<li><strong>Services:</strong> On-site expungements for eligible misdemeanor cases</li>
<li><strong>Registration:</strong> Preferred</li>
</ul>
<p style="margin-bottom: 0;"><a href="https://docs.google.com/forms/d/1JlN2Hegey-J4OjVlrEC1IgQ-EocfFh0GcC7HgcI1nr4/viewform">Register for Expungement Day</a></p>
</div>
<h2>A Fresh Start Begins with Opportunity</h2>
</article>
</div>

<div class="et_pb_text_inner footer-contact"><p><a href="https://maps.app.goo.gl/GAJqmG2c9sDqzj9k9">440 Vernon Odom Blvd.<br />Akron, OH 44307</a></p></div>
</body></html>`

// Same markup shape, a post whose event has already happened.
const PAST_URL = 'https://www.akronurbanleague.org/santa-claus-is-coming-dec-7-2025-100pm-400pm/'
const PAST_PUBLISHED = '2025-12-02T20:35:48'
const PAST_FIXTURE = `<!DOCTYPE html><html lang="en-US"><head>
<meta property="og:title" content="Santa Claus Is Coming! | Akron Urban League" />
</head><body>
<div class="et_pb_heading_container"><h1 class="et_pb_module_header">Santa Claus Is Coming!</h1></div>
<div class="et_pb_text_inner"><p>December 2, 2025</p></div>
<article style="max-width: 960px;">
<p>Join us at the Akron Urban League, 440 Vernon Odom Boulevard, Akron for photos with Santa on <strong>Sunday, December 7, 2025 from 1:00 pm to 4:00 pm</strong>.</p>
</article>
</body></html>`

// A post whose ONLY date lives in the hero <h1>/og:title. The <article> body
// has no "Month D, YYYY" at all, and the hero sits outside <article>.
const TITLE_DATE_URL = 'https://www.akronurbanleague.org/love-letter-to-the-league-gala-2025-sponsorships-and-tickets/'
const TITLE_DATE_PUBLISHED = '2025-11-18T15:02:11'
const TITLE_DATE_FIXTURE = `<!DOCTYPE html><html lang="en-US"><head>
<meta content="Love Letter to the League Gala - NEW DATE &#8211; March 13, 2026 at John S. Knight Center | Akron Urban League" property="og:title" />
</head><body>
<div class="et_pb_heading_container"><h1 class="et_pb_module_header">Love Letter to the League Gala &#8211; NEW DATE &#8211; March 13, 2026 at John S. Knight Center</h1></div>
<article>
<p>Sponsorships and tickets are available now. Doors open at 6:00 PM.</p>
</article>
</body></html>`

describe('akron_urban_league — module surface', () => {
  it('exports the stable source key', () => {
    assert.equal(SOURCE_KEY, 'akron_urban_league')
  })
})

describe('extractDateCandidates', () => {
  it('returns every Month D, YYYY in document order', () => {
    const got = extractDateCandidates('Posted September 2, 2026. Event is Friday, November 6, 2026.')
    assert.deepEqual(got.map(c => c.dateStr), ['2026-09-02', '2026-11-06'])
    assert.ok(got[0].index < got[1].index)
  })

  it('returns [] for text with no dates', () => {
    assert.deepEqual(extractDateCandidates('no dates here'), [])
    assert.deepEqual(extractDateCandidates(null), [])
  })
})

describe('pickEventDate', () => {
  it('picks the body event date over the hero publish-date echo (real fixture)', () => {
    // Exactly the page order: hero publish date first, event date second.
    const candidates = extractDateCandidates(
      'Sealing the Past & Breaking Barriers September 2, 2026 Blog '
      + 'Expungement Day on Friday, November 6, 2026, from 9 a.m. to 3 p.m.',
    )
    assert.deepEqual(candidates.map(c => c.dateStr), ['2026-09-02', '2026-11-06'])
    assert.equal(pickEventDate(candidates, EVENT_PUBLISHED, TODAY), '2026-11-06')
  })

  it('keeps a lone candidate even when it equals the publish date', () => {
    const candidates = extractDateCandidates('Today only: September 2, 2026.')
    assert.equal(pickEventDate(candidates, EVENT_PUBLISHED, TODAY), '2026-09-02')
  })

  it('prefers the first future candidate over an earlier past one', () => {
    const candidates = extractDateCandidates('Last year we met March 1, 2026. This year: October 3, 2026.')
    assert.equal(pickEventDate(candidates, null, TODAY), '2026-10-03')
  })

  it('falls back to the first candidate when every date is past', () => {
    const candidates = extractDateCandidates('December 7, 2025 and December 14, 2025')
    assert.equal(pickEventDate(candidates, PAST_PUBLISHED, TODAY), '2025-12-07')
  })

  it('returns null with no candidates', () => {
    assert.equal(pickEventDate([], EVENT_PUBLISHED, TODAY), null)
    assert.equal(pickEventDate(undefined, null, TODAY), null)
  })
})

describe('extractTime', () => {
  it('parses the dotted lowercase form "9 a.m. to 3 p.m."', () => {
    assert.equal(extractTime('from 9 a.m. to 3 p.m., at 440 Vernon Odom Boulevard'), '09:00:00')
  })

  it('parses the usual variants', () => {
    assert.equal(extractTime('Doors 7:30 PM'), '19:30:00')
    assert.equal(extractTime('1:00pm-4:00pm'), '13:00:00')
    assert.equal(extractTime('starts at 12:00 AM'), '00:00:00')
    assert.equal(extractTime('Lunch at noon'), '12:00:00')
    assert.equal(extractTime('no time here'), null)
  })

  it('prefers a nearby "begins/starts" cue', () => {
    assert.equal(extractTime('Doors Open 7:00 AM. Breakfast Begins: 8:00 AM'), '08:00:00')
  })
})

describe('parseDetailPage — real expungement fixture', () => {
  const parsed = parseDetailPage(EVENT_FIXTURE, EVENT_URL, EVENT_PUBLISHED, TODAY)

  it('extracts the exact title', () => {
    assert.equal(parsed.title, 'Sealing the Past & Breaking Barriers: Expungement Day at the Akron Urban League')
  })

  it('uses the body event date, not the September 2 publish date', () => {
    assert.equal(parsed.dateStr, '2026-11-06')
    assert.notEqual(parsed.dateStr, EVENT_PUBLISHED.slice(0, 10))
  })

  it('extracts the 9 a.m. start time', () => {
    assert.equal(parsed.timeStr, '09:00:00')
  })

  it('extracts the body address and city, not the site-footer address', () => {
    assert.equal(parsed.addressMatched, true)
    assert.equal(parsed.venueAddress, '440 Vernon Odom Boulevard')
    assert.equal(parsed.venueCity, 'Akron')
    assert.equal(parsed.venueState, 'OH')
  })

  it('threads the publish date through for logging without using it as the date', () => {
    assert.equal(parsed.publishedIso, EVENT_PUBLISHED)
  })

  it('takes the "Register for Expungement Day" CTA as the ticket URL', () => {
    // registerRe was widened to Register[^<]* so prose CTAs count.
    assert.equal(
      parsed.ticketUrl,
      'https://docs.google.com/forms/d/1JlN2Hegey-J4OjVlrEC1IgQ-EocfFh0GcC7HgcI1nr4/viewform',
    )
  })

  it('drops the site-logo og:image rather than storing it as the event image', () => {
    assert.equal(parsed.imageUrl, null)
  })
})

describe('window predicate', () => {
  const now = Date.parse('2026-09-11T16:00:00Z')

  it('accepts the expungement event', () => {
    const parsed = parseDetailPage(EVENT_FIXTURE, EVENT_URL, EVENT_PUBLISHED, TODAY)
    assert.equal(parsed.dateStr, '2026-11-06')
    assert.equal(isWithinWindow('2026-11-06T14:00:00Z', null, now), true)
  })

  it('parses a past post but rejects it from the ingestion window', () => {
    const parsed = parseDetailPage(PAST_FIXTURE, PAST_URL, PAST_PUBLISHED, TODAY)
    assert.equal(parsed.title, 'Santa Claus Is Coming!')
    assert.equal(parsed.dateStr, '2025-12-07')
    assert.equal(parsed.timeStr, '13:00:00')
    assert.equal(isWithinWindow('2025-12-07T18:00:00Z', null, now), false)
  })

  it('rejects events beyond the 365-day horizon', () => {
    assert.equal(isWithinWindow('2028-01-01T00:00:00Z', null, now), false)
  })
})

describe('deriveSourceId', () => {
  it('is the URL slug tail and is stable across calls', () => {
    const a = deriveSourceId(EVENT_URL)
    const b = deriveSourceId(EVENT_URL)
    assert.equal(a, 'sealing-the-past-breaking-barriers-expungement-day-at-the-akron-urban-league')
    assert.equal(a, b)
  })

  it('is insensitive to a missing trailing slash', () => {
    assert.equal(deriveSourceId(EVENT_URL.replace(/\/$/, '')), deriveSourceId(EVENT_URL))
  })
})

describe('parseMeta / mapTags', () => {
  it('parseMeta is import-safe and returns an object', () => {
    assert.equal(typeof parseMeta(EVENT_FIXTURE), 'object')
  })

  it('mapTags always carries the akron/community base tags', () => {
    const tags = mapTags('Expungement Day at the Akron Urban League', '')
    assert.ok(tags.includes('akron'))
    assert.ok(tags.includes('community'))
    assert.equal(new Set(tags).size, tags.length)
  })
})

describe('parseMeta', () => {
  const KEY_FIRST = '<meta property="og:title" content="Expungement Day" />'
    + '<meta name="og:description" content="A fresh start." />'
    + '<meta property="og:image" content="https://example.org/hero.jpg" />'
  const VALUE_FIRST = '<meta content="Expungement Day" property="og:title" />'
    + '<meta content="A fresh start." name="og:description" />'
    + '<meta content="https://example.org/hero.jpg" property="og:image" />'

  it('reads og:* with the key attribute first', () => {
    const meta = parseMeta(KEY_FIRST)
    assert.equal(meta['og:title'], 'Expungement Day')
    assert.equal(meta['og:description'], 'A fresh start.')
    assert.equal(meta['og:image'], 'https://example.org/hero.jpg')
  })

  it('reads og:* with the content attribute first', () => {
    const meta = parseMeta(VALUE_FIRST)
    assert.equal(meta['og:title'], 'Expungement Day')
    assert.equal(meta['og:description'], 'A fresh start.')
    assert.equal(meta['og:image'], 'https://example.org/hero.jpg')
  })

  it('pulls og:title and og:image off the real fixture', () => {
    const meta = parseMeta(EVENT_FIXTURE)
    assert.match(meta['og:title'], /^Sealing the Past/)
    assert.equal(meta['og:image'], 'https://www.akronurbanleague.org/wp-content/uploads/Akron-Urban-League-Logo.svg')
  })

  it('keeps a real og:image but nulls the logo SVG at parseDetailPage', () => {
    const withReal = EVENT_FIXTURE.replace(
      'https://www.akronurbanleague.org/wp-content/uploads/Akron-Urban-League-Logo.svg',
      'https://www.akronurbanleague.org/wp-content/uploads/Expongement-day2026-new-scaled.jpg',
    )
    assert.equal(
      parseDetailPage(withReal, EVENT_URL, EVENT_PUBLISHED, TODAY).imageUrl,
      'https://www.akronurbanleague.org/wp-content/uploads/Expongement-day2026-new-scaled.jpg',
    )
    assert.equal(parseDetailPage(EVENT_FIXTURE, EVENT_URL, EVENT_PUBLISHED, TODAY).imageUrl, null)
  })
})

describe('loose address matching — prose false positives', () => {
  const parseAddr = text => parseDetailPage(
    `<html><body><article><p>${text}</p></article></body></html>`,
    EVENT_URL, EVENT_PUBLISHED, TODAY,
  )

  it('still matches the real "at 440 Vernon Odom Boulevard in Akron"', () => {
    const got = parseAddr('Expungement Day, from 9 a.m. to 3 p.m., at 440 Vernon Odom Boulevard in Akron.')
    assert.equal(got.addressMatched, true)
    assert.equal(got.venueAddress, '440 Vernon Odom Boulevard')
    assert.equal(got.venueCity, 'Akron')
  })

  it('does not treat a founding year in prose as an address', () => {
    const got = parseAddr('Since 1925 the League has been a place in Akron.')
    assert.equal(got.addressMatched, false)
    assert.equal(got.venueAddress, null)
  })

  it('does not treat a dollar amount as an address', () => {
    const got = parseAddr('We raised $25,000 for Green Way, Kent residents.')
    assert.equal(got.addressMatched, false)
    assert.equal(got.venueAddress, null)
  })

  it('still matches the full ZIP form', () => {
    const got = parseAddr('Akron Urban League, 440 Vernon Odom Blvd., Akron, OH 44307')
    assert.equal(got.addressMatched, true)
    assert.equal(got.venueZip, '44307')
  })
})

describe('date found only in the post title', () => {
  it('uses the hero headline date when the article body has none', () => {
    const parsed = parseDetailPage(TITLE_DATE_FIXTURE, TITLE_DATE_URL, TITLE_DATE_PUBLISHED, TODAY)
    assert.equal(extractDateCandidates(parsed.title).length, 1)
    assert.equal(parsed.dateStr, '2026-03-13')
    assert.equal(parsed.timeStr, '18:00:00')
  })

  it('still prefers a body date over the title date', () => {
    const parsed = parseDetailPage(EVENT_FIXTURE, EVENT_URL, EVENT_PUBLISHED, TODAY)
    assert.equal(parsed.dateStr, '2026-11-06')
  })
})
