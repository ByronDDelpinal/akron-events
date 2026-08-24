/**
 * handlers.test.ts: Deno tests for the handler registry, driven through a
 * stubbed QueryExecutor.
 *
 * Run: `deno test supabase/functions/slack-ask/`. No network, no database, no
 * environment variables: the executor is injected (types.ts), which is the
 * whole reason the seam exists.
 *
 * Stubbing the EXECUTOR rather than a Supabase client is what makes these
 * tests worth writing. A mocked client can only tell you a handler returned
 * the number you fed it. A stubbed executor hands you the `SelectSpec` the
 * handler actually built, so the tests below can assert the things that
 * matter and that a review would otherwise have to catch by eye:
 *
 *   - no query selects a column outside its allowlist
 *   - no query selects a column that identifies a person
 *   - every query carries a LIMIT, and it is inside the row cap
 *   - a day count is clamped before it reaches a filter, not after
 *   - a scraper name is checked against the registry before any I/O
 *   - a missing or absurd window is re-derived, not trusted
 *
 * The last test in the file is the end-to-end one: every handler's output,
 * through the real renderer and the real egress filter, must fit the caps and
 * must not be withheld.
 */

import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1'
import { getHandler, HANDLER_IDS, HANDLERS } from './handlers.ts'
import { composeReply, GA_FLOOR_NOTE, MAX_REPLY_CHARS, MAX_REPLY_LINES } from './render.ts'
import { redactOutbound } from './redact.ts'
import { upcomingWindow } from './intent.ts'
import type {
  CountSpec,
  EmbedSpec,
  Filter,
  HandlerId,
  HandlerParams,
  QueryExecutor,
  Row,
  SelectSpec,
  TimeWindow,
} from './types.ts'

const NOW = new Date('2026-08-26T16:00:00Z') // Wed noon ET

// ── The stub ──────────────────────────────────────────────────────────────

interface Recorder extends QueryExecutor {
  readonly selects: SelectSpec[]
  readonly counts: CountSpec[]
}

/**
 * One generic row that satisfies every column any handler asks for, including
 * the embedded shapes. Returning the same row for every query keeps the stub
 * trivial; the assertions are about the SPECS, not the arithmetic.
 */
const GENERIC_ROW: Row = {
  id: 'row-1',
  source: 'eventbrite',
  title: 'Trio Night at the Bar & Grill',
  start_at: '2026-08-28T23:00:00Z',
  created_at: '2026-08-26T01:00:00Z',
  category_slugs: ['music', 'festival'],
  event_venues: [{ venues: { name: 'Musica', neighborhood_slug: 'downtown-akron' } }],
  event_organizations: [{ organizations: { name: 'Akron Symphony' } }],
  scraper_name: 'akron_library',
  last_status: 'success',
  last_ran_at: '2026-08-26T02:02:00Z',
  last_error: null,
  is_error: false,
  is_stale: false,
  is_zero_streak: false,
  last_events_found: 89,
  consecutive_zeros: 0,
  avg_events_last5: 91,
  hours_since_run: 14,
  status: 'sent',
  sent_at: '2026-08-26T10:02:00Z',
  events_found: 12,
  events_inserted: 3,
  events_updated: 9,
  category: 'bug',
  // The GA4 mirror (migration 062). Present on the generic row so the
  // registry-wide sweeps (allowlist, limits, empty, nulls, caps, redaction)
  // exercise the traffic handlers with real values rather than nothing.
  metric_date: '2026-08-25',
  total_users: 126,
  new_users: 68,
  engaged_sessions: 87,
  outbound_clicks: 2,
  outbound_users: 2,
  pwa_launches: 14,
  pwa_launch_users: 11,
  pwa_install_accepted: 1,
  pwa_users_7d: 29,
  pwa_users_28d: 58,
  // A REAL path with a uuid in it. /organizations/{uuid} and /venues/{uuid}
  // are live routes, and redact.ts withholds any reply containing a uuid, so
  // this row is what proves the whole traffic answer is not silently binned.
  page_path: '/organizations/4d890091-6d95-4728-99e1-880df91ae943',
  url_slug: null,
  page_views: 573,
  users: 12,
  outbound_tickets: 2,
  outbound_source: 0,
  embed_host: 'everydayakron.com',
}

/**
 * An event with TWO venues in two different neighbourhoods. Production has 738
 * of these, and the single-venue GENERIC_ROW makes join inflation structurally
 * invisible: every per-event dedupe bug looks correct when every event has
 * exactly one link.
 */
const MULTI_VENUE_ROW: Row = {
  ...GENERIC_ROW,
  title: 'Two Venue Festival',
  event_venues: [
    { venues: { name: 'Lock 3', neighborhood_slug: 'downtown-akron' } },
    { venues: { name: 'Musica', neighborhood_slug: 'highland-square' } },
  ],
  event_organizations: [
    { organizations: { name: 'Akron Symphony' } },
    { organizations: { name: 'Downtown Akron Partnership' } },
  ],
}

/** An event with no venue link at all, so `placed` and `rows.length` diverge. */
const NO_VENUE_ROW: Row = { ...GENERIC_ROW, title: 'Online Only', event_venues: [] }

type RowSource = readonly Row[] | ((spec: SelectSpec) => readonly Row[])

/** Different rows per table, for the handlers that read more than one. */
function byTable(map: Record<string, readonly Row[]>, fallback: readonly Row[] = []): RowSource {
  return (spec) => map[spec.table] ?? fallback
}

function recorder(
  rows: RowSource = [GENERIC_ROW, GENERIC_ROW, GENERIC_ROW],
  count = 7,
): Recorder {
  const selects: SelectSpec[] = []
  const counts: CountSpec[] = []
  return {
    selects,
    counts,
    select(spec) {
      selects.push(spec)
      return Promise.resolve(typeof rows === 'function' ? rows(spec) : rows)
    },
    count(spec) {
      counts.push(spec)
      return Promise.resolve(count)
    },
  }
}

/** An executor that fails the test if it is called at all. */
const forbiddenExecutor: QueryExecutor = {
  select() {
    throw new Error('this handler must not query')
  },
  count() {
    throw new Error('this handler must not query')
  },
}

/** Params good enough for every handler, so the whole registry can be swept. */
const PARAMS_FOR: Partial<Record<HandlerId, HandlerParams>> = {
  scraper_last_run: { scraperName: 'akron_library' },
  events_at_venue: { venueQuery: 'musica' },
}

async function run(id: HandlerId, exec: QueryExecutor, params: HandlerParams = {}): Promise<string[]> {
  const lines = await getHandler(id).run({ exec, params: { ...PARAMS_FOR[id], ...params }, now: NOW })
  return [...lines]
}

/**
 * Read the bound value off a filter by op (and optionally column).
 *
 * A helper rather than `filters.find(...).value` because `Filter` is a
 * discriminated union and the `in` arm carries `values`, not `value`, so the
 * direct property access does not type-check. Narrowing here keeps the
 * assertions readable.
 */
function filterValue(filters: readonly Filter[], op: Filter['op'], column?: string): unknown {
  for (const f of filters) {
    if (f.op !== op) continue
    if (column !== undefined && f.column !== column) continue
    return 'value' in f ? f.value : f.values
  }
  return undefined
}

function allColumns(spec: SelectSpec): string[] {
  const fromEmbeds = (embeds: readonly EmbedSpec[] | undefined): string[] =>
    (embeds ?? []).flatMap((e) => [...e.columns, ...fromEmbeds(e.embed)])
  return [...spec.columns, ...fromEmbeds(spec.embed)]
}

// ── Registry shape ────────────────────────────────────────────────────────

Deno.test('the registry is closed, frozen, and self-consistent', () => {
  assertEquals(Object.isFrozen(HANDLERS), true)
  assertEquals(HANDLER_IDS.length, 33)
  for (const id of HANDLER_IDS) {
    assertEquals(HANDLERS[id].id, id, `${id} has a mismatched id field`)
    assertEquals(HANDLERS[id].menuLabel.length > 0, true)
  }
})

Deno.test('getHandler throws on an unknown id rather than falling back', () => {
  // Deliberately unlike resolveAgentIdentity's soft default: a typo'd persona
  // costing the default avatar is fine, a typo'd handler running a DIFFERENT
  // QUERY is not.
  let threw = false
  try {
    getHandler('not_a_handler' as HandlerId)
  } catch {
    threw = true
  }
  assertEquals(threw, true)
  // Prototype keys are not handler ids either.
  let threwProto = false
  try {
    getHandler('constructor' as HandlerId)
  } catch {
    threwProto = true
  }
  assertEquals(threwProto, true)
})

Deno.test('the two terminal handlers never touch the database', () => {
  assertEquals(HANDLERS.analytics_unavailable.needsDb, false)
  assertEquals(HANDLERS.no_match.needsDb, false)
})

// ── Column allowlists ─────────────────────────────────────────────────────

/**
 * The columns that must never appear in any query this function issues.
 *
 * `subscribers.token` is the unsubscribe secret (slack-notify/index.ts:380-382).
 * The rest identify a person. Tier 1 does read some of them, deliberately, for
 * a private partner channel; Tier 3 does not inherit that (ADR 5.7).
 */
const FORBIDDEN_COLUMNS = [
  'token',
  'email',
  'contact_email',
  'author_name',
  'body',
  'auth_user_id',
  'subscriber_id',
  'reviewed_by',
  'preferences',
  'error_message',
]

Deno.test('no handler ever selects a wildcard', async () => {
  for (const id of HANDLER_IDS) {
    const exec = recorder()
    await run(id, exec)
    for (const spec of exec.selects) {
      assertEquals(spec.columns.includes('*'), false, `${id} selected a wildcard`)
      assertEquals(spec.columns.length >= 0, true)
    }
  }
})

Deno.test('no handler ever selects a column that identifies a person', async () => {
  for (const id of HANDLER_IDS) {
    const exec = recorder()
    await run(id, exec)
    for (const spec of exec.selects) {
      for (const column of allColumns(spec)) {
        assertEquals(
          FORBIDDEN_COLUMNS.includes(column),
          false,
          `${id} selected forbidden column "${column}" from ${spec.table}`,
        )
      }
    }
  }
})

Deno.test('subscriber, feedback and embed questions are answered by COUNTS', async () => {
  // The strongest form of "no row is transferred": a CountSpec has no column
  // list at all, so there is nothing for a future edit to widen.
  for (const id of ['subscriber_counts', 'embed_requests_count', 'partner_orgs_count'] as HandlerId[]) {
    const exec = recorder()
    await run(id, exec)
    assertEquals(exec.selects.length, 0, `${id} selected rows instead of counting`)
    assertEquals(exec.counts.length > 0, true)
  }
  // feedback_recent does select, but only category and status.
  const exec = recorder()
  await run('feedback_recent', exec)
  assertEquals(exec.selects.length, 1)
  assertEquals([...exec.selects[0].columns].sort(), ['category', 'resolved_at'])
  assertEquals(exec.selects[0].table, 'feedback_posts')
})

Deno.test('the subscribers table is never read row-wise at all', async () => {
  for (const id of HANDLER_IDS) {
    const exec = recorder()
    await run(id, exec)
    for (const spec of exec.selects) {
      assertEquals(spec.table === 'subscribers', false, `${id} selected rows from subscribers`)
    }
  }
})

// ── Caps and limits ───────────────────────────────────────────────────────

Deno.test('every select carries a sane LIMIT', async () => {
  for (const id of HANDLER_IDS) {
    const exec = recorder()
    await run(id, exec)
    for (const spec of exec.selects) {
      assertEquals(Number.isInteger(spec.limit), true, `${id} has a non-integer limit`)
      assertEquals(spec.limit > 0, true, `${id} has a non-positive limit`)
      assertEquals(spec.limit <= 3000, true, `${id} exceeds the row cap with ${spec.limit}`)
    }
  }
})

// ── Param validation, done by the handler and not trusted from the matcher ─

Deno.test('scraper_last_run rejects an unregistered name BEFORE any query', async () => {
  for (const bad of ['', 'not_a_scraper', 'DROP TABLE events', '__proto__', 'eventbrite; --']) {
    const exec = recorder()
    const lines = await run('scraper_last_run', exec, { scraperName: bad })
    assertEquals(exec.selects.length, 0, `queried anyway for "${bad}"`)
    assertEquals(exec.counts.length, 0)
    assertStringIncludes(lines[0], 'Not a scraper I know')
  }
})

Deno.test('scraper_last_run passes a registry key through as a bound value', async () => {
  const exec = recorder()
  await run('scraper_last_run', exec, { scraperName: 'summit_artspace' })
  assertEquals(exec.selects.length, 1)
  assertEquals(exec.selects[0].table, 'scraper_health')
  assertEquals(exec.selects[0].filters, [{ op: 'eq', column: 'scraper_name', value: 'summit_artspace' }])
})

Deno.test('events_at_venue rejects a wildcard-bearing term BEFORE any query', async () => {
  for (const bad of ['%', 'a%b', 'x_y', 'a,b', '(x)', '']) {
    const exec = recorder()
    const lines = await run('events_at_venue', exec, { venueQuery: bad })
    assertEquals(exec.selects.length, 0, `queried anyway for "${bad}"`)
    assertStringIncludes(lines[0], 'Which venue')
  }
})

Deno.test('events_at_venue wraps a clean term itself, as a bound ilike value', async () => {
  const exec = recorder()
  await run('events_at_venue', exec, { venueQuery: "jilly's" })
  const filter = exec.selects[0].filters.find((f) => f.op === 'ilike')
  assertEquals(filter, { op: 'ilike', column: 'event_venues.venues.name', value: "%jilly's%" })
})

Deno.test('a day count is clamped by the handler, not just by the matcher', async () => {
  const exec = recorder()
  await run('scrapers_stale', exec, { days: 100_000 })
  // 90 days is the clamp, so the filter must be 90 * 24 hours.
  assertEquals(exec.selects[0].filters, [{ op: 'gte', column: 'hours_since_run', value: 2160 }])

  const low = recorder()
  await run('scrapers_stale', low, { days: -5 })
  assertEquals(low.selects[0].filters, [{ op: 'gte', column: 'hours_since_run', value: 24 }])
})

Deno.test('a rolling cutoff is clamped too', async () => {
  const exec = recorder()
  await run('events_added_recently', exec, { days: 9999 })
  // PUBLISHED plus the rolling cutoff.
  assertEquals(exec.selects[0].filters.length, 2)
  // 90 days before NOW, not 9999.
  assertEquals(
    filterValue(exec.selects[0].filters, 'gte', 'created_at'),
    new Date(NOW.getTime() - 90 * 86_400_000).toISOString(),
  )
})

Deno.test('a missing window is re-derived to the documented default', async () => {
  const exec = recorder()
  await run('events_in_window', exec, {})
  const expected = upcomingWindow(NOW, 7)
  assertEquals(exec.counts[0].filters, [
    { op: 'eq', column: 'status', value: 'published' },
    { op: 'gte', column: 'start_at', value: expected.startUtc },
    { op: 'lt', column: 'start_at', value: expected.endUtc },
  ])
})

Deno.test('an insane window is discarded, not queried', async () => {
  const inverted: TimeWindow = {
    kind: 'today',
    label: 'nonsense',
    startUtc: '2027-01-01T00:00:00.000Z',
    endUtc: '2026-01-01T00:00:00.000Z',
    startDateEt: '2027-01-01',
    endDateEt: '2026-01-01',
  }
  const exec = recorder()
  await run('events_in_window', exec, { window: inverted })
  assertEquals(filterValue(exec.counts[0].filters, 'gte'), upcomingWindow(NOW, 7).startUtc)

  const enormous: TimeWindow = { ...inverted, startUtc: '2020-01-01T00:00:00.000Z', endUtc: '2030-01-01T00:00:00.000Z', startDateEt: '2020-01-01', endDateEt: '2029-12-31' }
  const exec2 = recorder()
  await run('events_in_window', exec2, { window: enormous })
  assertEquals(filterValue(exec2.counts[0].filters, 'gte'), upcomingWindow(NOW, 7).startUtc)
})

// ── Window filtering is half-open, and on the right column ────────────────

Deno.test('windowed handlers filter start_at half-open and only published rows', async () => {
  const w = upcomingWindow(NOW, 30)
  for (const id of ['events_by_source', 'events_by_category', 'top_venues', 'free_vs_paid'] as HandlerId[]) {
    const exec = recorder()
    await run(id, exec, { window: w })
    const specs = [...exec.selects, ...exec.counts]
    for (const spec of specs) {
      if (spec.table !== 'events') continue
      assertEquals(filterValue(spec.filters, 'gte', 'start_at'), w.startUtc, `${id} lower bound`)
      assertEquals(filterValue(spec.filters, 'lt', 'start_at'), w.endUtc, `${id} upper bound`)
      assertEquals(
        spec.filters.some((f) => f.op === 'eq' && f.column === 'status' && f.value === 'published'),
        true,
        `${id} did not restrict to published`,
      )
    }
  }
})

// ── Rendering behaviour worth pinning ─────────────────────────────────────

Deno.test('events_in_window leads with the answer and adds the comparison', async () => {
  const exec = recorder([], 47)
  const lines = await run('events_in_window', exec, { window: upcomingWindow(NOW, 3) })
  assertEquals(lines.length, 1)
  assertStringIncludes(lines[0], '47 events next 3d.')
  assertStringIncludes(lines[0], 'Prior 3d: 47.')
})

Deno.test('the prior window is the same number of calendar days, immediately before', async () => {
  const exec = recorder([], 1)
  const w = upcomingWindow(NOW, 3) // 26, 27, 28 Aug
  await run('events_in_window', exec, { window: w })
  const prior = exec.counts[1].filters
  assertEquals(filterValue(prior, 'gte'), '2026-08-23T04:00:00.000Z')
  assertEquals(filterValue(prior, 'lt'), w.startUtc)
})

Deno.test('events_by_neighborhood counts EVENTS, not venue links', async () => {
  // The bug this pins: a flat tally over a multi-venue event counts links, so
  // the neighbourhood totals exceed the event count and "events with no
  // neighbourhood" (rows minus links) goes NEGATIVE. 738 production events
  // have more than one venue.
  const rows = [MULTI_VENUE_ROW, MULTI_VENUE_ROW, GENERIC_ROW, NO_VENUE_ROW]
  const lines = await run('events_by_neighborhood', recorder(rows))

  assertStringIncludes(lines[0], '4 events')
  // 3 of 4 events have a venue with a neighbourhood, so exactly 1 does not.
  assertEquals(lines[lines.length - 1], '1 event has no neighbourhood on its venue.')
  // Never negative, whatever the mix.
  const remainder = Number(/^(-?\d+)/.exec(lines[lines.length - 1])![1])
  assertEquals(remainder >= 0, true, `remainder went negative: ${remainder}`)

  // Per-neighbourhood counts are event counts and cannot exceed the total.
  for (const [, count] of [...lines[1].matchAll(/(\S+) (\d+)/g)].map((m) => [m[1], Number(m[2])] as const)) {
    assertEquals(count <= rows.length, true, `a neighbourhood counted ${count} of ${rows.length} events`)
  }
})

Deno.test('events_by_neighborhood never reports a negative remainder on any mix', async () => {
  for (const rows of [[MULTI_VENUE_ROW], [MULTI_VENUE_ROW, MULTI_VENUE_ROW], [GENERIC_ROW, MULTI_VENUE_ROW]]) {
    const lines = await run('events_by_neighborhood', recorder(rows))
    const last = lines[lines.length - 1]
    assertEquals(last.startsWith('-'), false, `negative remainder for ${rows.length} rows: ${last}`)
  }
})

Deno.test('top_venues and top_organizations count one event once per name', async () => {
  // Two identical two-venue events: Lock 3 and Musica get 2 each, not 4.
  const venues = await run('top_venues', recorder([MULTI_VENUE_ROW, MULTI_VENUE_ROW]))
  assertStringIncludes(venues[0], '(by event)')
  assertEquals(venues[1], 'Lock 3 2')
  assertEquals(venues[2], 'Musica 2')

  const orgs = await run('top_organizations', recorder([MULTI_VENUE_ROW, MULTI_VENUE_ROW]))
  assertStringIncludes(orgs[0], '(by event)')
  assertEquals(orgs[1], 'Akron Symphony 2')
})

Deno.test('events_at_venue names the venue that MATCHED, not the first one listed', async () => {
  // On a multi-venue event the first embedded venue is frequently not the one
  // the ilike hit, so the reply confidently names the wrong place.
  const lines = await run('events_at_venue', recorder([MULTI_VENUE_ROW]), { venueQuery: 'musica' })
  assertStringIncludes(lines[0], 'at Musica')
  assertEquals(lines[0].includes('Lock 3'), false)

  const other = await run('events_at_venue', recorder([MULTI_VENUE_ROW]), { venueQuery: 'lock 3' })
  assertStringIncludes(other[0], 'at Lock 3')
})

Deno.test('feedback_recent derives resolution from resolved_at, not status', async () => {
  // Every production row has `status = 'published'`, which is a visibility
  // flag. A `status !== 'resolved'` test therefore reports the entire batch as
  // open forever, which is indistinguishable from the total.
  const rows = [
    { category: 'bug', status: 'published', resolved_at: null },
    { category: 'bug', status: 'published', resolved_at: '2026-08-20T12:00:00Z' },
    { category: 'idea', status: 'published', resolved_at: '2026-08-21T12:00:00Z' },
  ]
  const lines = await run('feedback_recent', recorder(rows, 3))
  assertStringIncludes(lines[2], '1 of the recent ones are unresolved')
  // The bug: this would have said 3, exactly the row count.
  assertEquals(lines[2].startsWith('3 '), false)
})

Deno.test('subscriber_counts uses the digest\'s own recipient definition', async () => {
  // send-digest/index.ts:684-685 gates on confirmed AND unsubscribed_at IS
  // NULL. A bot whose subscriber count disagrees with the mailer's is worse
  // than no count.
  const exec = recorder()
  await run('subscriber_counts', exec)
  const confirmed = exec.counts.find((c) =>
    c.filters.some((f) => f.column === 'confirmed')
  )!
  assertEquals(confirmed.filters, [
    { op: 'is', column: 'confirmed', value: true },
    { op: 'is', column: 'unsubscribed_at', value: null },
  ])
})

Deno.test('events_added_recently restricts to published like every other events handler', async () => {
  const exec = recorder()
  await run('events_added_recently', exec)
  assertEquals(
    exec.selects[0].filters.some((f) => f.op === 'eq' && f.column === 'status' && f.value === 'published'),
    true,
    'counted the 415 cancelled rows',
  )
})

Deno.test('a hostile scraper error is clipped and escaped before it reaches a line', async () => {
  const hostile = {
    ...GENERIC_ROW,
    scraper_name: 'eventbrite',
    last_error: `<!channel> <@U0FAKE> ${'&'.repeat(200)} <https://evil.test|click me>`,
  }
  const exec = recorder([hostile])
  const lines = await run('scrapers_failing', exec)
  const text = lines.join('\n')
  assertEquals(text.includes('<'), false)
  assertEquals(text.includes('>'), false)
  assertEquals(text.includes('!channel'), true) // neutered, not deleted
  assertEquals(composeReply(lines).length <= MAX_REPLY_CHARS, true)
})

Deno.test('featured_events explains an empty result instead of looking broken', async () => {
  const exec = recorder([], 4805)
  const lines = await run('featured_events', exec)
  assertStringIncludes(lines[0], 'No featured events upcoming')
  assertStringIncludes(lines[1], 'banner-eligible')
})

Deno.test('status_summary reports all clear when nothing is wrong', async () => {
  // The fixture carries the four names scraper_health permanently has and the
  // manifest does not, because production always has them. A fixture without
  // them cannot catch a drift fact that fires unconditionally, which is
  // exactly how "All clear." became unreachable once.
  const exec = recorder(
    byTable({
      scraper_health: [
        { scraper_name: 'akron_library', is_error: false, is_stale: false, is_zero_streak: false },
        { scraper_name: 'dedupe_cross_source', is_error: false, is_stale: false, is_zero_streak: false },
        { scraper_name: 'uakron_chp', is_error: false, is_stale: false, is_zero_streak: false },
        { scraper_name: 'uakron_myers_art', is_error: false, is_stale: false, is_zero_streak: false },
        { scraper_name: 'ejthomas_hall', is_error: false, is_stale: false, is_zero_streak: false },
      ],
      scraper_runs: [{ status: 'success', events_found: 100 }],
    }),
    0,
  )
  const lines = await run('status_summary', exec)
  assertEquals(lines[0], 'All clear.')
  assertEquals(lines.join('\n').includes('unregistered'), false, 'a standing condition became a daily alert')
  // plural(), so never "1 runs".
  assertStringIncludes(lines[1], 'Last night: 1 run,')
})

Deno.test('status_summary counts only scrapers the manifest registry knows', async () => {
  // scraper_health is derived from scraper_runs, so it carries names the
  // manifest does not have. `dedupe_cross_source` is a post-processing pass,
  // not a scraper, and it must never be reported as a failing scraper.
  const exec = recorder(
    byTable({
      scraper_health: [
        { scraper_name: 'eventbrite', is_error: true, is_stale: false, is_zero_streak: false },
        { scraper_name: 'dedupe_cross_source', is_error: true, is_stale: false, is_zero_streak: false },
        { scraper_name: 'uakron_chp', is_error: false, is_stale: true, is_zero_streak: false },
      ],
      scraper_runs: [{ status: 'success', events_found: 10 }],
    }),
    0,
  )
  const lines = await run('status_summary', exec)
  const text = lines.join('\n')
  // One registered scraper erroring, not two, and no stale count from the
  // unregistered name.
  assertStringIncludes(text, '1 scraper erroring.')
  assertEquals(text.includes('stale'), false)
  // Drift is reported by scraper_health_summary, NOT here: it is a standing
  // condition and this is the handler people read every day.
  assertEquals(text.includes('unregistered'), false)
})

Deno.test('scraper_health_summary is where registry drift is reported', async () => {
  const exec = recorder([
    { scraper_name: 'akron_library', is_error: false, is_stale: false, is_zero_streak: false },
    { scraper_name: 'dedupe_cross_source', is_error: false, is_stale: false, is_zero_streak: false },
  ])
  const lines = await run('scraper_health_summary', exec)
  assertStringIncludes(lines[0], '1/1 scrapers healthy')
  assertStringIncludes(lines.join('\n'), '1 names in scraper_health are not in the manifest registry.')
})

Deno.test('sub-day windows get no prior-period comparison', async () => {
  // priorWindow is built from calendar midnights, so comparing "last night"
  // against it puts a few hours next to a whole day and calls them alike.
  for (const kind of ['tonight', 'last_night', 'last_hours'] as const) {
    const exec = recorder([], 9)
    const w: TimeWindow = {
      kind,
      label: kind === 'last_hours' ? 'last 24h' : kind.replace('_', ' '),
      startUtc: '2026-08-25T21:00:00.000Z',
      endUtc: '2026-08-26T04:00:00.000Z',
      startDateEt: '2026-08-25',
      endDateEt: '2026-08-25',
    }
    const lines = await run('events_in_window', exec, { window: w })
    assertEquals(lines[0].includes('Prior'), false, `${kind} offered a bogus comparison`)
    assertEquals(exec.counts.length, 1, `${kind} still ran the prior-window query`)
  }
  // A whole-day-or-longer window still gets its comparison.
  const day = recorder([], 9)
  await run('events_in_window', day, { window: upcomingWindow(NOW, 3) })
  assertEquals(day.counts.length, 2)
})

Deno.test('scrapers_failing filters the registry and marks the remainder', async () => {
  const exec = recorder([
    { scraper_name: 'eventbrite', last_error: 'HTTP 403', last_ran_at: '2026-08-26T02:00:00Z' },
    { scraper_name: 'dedupe_cross_source', last_error: 'boom', last_ran_at: '2026-08-26T03:00:00Z' },
  ])
  const lines = await run('scrapers_failing', exec)
  assertStringIncludes(lines[0], '1 scraper erroring (+1 unregistered):')
  assertEquals(lines.join('\n').includes('dedupe_cross_source'), false)
})

Deno.test('status_summary ranks the most alarming fact first', async () => {
  // No runs at all outranks everything else, including a big review backlog.
  const exec = recorder([], 500)
  const lines = await run('status_summary', exec)
  assertStringIncludes(lines[0], 'to look at')
  assertStringIncludes(lines[1], 'No scraper runs at all last night')
  assertEquals(lines.length <= 5, true)
})

Deno.test('status_summary issues all its probes concurrently and stays inside the caps', async () => {
  const exec = recorder()
  const lines = await run('status_summary', exec)
  // Two selects (health, runs) and two counts (digest failures, review
  // backlog). The health probe is a select rather than three counts so it can
  // be filtered through the manifest registry.
  assertEquals(exec.counts.length, 2)
  assertEquals(exec.selects.length, 2)
  assertEquals(composeReply(lines).split('\n').length <= MAX_REPLY_LINES, true)
})

Deno.test('analytics_unavailable is SHRUNK, not deleted, and names both halves', async () => {
  const lines = await run('analytics_unavailable', forbiddenExecutor)
  const text = lines.join(' ')
  // Half one: what became possible. A refusal that does not say what IS
  // answerable teaches nothing and sends the reader away.
  assertStringIncludes(text, 'Traffic, top pages, outbound clicks, embeds and installs are answerable')
  // Half two: what is still genuinely out of reach. If this list ever empties
  // the handler should go, but until then it must be specific enough that a
  // reader can tell whether their question is on it.
  for (const gap of ['referrers', 'devices', 'bounce', 'impressions', 'today']) {
    assertStringIncludes(text, gap)
  }
  // Still no database.
  assertEquals(HANDLERS.analytics_unavailable.needsDb, false)
  // And still never a number that could be mistaken for a measurement.
  assertEquals(/\b\d{2,}\b/.test(text), false)
})

Deno.test('no_match returns the teaching menu with no query at all', async () => {
  const lines = await run('no_match', forbiddenExecutor)
  assertStringIncludes(lines[0], 'Not one I know')
  assertEquals(lines.length <= MAX_REPLY_LINES, true)
})

// ── Site traffic: the GA4 mirror ──────────────────────────────────────────
//
// Everything below is about the two properties that make these handlers
// trustworthy rather than merely functional: the numbers are marked as FLOORS,
// and a distinct-user count is never fabricated by adding things up.

const TRAFFIC_IDS: HandlerId[] = [
  'traffic_overview',
  'traffic_trend',
  'top_pages',
  'outbound_clicks',
  'embed_traffic',
  'pwa_installs',
]

/** One stored day. Three of these make a 1,500-view window. */
const DAY_ROW: Row = {
  metric_date: '2026-08-25',
  total_users: 100,
  page_views: 500,
  sessions: 150,
  outbound_clicks: 3,
  outbound_users: 3,
  pwa_launches: 10,
  pwa_launch_users: 6,
  pwa_install_accepted: 1,
  pwa_users_7d: 29,
  pwa_users_28d: 58,
}

const GA_TABLES = ['site_metrics_daily', 'page_metrics_daily', 'embed_metrics_daily']

/** A past window, as the matcher would hand one over. */
function pastWindow(startDateEt: string, endDateEt: string, label: string, kind: TimeWindow['kind'] = 'last_days'): TimeWindow {
  return {
    kind,
    label,
    startUtc: `${startDateEt}T04:00:00.000Z`,
    endUtc: `${endDateEt}T04:00:00.000Z`,
    startDateEt,
    endDateEt,
  }
}

Deno.test('traffic handlers read only the GA mirror, and only allowlisted columns', async () => {
  // The whole point of the design: no GA credential and no outbound request
  // inside the edge function, just three Postgres tables.
  const allowed = new Set([
    'metric_date', 'total_users', 'page_views', 'sessions', 'outbound_clicks',
    'outbound_users', 'pwa_launches', 'pwa_install_accepted', 'pwa_users_7d',
    'pwa_users_28d', 'page_path', 'url_slug', 'outbound_tickets',
    'outbound_source', 'embed_host', 'users',
  ])
  for (const id of TRAFFIC_IDS) {
    const exec = recorder()
    await run(id, exec)
    assertEquals(exec.counts.length, 0, `${id} issued a count; these are all row reads`)
    assertEquals(exec.selects.length > 0, true, `${id} queried nothing`)
    for (const spec of exec.selects) {
      assertEquals(GA_TABLES.includes(spec.table), true, `${id} read ${spec.table}`)
      for (const column of allColumns(spec)) {
        assertEquals(allowed.has(column), true, `${id} read unlisted column "${column}"`)
      }
      assertEquals(spec.embed, undefined, `${id} joined; the mirror needs no joins`)
    }
  }
})

Deno.test('every GA figure carries the floor marker and every GA reply carries the note', async () => {
  // GA under-counts by an unknown margin -- Byron's own browser blocks
  // google-analytics.com -- so a bare number here is a claim the data cannot
  // support. `~` survives being quoted out of context; the note gives it a
  // meaning. Both, or neither is worth anything.
  for (const id of TRAFFIC_IDS) {
    const exec = recorder(byTable({
      site_metrics_daily: [DAY_ROW, DAY_ROW, DAY_ROW],
      page_metrics_daily: [{ page_path: '/events/today', url_slug: null, page_views: 264, outbound_clicks: 4, outbound_tickets: 3, outbound_source: 1 }],
      embed_metrics_daily: [{ embed_host: 'everydayakron.com', page_views: 128, users: 41 }],
    }))
    const lines = await run(id, exec)
    const text = lines.join('\n')
    assertEquals(lines[lines.length - 1], GA_FLOOR_NOTE, `${id} dropped the floor note`)
    // EVERY figure that came from GA4 must wear the tilde. Three things in a
    // reply do not come from GA4 and are exact, so they are removed before
    // the sweep: our own storage-coverage count ("3 of 7 days have data
    // stored"), a window length ("7d"), and a calendar date.
    for (const body of lines.slice(0, -1)) {
      const measured = body
        .replace(/\d+ of \d+ days have data stored\./g, '')
        .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
        .replace(/\b\d+d\b/g, '')
      for (const match of measured.matchAll(/(.?)(\d[\d,]*)/g)) {
        assertEquals(match[1], '~', `${id} printed a bare figure "${match[2]}" in: ${body}`)
      }
    }
    assertStringIncludes(text, '~')
  }
})

Deno.test('traffic_overview never calls a multi-day sum of daily uniques "visitors"', async () => {
  // total_users is that DAY's distinct-user count. Summing seven days counts
  // Tuesday's returning visitor twice, so the sum is visitor-days and the
  // per-day average is what is actually comparable.
  const exec = recorder(byTable({ site_metrics_daily: [DAY_ROW, DAY_ROW, DAY_ROW] }))
  const lines = await run('traffic_overview', exec)
  assertStringIncludes(lines[0], '~1,500 views')
  assertStringIncludes(lines[0], '~300 visitor-days')
  assertStringIncludes(lines[0], '(~100/day)')
  assertEquals(/\bvisitors\b/.test(lines.join(' ')), false, 'a sum of daily uniques was called visitors')
  // A gap in the mirror is reported, not hidden: three stored days out of a
  // seven-day question is a fact about the loader, not about the traffic.
  assertStringIncludes(lines.join('\n'), '3 of 7 days have data stored.')
})

Deno.test('a single-day window DOES say visitors, because one day of uniques is a real count', async () => {
  const exec = recorder(byTable({ site_metrics_daily: [DAY_ROW] }))
  const lines = await run('traffic_overview', exec, {
    window: pastWindow('2026-08-25', '2026-08-25', 'Aug 25', 'date'),
  })
  assertStringIncludes(lines[0], '~100 visitors')
  assertEquals(lines[0].includes('visitor-days'), false)
})

Deno.test('the traffic window is clamped to what the loader can possibly have written', async () => {
  // NOW is Wed 2026-08-26 noon ET, so the latest stored day is 2026-08-25.
  // Default, no window named: seven days ending yesterday.
  const plain = recorder(byTable({ site_metrics_daily: [DAY_ROW] }))
  await run('traffic_overview', plain)
  assertEquals(filterValue(plain.selects[0].filters, 'gte', 'metric_date'), '2026-08-19')
  assertEquals(filterValue(plain.selects[0].filters, 'lte', 'metric_date'), '2026-08-25')
  // The prior window is the same length, immediately before, with no overlap.
  assertEquals(filterValue(plain.selects[1].filters, 'gte', 'metric_date'), '2026-08-12')
  assertEquals(filterValue(plain.selects[1].filters, 'lte', 'metric_date'), '2026-08-18')

  // "this week" on a Wednesday runs to Sunday. The tail is not loaded, so it
  // is trimmed and the label says so rather than quietly reporting three days
  // as a week.
  const week = recorder(byTable({ site_metrics_daily: [DAY_ROW] }))
  const weekLines = await run('traffic_overview', week, {
    window: pastWindow('2026-08-24', '2026-08-30', 'this week (Aug 24-30)', 'week'),
  })
  assertEquals(filterValue(week.selects[0].filters, 'lte', 'metric_date'), '2026-08-25')
  assertStringIncludes(weekLines[0], 'this week (Aug 24-30) so far')
})

Deno.test('a question about TODAY answers about yesterday and says which', async () => {
  // The loader never writes a partial day. Refusing outright is a dead end
  // when a good answer is one day back; answering silently is a wrong answer.
  const exec = recorder(byTable({ site_metrics_daily: [DAY_ROW] }))
  const lines = await run('traffic_overview', exec, {
    window: pastWindow('2026-08-26', '2026-08-26', 'today', 'today'),
  })
  assertEquals(filterValue(exec.selects[0].filters, 'gte', 'metric_date'), '2026-08-25')
  assertEquals(filterValue(exec.selects[0].filters, 'lte', 'metric_date'), '2026-08-25')
  assertStringIncludes(lines[0], 'yesterday (today not loaded yet)')
})

Deno.test('no traffic handler ever queries a date later than yesterday', async () => {
  // A forward window is always empty in a table of past days, and
  // requireWindow's forward-looking fallback is exactly the trap that would
  // put one there. Every traffic handler uses metricsRange instead.
  const forward = pastWindow('2026-08-27', '2026-09-10', 'next 14d', 'next_days')
  for (const id of TRAFFIC_IDS) {
    const exec = recorder()
    await run(id, exec, { window: forward })
    for (const spec of exec.selects) {
      const upper = filterValue(spec.filters, 'lte', 'metric_date')
      if (upper === undefined) continue
      assertEquals(String(upper) <= '2026-08-25', true, `${id} asked for ${upper}`)
    }
  }
})

Deno.test('a uuid in the SLUG is scrubbed too, not just one in the path', async () => {
  // The scrub used to sit on the page_path fallback only, while url_slug
  // returned earlier and unmodified. redact.ts does not care which column a
  // uuid came from: either one withholds the whole reply, so one malformed
  // /events/x/{uuid}/{uuid} path in a week of GA data cost the entire
  // top-pages answer. Both branches are scrubbed now, and the loader also
  // bounds its slug capture to `[^/]+` so the shape cannot be produced.
  const exec = recorder(byTable({
    page_metrics_daily: [
      { page_path: '/events/x/0a95a063-3600-448d-b329-c8ee8fac81e5', url_slug: 'x/0a95a063-3600-448d-b329-c8ee8fac81e5', page_views: 90 },
      { page_path: '/venues/be8f5fb8-59fc-4a0a-b113-54c6ebdf73fc', url_slug: null, page_views: 40 },
    ],
  }))
  const reply = composeReply(await run('top_pages', exec))
  assertEquals(redactOutbound(reply).ok, true, 'a uuid reached the reply and it was withheld')
  assertEquals(reply.includes('0a95a063'), false)
  assertEquals(reply.includes('be8f5fb8'), false)
})

Deno.test('top_pages strips a uuid from a path, or redaction bins the whole answer', async () => {
  // redact.ts: "no handler renders a uuid". /organizations/{uuid} is a live
  // route that shows up in top pages, so one such row would withhold the
  // entire reply, not just its own line.
  const exec = recorder(byTable({
    page_metrics_daily: [
      { page_path: '/organizations/4d890091-6d95-4728-99e1-880df91ae943', url_slug: null, page_views: 40 },
      { page_path: '/events/porchrokr-2026/0a95a063-3600-448d-b329-c8ee8fac81e5', url_slug: 'porchrokr-2026', page_views: 300 },
    ],
  }))
  const lines = await run('top_pages', exec)
  const reply = composeReply(lines)
  assertEquals(redactOutbound(reply).ok, true, 'a uuid reached the reply and it was withheld')
  assertStringIncludes(reply, '/organizations/{id}')
  // plural(), so never "over ~1 pages".
  const one = recorder(byTable({ page_metrics_daily: [{ page_path: '/submit', url_slug: null, page_views: 11 }] }))
  assertStringIncludes((await run('top_pages', one))[0], 'over ~1 page:')
  // An event page is shown by its slug, which is also the join key to events.
  assertStringIncludes(reply, 'porchrokr-2026 ~300')
  assertEquals(reply.includes('0a95a063'), false)
})

Deno.test('outbound_clicks trusts the site-wide total and omits a split it does not have', async () => {
  // The per-page rows are subject to the loader's per-day page cap; the daily
  // site report is not. And when the link_type custom dimension is not
  // registered in GA4 the split comes back as zeros, which is a fact about
  // the dimension, not about the clicks, so the line is dropped rather than
  // asserting "0 to ticket links".
  const exec = recorder(byTable({
    site_metrics_daily: [{ ...DAY_ROW, outbound_clicks: 17 }],
    page_metrics_daily: [
      { page_path: '/events/x/1', url_slug: 'ales-on-rails', outbound_clicks: 4, outbound_tickets: 0, outbound_source: 0 },
    ],
  }))
  const lines = await run('outbound_clicks', exec)
  assertStringIncludes(lines[0], '~17 outbound clicks')
  assertEquals(lines.join(' ').includes('ticket links'), false)
  // The per-page read uses the partial index's predicate rather than
  // fetching every page and filtering in TypeScript.
  const pageSpec = exec.selects.find((sp) => sp.table === 'page_metrics_daily')
  assertEquals(filterValue(pageSpec!.filters, 'gt', 'outbound_clicks'), 0)

  // When the per-page rows account for the whole site total, the split is
  // stated plainly.
  const withSplit = recorder(byTable({
    site_metrics_daily: [{ ...DAY_ROW, outbound_clicks: 4 }],
    page_metrics_daily: [
      { page_path: '/events/x/1', url_slug: 'ales-on-rails', outbound_clicks: 4, outbound_tickets: 3, outbound_source: 1 },
    ],
  }))
  assertStringIncludes((await run('outbound_clicks', withSplit)).join('\n'), '~3 to ticket links, ~1 to the source site.')

  // When they do not -- a page trimmed by the loader's cap, or a click with no
  // link_type recorded -- the line names its own base rather than implying the
  // remaining clicks went nowhere.
  const partial = recorder(byTable({
    site_metrics_daily: [{ ...DAY_ROW, outbound_clicks: 17 }],
    page_metrics_daily: [
      { page_path: '/events/x/1', url_slug: 'ales-on-rails', outbound_clicks: 4, outbound_tickets: 3, outbound_source: 1 },
    ],
  }))
  assertStringIncludes(
    (await run('outbound_clicks', partial)).join('\n'),
    'Of the ~4 with a link type recorded: ~3 tickets, ~1 source.',
  )
})

Deno.test('embed_traffic names BOTH causes of an empty table instead of picking one', async () => {
  // "Nobody loaded an embed" and "the embed_host dimension is unregistered in
  // GA4 Admin" are indistinguishable from here, and guessing would be worse.
  const exec = recorder(byTable({ embed_metrics_daily: [] }))
  const lines = await run('embed_traffic', exec)
  const text = lines.join('\n')
  assertStringIncludes(text, 'No embed traffic recorded')
  assertStringIncludes(text, 'embed_host dimension is still unregistered')
})

Deno.test('pwa_installs reads the stored distinct-user snapshot and never sums daily users', async () => {
  // THE HANDLER WITH NO TRUE ANSWER. Uninstalls fire no event and iOS Add to
  // Home Screen fires nothing at all, so "how many installs" has no honest
  // total. The only defensible figure is distinct users who opened the
  // installed app in a trailing window, which GA4 computes and the loader
  // stores; deriving it by adding up pwa_launch_users would produce a bigger,
  // wronger number because distinct counts do not add.
  const exec = recorder(byTable({
    site_metrics_daily: [{ metric_date: '2026-08-25', pwa_users_7d: 29, pwa_users_28d: 58, pwa_launches: 14, pwa_install_accepted: 1 }],
  }))
  const lines = await run('pwa_installs', exec)
  const text = lines.join('\n')

  // The snapshot query asks for the most recent NON-NULL row: null in those
  // columns means "not computed for this date", which is not zero.
  const snap = exec.selects.find((sp) => sp.limit === 1)!
  assertEquals(filterValue(snap.filters, 'not_is', 'pwa_users_28d'), null)
  assertEquals(snap.order, { column: 'metric_date', ascending: false })

  assertStringIncludes(text, '~58 people opened the installed app in the 28d to 2026-08-25')
  assertStringIncludes(text, '~29 in the last 7d')
  // The framing is mandatory, not decorative.
  assertStringIncludes(text, 'floor on active installs, not an install count')
  assertStringIncludes(text, 'iOS Add to Home Screen fires none at all')
  // And it must never present a total that reads like an install count.
  assertEquals(/\b(total|all[- ]time) installs?\b/i.test(text), false)
  assertStringIncludes(text, '~1 Android/desktop install prompt accepted')
})

Deno.test('pwa_installs refuses to invent a figure when no snapshot is stored', async () => {
  // The snapshot query is the one with limit 1; the window query is not.
  const exec = recorder((spec: SelectSpec) =>
    spec.limit === 1 ? [] : [{ pwa_launches: 14, pwa_install_accepted: 1 }]
  )
  const lines = await run('pwa_installs', exec)
  const text = lines.join('\n')
  assertStringIncludes(text, 'will not fake one from daily counts')
  assertStringIncludes(text, 'scripts/ga-to-db.js')
  // It still reports the two additive facts it genuinely has.
  assertStringIncludes(text, '~14 app launches')
})

Deno.test('a traffic question against an empty mirror says so instead of reporting zero', async () => {
  // "~0 views last week" and "the loader has not run" are very different
  // findings and only one of them is true.
  for (const id of ['traffic_overview', 'traffic_trend', 'top_pages'] as HandlerId[]) {
    const exec = recorder([], 0)
    const lines = await run(id, exec)
    assertStringIncludes(lines[0], 'No GA data stored')
    assertStringIncludes(lines.join('\n'), 'scripts/ga-to-db.js')
    assertEquals(lines.join(' ').includes('~0'), false, `${id} reported a zero it does not have`)
  }
})

Deno.test('traffic_trend leads with the delta and refuses one it cannot compute', async () => {
  const exec = recorder(byTable({ site_metrics_daily: [DAY_ROW, DAY_ROW] }))
  const lines = await run('traffic_trend', exec)
  assertStringIncludes(lines.join('\n'), 'views ~1,000 vs ~1,000, flat')

  // A zero prior is NOT rendered as an infinite rise.
  const fresh: Recorder = recorder((spec: SelectSpec) =>
    String(filterValue(spec.filters, 'gte', 'metric_date')) >= '2026-08-19' ? [DAY_ROW] : []
  )
  const lines2 = await run('traffic_trend', fresh)
  assertStringIncludes(lines2.join('\n'), 'nothing to compare against')
})

// ── The end-to-end contract ───────────────────────────────────────────────

Deno.test('every handler produces a reply that fits the caps and survives redaction', async () => {
  for (const id of HANDLER_IDS) {
    const exec = id === 'analytics_unavailable' || id === 'no_match' ? forbiddenExecutor : recorder()
    const lines = await run(id, exec)
    assertEquals(lines.length > 0, true, `${id} produced no lines`)

    const reply = composeReply(lines)
    assertEquals(reply.split('\n').length <= MAX_REPLY_LINES, true, `${id} exceeded the line cap`)
    assertEquals(reply.length <= MAX_REPLY_CHARS, true, `${id} exceeded the character cap`)

    const scanned = redactOutbound(reply)
    assertEquals(scanned.ok, true, `${id} was withheld by ${scanned.violations.join(',')}`)

    // Line one is the answer, not a preamble restating the question.
    assertEquals(/^(sure|ok|here|i |let me|you asked)/i.test(reply), false, `${id} opened with a preamble`)
  }
})

Deno.test('every handler survives an empty database without throwing', async () => {
  for (const id of HANDLER_IDS) {
    const exec = id === 'analytics_unavailable' || id === 'no_match' ? forbiddenExecutor : recorder([], 0)
    const lines = await run(id, exec)
    assertEquals(lines.length > 0, true, `${id} produced no lines on an empty database`)
    assertEquals(redactOutbound(composeReply(lines)).ok, true, `${id} was withheld on an empty database`)
  }
})

Deno.test('every handler survives rows full of nulls without throwing', async () => {
  // Real defence against `undefined` reaching a line as the string "undefined".
  const nulls: Row = {
    id: null,
    source: null,
    title: null,
    start_at: null,
    category_slugs: null,
    event_venues: null,
    event_organizations: null,
    scraper_name: null,
    last_status: null,
    last_ran_at: null,
    last_error: null,
    last_events_found: null,
    consecutive_zeros: null,
    avg_events_last5: null,
    hours_since_run: null,
    status: null,
    sent_at: null,
    events_found: null,
    category: null,
    metric_date: null,
    total_users: null,
    sessions: null,
    page_views: null,
    outbound_clicks: null,
    outbound_users: null,
    outbound_tickets: null,
    outbound_source: null,
    pwa_launches: null,
    pwa_install_accepted: null,
    pwa_users_7d: null,
    pwa_users_28d: null,
    page_path: null,
    url_slug: null,
    users: null,
    embed_host: null,
  }
  for (const id of HANDLER_IDS) {
    const exec = id === 'analytics_unavailable' || id === 'no_match' ? forbiddenExecutor : recorder([nulls, nulls], 0)
    const lines = await run(id, exec)
    const reply = composeReply(lines)
    assertEquals(reply.includes('undefined'), false, `${id} rendered the string "undefined"`)
    assertEquals(reply.includes('NaN'), false, `${id} rendered NaN`)
    assertEquals(redactOutbound(reply).ok, true, `${id} was withheld on null rows`)
  }
})
