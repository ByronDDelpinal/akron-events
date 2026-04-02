/**
 * test-torchbearers.js
 *
 * Tests for the Torchbearers (Tribe Events Calendar) scraper.
 * Category mapping, tag parsing, cost parsing, venue resolution,
 * full normalization, and batch invariants.
 *
 * Run:
 *   node --test scripts/tests/test-torchbearers.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// ── Set dummy env vars before any imports ───────────────────────────────────
process.env.VITE_SUPABASE_URL        = process.env.VITE_SUPABASE_URL        || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import {
  COMPLETE_EVENT,
  EVENT_WITH_VENUE,
  SOCIAL_EVENT,
  VOLUNTEER_EVENT,
  GMM_EVENT,
  NO_VENUE,
  PAID_EVENT,
  HTML_ENTITIES_EVENT,
  NO_START_DATE,
  ALL_FIXTURES,
} from './fixtures/torchbearers-events.js'

import { stripHtml, parseCostFromTribe, parseTagsFromTribe, sanitizeEventText } from '../lib/normalize.js'

// ════════════════════════════════════════════════════════════════════════════
// RE-IMPLEMENT SCRAPER LOGIC FOR TESTABILITY
// ════════════════════════════════════════════════════════════════════════════

function parseImage(imageObj, descriptionHtml = '') {
  if (imageObj && imageObj.url) return imageObj.url
  const match = descriptionHtml.match(/<img[^>]+src="([^"]+)"/)
  return match?.[1] ?? null
}

function parseCategory(categories = []) {
  const slugs = categories.map(c => (c.slug ?? c.name ?? '').toLowerCase())
  if (slugs.some(s => s.includes('music') || s.includes('concert')))         return 'music'
  if (slugs.some(s => s.includes('art') || s.includes('gallery')))           return 'art'
  if (slugs.some(s => s.includes('food') || s.includes('culinary')))         return 'food'
  if (slugs.some(s => s.includes('sport') || s.includes('fitness')))         return 'sports'
  if (slugs.some(s => s.includes('educat') || s.includes('workshop')))       return 'education'
  if (slugs.some(s => s.includes('nonprofit') || s.includes('fundrais')))    return 'nonprofit'
  if (slugs.some(s => s.includes('social') || s.includes('happy-hour')))     return 'community'
  if (slugs.some(s => s.includes('volunteer') || s.includes('service')))     return 'nonprofit'
  if (slugs.some(s => s.includes('committee') || s.includes('meeting')))     return 'community'
  if (slugs.some(s => s.includes('gmm') || s.includes('general-member')))    return 'community'
  return 'community'
}

function normalise(ev) {
  const { price_min, price_max } = parseCostFromTribe(ev.cost, ev.cost_details)
  const category  = parseCategory(ev.categories)
  const tags      = parseTagsFromTribe(ev.categories, ev.tags, ['akron', 'young-professionals', 'leadership'])
  const imageUrl  = parseImage(ev.image, ev.description)
  const descText  = stripHtml(ev.description)

  return {
    title:           ev.title,
    description:     descText || null,
    start_at:        ev.utc_start_date ? ev.utc_start_date.replace(' ', 'T') + 'Z' : null,
    end_at:          ev.utc_end_date   ? ev.utc_end_date.replace(' ', 'T') + 'Z'   : null,
    category,
    tags,
    price_min,
    price_max,
    age_restriction: 'not_specified',
    image_url:       imageUrl,
    ticket_url:      ev.website || ev.url || null,
    source:          'torchbearers',
    source_id:       String(ev.id),
    status:          'published',
    featured:        ev.featured ?? false,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Category mapping
// ════════════════════════════════════════════════════════════════════════════

describe('Torchbearers — category mapping', () => {
  it('maps committee meetings to community', () => {
    assert.equal(parseCategory(COMPLETE_EVENT.categories), 'community')
  })

  it('maps social events to community', () => {
    assert.equal(parseCategory(SOCIAL_EVENT.categories), 'community')
  })

  it('maps volunteer to nonprofit', () => {
    assert.equal(parseCategory(VOLUNTEER_EVENT.categories), 'nonprofit')
  })

  it('maps GMM to community', () => {
    assert.equal(parseCategory(GMM_EVENT.categories), 'community')
  })

  it('maps fundraisers to nonprofit', () => {
    assert.equal(parseCategory(PAID_EVENT.categories), 'nonprofit')
  })

  it('maps workshops to education', () => {
    assert.equal(parseCategory(NO_VENUE.categories), 'education')
  })

  it('defaults to community for empty categories', () => {
    assert.equal(parseCategory([]), 'community')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Tag parsing
// ════════════════════════════════════════════════════════════════════════════

describe('Torchbearers — tag parsing', () => {
  it('includes extra static tags', () => {
    const row = normalise(COMPLETE_EVENT)
    assert.ok(row.tags.includes('akron'))
    assert.ok(row.tags.includes('young-professionals'))
    assert.ok(row.tags.includes('leadership'))
  })

  it('includes category names as tags', () => {
    const row = normalise(COMPLETE_EVENT)
    assert.ok(row.tags.includes('committee meetings'))
  })

  it('includes API tags', () => {
    const row = normalise(SOCIAL_EVENT)
    assert.ok(row.tags.includes('happy hour'))
  })

  it('deduplicates tags', () => {
    const row = normalise(VOLUNTEER_EVENT)
    const unique = new Set(row.tags)
    assert.equal(row.tags.length, unique.size)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Cost parsing
// ════════════════════════════════════════════════════════════════════════════

describe('Torchbearers — cost parsing', () => {
  it('parses free event', () => {
    const row = normalise(COMPLETE_EVENT)
    assert.equal(row.price_min, 0)
  })

  it('parses paid event with range', () => {
    const row = normalise(PAID_EVENT)
    assert.equal(row.price_min, 50)
    assert.equal(row.price_max, 75)
  })

  it('parses empty cost as free', () => {
    const row = normalise(SOCIAL_EVENT)
    assert.equal(row.price_min, 0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Image extraction
// ════════════════════════════════════════════════════════════════════════════

describe('Torchbearers — image extraction', () => {
  it('extracts image URL from image object', () => {
    const row = normalise(EVENT_WITH_VENUE)
    assert.ok(row.image_url.includes('MarComm.png'))
  })

  it('returns null when image is false', () => {
    const row = normalise(COMPLETE_EVENT)
    assert.equal(row.image_url, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Venue handling
// ════════════════════════════════════════════════════════════════════════════

describe('Torchbearers — venue handling', () => {
  it('event with venue has venue data', () => {
    assert.equal(EVENT_WITH_VENUE.venue.venue, 'Macaroni Grill')
    assert.equal(EVENT_WITH_VENUE.venue.city, 'Akron')
    assert.equal(EVENT_WITH_VENUE.venue.zip, '44333')
  })

  it('virtual event has empty venue array', () => {
    assert.ok(Array.isArray(COMPLETE_EVENT.venue))
    assert.equal(COMPLETE_EVENT.venue.length, 0)
  })

  it('venue with geo coordinates parses correctly', () => {
    const v = SOCIAL_EVENT.venue
    assert.equal(parseFloat(v.geo_lat), 41.0782)
    assert.equal(parseFloat(v.geo_lng), -81.5365)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Full normalization
// ════════════════════════════════════════════════════════════════════════════

describe('Torchbearers — full normalization', () => {
  it('normalises complete event', () => {
    const row = normalise(COMPLETE_EVENT)
    assert.equal(row.source, 'torchbearers')
    assert.equal(row.source_id, '25876')
    assert.equal(row.title, 'Membership Committee Meeting')
    assert.equal(row.start_at, '2026-04-01T22:00:00Z')
    assert.equal(row.end_at, '2026-04-01T23:00:00Z')
    assert.equal(row.status, 'published')
  })

  it('strips HTML from description', () => {
    const row = normalise(VOLUNTEER_EVENT)
    assert.ok(!row.description.includes('<p>'))
    assert.ok(!row.description.includes('<strong>'))
    assert.ok(row.description.includes('volunteer'))
  })

  it('featured event maps correctly', () => {
    const row = normalise(VOLUNTEER_EVENT)
    assert.equal(row.featured, true)
  })

  it('non-featured event maps correctly', () => {
    const row = normalise(COMPLETE_EVENT)
    assert.equal(row.featured, false)
  })

  it('no-start-date event gets null start_at', () => {
    const row = normalise(NO_START_DATE)
    assert.equal(row.start_at, null)
  })

  it('ticket_url prefers website field when present', () => {
    const row = normalise(PAID_EVENT)
    assert.equal(row.ticket_url, 'https://torchbearersakron.com/gala')
  })

  it('ticket_url falls back to url when website is empty', () => {
    const row = normalise(COMPLETE_EVENT)
    assert.equal(row.ticket_url, 'https://torchbearersakron.com/event/membership-committee-meeting/')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// HTML entity handling
// ════════════════════════════════════════════════════════════════════════════

describe('Torchbearers — HTML entity handling', () => {
  it('sanitizeEventText decodes &#8217; in title', () => {
    const row = normalise(HTML_ENTITIES_EVENT)
    const sanitized = sanitizeEventText(row)
    assert.ok(!sanitized.title.includes('&#8217;'))
    assert.ok(sanitized.title.includes("'"))
  })

  it('sanitizeEventText decodes &amp; in title', () => {
    const row = normalise(HTML_ENTITIES_EVENT)
    const sanitized = sanitizeEventText(row)
    assert.ok(!sanitized.title.includes('&amp;'))
    assert.ok(sanitized.title.includes('&'))
  })

  it('stripHtml decodes entities in description', () => {
    const row = normalise(HTML_ENTITIES_EVENT)
    assert.ok(!row.description.includes('&#8217;'))
    assert.ok(!row.description.includes('&amp;'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Batch invariants
// ════════════════════════════════════════════════════════════════════════════

describe('Torchbearers — batch invariants', () => {
  it('every fixture normalises without throwing', () => {
    for (const ev of ALL_FIXTURES) {
      assert.doesNotThrow(() => normalise(ev))
    }
  })

  it('every normalised row has source=torchbearers', () => {
    for (const ev of ALL_FIXTURES) {
      assert.equal(normalise(ev).source, 'torchbearers')
    }
  })

  it('every normalised row has numeric source_id', () => {
    for (const ev of ALL_FIXTURES) {
      const row = normalise(ev)
      assert.ok(row.source_id, `source_id missing for "${ev.title}"`)
      assert.ok(!isNaN(Number(row.source_id)), `source_id not numeric for "${ev.title}"`)
    }
  })

  it('tags always include static extras', () => {
    for (const ev of ALL_FIXTURES) {
      const row = normalise(ev)
      assert.ok(row.tags.includes('akron'), `missing 'akron' tag for "${ev.title}"`)
      assert.ok(row.tags.includes('leadership'), `missing 'leadership' tag for "${ev.title}"`)
    }
  })

  it('description never contains raw HTML', () => {
    for (const ev of ALL_FIXTURES) {
      const row = normalise(ev)
      if (row.description) {
        assert.ok(!/<[a-z][\s\S]*>/i.test(row.description),
          `HTML found in description for "${ev.title}"`)
      }
    }
  })

  it('start_at is valid ISO 8601 or null', () => {
    for (const ev of ALL_FIXTURES) {
      const row = normalise(ev)
      if (row.start_at) {
        assert.ok(!isNaN(Date.parse(row.start_at)),
          `Invalid start_at for "${ev.title}"`)
      }
    }
  })
})
