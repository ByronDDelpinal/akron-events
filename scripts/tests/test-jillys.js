/**
 * test-jillys.js
 *
 * Comprehensive tests for the Jilly's Music Room scraper.
 * Tests category mapping, ticket URL extraction, tag parsing, and full normalization.
 *
 * Run:
 *   node --test scripts/tests/test-jillys.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

import { stripHtml } from '../lib/normalize.js'
import {
  COMPLETE_AJAX_EVENT,
  COMPLETE_REST_POST,
  NO_REST_DATA,
  FEATURED_EVENT,
  HTML_ENTITIES_TITLE,
  FOOD_EVENT,
  MISSING_START_TIME,
  WORKSHOP_EVENT,
  TICKET_URL_EXTRACTION,
  ALL_FIXTURES,
} from './fixtures/jillys-events.js'

// Closure guard is imported from the REAL module (main() is guarded, so this
// is import-safe) — never re-implement it here.
const { isClosureTitle, emptyCalendarOutcome } = await import('../scrape-jillys.js')

// Re-implement parsing logic from scraper
function extractTicketUrl(html = '', permalink = '') {
  const ticketPatterns = [
    /href="(https?:\/\/(?:www\.)?(?:tickpick|eventbrite|ticketmaster|axs|dice\.fm|bandsintown)[^"]+)"/i,
    /href="([^"]+)"\s[^>]*>\s*(?:BUY\s+)?TICKET/i,
    /href="([^"]+)"\s[^>]*>\s*GET\s+TICKET/i,
  ]
  for (const re of ticketPatterns) {
    const m = html.match(re)
    if (m) return m[1]
  }
  return permalink || null
}

function parseCategory(classList = []) {
  const classes = classList.join(' ').toLowerCase()
  if (classes.includes('event_type-food')) return 'food'
  if (classes.includes('event_type-music')) return 'music'
  if (classes.includes('event_type-class') || classes.includes('event_type-workshop')) return 'education'
  if (classes.includes('event_type-community')) return 'community'
  return 'music'
}

function parseTags(termArrays = []) {
  const tags = []
  for (const termList of termArrays) {
    for (const term of termList) {
      if (term.name) tags.push(term.name.toLowerCase())
    }
  }
  tags.push('live music', "jilly's")
  return [...new Set(tags)]
}

function mergeEvent(ajaxEvent, restPost) {
  if (!ajaxEvent.event_start_unix_utc) return null

  const tzOffsetSec = ajaxEvent.event_start_unix_utc - ajaxEvent.event_start_unix
  const startAt = new Date(ajaxEvent.event_start_unix_utc * 1000).toISOString()
  const endAt = ajaxEvent.event_end_unix
    ? new Date((ajaxEvent.event_end_unix + tzOffsetSec) * 1000).toISOString()
    : null

  let title = stripHtml(ajaxEvent.event_title ?? '')
  let description = null
  let imageUrl = null
  let ticketUrl = null
  let classList = []
  let termArrays = []

  if (restPost) {
    title = stripHtml(restPost.title?.rendered ?? ajaxEvent.event_title)
    description = stripHtml(restPost.content?.rendered ?? '') || null
    classList = restPost.class_list ?? []
    ticketUrl = extractTicketUrl(restPost.content?.rendered ?? '', restPost.link)

    const media = restPost._embedded?.['wp:featuredmedia']?.[0]
    imageUrl = media?.source_url ?? null

    const wpTerms = restPost._embedded?.['wp:term'] ?? []
    termArrays = wpTerms.slice(1)
  }

  const category = parseCategory(classList)
  const tags = parseTags(termArrays)

  return {
    title,
    description,
    start_at: startAt,
    end_at: endAt,
    category,
    tags,
    price_min: null,
    price_max: null,
    age_restriction: 'not_specified',
    image_url: imageUrl,
    ticket_url: ticketUrl,
    source: 'jillys_music_room',
    source_id: String(ajaxEvent.ID),
    status: 'published',
    // Mirrors the scraper: featured is human-only, never derived from source.
    featured: false,
  }
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Category Mapping
// ════════════════════════════════════════════════════════════════════════════

describe('Jilly\'s: Category Mapping', () => {
  it('maps event_type-music to music', () => {
    assert.equal(parseCategory(['event_type-music']), 'music')
  })

  it('maps event_type-food to food', () => {
    assert.equal(parseCategory(['event_type-food']), 'food')
  })

  it('maps event_type-workshop to education', () => {
    assert.equal(parseCategory(['event_type-workshop']), 'education')
  })

  it('maps event_type-community to community', () => {
    assert.equal(parseCategory(['event_type-community']), 'community')
  })

  it('defaults to music for unknown types', () => {
    assert.equal(parseCategory([]), 'music')
    assert.equal(parseCategory(['event_type-unknown']), 'music')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Tag Parsing
// ════════════════════════════════════════════════════════════════════════════

describe('Jilly\'s: Tag Parsing', () => {
  it('extracts tags from taxonomy term objects', () => {
    const tags = parseTags([[{ name: 'Live Music' }, { name: 'Soul' }]])
    assert.ok(tags.includes('live music'))
    assert.ok(tags.includes('soul'))
    assert.ok(tags.includes("jilly's"))
  })

  it('always includes live music and jillys tags', () => {
    const tags = parseTags([])
    assert.ok(tags.includes('live music'))
    assert.ok(tags.includes("jilly's"))
  })

  it('deduplicates tags', () => {
    const tags = parseTags([[{ name: 'Music' }, { name: 'music' }]])
    const musicCount = tags.filter(t => t === 'music').length
    assert.equal(musicCount, 1)
  })

  it('lowercases all tags', () => {
    const tags = parseTags([[{ name: 'LIVE MUSIC' }]])
    assert.ok(tags.some(t => t === 'live music'))
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Ticket URL Extraction
// ════════════════════════════════════════════════════════════════════════════

describe('Jilly\'s: Ticket URL Extraction', () => {
  it('extracts Eventbrite ticket URL', () => {
    const html = '<a href="https://eventbrite.com/e/concert">GET TICKETS</a>'
    const url = extractTicketUrl(html, 'https://jillys.com/event')
    assert.equal(url, 'https://eventbrite.com/e/concert')
  })

  it('extracts Ticketmaster URL', () => {
    const html = '<a href="https://ticketmaster.com/show">BUY TICKET</a>'
    const url = extractTicketUrl(html)
    assert.equal(url, 'https://ticketmaster.com/show')
  })

  it('falls back to permalink when no ticket link found', () => {
    const html = '<p>No ticket links here</p>'
    const url = extractTicketUrl(html, 'https://jillys.com/event')
    assert.equal(url, 'https://jillys.com/event')
  })

  it('returns null when no URL and no permalink', () => {
    const url = extractTicketUrl('<p>Text only</p>', '')
    assert.equal(url, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Full Event Merging
// ════════════════════════════════════════════════════════════════════════════

describe('Jilly\'s: Event Merging', () => {
  it('merges complete ajax and rest data', () => {
    const row = mergeEvent(COMPLETE_AJAX_EVENT, COMPLETE_REST_POST)
    assert.ok(row)
    assert.equal(row.title, 'Motown Tribute Band')
    assert.equal(row.source, 'jillys_music_room')
    assert.equal(row.source_id, '100')
    assert.equal(row.category, 'music')
    assert.ok(row.tags.includes('live music'))
    assert.equal(row.image_url, 'https://jillysmusicroom.com/img/motown.jpg')
  })

  it('handles missing rest data', () => {
    const row = mergeEvent(NO_REST_DATA.ajaxEvent, null)
    assert.ok(row)
    assert.equal(row.title, 'Unplugged Night')
    assert.equal(row.category, 'music') // default
    assert.equal(row.image_url, null)
  })

  it('skips event with missing start time', () => {
    const row = mergeEvent(MISSING_START_TIME.ajaxEvent, MISSING_START_TIME.restPost)
    assert.equal(row, null)
  })

  it('decodes HTML entities in title', () => {
    const row = mergeEvent(HTML_ENTITIES_TITLE.ajaxEvent, HTML_ENTITIES_TITLE.restPost)
    assert.ok(row)
    assert.equal(row.title, 'The "Blues" Brothers & Friends')
  })

  it('source featured flag never sets featured (human-only)', () => {
    const row = mergeEvent(FEATURED_EVENT.ajaxEvent, FEATURED_EVENT.restPost)
    assert.ok(row)
    assert.equal(row.featured, false)
  })

  it('extracts ticket URL from rest content', () => {
    const row = mergeEvent(TICKET_URL_EXTRACTION.ajaxEvent, TICKET_URL_EXTRACTION.restPost)
    assert.ok(row)
    assert.ok(row.ticket_url.includes('eventbrite.com'))
  })

  it('categorizes food events correctly', () => {
    const row = mergeEvent(FOOD_EVENT.ajaxEvent, FOOD_EVENT.restPost)
    assert.ok(row)
    assert.equal(row.category, 'food')
  })

  it('categorizes workshop events as education', () => {
    const row = mergeEvent(WORKSHOP_EVENT.ajaxEvent, WORKSHOP_EVENT.restPost)
    assert.ok(row)
    assert.equal(row.category, 'education')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// TESTS: Batch Processing Invariants
// ════════════════════════════════════════════════════════════════════════════

describe('Jilly\'s: Batch Processing', () => {
  it('every merged event has consistent source', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = mergeEvent(fixture.ajax, fixture.rest)
      if (row) {
        assert.equal(row.source, 'jillys_music_room')
      }
    }
  })

  it('every non-null row has required fields', () => {
    const REQUIRED = ['title', 'start_at', 'category', 'source', 'source_id', 'status']
    for (const fixture of ALL_FIXTURES) {
      const row = mergeEvent(fixture.ajax, fixture.rest)
      if (!row) continue
      for (const field of REQUIRED) {
        assert.ok(row[field] != null, `missing field '${field}'`)
      }
    }
  })

  it('price_min is always a number or null', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = mergeEvent(fixture.ajax, fixture.rest)
      if (!row) continue
      assert.ok(row.price_min === null || typeof row.price_min === 'number')
    }
  })

  it('tags array always includes jillys tag', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = mergeEvent(fixture.ajax, fixture.rest)
      if (!row) continue
      assert.ok(Array.isArray(row.tags))
      assert.ok(row.tags.includes("jilly's"))
    }
  })

  it('source_id is always a string', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = mergeEvent(fixture.ajax, fixture.rest)
      if (!row) continue
      assert.equal(typeof row.source_id, 'string')
    }
  })

  it('category is always valid', () => {
    const ALLOWED = ['music', 'art', 'community', 'education', 'sports', 'food', 'nonprofit', 'other']
    for (const fixture of ALL_FIXTURES) {
      const row = mergeEvent(fixture.ajax, fixture.rest)
      if (!row) continue
      assert.ok(ALLOWED.includes(row.category))
    }
  })

  it('all start_at values are valid ISO 8601', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = mergeEvent(fixture.ajax, fixture.rest)
      if (!row) continue
      const parsed = new Date(row.start_at)
      assert.ok(!isNaN(parsed.getTime()))
      assert.ok(row.start_at.endsWith('Z'))
    }
  })

  it('no row has HTML in title or description', () => {
    for (const fixture of ALL_FIXTURES) {
      const row = mergeEvent(fixture.ajax, fixture.rest)
      if (!row) continue
      assert.ok(!/<[a-zA-Z]/.test(row.title))
      if (row.description) {
        assert.ok(!/<[a-zA-Z]/.test(row.description))
      }
    }
  })
})

// ════════════════════════════════════════════════════════════════════════
// TESTS: Closure Title Guard (real module)
// ════════════════════════════════════════════════════════════════════════

describe("Jilly's: Closure Title Guard", () => {
  it('flags closure notice titles', () => {
    const CLOSURES = [
      'CLOSED FOR PRIVATE EVENT',
      'CLOSED FOR HOLIDAY',
      'CLOSED',
      'CLOSED: SHOW POSTPONED',
      'Closed for Thanksgiving',
      'NO BRUNCH SERVICE',
      'No Brunch this Sunday',
      'BRUNCH SUSPENDED UNTIL FURTHER NOTICE',
      'PRIVATE BRUNCH EVENT',
    ]
    for (const title of CLOSURES) {
      assert.equal(isClosureTitle(title), true, `expected closure: ${title}`)
    }
  })

  it('does not flag titles that merely mention closed/closing', () => {
    assert.equal(isClosureTitle('OPEN FOR BRUNCH | CLOSING AT 3PM'), false)
    assert.equal(isClosureTitle('The Doors Are Closed (Tribute)'), false)
  })

  it('does not flag normal show titles', () => {
    assert.equal(isClosureTitle('Motown Tribute Band'), false)
  })

  it('returns false for null and empty input', () => {
    assert.equal(isClosureTitle(null), false)
    assert.equal(isClosureTitle(''), false)
    assert.equal(isClosureTitle(undefined), false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Zero-event reporting guard
// ════════════════════════════════════════════════════════════════════════════
//
// logUpsertResult defaults to status='success', so an empty EventON response
// was indistinguishable from a healthy night. The monitor has to be able to
// tell an empty calendar from a broken one.
describe("Jilly's: emptyCalendarOutcome", () => {
  it('defaults to an error and carries the AJAX status', () => {
    const out = emptyCalendarOutcome({ ajaxStatus: 'GOOD' })
    assert.equal(out.status, 'error')
    assert.equal(out.errorMessage, 'EventON AJAX returned 0 upcoming events (status=GOOD)')
  })

  it('reports a missing AJAX status as "missing"', () => {
    for (const s of [undefined, null, '', '  ', NaN]) {
      assert.equal(
        emptyCalendarOutcome({ ajaxStatus: s }).errorMessage,
        'EventON AJAX returned 0 upcoming events (status=missing)',
        `value: ${String(s)}`
      )
    }
  })

  it('treats an empty calendar as a clean zero-event run when allowEmptyFeed is set', () => {
    const out = emptyCalendarOutcome({ allowEmptyFeed: true, ajaxStatus: 'GOOD' })
    assert.equal(out.status, 'success')
    assert.equal(out.errorMessage, null)
    assert.match(out.reason, /expected for this source/)
  })

  it('only opts in on an explicit true — never on a truthy accident', () => {
    for (const v of [undefined, null, false, 0, '', 'yes', 1]) {
      assert.equal(
        emptyCalendarOutcome({ allowEmptyFeed: v }).status, 'error',
        `value: ${JSON.stringify(v)}`
      )
    }
  })

  it('is safe with no argument at all — no NaN/undefined leaks', () => {
    const out = emptyCalendarOutcome()
    assert.equal(out.status, 'error')
    assert.doesNotMatch(out.errorMessage, /NaN|undefined/)
  })
})

// ── Retirement of removed posts (2026-11-02) ──────────────────────────────
//
// Imported from the REAL module — the guards are the point, never re-implement.
const {
  classifyRestProbe, planRetirement, retirementCandidates, probeWpPost, retirementReason,
  RETIREMENT_MIN_FOUND, RETIREMENT_MAX_FRACTION, RETIREMENT_STAMP_BY,
} = await import('../scrape-jillys.js')

const row = (source_id, extra = {}) => ({ id: `id-${source_id}`, title: `Event ${source_id}`, source_id: String(source_id), status: 'published', manual_overrides: {}, ...extra })

describe('classifyRestProbe — the three WordPress answers', () => {
  it('200 is live', () => assert.equal(classifyRestProbe(200, { id: 4613, status: 'publish' }), 'live'))
  it('404 rest_post_invalid_id is gone (deleted/trashed) — the Swing Night case', () =>
    assert.equal(classifyRestProbe(404, { code: 'rest_post_invalid_id', data: { status: 404 } }), 'gone'))
  it('401 rest_forbidden is unpublished (draft/private) — the Modern Jazz Brunch case', () =>
    assert.equal(classifyRestProbe(401, { code: 'rest_forbidden', data: { status: 401 } }), 'unpublished'))
  it('a 404 without the WP code is unknown (could be a WAF/HTML page)', () =>
    assert.equal(classifyRestProbe(404, null), 'unknown'))
  it('5xx / 403 / 429 are unknown, never a removal signal', () => {
    for (const s of [500, 502, 503, 403, 429]) assert.equal(classifyRestProbe(s, { code: 'x' }), 'unknown')
  })
})

describe('probeWpPost — transport failures never retire', () => {
  const resp = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), clone() { return this } })
  it('maps a 404 body through classifyRestProbe', async () => {
    const v = await probeWpPost(4614, { fetchImpl: async () => resp(404, { code: 'rest_post_invalid_id' }) })
    assert.equal(v, 'gone')
  })
  it('network error → unknown', async () => {
    const v = await probeWpPost(4614, { fetchImpl: async () => { throw new Error('ECONNRESET') } })
    assert.equal(v, 'unknown')
  })
  it('non-JSON body → unknown', async () => {
    const v = await probeWpPost(4614, { fetchImpl: async () => ({ ok: false, status: 404, json: async () => { throw new SyntaxError('html') }, clone() { return this } }) })
    assert.equal(v, 'unknown')
  })
})

describe('retirementCandidates — who gets probed', () => {
  it('only published, un-pinned rows absent from the AJAX result', () => {
    const rows = [
      row(1), row(2),
      row(3, { status: 'cancelled' }),
      row(4, { manual_overrides: { status: { at: 'x' } } }),
    ]
    const c = retirementCandidates({ rows, seenSourceIds: new Set(['1']) })
    assert.deepEqual(c.map(r => r.source_id), ['2'])
  })
})

describe('planRetirement — guards', () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(i + 1))
  const seen = new Set(rows.slice(0, 18).map(r => r.source_id))   // 19 and 20 missing
  const healthy = { rows, seenSourceIds: seen, ajaxCount: 40 }

  it('retires rows WordPress confirms gone or unpublished', () => {
    const plan = planRetirement({ ...healthy, verdicts: new Map([['19', 'gone'], ['20', 'unpublished']]) })
    assert.equal(plan.skipped, null)
    assert.deepEqual(plan.retire.map(r => [r.row.source_id, r.verdict]), [['19', 'gone'], ['20', 'unpublished']])
  })
  it('keeps a row WordPress still publishes (EventON drift), and reports it', () => {
    const plan = planRetirement({ ...healthy, verdicts: new Map([['19', 'live'], ['20', 'gone']]) })
    assert.deepEqual(plan.leftLive.map(r => r.source_id), ['19'])
    assert.deepEqual(plan.retire.map(r => r.row.source_id), ['20'])
  })
  it('keeps a row whose probe was inconclusive or missing', () => {
    const plan = planRetirement({ ...healthy, verdicts: new Map([['19', 'unknown']]) })
    assert.deepEqual(plan.retire, [])
    assert.deepEqual(plan.leftUnknown.map(r => r.source_id).sort(), ['19', '20'])
  })
  it('never touches a human status pin, even when WordPress says gone', () => {
    const pinnedRows = [...rows, row(21, { manual_overrides: { status: { at: 'x', by: 'byron' } } })]
    const plan = planRetirement({ rows: pinnedRows, seenSourceIds: seen, ajaxCount: 40, verdicts: new Map([['21', 'gone']]) })
    assert.ok(!plan.retire.some(r => r.row.source_id === '21'))
    assert.equal(plan.protectedCount, 1)
  })
  it('retires nothing when the AJAX read is below the floor', () => {
    const plan = planRetirement({ ...healthy, ajaxCount: RETIREMENT_MIN_FOUND - 1, verdicts: new Map([['19', 'gone']]) })
    assert.equal(plan.skipped, 'below-floor')
    assert.deepEqual(plan.retire, [])
  })
  it('retires nothing above the ceiling, even with every probe confirming', () => {
    const verdicts = new Map(rows.map(r => [r.source_id, 'gone']))
    const plan = planRetirement({ rows, seenSourceIds: new Set(), ajaxCount: 40, verdicts })
    assert.equal(plan.skipped, 'above-ceiling')
    assert.ok(plan.fraction > RETIREMENT_MAX_FRACTION)
    assert.deepEqual(plan.retire, [])
  })
  it('ceiling denominator is retire-eligible rows, so cancelled closure notices do not dilute it', () => {
    // 4 eligible, 2 confirmed gone = 50%; 20 extra already-cancelled rows must not rescue it.
    const small = [row(1), row(2), row(3), row(4), ...Array.from({ length: 20 }, (_, i) => row(100 + i, { status: 'cancelled' }))]
    const plan = planRetirement({ rows: small, seenSourceIds: new Set(['1', '2']), ajaxCount: 40, verdicts: new Map([['3', 'gone'], ['4', 'gone']]) })
    assert.equal(plan.skipped, 'above-ceiling')
  })
  it('stamp names the scraper and the reason carries the WP verdict + date', () => {
    assert.equal(RETIREMENT_STAMP_BY, 'scrape-jillys:retirement')
    assert.match(retirementReason('gone', '2026-11-02T09:10:00.000Z'), /404 rest_post_invalid_id on 2026-11-02/)
    assert.match(retirementReason('unpublished', '2026-11-02T09:10:00.000Z'), /401 rest_forbidden on 2026-11-02/)
  })
})
