/**
 * test-digest-selection.js
 *
 * Behavioral tests for the digest selection algorithm (select.ts), the
 * logic that decides which ~14 events go in each email. These import the
 * real module (Node strips the TS types) and assert the properties we
 * actually care about: temporal spread, organizer diversity, the cap,
 * determinism + daily rotation, the tail, the today-only case, and the
 * reserved featured hero.
 *
 * Run:  node --test scripts/tests/test-digest-selection.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SELECT = join(__dirname, '..', '..', 'supabase', 'functions', 'send-digest', 'select.ts')
const {
  selectDigestEvents,
  filterEventsForSubscriber,
  MAX_EVENTS_PER_EMAIL,
  MAX_PER_ORG,
  TAIL_EVENT_COUNT,
  orgKey,
} = await import(SELECT)

const NOW = new Date('2026-06-15T08:00:00Z')

// Build an event `dayOffset` days after NOW. Defaults make a "plain"
// event (no free/image/ticket/description weight) so scoring ties unless
// a test opts into signals — that keeps jitter-driven tests meaningful.
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
    image_url: opts.image ? 'https://x/i.png' : null,
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

  it('returns a tail that is disjoint from picks and capped', () => {
    const events = Array.from({ length: 60 }, (_, i) => ev(i, i % 20, { org: `org-${i}` }))
    const { picks, tail } = selectDigestEvents(events, sub(), NOW)
    assert.ok(tail.length <= TAIL_EVENT_COUNT)
    const pickIds = new Set(picks.map(e => e.id))
    assert.ok(tail.every(e => !pickIds.has(e.id)), 'tail must not repeat a pick')
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
