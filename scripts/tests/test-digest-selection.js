/**
 * test-digest-selection.js
 *
 * Behavioral tests for the digest selection algorithm (select.ts), the
 * logic that decides which ~14 events go in each email. These import the
 * real module (Node strips the TS types) and assert the properties we
 * actually care about: temporal spread, organizer diversity, the cap,
 * determinism + daily rotation, the today-only case, the reserved
 * featured hero, and the image gate on rich cards.
 *
 * Run:  node --test scripts/tests/test-digest-selection.js
 */

// Pin Eastern time so the date suffix in slugs is deterministic and
// matches what the digest emits (it formats slug dates in ET, the
// audience TZ). Must run before any date formatting.
process.env.TZ = 'America/New_York'

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { eventPath as appEventPath } from '../../src/lib/slug.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SELECT = join(__dirname, '..', '..', 'supabase', 'functions', 'send-digest', 'select.ts')
const {
  selectDigestEvents,
  filterEventsForSubscriber,
  MAX_EVENTS_PER_EMAIL,
  MAX_PER_ORG,
  orgKey,
  eventPath,
  hasImage,
} = await import(SELECT)

const NOW = new Date('2026-06-15T08:00:00Z')

// Build an event `dayOffset` days after NOW. Defaults make a "plain"
// event (no free/ticket/description weight) so scoring ties unless a test
// opts into signals — that keeps jitter-driven tests meaningful.
//
// An image IS present by default: it's a hard gate for rich cards, not a
// scored signal, so an image-less event is simply not pick-eligible and
// would make every selection test here trivially empty. Opt out with
// `{ image: false }` to exercise the gate itself.
function ev(id, dayOffset, opts = {}) {
  const d = new Date(NOW)
  d.setUTCDate(d.getUTCDate() + dayOffset)
  if (opts.hour != null) d.setUTCHours(opts.hour)
  else d.setUTCHours(18)
  const org = opts.org ?? `org-${id}`
  return {
    id: String(id),
    title: opts.title ?? `Event ${id}`,
    description: opts.description ?? null,
    start_at: d.toISOString(),
    end_at: null,
    category: opts.category ?? 'music',
    categories: opts.categories ?? ['music'],
    tags: [],
    price_min: opts.free ? 0 : (opts.price_min ?? 10),
    price_max: opts.free ? 0 : (opts.price_max ?? 20),
    age_restriction: 'all_ages',
    image_url: opts.image === false ? null : 'https://x/i.png',
    ticket_url: opts.ticket ? 'https://x/t' : null,
    featured: !!opts.featured,
    venues: [{ name: opts.venue ?? `V${id}`, address: null, lat: null, lng: null, image_url: null }],
    organizations: [{ id: org, name: org, image_url: null }],
  }
}

function sub(overrides = {}) {
  return {
    id: overrides.id ?? 'sub-1',
    email: 'a@b.com',
    frequency: overrides.frequency ?? 'daily',
    lookahead_days: overrides.lookahead_days ?? 30,
    preferences: {
      intents: ['all'], categories: [], venue_ids: [], org_ids: [],
      price_max: null, age_restriction: null,
      event_days: [0, 1, 2, 3, 4, 5, 6], location: null,
      keywords: [], keywords_title_only: false,
    },
    token: 't',
  }
}

const distinctDays = (events) => new Set(events.map(e => e.start_at.slice(0, 10))).size

describe('digest selection', () => {
  it('spreads picks across the window instead of clustering on the soonest day', () => {
    // 15 days, 4 events each, all distinct orgs — the old "sort by date,
    // take 14" would return only days 0–3.
    const events = []
    let id = 0
    for (let day = 0; day < 15; day++) {
      for (let k = 0; k < 4; k++) events.push(ev(id, day, { org: `org-${id}` })), id++
    }
    const { picks } = selectDigestEvents(events, sub(), NOW)
    assert.ok(picks.length <= MAX_EVENTS_PER_EMAIL)
    assert.ok(distinctDays(picks) >= 12, `expected wide spread, got ${distinctDays(picks)} distinct days`)
  })

  it('never exceeds the per-organizer diversity cap when alternatives exist', () => {
    const events = []
    let id = 0
    // One dominant org with an event every day for 20 days...
    for (let day = 0; day < 20; day++) events.push(ev(id++, day, { org: 'BIG' }))
    // ...plus plenty of other distinct-org events to choose instead.
    for (let day = 0; day < 12; day++) events.push(ev(id++, day, { org: `small-${id}` }))

    const { picks } = selectDigestEvents(events, sub(), NOW)
    const counts = {}
    for (const e of picks) counts[orgKey(e)] = (counts[orgKey(e)] ?? 0) + 1
    assert.ok((counts['BIG'] ?? 0) <= MAX_PER_ORG, `BIG appeared ${counts['BIG']} times`)
  })

  it('caps picks at MAX_EVENTS_PER_EMAIL and exposes the true match count separately', () => {
    const events = Array.from({ length: 100 }, (_, i) => ev(i, i % 25, { org: `org-${i}` }))
    const matched = filterEventsForSubscriber(events, sub(), NOW)
    const { picks } = selectDigestEvents(matched, sub(), NOW)
    assert.equal(picks.length, MAX_EVENTS_PER_EMAIL)
    assert.ok(matched.length > picks.length, 'matched count should exceed the shown picks')
  })

  it('is deterministic per subscriber+date and rotates the sample across days', () => {
    // 28 same-day, same-score, distinct-org events: selection is purely
    // jitter-driven, so the seed (subscriber+date) fully determines it.
    const events = Array.from({ length: 28 }, (_, i) => ev(i, 0, { hour: 12 + (i % 6), org: `org-${i}` }))

    const a1 = selectDigestEvents(events, sub(), NOW).picks.map(e => e.id)
    const a2 = selectDigestEvents(events, sub(), NOW).picks.map(e => e.id)
    assert.deepEqual(a1, a2, 'same subscriber + date must be reproducible')

    const other = new Date('2026-06-16T08:00:00Z')
    const b = selectDigestEvents(events, sub(), other).picks.map(e => e.id)
    assert.notDeepEqual(a1.slice().sort(), b.slice().sort(), 'a different day should rotate the sample')
  })

  it('today-only window returns same-day picks within the org cap', () => {
    const events = []
    let id = 0
    for (let o = 0; o < 10; o++) for (let k = 0; k < 2; k++) events.push(ev(id++, 0, { hour: 12 + k, org: `org-${o}` }))
    const s = sub({ frequency: 'daily', lookahead_days: 1 })
    const { picks } = selectDigestEvents(filterEventsForSubscriber(events, s, NOW), s, NOW)
    assert.equal(distinctDays(picks), 1)
    const counts = {}
    for (const e of picks) counts[orgKey(e)] = (counts[orgKey(e)] ?? 0) + 1
    assert.ok(Object.values(counts).every(c => c <= MAX_PER_ORG))
  })

  it('always reserves the featured hero, even on a late day', () => {
    const events = []
    let id = 0
    for (let day = 0; day < 14; day++) for (let k = 0; k < 3; k++) events.push(ev(id++, day, { org: `org-${id}` }))
    const hero = ev('HERO', 27, { featured: true, org: 'hero-org' })
    events.push(hero)
    const { picks } = selectDigestEvents(events, sub(), NOW)
    assert.ok(picks.some(e => e.id === 'HERO'), 'featured hero must be included')
  })

  it('orders picks chronologically for the day-grouped layout', () => {
    const events = Array.from({ length: 40 }, (_, i) => ev(i, i % 15, { org: `org-${i}` }))
    const { picks } = selectDigestEvents(events, sub(), NOW)
    const times = picks.map(e => new Date(e.start_at).getTime())
    assert.deepEqual(times, times.slice().sort((a, b) => a - b))
  })
})

// Rich cards render an <img>; with no resolvable image the card falls back
// to a category-colored gradient placeholder, which reads as a design bug
// in the inbox. These lock the gate that prevents that.
describe('digest image gate', () => {
  it('never puts an image-less event in the picks', () => {
    const events = [
      ...Array.from({ length: 6 }, (_, i) => ev(`img-${i}`, i, { org: `org-${i}` })),
      ...Array.from({ length: 6 }, (_, i) => ev(`no-img-${i}`, i, { org: `bare-${i}`, image: false })),
    ]
    const { picks } = selectDigestEvents(events, sub(), NOW)
    assert.ok(picks.length > 0, 'sanity: the image-having events should still be picked')
    assert.ok(picks.every(hasImage), 'every pick must have a resolvable image')
    assert.ok(!picks.some(e => String(e.id).startsWith('no-img')), 'no image-less event may appear as a card')
  })

  // Regression: "Feast of Santo Stefano" (2026-07-15) shipped as the hero
  // with a bare FESTIVAL gradient block. It was featured:true with no
  // image on the event, its venue, or its organizer. hasImage was only a
  // +6 score, so with nothing to outrank it the hero slot took it anyway.
  it('does not promote an image-less featured event to hero', () => {
    const events = [
      ...Array.from({ length: 8 }, (_, i) => ev(`plain-${i}`, i, { org: `org-${i}` })),
      ev('BARE-HERO', 3, { featured: true, org: 'carovillese', image: false }),
    ]
    const { picks } = selectDigestEvents(events, sub(), NOW)
    assert.ok(!picks.some(e => e.id === 'BARE-HERO'), 'an image-less featured event must not become a card')
  })

  it('still prefers a featured event for hero when it does have an image', () => {
    const events = [
      ...Array.from({ length: 8 }, (_, i) => ev(`plain-${i}`, i, { org: `org-${i}` })),
      ev('GOOD-HERO', 3, { featured: true, org: 'hero-org' }),
    ]
    const { picks } = selectDigestEvents(events, sub(), NOW)
    assert.ok(picks.some(e => e.id === 'GOOD-HERO'), 'a featured event WITH an image is still the hero')
  })

  // With the plain-text tail removed (2026-07-15), the card gate is the
  // email's only door — an image-less event has nowhere left to appear.
  it('keeps image-less events out of the email entirely', () => {
    const events = [
      ...Array.from({ length: 20 }, (_, i) => ev(`img-${i}`, i % 10, { org: `org-${i}` })),
      ev('BARE', 2, { org: 'bare-org', image: false }),
    ]
    const selection = selectDigestEvents(events, sub(), NOW)
    assert.ok(!selection.picks.some(e => e.id === 'BARE'), 'image-less event must not be a card')
    assert.deepEqual(Object.keys(selection), ['picks'], 'selection exposes picks only — no tail to leak into')
  })

  it('returns no picks when nothing has an image, so the caller skips the send', () => {
    const events = Array.from({ length: 10 }, (_, i) => ev(i, i, { org: `org-${i}`, image: false }))
    const { picks } = selectDigestEvents(events, sub(), NOW)
    assert.equal(picks.length, 0, 'an all-placeholder email must not be assembled at all')
  })

  it('resolves an image through the venue and organizer fallback chain', () => {
    const viaVenue = ev('V', 1, { image: false })
    viaVenue.venues[0].image_url = 'https://x/venue.png'
    assert.ok(hasImage(viaVenue), 'venue image should satisfy the gate')

    const viaOrg = ev('O', 1, { image: false })
    viaOrg.organizations[0].image_url = 'https://x/org.png'
    assert.ok(hasImage(viaOrg), 'organizer image should satisfy the gate')

    const none = ev('N', 1, { image: false })
    assert.ok(!hasImage(none), 'no image anywhere in the chain fails the gate')

    // Mirrors resolveEventImage()'s http(s) test in index.ts — a relative
    // or junk path is not a usable <img src> in an email client.
    const relative = ev('R', 1, { image: false })
    relative.image_url = '/local/path.png'
    assert.ok(!hasImage(relative), 'non-http(s) src must not satisfy the gate')
  })
})

describe('digest event URLs', () => {
  // Regression for the broken "/events/{id}" links: every link must carry
  // a slug SEGMENT plus the id, or it hits the slug-only router and errors.
  it('builds /events/{slug}/{id} with a non-empty slug ending in the id', () => {
    const e = { id: 'abc-123', title: 'Riverfront Cruise In', start_at: '2026-06-11T22:00:00Z' }
    const path = eventPath(e)
    const parts = path.split('/') // ['', 'events', slug, id]
    assert.equal(parts.length, 4)
    assert.equal(parts[1], 'events')
    assert.ok(parts[2].length > 0, 'slug segment must not be empty')
    assert.equal(parts[3], 'abc-123')
  })

  it('matches the app slug.js for representative events (drift guard)', () => {
    // Noon-ET (16:00Z) start times so the date suffix is unambiguous.
    const samples = [
      { id: 'u1', title: 'Café Música & Friends!', start_at: '2026-05-28T16:00:00Z' },
      { id: 'u2', title: 'Submit', start_at: '2026-06-05T16:00:00Z' },       // reserved-word title
      { id: 'u3', title: '   ', start_at: '2026-06-09T16:00:00Z' },          // empty after strip
      { id: 'u4', title: 'The Black Keys — Homecoming', start_at: '2026-06-19T16:00:00Z' },
      { id: 'u5', title: 'No Date Event', start_at: null },
    ]
    for (const e of samples) {
      assert.equal(eventPath(e), appEventPath(e), `slug drift for "${e.title}"`)
    }
  })
})
