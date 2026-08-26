/**test-uakron.js - Tests for University of Akron calendar scraper*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'dummy-key'

import { stripHtml } from '../lib/normalize.js'
import { preloadSummitCountyBoundary } from '../lib/summit-county.js'
import { classifySource, isAllDayEntry, resolveLocality, slugIdFromUrl, pickCanonicalEntry, fetchEvents, isStaleLastModified, LAST_MODIFIED_MAX_AGE_MS, MIN_EXPECTED_EVENTS, COMPLETE_RENDER_MIN_EVENTS, MAX_FETCH_ATTEMPTS } from '../scrape-uakron-calendar.js'
import { EJ_THOMAS_EVENT, GENERAL_UAKRON_EVENT, LECTURE_EVENT, MISSING_TITLE, MISSING_DATE, PAID_EVENT, PERFORMANCE_CONCERT, MYERS_ART_EVENT, CHP_EVENT, NUMERIC_COST_EVENT, TIERED_COST_EVENT, OBJECT_COST_EVENT, WAYNE_ORRVILLE_COORDS_EVENT, WAYNE_NO_COORDS_EVENT, SOPA_ORIGINAL_26852, LIVE_COPY_26855, CHP_ORIGINAL_26863, CHP_LIVE_COPY_26864, ALL_FIXTURES } from './fixtures/uakron-events.js'

// resolveLocality's coordinate branch needs the county polygon loaded — same
// top-level preload pattern as test-summit-county.js / test-akron-life.js.
await preloadSummitCountyBoundary()

function parseCategory(ev) {
  const group = (ev.group_title ?? '').toLowerCase()
  const types = (ev.event_types ?? []).map(t => (t.name ?? '').toLowerCase())
  const tags = ev.tags ? (Array.isArray(ev.tags) ? ev.tags.map(t => (t.name ?? '').toLowerCase()) : []) : []
  const all = [...types, ...tags, group]

  if (group.includes('ej thomas') || group.includes('performing arts')) return 'art'
  if (group.includes('music') || group.includes('school of music')) return 'music'
  if (group.includes('art') || group.includes('school of art')) return 'art'
  if (all.some(s => s.includes('athletic') || s.includes('sport') || s.includes('recreation'))) return 'sports'
  if (all.some(s => s.includes('lecture') || s.includes('seminar') || s.includes('workshop') || s.includes('class'))) return 'education'
  if (all.some(s => s.includes('performance') || s.includes('recital') || s.includes('concert'))) {
    if (group.includes('music') || group.includes('school of music')) return 'music'
    return 'art'
  }
  return 'education'
}

function parseTags(ev) {
  const tags = ev.tags ? (Array.isArray(ev.tags) ? ev.tags.map(t => t.name?.toLowerCase()).filter(Boolean) : []) : []
  return [...new Set([...tags, 'university', 'uakron'])]
}

function parsePrice(costStr) {
  // Mirror of scrape-uakron-calendar.js parsePrice(). Never assume free:
  // unknown/unparseable cost stays null; only an explicit number or
  // "free"/"no charge" resolves to 0.
  if (costStr == null || costStr === '' || costStr === false) return null

  if (typeof costStr === 'number') {
    return Number.isFinite(costStr) && costStr >= 0 ? costStr : null
  }

  if (Array.isArray(costStr)) {
    const nums = costStr
      .map(v => typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.]/g, '')))
      .filter(n => Number.isFinite(n) && n >= 0)
    return nums.length ? Math.min(...nums) : null
  }

  if (typeof costStr !== 'string') return null

  const s = costStr.trim().toLowerCase()
  if (!s) return null
  if (s === 'free' || s === 'no charge') return 0
  const m = s.match(/\d+(\.\d+)?/)
  return m ? parseFloat(m[0]) : null
}

function normalizeEvent(ev) {
  if (!ev.title || !ev.date_iso) return null

  const startAt = new Date(ev.date_iso).toISOString()
  const endAt = ev.date2_iso ? new Date(ev.date2_iso).toISOString() : null

  const category = parseCategory(ev)
  const tags = parseTags(ev)
  const price_min = parsePrice(ev.cost)
  const descText = stripHtml(ev.description ?? '')

  const source = classifySource(ev.group_title)

  return {
    title: ev.title,
    description: descText || null,
    start_at: startAt,
    end_at: endAt,
    category,
    tags,
    price_min,
    price_max: null,
    age_restriction: 'not_specified',
    image_url: ev.thumbnail ?? null,
    ticket_url: ev.url ?? null,
    source,
    source_id: String(ev.id),
    status: 'published',
    featured: false,
  }
}

describe('UAkron: Category Mapping', () => {
  it('maps EJ Thomas to art', () => {
    assert.equal(parseCategory({ group_title: 'EJ Thomas Hall', event_types: [] }), 'art')
  })

  it('maps music school to music', () => {
    assert.equal(parseCategory({ group_title: 'School of Music', event_types: [] }), 'music')
  })

  it('maps athletics to sports', () => {
    assert.equal(parseCategory({ group_title: 'Athletics', event_types: [{ name: 'Athletic Event' }] }), 'sports')
  })

  it('maps lectures to education', () => {
    assert.equal(parseCategory({ group_title: '', event_types: [{ name: 'Lecture' }] }), 'education')
  })
})

describe('UAkron: Price Parsing', () => {
  it('parses free events', () => {
    assert.equal(parsePrice('Free'), 0)
    assert.equal(parsePrice('No charge'), 0)
  })

  it('extracts numeric prices', () => {
    assert.equal(parsePrice('$25'), 25)
    assert.equal(parsePrice('$15.50'), 15.50)
  })

  it('returns null (unknown — never assume free) for null/empty', () => {
    assert.equal(parsePrice(null), null)
    assert.equal(parsePrice(''), null)
    assert.equal(parsePrice(false), null)
  })

  // ── Non-string cost handling (Simonetti Awards incident, 2026-04-17) ─────
  // LiveWhale's JSON API serialises the cost field by content type. A bare
  // numeric price is emitted as a JSON number; tiered pricing as an array.
  // parsePrice must accept these without calling .trim() on them.
  it('accepts a bare number (no dollar sign in admin entry)', () => {
    assert.equal(parsePrice(45), 45)
    assert.equal(parsePrice(0), 0)
    assert.equal(parsePrice(15.5), 15.5)
  })

  it('rejects negative / non-finite numbers as unknown (null)', () => {
    assert.equal(parsePrice(-10), null)
    assert.equal(parsePrice(NaN), null)
    assert.equal(parsePrice(Infinity), null)
  })

  it('takes the minimum of a tiered price array', () => {
    assert.equal(parsePrice([35, 60]), 35)
    assert.equal(parsePrice([60, 35, 100]), 35)
    assert.equal(parsePrice([5]), 5)
  })

  it('parses string entries inside a tiered array', () => {
    assert.equal(parsePrice(['$35', '$60']), 35)
    assert.equal(parsePrice(['alumni: $25', 'guest: $40']), 25)
  })

  it('returns null for empty or all-invalid arrays (unknown, not free)', () => {
    assert.equal(parsePrice([]), null)
    assert.equal(parsePrice(['invalid', null]), null)
    assert.equal(parsePrice([-5, -10]), null)
  })

  it('treats objects and booleans as unknown (null)', () => {
    assert.equal(parsePrice({ amount: 50 }), null)
    assert.equal(parsePrice(true), null)
    assert.equal(parsePrice(undefined), null)
  })

  it('does not throw on any of the observed shapes', () => {
    // Regression guard: the incident crashed here with
    // "costStr.trim is not a function".
    assert.doesNotThrow(() => parsePrice(45))
    assert.doesNotThrow(() => parsePrice([35, 60]))
    assert.doesNotThrow(() => parsePrice({ amount: 50 }))
    assert.doesNotThrow(() => parsePrice(null))
    assert.doesNotThrow(() => parsePrice('Free'))
  })
})

describe('UAkron: Event Normalization', () => {
  it('normalizes EJ Thomas event', () => {
    const row = normalizeEvent(EJ_THOMAS_EVENT)
    assert.ok(row)
    assert.equal(row.source, 'ejthomas_hall')
    assert.equal(row.category, 'art')
  })

  it('normalizes general UAkron event', () => {
    const row = normalizeEvent(GENERAL_UAKRON_EVENT)
    assert.ok(row)
    assert.equal(row.source, 'uakron_calendar')
  })

  it('routes Myers School of Art to uakron_myers_art', () => {
    const row = normalizeEvent(MYERS_ART_EVENT)
    assert.ok(row)
    assert.equal(row.source, 'uakron_myers_art')
  })

  it('routes Cummings Center to uakron_chp', () => {
    const row = normalizeEvent(CHP_EVENT)
    assert.ok(row)
    assert.equal(row.source, 'uakron_chp')
  })

  it('normalizes event with numeric cost (Simonetti-shape)', () => {
    const row = normalizeEvent(NUMERIC_COST_EVENT)
    assert.ok(row, 'event with cost: 45 should normalize, not throw')
    assert.equal(row.price_min, 45)
  })

  it('normalizes event with tiered array cost', () => {
    const row = normalizeEvent(TIERED_COST_EVENT)
    assert.ok(row, 'event with cost: [35, 60] should normalize')
    assert.equal(row.price_min, 35, 'array cost should use the minimum tier')
  })

  it('normalizes event with object cost (unknown → null, never assume free)', () => {
    const row = normalizeEvent(OBJECT_COST_EVENT)
    assert.ok(row, 'event with object cost should normalize, not throw')
    assert.equal(row.price_min, null, 'unknown-shape cost stays null, not 0')
  })

  it('skips event without title', () => {
    const row = normalizeEvent(MISSING_TITLE)
    assert.equal(row, null)
  })

  it('skips event without date', () => {
    const row = normalizeEvent(MISSING_DATE)
    assert.equal(row, null)
  })

  it('parses paid events', () => {
    const row = normalizeEvent(PAID_EVENT)
    assert.ok(row)
    assert.equal(row.price_min, 25)
  })

  it('categorizes performance concerts', () => {
    const row = normalizeEvent(PERFORMANCE_CONCERT)
    assert.ok(row)
    assert.equal(row.category, 'music')
  })
})

describe('UAkron: All-day academic-calendar filter', () => {
  // Real shapes pulled from the LiveWhale feed (2026-06-14): these all carry
  // is_all_day:1, a midnight start, and no end time.
  const ALL_DAY_NOISE = [
    { title: 'Summer Hours Begin: 8:00 am - 4:30 pm', date_iso: '2026-06-14T00:00:00-04:00', is_all_day: 1 },
    { title: 'Juneteenth',                            date_iso: '2026-06-19T00:00:00-04:00', is_all_day: 1 },
    { title: 'Day and Evening Classes Begin',         date_iso: '2026-08-24T00:00:00-04:00', is_all_day: 1 },
    { title: 'Commencement',                          date_iso: '2026-08-15T00:00:00-04:00', is_all_day: 1 },
    { title: 'BCAS Summer CORE', description: 'Orientation', location: 'Student Union', is_all_day: 1, date_iso: '2026-06-15T00:00:00-04:00' },
  ]

  it('flags every all-day entry, even one that carries a description', () => {
    for (const ev of ALL_DAY_NOISE) {
      assert.equal(isAllDayEntry(ev), true, `should filter "${ev.title}"`)
    }
  })

  it('keeps timed events (is_all_day falsy)', () => {
    assert.equal(isAllDayEntry({ title: 'Jazz Concert', date_iso: '2026-06-20T19:00:00-04:00', is_all_day: 0 }), false)
    assert.equal(isAllDayEntry({ title: 'Lecture', date_iso: '2026-06-20T14:00:00-04:00' }), false)
    assert.equal(isAllDayEntry(EJ_THOMAS_EVENT), false)
  })

  it('is null-safe', () => {
    assert.equal(isAllDayEntry(null), false)
    assert.equal(isAllDayEntry(undefined), false)
    assert.equal(isAllDayEntry({}), false)
  })
})

describe('UAkron: resolveLocality (Wayne College geo-gate)', () => {
  it('gates coord-less Wayne events out via group_title', () => {
    assert.equal(resolveLocality(WAYNE_NO_COORDS_EVENT), 'out')
  })

  it('gates Wayne events with Orrville coords out via the polygon', () => {
    assert.equal(resolveLocality(WAYNE_ORRVILLE_COORDS_EVENT), 'out')
  })

  it('keeps coord-less non-Wayne (main campus) events in', () => {
    assert.equal(resolveLocality(GENERAL_UAKRON_EVENT), 'in')
    assert.equal(resolveLocality(LECTURE_EVENT), 'in')
  })

  it('keeps events with Akron coords in (polygon path)', () => {
    assert.equal(resolveLocality(EJ_THOMAS_EVENT), 'in')
  })

  it('coords win over the group-title check', () => {
    // A hypothetical Wayne-group event held on the Akron main campus must
    // pass: the polygon is authoritative, the name check only handles
    // coord-less rows.
    assert.equal(resolveLocality({ ...WAYNE_NO_COORDS_EVENT, location_latitude: '41.0756', location_longitude: '-81.5106' }), 'in')
  })

  it('is case/whitespace tolerant and null-safe on group_title', () => {
    assert.equal(resolveLocality({ group_title: '  WAYNE  ' }), 'out')
    assert.equal(resolveLocality({ group_title: null }), 'in')
    assert.equal(resolveLocality({}), 'in')
  })
})

// Mirror of the processEvents duplicate pre-pass grouping key:
// slugIdFromUrl(ev.url) ?? String(ev.id).
function groupByFeedKey(rawEvents) {
  const groups = new Map()
  for (const ev of rawEvents) {
    const key = slugIdFromUrl(ev.url) ?? String(ev.id)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(ev)
  }
  return groups
}

describe('UAkron: slugIdFromUrl', () => {
  it('extracts the id from a group-original /event/ URL', () => {
    assert.equal(slugIdFromUrl('https://calendar.uakron.edu/sopa/event/26852-x'), '26852')
  })

  it('extracts the id from a /live/events/ syndicated URL', () => {
    assert.equal(slugIdFromUrl('https://calendar.uakron.edu/live/events/26852-x'), '26852')
  })

  it('returns null for no-match and missing URLs', () => {
    assert.equal(slugIdFromUrl('https://calendar.uakron.edu/live/'), null)
    assert.equal(slugIdFromUrl('https://www.uakron.edu/about'), null)
    assert.equal(slugIdFromUrl(''), null)
    assert.equal(slugIdFromUrl(null), null)
    assert.equal(slugIdFromUrl(undefined), null)
  })
})

describe('UAkron: intra-feed duplicate suppression', () => {
  it('groups a sopa original and its /live copy under one slug key', () => {
    const groups = groupByFeedKey([SOPA_ORIGINAL_26852, LIVE_COPY_26855])
    assert.equal(groups.size, 1)
    assert.equal(groups.get('26852').length, 2)
  })

  it('picks the group original when neither copy exists in the DB', () => {
    const winner = pickCanonicalEntry([SOPA_ORIGINAL_26852, LIVE_COPY_26855], new Set())
    assert.equal(String(winner.id), '26852')
    // Order-insensitive
    const reversed = pickCanonicalEntry([LIVE_COPY_26855, SOPA_ORIGINAL_26852], new Set())
    assert.equal(String(reversed.id), '26852')
  })

  it('prefers the copy whose source_id already exists in events', () => {
    // The /live copy 26864 was minted on a previous run — keep updating that
    // row instead of minting a sibling under the slug id.
    const winner = pickCanonicalEntry([CHP_ORIGINAL_26863, CHP_LIVE_COPY_26864], new Set(['26864']))
    assert.equal(String(winner.id), '26864')
  })

  it('falls back to lowest numeric id when no entry is the slug original', () => {
    const a = { id: 26990, url: 'https://calendar.uakron.edu/live/events/26900-x' }
    const b = { id: 26955, url: 'https://calendar.uakron.edu/live/events/26900-x' }
    assert.equal(pickCanonicalEntry([a, b], new Set()).id, 26955)
  })

  it('leaves a singleton /live copy untouched (source_id stays its listing id)', () => {
    const groups = groupByFeedKey([CHP_LIVE_COPY_26864])
    assert.equal(groups.size, 1)
    assert.ok(groups.has('26863'), 'grouped under its URL slug id')
    const entries = groups.get('26863')
    assert.equal(entries.length, 1)
    const winner = pickCanonicalEntry(entries, new Set())
    assert.equal(String(winner.id), '26864', 'singleton keeps its own listing id as source_id')
  })

  it('recurring same-id occurrences share a group but have one distinct listing id (pass-through, not collapse)', () => {
    // The feed repeats week-long academic markers as one listing id across
    // many occurrence dates (e.g. id 25162 on 26 dates). Same source_id
    // cannot mint duplicates, so processEvents only collapses groups with
    // MORE than one distinct listing id.
    const occurrences = [
      { id: 25167, title: 'UA Closed', url: 'https://calendar.uakron.edu/event/25167-ua-closed', date_iso: '2026-12-28T00:00:00-05:00', is_all_day: 1 },
      { id: 25167, title: 'UA Closed', url: 'https://calendar.uakron.edu/event/25167-ua-closed', date_iso: '2026-12-29T00:00:00-05:00', is_all_day: 1 },
    ]
    const groups = groupByFeedKey(occurrences)
    assert.equal(groups.size, 1)
    const entries = groups.get('25167')
    assert.equal(entries.length, 2)
    assert.equal(new Set(entries.map(ev => String(ev.id))).size, 1, 'one distinct listing id → pass-through')
  })

  it('groups url-less entries by their own id (no accidental merging)', () => {
    const groups = groupByFeedKey([GENERAL_UAKRON_EVENT, LECTURE_EVENT])
    assert.equal(groups.size, 2)
    assert.ok(groups.has('2'))
    assert.ok(groups.has('4'))
  })
})

describe('UAkron: Batch Processing', () => {
  it('every event has required fields', () => {
    const REQUIRED = ['title', 'start_at', 'source', 'source_id']
    for (const ev of ALL_FIXTURES) {
      const row = normalizeEvent(ev)
      if (!row) continue
      for (const field of REQUIRED) {
        assert.ok(row[field] != null)
      }
    }
  })

  it('all start_at are valid ISO 8601', () => {
    for (const ev of ALL_FIXTURES) {
      const row = normalizeEvent(ev)
      if (!row) continue
      const parsed = new Date(row.start_at)
      assert.ok(!isNaN(parsed.getTime()))
      assert.ok(row.start_at.endsWith('Z'))
    }
  })

  it('source is one of the four known UAkron sub-calendars', () => {
    const VALID = ['ejthomas_hall', 'uakron_myers_art', 'uakron_chp', 'uakron_calendar']
    for (const ev of ALL_FIXTURES) {
      const row = normalizeEvent(ev)
      if (!row) continue
      assert.ok(VALID.includes(row.source), `Unexpected source: ${row.source}`)
    }
  })

  it('tags always include university and uakron', () => {
    for (const ev of ALL_FIXTURES) {
      const row = normalizeEvent(ev)
      if (!row) continue
      assert.ok(row.tags.includes('university'))
      assert.ok(row.tags.includes('uakron'))
    }
  })
})

// ── Stale-snapshot guard ─────────────────────────────────────────────────
//
// LiveWhale alternates between a live render (~334 events, current
// `last-modified`) and a frozen 2026-06-14 CDN snapshot (~163 events,
// months-old `last-modified`). fetchEvents takes fetch/clock/sleep by
// injection precisely so this is exercisable with no network and no waiting.

const NOW    = Date.parse('2026-08-26T12:00:00Z')
const FRESH  = new Date(NOW - 5 * 60 * 1000).toUTCString()          // 5 min old
const STALE  = new Date(Date.parse('2026-06-14T10:00:00Z')).toUTCString()

const FRESH_COUNT = 334   // observed live render
const STALE_COUNT = 163   // observed poisoned snapshot — ALSO a plausible honest
                          // off-season count, which is why it must clear the floor
const SUB_FLOOR_COUNT = MIN_EXPECTED_EVENTS - 1

function makeEvents(n) {
  return Array.from({ length: n }, (_, i) => ({
    id:       String(20000 + i),
    title:    `Event ${i}`,
    date_iso: '2026-09-01T19:00:00-04:00',
  }))
}

/** Minimal stand-in for the bits of Response that fetchEvents touches. */
function fakeResponse({ lastModified = null, events = [], ok = true, status = 200, body = null } = {}) {
  const payload = body ?? events
  return {
    ok,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === 'last-modified' ? lastModified : null) },
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

/**
 * Build an injectable fetch that replays `responses` in order (the last one
 * repeats), recording every URL it was called with.
 */
function scriptedFetch(responses) {
  const urls = []
  const impl = async (url) => {
    urls.push(url)
    return responses[Math.min(urls.length - 1, responses.length - 1)]
  }
  impl.urls = urls
  return impl
}

/** Run fn with console.log/warn muted — the retry path is chatty by design. */
async function quiet(fn) {
  const { log, warn } = console
  console.log = () => {}
  console.warn = () => {}
  try {
    return await fn()
  } finally {
    console.log = log
    console.warn = warn
  }
}

const deps = (fetchImpl, sleepCalls = []) => ({
  fetchImpl,
  now: () => NOW,
  sleepImpl: async (ms) => { sleepCalls.push(ms) },
})

describe('UAkron: isStaleLastModified', () => {
  it('flags the frozen June 14 snapshot header', () => {
    assert.equal(isStaleLastModified(STALE, NOW), true)
  })

  it('passes a header rendered minutes ago', () => {
    assert.equal(isStaleLastModified(FRESH, NOW), false)
  })

  it('uses a 24h threshold', () => {
    const justInside  = new Date(NOW - LAST_MODIFIED_MAX_AGE_MS + 60_000).toUTCString()
    const justOutside = new Date(NOW - LAST_MODIFIED_MAX_AGE_MS - 60_000).toUTCString()
    assert.equal(isStaleLastModified(justInside, NOW), false)
    assert.equal(isStaleLastModified(justOutside, NOW), true)
  })

  it('cannot judge a missing or unparseable header (false — the count floor is the backstop)', () => {
    assert.equal(isStaleLastModified(null, NOW), false)
    assert.equal(isStaleLastModified(undefined, NOW), false)
    assert.equal(isStaleLastModified('', NOW), false)
    assert.equal(isStaleLastModified('not-a-date', NOW), false)
  })
})

describe('UAkron: fetchEvents stale-snapshot guard', () => {
  it('returns a fresh payload unchanged, on one request, with no cache-buster', async () => {
    const events = makeEvents(FRESH_COUNT)
    const f = scriptedFetch([fakeResponse({ lastModified: FRESH, events })])
    const out = await quiet(() => fetchEvents(deps(f)))

    assert.equal(out.length, FRESH_COUNT)
    assert.deepEqual(out, events)
    assert.equal(f.urls.length, 1, 'a fresh render must not trigger a retry')
    assert.ok(!f.urls[0].includes('&_='), 'first attempt uses the bare URL')
  })

  it('retries with a fresh cache-buster when last-modified is stale, then returns the live render', async () => {
    const fresh = makeEvents(FRESH_COUNT)
    const sleeps = []
    const f = scriptedFetch([
      fakeResponse({ lastModified: STALE, events: makeEvents(STALE_COUNT) }),
      fakeResponse({ lastModified: FRESH, events: fresh }),
    ])
    const out = await quiet(() => fetchEvents(deps(f, sleeps)))

    assert.equal(f.urls.length, 2, 'stale response must trigger exactly one retry here')
    assert.ok(f.urls[1].includes('&_='), 'the retry carries a cache-buster')
    assert.notEqual(f.urls[0], f.urls[1], 'the retry URL must differ from the first')
    assert.equal(sleeps.length, 1, 'one backoff between the two attempts')
    assert.ok(sleeps[0] > 0)
    assert.equal(out.length, FRESH_COUNT)
    assert.deepEqual(out, fresh, 'the fresh payload passes through untouched')
  })

  it('throws on exhaustion rather than returning the stale body', async () => {
    const sleeps = []
    const f = scriptedFetch([fakeResponse({ lastModified: STALE, events: makeEvents(STALE_COUNT) })])

    await assert.rejects(
      () => quiet(() => fetchEvents(deps(f, sleeps))),
      /stale cached snapshot on all 5 attempts/,
      'exhaustion must throw — never resolve with the poisoned snapshot',
    )
    assert.equal(f.urls.length, MAX_FETCH_ATTEMPTS, 'exactly 5 attempts, no more')
    assert.equal(sleeps.length, MAX_FETCH_ATTEMPTS - 1, 'no pointless sleep after the final attempt')
    // Every retry gets its own buster; none may repeat a previous URL.
    assert.equal(new Set(f.urls).size, MAX_FETCH_ATTEMPTS)
  })

  it('throws on a sub-floor event count even when last-modified looks fresh', async () => {
    // The backstop for the day last-modified stops tracking the render.
    const f = scriptedFetch([fakeResponse({ lastModified: FRESH, events: makeEvents(SUB_FLOOR_COUNT) })])

    await assert.rejects(
      () => quiet(() => fetchEvents(deps(f))),
      new RegExp(`only ${SUB_FLOOR_COUNT} events, below the ${MIN_EXPECTED_EVENTS} floor`),
    )
    assert.equal(f.urls.length, 1, 'the floor is fatal, not retryable')
  })

  it('applies the floor when the header is absent entirely', async () => {
    const short = scriptedFetch([fakeResponse({ lastModified: null, events: makeEvents(10) })])
    await assert.rejects(
      () => quiet(() => fetchEvents(deps(short))),
      new RegExp(`below the ${MIN_EXPECTED_EVENTS} floor`),
    )

    // ...but a healthy count with no header is still accepted.
    const healthy = scriptedFetch([fakeResponse({ lastModified: null, events: makeEvents(FRESH_COUNT) })])
    const out = await quiet(() => fetchEvents(deps(healthy)))
    assert.equal(out.length, FRESH_COUNT)
  })

  it('accepts a count exactly at the floor and rejects one below it', async () => {
    const atFloor = scriptedFetch([fakeResponse({ lastModified: FRESH, events: makeEvents(MIN_EXPECTED_EVENTS) })])
    const out = await quiet(() => fetchEvents(deps(atFloor)))
    assert.equal(out.length, MIN_EXPECTED_EVENTS)

    const below = scriptedFetch([fakeResponse({ lastModified: FRESH, events: makeEvents(MIN_EXPECTED_EVENTS - 1) })])
    await assert.rejects(
      () => quiet(() => fetchEvents(deps(below))),
      new RegExp(`below the ${MIN_EXPECTED_EVENTS} floor`),
    )
  })

  it('the floor sits below the off-season baseline, so a lean-but-fresh feed passes', async () => {
    // Regression guard for the seasonal false-failure: the June render is a
    // legitimate ~163 events. A floor calibrated on the August peak would
    // hard-fail all four sources every night through the summer trough.
    assert.ok(MIN_EXPECTED_EVENTS < STALE_COUNT, 'floor must clear the honest off-season count')
    const f = scriptedFetch([fakeResponse({ lastModified: FRESH, events: makeEvents(STALE_COUNT) })])
    const out = await quiet(() => fetchEvents(deps(f)))
    assert.equal(out.length, STALE_COUNT)
    assert.equal(f.urls.length, 1)
  })

  it('unwraps the { events: [...] } envelope shape', async () => {
    const events = makeEvents(FRESH_COUNT)
    const f = scriptedFetch([fakeResponse({ lastModified: FRESH, body: { events } })])
    const out = await quiet(() => fetchEvents(deps(f)))
    assert.equal(out.length, FRESH_COUNT)
  })

  it('still throws immediately on a non-2xx response', async () => {
    const f = scriptedFetch([fakeResponse({ ok: false, status: 503, events: [] })])
    await assert.rejects(() => quiet(() => fetchEvents(deps(f))), /LiveWhale API error 503/)
    assert.equal(f.urls.length, 1, 'HTTP errors are not part of the stale-retry loop')
  })
})

describe('UAkron: complete-render short-circuit over a stale header', () => {
  it('accepts a full render on the first attempt even when last-modified is months old', async () => {
    // LiveWhale may simply not re-render for >24h, or last-modified may track
    // content change rather than render time. Burning 5 attempts and then
    // discarding 334 good events is the wrong trade.
    const events = makeEvents(FRESH_COUNT)
    const sleeps = []
    const f = scriptedFetch([fakeResponse({ lastModified: STALE, events })])

    const out = await quiet(() => fetchEvents(deps(f, sleeps)))

    assert.equal(out.length, FRESH_COUNT)
    assert.deepEqual(out, events, 'the payload passes through untouched')
    assert.equal(f.urls.length, 1, 'a complete body must not trigger a retry')
    assert.equal(sleeps.length, 0, 'and must not sleep')
  })

  it('accepts exactly at COMPLETE_RENDER_MIN_EVENTS but still retries one below it', async () => {
    const at = scriptedFetch([fakeResponse({ lastModified: STALE, events: makeEvents(COMPLETE_RENDER_MIN_EVENTS) })])
    const out = await quiet(() => fetchEvents(deps(at)))
    assert.equal(out.length, COMPLETE_RENDER_MIN_EVENTS)
    assert.equal(at.urls.length, 1)

    const below = scriptedFetch([
      fakeResponse({ lastModified: STALE, events: makeEvents(COMPLETE_RENDER_MIN_EVENTS - 1) }),
      fakeResponse({ lastModified: FRESH, events: makeEvents(FRESH_COUNT) }),
    ])
    const recovered = await quiet(() => fetchEvents(deps(below, [])))
    assert.equal(below.urls.length, 2, 'one below the bar is still treated as suspect')
    assert.equal(recovered.length, FRESH_COUNT)
  })

  it('does NOT let the short-circuit swallow the ~163 poisoned snapshot', async () => {
    // The whole point: 163 clears the 100 floor, so only the header guard
    // catches it — the short-circuit bar must stay above the snapshot size.
    assert.ok(COMPLETE_RENDER_MIN_EVENTS > STALE_COUNT, 'short-circuit bar must sit above the poisoned snapshot')
    const f = scriptedFetch([fakeResponse({ lastModified: STALE, events: makeEvents(STALE_COUNT) })])

    await assert.rejects(
      () => quiet(() => fetchEvents(deps(f, []))),
      /stale cached snapshot on all 5 attempts/,
    )
    assert.equal(f.urls.length, MAX_FETCH_ATTEMPTS)
  })
})
