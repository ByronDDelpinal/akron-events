/**
 * test-extend-series.js - the nightly recurring-series extender
 * (ADR-069 slice 2).
 *
 * Most pins run against scripts/lib/series.js directly with a fixed
 * `todayYmd` and hand-built rows, which needs no client and no clock: that is
 * the point of the planner being pure. The client seam
 * (supabase-admin __setClientForTests) is used only for the end-to-end pins:
 * dry-run writes nothing, the events write carries ON CONFLICT DO NOTHING and
 * never an update, and the junction copy fires once per table for the ids the
 * write actually returned.
 *
 * Two DST facts are pinned as full ISO strings because a rolled UTC date is
 * exactly what a naive implementation gets wrong: 2026-10-29 19:00 Eastern is
 * EDT (23:00Z the same day) and 2026-11-05 19:00 Eastern is EST
 * (2026-11-06T00:00:00.000Z, the next UTC day).
 *
 * Run:  node --test scripts/tests/test-extend-series.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  NEVER_COPY_COLUMNS, occurrenceKey, planSeriesExtension, selectTemplate,
} = await import('../lib/series.js')
const { occurrenceSourceId, parseOccurrenceSourceId } = await import('../../src/lib/recurrence.js')
const { easternToIso, easternTodayIso } = await import('../lib/normalize.js')
const { __setClientForTests } = await import('../lib/supabase-admin.js')
const { main } = await import('../extend-series.js')

const SERIES_ID   = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f601'
const SERIES_ID_2 = '3f2a1b4c-5d6e-4f70-8a91-b2c3d4e5f602'
const TEMPLATE_ID = '9c11a2b3-4d5e-4f60-9a81-b2c3d4e5f701'

const seriesRow = (over = {}) => ({
  id: SERIES_ID,
  rrule: 'FREQ=WEEKLY;BYDAY=TH',
  dtstart_date: '2026-10-01',
  start_time: '19:00',
  duration_min: null,
  exdates: [],
  source: 'manual',
  ...over,
})

const templateRow = (over = {}) => ({
  id: TEMPLATE_ID,
  series_id: SERIES_ID,
  status: 'published',
  start_at: '2026-09-24T23:00:00.000Z',
  end_at: null,
  created_at: '2026-08-01T12:00:00.000Z',
  title: 'Thursday Trivia',
  description: 'Quiz night at the bar.',
  image_url: 'https://example.test/trivia.jpg',
  image_width: 800, image_height: 600, image_file_size: 12345,
  ticket_url: null,
  source_url: 'https://example.test/trivia',
  price_min: 0, price_max: 0,
  age_restriction: '21+',
  tags: ['trivia'],
  is_family: false, is_fundraiser: false,
  event_attendance_mode: 'offline',
  event_status: 'scheduled',
  is_accessible_for_free: true,
  needs_review: false,
  manual_overrides: { status: 'published', title: true },
  source: 'manual',
  ...over,
})

/** Plan one night with the planner alone, no client involved. */
const plan = ({ series = [seriesRow()], occurrences = [templateRow()], todayYmd, ...rest }) =>
  planSeriesExtension({ seriesRows: series, occurrenceRows: occurrences, todayYmd, ...rest })

const datesOf = (inserts) => inserts.map((r) => parseOccurrenceSourceId(r.source_id).ymd)

// ── Fake supabase client ────────────────────────────────────────────────────
//
// Records every call so the assertions are about what the script actually
// tried to write. Chainable-builder shape copied from
// test-normalize-upsert-counters.js.
function makeClient({ series = [], occurrences = [], existing = [], aliases = [], junctionRows = {}, insertedLimit = null }) {
  const calls = []
  function resolve(st) {
    if (st.op === 'upsert' && st.table === 'events') {
      const created = st.rows.map((r) => ({ id: `ev-${r.source_id}`, source_id: r.source_id }))
      return { data: insertedLimit == null ? created : created.slice(0, insertedLimit), error: null }
    }
    if (st.op === 'upsert') return { data: null, error: null }
    if (st.table === 'event_series') return { data: series, error: null }
    if (st.table === 'events') {
      return st.cols === 'source, source_id'
        ? { data: existing, error: null }
        : { data: occurrences, error: null }
    }
    if (st.table === 'event_aliases') return { data: aliases, error: null }
    return { data: junctionRows[st.table] || [], error: null }
  }
  function builder(table) {
    const st = { table, op: 'select', cols: null, rows: null }
    const chain = {
      select(cols) { st.cols = cols; return chain },
      is(col, val) { calls.push({ op: 'is', table, col, val }); return chain },
      in()  { return chain },
      eq()  { return chain },
      order(col, opts) { calls.push({ op: 'order', table, col, opts }); return chain },
      range(from, to) { calls.push({ op: 'range', table, from, to }); return chain },
      upsert(rows, opts) { st.op = 'upsert'; st.rows = rows; calls.push({ op: 'upsert', table, rows, opts }); return chain },
      insert(rows) { calls.push({ op: 'insert', table, rows }); return chain },
      update(rows) { calls.push({ op: 'update', table, rows }); return chain },
      delete() { calls.push({ op: 'delete', table }); return chain },
      then(onF, onR) { return Promise.resolve(resolve(st)).then(onF, onR) },
    }
    return chain
  }
  return { client: { from: builder }, calls }
}

/** Run the CLI end to end against a fake client. */
async function runMain(fixture, opts = {}) {
  const { client, calls } = makeClient(fixture)
  const logs = []
  const origLog = console.log
  console.log = (...args) => logs.push(args.join(' '))
  __setClientForTests(client)
  try {
    await main(opts)
  } finally {
    __setClientForTests(null)
    console.log = origLog
  }
  calls.logs = logs
  return calls
}

/** A series whose dates always land inside the horizon of the real "today". */
const e2eSeries = () => seriesRow({ rrule: 'FREQ=DAILY;COUNT=3', dtstart_date: easternTodayIso() })

// ── 1..3: the calendar ──────────────────────────────────────────────────────
describe('series extender - expansion', () => {
  it('1. crosses the November DST boundary on wall-clock time', () => {
    const { inserts } = plan({ todayYmd: '2026-10-01' })
    const byDate = Object.fromEntries(inserts.map((r) => [parseOccurrenceSourceId(r.source_id).ymd, r]))
    assert.equal(byDate['2026-10-29'].start_at, '2026-10-29T23:00:00.000Z') // EDT, UTC-4
    assert.equal(byDate['2026-11-05'].start_at, '2026-11-06T00:00:00.000Z') // EST, UTC-5, next UTC day
  })

  it('2. skips a month too short for a BYDAY-less MONTHLY rule, never rolls it', () => {
    const series = seriesRow({ rrule: 'FREQ=MONTHLY', dtstart_date: '2026-01-31' })
    const { inserts } = plan({ series: [series], todayYmd: '2026-02-01' })
    const dates = datesOf(inserts)
    assert.deepEqual(dates, ['2026-03-31'])
    assert.ok(!dates.includes('2026-03-03'))
    assert.ok(!dates.some((d) => d.startsWith('2026-02')))
  })

  it('3. resolves a BYDAY ordinal, including a fifth-Thursday month', () => {
    const series = seriesRow({ rrule: 'FREQ=MONTHLY;BYDAY=-1TH', dtstart_date: '2026-09-24' })
    const { inserts } = plan({ series: [series], todayYmd: '2026-09-02' })
    assert.deepEqual(datesOf(inserts), ['2026-09-24', '2026-10-29', '2026-11-26'])
  })
})

// ── 4..5: suppression ───────────────────────────────────────────────────────
describe('series extender - suppression', () => {
  it('4. an exdate removes exactly one date and shifts nothing', () => {
    const series = seriesRow({ exdates: ['2026-10-15'] })
    const { inserts, counters } = plan({ series: [series], todayYmd: '2026-10-01' })
    const dates = datesOf(inserts)
    assert.ok(!dates.includes('2026-10-15'))
    assert.equal(counters.skipped_exdate, 1)
    assert.deepEqual(dates.slice(0, 4), ['2026-10-01', '2026-10-08', '2026-10-22', '2026-10-29'])
  })

  it('5. an event_aliases row removes that date and leaves its neighbours', () => {
    const aliasKeys = new Set([occurrenceKey('manual', `series:${SERIES_ID}:2026-10-15`)])
    const { inserts, counters } = plan({ todayYmd: '2026-10-01', aliasKeys })
    const dates = datesOf(inserts)
    assert.ok(!dates.includes('2026-10-15'))
    assert.ok(dates.includes('2026-10-08') && dates.includes('2026-10-22'))
    assert.equal(counters.skipped_alias, 1)
    assert.equal(counters.skipped_existing, 0)
  })
})

// ── 6..9: no template, cancelled series ─────────────────────────────────────
describe('series extender - template selection', () => {
  it('6. a pending_review-only series plans nothing and counts no_template', () => {
    const occurrences = [templateRow({ status: 'pending_review' })]
    const { inserts, counters, perSeries } = plan({ occurrences, todayYmd: '2026-10-01' })
    assert.equal(inserts.length, 0)
    assert.equal(counters.no_template, 1)
    assert.equal(counters.with_template, 0)
    assert.equal(perSeries[0].reason, 'no_template')
  })

  it('7. a series with no occurrence rows plans nothing and does not throw', () => {
    const { inserts, counters } = plan({ occurrences: [], todayYmd: '2026-10-01' })
    assert.equal(inserts.length, 0)
    assert.equal(counters.no_template, 1)
    assert.equal(selectTemplate([]), null)
  })

  it('8. an all-cancelled series plans nothing and counts no_template', () => {
    const occurrences = [templateRow({ status: 'cancelled' }), templateRow({ id: 'other', status: 'cancelled' })]
    const { inserts, counters } = plan({ occurrences, todayYmd: '2026-10-01' })
    assert.equal(inserts.length, 0)
    assert.equal(counters.no_template, 1)
  })

  it('9. the active-series query filters on cancelled_at is null', async () => {
    const calls = await runMain({
      series: [e2eSeries()],
      occurrences: [templateRow({ series_id: SERIES_ID })],
    })
    assert.ok(calls.some((c) => c.op === 'is' && c.table === 'event_series' && c.col === 'cancelled_at' && c.val === null))
    // A cancelled series never comes back from Q1, so nothing is planned for it.
    const written = calls.filter((c) => c.op === 'upsert' && c.table === 'events').flatMap((c) => c.rows)
    assert.ok(written.length > 0)
    assert.ok(written.every((r) => r.series_id === SERIES_ID))
  })
})

// ── 10, 14..16, 20: the payload ─────────────────────────────────────────────
describe('series extender - payload', () => {
  it('10. an existing row is skipped, never updated', async () => {
    const todayYmd = easternTodayIso()
    const taken = `series:${SERIES_ID}:${todayYmd}`
    const calls = await runMain({
      series: [e2eSeries()],
      occurrences: [templateRow()],
      existing: [{ source: 'manual', source_id: taken }],
    })
    const eventUpserts = calls.filter((c) => c.op === 'upsert' && c.table === 'events')
    const written = eventUpserts.flatMap((c) => c.rows)
    assert.ok(!written.some((r) => r.source_id === taken))
    assert.equal(calls.filter((c) => c.op === 'update').length, 0)
    for (const c of eventUpserts) {
      assert.equal(c.opts.ignoreDuplicates, true)
      assert.equal(c.opts.onConflict, 'source,source_id')
    }
    // and the planner counts it, on the PAIR, in whatever status it holds
    const existingKeys = new Set([occurrenceKey('manual', `series:${SERIES_ID}:2026-10-15`)])
    const { counters, inserts } = plan({ todayYmd: '2026-10-01', existingKeys })
    assert.equal(counters.skipped_existing, 1)
    assert.ok(!datesOf(inserts).includes('2026-10-15'))
  })

  it('14. featured is false on every occurrence, even from a featured template', () => {
    const { inserts } = plan({ occurrences: [templateRow({ featured: true })], todayYmd: '2026-10-01' })
    assert.ok(inserts.length > 0)
    for (const row of inserts) assert.equal(row.featured, false)
  })

  it('15. payloads carry the series link and nothing the database owns', () => {
    const { inserts } = plan({ todayYmd: '2026-10-01' })
    for (const row of inserts) {
      for (const col of NEVER_COPY_COLUMNS) {
        assert.ok(!(col in row), `payload must not carry ${col}`)
      }
      assert.equal(row.series_id, SERIES_ID)
      assert.equal(row.status, 'published')
      const parsed = parseOccurrenceSourceId(row.source_id)
      assert.equal(parsed.seriesId, SERIES_ID)
      // the instant is minted from the source_id's civil date at the series
      // wall-clock time, which is what keeps the UTC year roll honest
      assert.equal(row.start_at, easternToIso(parsed.ymd, '19:00'))
    }
    assert.deepEqual(datesOf(inserts).slice(0, 2), ['2026-10-01', '2026-10-08'])
  })

  it('16. manual_overrides travels forward unchanged', () => {
    const overrides = { status: 'published', title: true }
    const { inserts } = plan({ occurrences: [templateRow({ manual_overrides: overrides })], todayYmd: '2026-10-01' })
    for (const row of inserts) assert.deepEqual(row.manual_overrides, overrides)
  })

  it('20. end_at comes from the series duration, then the template delta, then null', () => {
    const withDuration = plan({ series: [seriesRow({ duration_min: 120 })], todayYmd: '2026-10-01' }).inserts
    const byDate = Object.fromEntries(withDuration.map((r) => [parseOccurrenceSourceId(r.source_id).ymd, r]))
    assert.equal(byDate['2026-10-29'].end_at, '2026-10-30T01:00:00.000Z')
    assert.equal(byDate['2026-11-05'].end_at, '2026-11-06T02:00:00.000Z') // 120 real minutes across DST

    const fromTemplate = plan({
      occurrences: [templateRow({ start_at: '2026-09-24T23:00:00.000Z', end_at: '2026-09-25T01:30:00.000Z' })],
      todayYmd: '2026-10-01',
    }).inserts
    assert.equal(fromTemplate[0].start_at, '2026-10-01T23:00:00.000Z')
    assert.equal(fromTemplate[0].end_at, '2026-10-02T01:30:00.000Z')

    const unknown = plan({ todayYmd: '2026-10-01' }).inserts
    for (const row of unknown) assert.equal(row.end_at, null)
  })
})

// ── 11..13: window and COUNT ────────────────────────────────────────────────
describe('series extender - window', () => {
  it('11. a COUNT consumed entirely in the past plans nothing', () => {
    const series = seriesRow({ rrule: 'FREQ=WEEKLY;BYDAY=WE;COUNT=6', dtstart_date: '2026-06-24' })
    const { inserts, counters } = plan({ series: [series], todayYmd: '2026-09-02' })
    assert.equal(inserts.length, 0)
    assert.equal(counters.planned, 0)
    assert.equal(counters.with_template, 1) // it had a template, it simply owes nothing
  })

  it('12. a partially consumed COUNT plans only the dates still owed', () => {
    const series = seriesRow({ rrule: 'FREQ=WEEKLY;BYDAY=WE;COUNT=6', dtstart_date: '2026-08-12' })
    const { inserts } = plan({ series: [series], todayYmd: '2026-09-02' })
    assert.deepEqual(datesOf(inserts), ['2026-09-02', '2026-09-09', '2026-09-16'])
  })

  it('13. the horizon is inclusive at both ends and hard at the top', () => {
    const inside = seriesRow({ rrule: 'FREQ=WEEKLY;BYDAY=WE', dtstart_date: '2026-09-02' })
    const dates = datesOf(plan({ series: [inside], todayYmd: '2026-09-02' }).inserts)
    assert.equal(dates[0], '2026-09-02')                  // today, inclusive
    assert.equal(dates[dates.length - 1], '2026-12-02')   // today + 91, inclusive
    assert.ok(!dates.includes('2026-12-09'))

    const past = seriesRow({ id: SERIES_ID_2, rrule: 'FREQ=WEEKLY;BYDAY=TH', dtstart_date: '2026-12-03' })
    const beyond = plan({
      series: [past],
      occurrences: [templateRow({ series_id: SERIES_ID_2 })],
      todayYmd: '2026-09-02',
    })
    assert.equal(beyond.inserts.length, 0)                // 2026-12-03 is past the horizon
  })
})

// ── 17..19: the write path ──────────────────────────────────────────────────
describe('series extender - write path', () => {
  const junctionFixture = {
    event_venues:        [{ event_id: TEMPLATE_ID, venue_id: 'venue-1' }],
    event_areas:         [{ event_id: TEMPLATE_ID, area_id: 'area-1' }],
    event_organizations: [{ event_id: TEMPLATE_ID, organization_id: 'org-1' }],
    event_categories:    [
      { event_id: TEMPLATE_ID, category: 'music' },
      { event_id: TEMPLATE_ID, category: 'nightlife' },
    ],
  }

  it('17. all four junctions are copied, one batched upsert each', async () => {
    const calls = await runMain({
      series: [e2eSeries()], occurrences: [templateRow()], junctionRows: junctionFixture,
    })
    const created = calls.filter((c) => c.op === 'upsert' && c.table === 'events').flatMap((c) => c.rows)
    assert.equal(created.length, 3) // FREQ=DAILY;COUNT=3

    const junctionCalls = calls.filter((c) => c.op === 'upsert' && c.table !== 'events')
    assert.equal(junctionCalls.length, 4)
    for (const c of junctionCalls) assert.equal(c.opts.ignoreDuplicates, true)
    const rowsOf = (table) => junctionCalls.find((c) => c.table === table).rows
    assert.equal(rowsOf('event_venues').length, 3)
    assert.equal(rowsOf('event_areas').length, 3)
    assert.equal(rowsOf('event_organizations').length, 3)
    assert.equal(rowsOf('event_categories').length, 6) // two categories per occurrence
    assert.deepEqual(rowsOf('event_venues')[0], { event_id: `ev-${created[0].source_id}`, venue_id: 'venue-1' })
  })

  it('18. junction rows are built only for the ids the write returned', async () => {
    const calls = await runMain({
      series: [e2eSeries()], occurrences: [templateRow()],
      junctionRows: junctionFixture, insertedLimit: 1, // the race case: two rows lost
    })
    const junctionCalls = calls.filter((c) => c.op === 'upsert' && c.table !== 'events')
    assert.equal(junctionCalls.length, 4)
    assert.equal(junctionCalls.find((c) => c.table === 'event_venues').rows.length, 1)
    assert.equal(junctionCalls.find((c) => c.table === 'event_categories').rows.length, 2)
  })

  it('19. --dry-run writes nothing at all but still reports the plan', async () => {
    const calls = await runMain(
      { series: [e2eSeries()], occurrences: [templateRow()], junctionRows: junctionFixture },
      { dryRun: true },
    )
    assert.equal(calls.filter((c) => c.op === 'upsert' || c.op === 'insert').length, 0)
    const text = calls.logs.join('\n')
    assert.match(text, /dates planned\s+3/)
    assert.match(text, /would insert\s+0/)
  })
})

// ── 22..24: review follow-ups ───────────────────────────────────────────────
describe('series extender - duplicate and paging guards', () => {
  it('22. a date already materialised under another source is never minted again', () => {
    // The series was promoted from 'manual' to 'partner:acme' after its first
    // occurrences were written. The unique constraint is on the PAIR, so
    // Postgres would accept a second row for the same night; the bare-id set
    // is the only thing that stops it.
    const series = seriesRow({ source: 'partner:acme' })
    const occurrences = [templateRow({ source: 'partner:acme' })]
    const existingSourceIds = new Set([occurrenceSourceId(SERIES_ID, '2026-10-15')])
    const { inserts, counters, perSeries } = plan({
      series: [series], occurrences, todayYmd: '2026-10-01', existingSourceIds,
    })
    const dates = datesOf(inserts)
    assert.ok(!dates.includes('2026-10-15'))
    assert.ok(dates.includes('2026-10-08') && dates.includes('2026-10-22'))
    assert.equal(counters.skipped_existing_other_source, 1)
    assert.equal(counters.skipped_existing, 0)   // the pair itself was free
    assert.equal(perSeries[0].skippedExistingOtherSource, 1)
  })

  it('23. a template whose source disagrees with the series is counted, and the template wins', () => {
    const series = seriesRow({ source: 'partner:acme' })
    const occurrences = [templateRow({ source: 'manual' })]
    const { inserts, counters, perSeries } = plan({ series: [series], occurrences, todayYmd: '2026-10-01' })
    assert.equal(counters.source_mismatch, 1)
    assert.equal(perSeries[0].sourceMismatch, true)
    for (const row of inserts) assert.equal(row.source, 'manual')

    const agreed = plan({ todayYmd: '2026-10-01' })
    assert.equal(agreed.counters.source_mismatch, 0)
    assert.equal(agreed.perSeries[0].sourceMismatch, false)
  })

  it('24. every read is paged under a total, stable ordering', async () => {
    const calls = await runMain({ series: [e2eSeries()], occurrences: [templateRow()] })
    const orderCols = (table) => calls.filter((c) => c.op === 'order' && c.table === table).map((c) => c.col)
    // Q2 must sort by series_id FIRST: an unpaged start_at DESC across a
    // whole chunk starves the series below the 1000-row cut.
    assert.deepEqual(orderCols('events').slice(0, 3), ['series_id', 'start_at', 'id'])
    assert.deepEqual(orderCols('event_series'), ['id'])
    for (const table of ['event_series', 'events', 'event_aliases', 'event_venues']) {
      assert.ok(calls.some((c) => c.op === 'range' && c.table === table), `${table} must be paged`)
    }
    const firstPage = calls.find((c) => c.op === 'range')
    assert.equal(firstPage.from, 0)
    assert.equal(firstPage.to, 999)
  })
})
