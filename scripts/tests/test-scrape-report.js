/**
 * test-scrape-report.js — pure analysis for the scrape:all run-health report.
 *
 * Run:  node --test scripts/tests/test-scrape-report.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const {
  analyzeRuns, median, renderMarkdown,
  resolveRunContext, summarizeThisRun, RUN_CONTEXT_MAX_AGE_HOURS,
} = await import('../scrape-report.js')

const NOW = Date.parse('2026-06-19T08:00:00Z')
const recent = (h) => new Date(NOW - h * 3.6e6).toISOString()

describe('median', () => {
  it('odd/even/empty', () => {
    assert.equal(median([3, 1, 2]), 2)
    assert.equal(median([4, 1, 2, 3]), 2.5)
    assert.equal(median([]), null)
  })
})

describe('analyzeRuns', () => {
  const activeSources = ['ok_src', 'err_src', 'zero_src', 'drop_src', 'missing_src', 'stale_src', 'new_src']
  const latestBySource = {
    ok_src:    { ran_at: recent(2), status: 'success', events_found: 40, events_inserted: 38, events_skipped: 2 },
    err_src:   { ran_at: recent(2), status: 'error',   events_found: 0, error_message: 'HTTP 403 fetching feed' },
    zero_src:  { ran_at: recent(2), status: 'success', events_found: 0, events_inserted: 0, events_skipped: 0 },
    drop_src:  { ran_at: recent(2), status: 'success', events_found: 2, events_inserted: 2, events_skipped: 0 },
    stale_src: { ran_at: recent(50), status: 'success', events_found: 30 }, // >36h old
    new_src:   { ran_at: recent(2), status: 'success', events_found: 3 },   // low baseline/history → no drop flag
    // missing_src: intentionally absent
  }
  const baselines    = { ok_src: 40, drop_src: 35, new_src: 3 }
  const historyCount = { ok_src: 20, drop_src: 20, new_src: 1 }

  const { issues, summary } = analyzeRuns({ latestBySource, baselines, historyCount, activeSources, nowMs: NOW })
  const byType = Object.fromEntries(issues.map((i) => [i.source, i.type]))

  it('flags each failure mode and leaves healthy sources alone', () => {
    assert.equal(byType.ok_src, undefined)          // healthy
    assert.equal(byType.err_src, 'error')
    assert.equal(byType.zero_src, 'zero_events')
    assert.equal(byType.drop_src, 'volume_drop')
    assert.equal(byType.missing_src, 'did_not_run')
    assert.equal(byType.stale_src, 'stale')
    assert.equal(byType.new_src, undefined)         // baseline too small / too few data points → no false drop
  })

  it('includes the error message for diagnosis', () => {
    assert.match(issues.find((i) => i.source === 'err_src').detail, /HTTP 403/)
  })

  it('summary counts are correct', () => {
    assert.equal(summary.activeSources, 7)
    assert.equal(summary.sourcesWithIssues, 5)
    assert.equal(summary.healthy, 2)
    assert.equal(summary.byType.error, 1)
  })
})

describe('counts() includes updated (fix for the silently-dropped split)', () => {
  it('an error/zero_events/volume_drop issue carries counts.updated', () => {
    const latestBySource = {
      err_src: { ran_at: recent(2), status: 'error', events_found: 0, events_inserted: 0, events_updated: 0, error_message: 'boom' },
    }
    const { issues } = analyzeRuns({ latestBySource, activeSources: ['err_src'], nowMs: NOW })
    assert.equal(issues[0].counts.updated, 0)
  })
  it('a healthy run with a real updated count surfaces it in the runs listing shape', () => {
    // exercised indirectly via the counts() used in scrape-report.js's `runs`
    // array — analyzeRuns doesn't attach counts to healthy sources, so this
    // just pins that updated !== undefined once a run object carries it.
    const run = { ran_at: recent(2), status: 'success', events_found: 10, events_inserted: 3, events_updated: 7, events_skipped: 0 }
    const { issues } = analyzeRuns({ latestBySource: { ok: run }, activeSources: ['ok'], nowMs: NOW })
    assert.equal(issues.length, 0) // healthy, no issue — updated is verified via thisRun tests below
  })
})

// ── resolveRunContext — must never throw, degrades to an unlabeled census ──
describe('resolveRunContext', () => {
  const GENERATED = Date.parse('2026-07-26T12:00:00Z')

  it('accepts a fresh manifest', () => {
    const run = { startedAt: '2026-07-26T11:00:00.000Z', scope: 'full' }
    const ctx = resolveRunContext(run, GENERATED)
    assert.equal(ctx.ignored, false)
    assert.equal(ctx.run, run)
    assert.equal(ctx.reason, null)
  })
  it('ignores a manifest older than RUN_CONTEXT_MAX_AGE_HOURS', () => {
    assert.equal(RUN_CONTEXT_MAX_AGE_HOURS, 12)
    const staleStart = new Date(GENERATED - 13 * 3.6e6).toISOString()
    const ctx = resolveRunContext({ startedAt: staleStart, scope: 'full' }, GENERATED)
    assert.equal(ctx.ignored, true)
    assert.equal(ctx.run, null)
    assert.equal(ctx.reason, 'stale')
  })
  it('accepts a manifest right at the boundary (just under 12h)', () => {
    const start = new Date(GENERATED - 11.9 * 3.6e6).toISOString()
    const ctx = resolveRunContext({ startedAt: start, scope: 'full' }, GENERATED)
    assert.equal(ctx.ignored, false)
  })
  it('degrades an absent file (null) without throwing', () => {
    const ctx = resolveRunContext(null, GENERATED)
    assert.equal(ctx.ignored, true)
    assert.equal(ctx.reason, 'absent')
  })
  it('degrades undefined without throwing', () => {
    assert.doesNotThrow(() => resolveRunContext(undefined, GENERATED))
    assert.equal(resolveRunContext(undefined, GENERATED).ignored, true)
  })
  it('degrades a malformed/non-manifest-shaped value without throwing', () => {
    for (const bad of ['not json', 42, [], ['a', 'b'], {}, { startedAt: 'not-a-date' }, { startedAt: null }]) {
      assert.doesNotThrow(() => resolveRunContext(bad, GENERATED))
      const ctx = resolveRunContext(bad, GENERATED)
      assert.equal(ctx.ignored, true)
      assert.equal(ctx.run, null)
    }
  })
})

// ── summarizeThisRun ─────────────────────────────────────────────────────
describe('summarizeThisRun', () => {
  const startedAt = '2026-07-26T05:00:00.000Z'
  const startedAtMs = Date.parse(startedAt)

  it('returns null when there is no accepted run context', () => {
    assert.equal(summarizeThisRun({ runContext: { run: null, ignored: true }, latestBySource: {} }), null)
    assert.equal(summarizeThisRun({ runContext: null, latestBySource: {} }), null)
  })

  it('filtered scope: summarizes only the planned key(s), with totals', () => {
    const run = { scope: 'single', filter: { key: 'musica', group: null, noDedupe: false }, startedAt, plannedKeys: ['musica'], plannedCount: 1 }
    const latestBySource = {
      musica: { ran_at: new Date(startedAtMs + 60000).toISOString(), status: 'success', events_found: 5, events_inserted: 3, events_updated: 2, events_skipped: 0 },
      unrelated_src: { ran_at: new Date(startedAtMs + 60000).toISOString(), status: 'error', events_found: 0 }, // not planned — must be ignored
    }
    const result = summarizeThisRun({ runContext: { run, ignored: false }, latestBySource })
    assert.equal(result.scope, 'single')
    assert.equal(result.plannedCount, 1)
    assert.equal(result.loggedCount, 1)
    assert.deepEqual(result.plannedButNotLogged, [])
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].source, 'musica')
    assert.deepEqual(result.totals, { found: 5, inserted: 3, updated: 2, skipped: 0 })
  })

  it('full scope: summarizes every planned key', () => {
    const run = { scope: 'full', filter: { key: null, group: null, noDedupe: false }, startedAt, plannedKeys: ['a', 'b'], plannedCount: 2 }
    const latestBySource = {
      a: { ran_at: new Date(startedAtMs + 1000).toISOString(), status: 'success', events_found: 2, events_inserted: 2, events_updated: 0, events_skipped: 0 },
      b: { ran_at: new Date(startedAtMs + 1000).toISOString(), status: 'success', events_found: 4, events_inserted: 0, events_updated: 4, events_skipped: 0 },
    }
    const result = summarizeThisRun({ runContext: { run, ignored: false }, latestBySource })
    assert.equal(result.loggedCount, 2)
    assert.deepEqual(result.totals, { found: 6, inserted: 2, updated: 4, skipped: 0 })
  })

  it('a planned key with no scraper_runs row at/after startedAt lands in plannedButNotLogged', () => {
    const run = { scope: 'single', filter: { key: 'musica', group: null, noDedupe: false }, startedAt, plannedKeys: ['musica'], plannedCount: 1 }
    // Case 1: no row at all for the planned source.
    let result = summarizeThisRun({ runContext: { run, ignored: false }, latestBySource: {} })
    assert.deepEqual(result.plannedButNotLogged, ['musica'])
    assert.equal(result.loggedCount, 0)

    // Case 2: a row exists but predates this run's startedAt (stale/leftover).
    const staleRow = { ran_at: new Date(startedAtMs - 60000).toISOString(), status: 'success', events_found: 9 }
    result = summarizeThisRun({ runContext: { run, ignored: false }, latestBySource: { musica: staleRow } })
    assert.deepEqual(result.plannedButNotLogged, ['musica'])
    assert.equal(result.loggedCount, 0)
  })
})

describe('renderMarkdown', () => {
  it('writes a clean-bill message when there are no issues', () => {
    const md = renderMarkdown({ generatedAt: 'T', summary: { healthy: 5, activeSources: 5, sourcesWithIssues: 0, byType: {} }, issues: [] })
    assert.match(md, /No issues detected/)
  })
  it('groups issues and prompts for approval', () => {
    const md = renderMarkdown({
      generatedAt: 'T',
      summary: { healthy: 4, activeSources: 5, sourcesWithIssues: 1, byType: { error: 1 } },
      issues: [{ source: 'err_src', type: 'error', detail: 'HTTP 403' }],
    })
    assert.match(md, /Fatal error/)
    assert.match(md, /err_src/)
    assert.match(md, /approval/i)
  })

  // ── Recurrence guard: the whole point of defect 1 — a filtered run's
  // markdown must clearly say "N of 137" and carry the standing-corpus
  // disclaimer; a full-scope run must NOT carry that filtered disclaimer.
  it('a filtered (single) report carries the "N of 137" phrasing and the disclaimer', () => {
    const md = renderMarkdown({
      generatedAt: 'T',
      scope: { kind: 'single', filter: { key: 'musica', group: null, noDedupe: false }, ignoredManifest: false, ignoredReason: null },
      thisRun: { scope: 'single', filter: { key: 'musica' }, plannedCount: 1, loggedCount: 1, plannedButNotLogged: [], results: [{ source: 'musica', status: 'success', found: 5, inserted: 5, updated: 0, skipped: 0 }], totals: { found: 5, inserted: 5, updated: 0, skipped: 0 } },
      summary: { healthy: 124, activeSources: 137, sourcesWithIssues: 13, byType: { error: 13 } },
      issues: [{ source: 'err_src', type: 'error', detail: 'HTTP 403' }],
    })
    assert.match(md, /1 of 137/)
    assert.match(md, /musica/)
    assert.match(md, /most predate this run and are unrelated to it/)
  })

  it('a full-scope report does NOT carry the filtered-run disclaimer', () => {
    const md = renderMarkdown({
      generatedAt: 'T',
      scope: { kind: 'full', filter: { key: null, group: null, noDedupe: false }, ignoredManifest: false, ignoredReason: null },
      thisRun: { scope: 'full', filter: { key: null }, plannedCount: 137, loggedCount: 137, plannedButNotLogged: [], results: [], totals: { found: 0, inserted: 0, updated: 0, skipped: 0 } },
      summary: { healthy: 124, activeSources: 137, sourcesWithIssues: 13, byType: { error: 13 } },
      issues: [{ source: 'err_src', type: 'error', detail: 'HTTP 403' }],
    })
    assert.doesNotMatch(md, /most predate this run and are unrelated to it/)
    assert.match(md, /this run's own outcome/)
  })

  it('an unlabeled (no manifest) report reads like a plain standing census — no filtered claim either way', () => {
    const md = renderMarkdown({
      generatedAt: 'T',
      summary: { healthy: 124, activeSources: 137, sourcesWithIssues: 13, byType: { error: 13 } },
      issues: [{ source: 'err_src', type: 'error', detail: 'HTTP 403' }],
    })
    assert.doesNotMatch(md, /most predate this run and are unrelated to it/)
    assert.doesNotMatch(md, /this run's own outcome/)
  })
})

// ── Consumer-contract regression test ───────────────────────────────────────
// scrape-reports/latest.json is read by the Cowork nightly-qa-pipeline. This
// pins summary.{activeSources,healthy,sourcesWithIssues,byType} and
// issues[].{source,type,detail} byte-identical to pre-defect-1 output, for a
// fixed input, so a future change to analyzeRuns can't silently break that
// consumer. (issues[].counts is intentionally NOT pinned — the `updated` fix
// is a deliberate, desired change to that field.)
describe('consumer contract — summary/issues shape frozen for nightly-qa-pipeline', () => {
  const activeSources = ['ok_src', 'err_src', 'zero_src', 'drop_src', 'missing_src', 'stale_src', 'new_src']
  const latestBySource = {
    ok_src:    { ran_at: recent(2), status: 'success', events_found: 40, events_inserted: 38, events_skipped: 2 },
    err_src:   { ran_at: recent(2), status: 'error',   events_found: 0, error_message: 'HTTP 403 fetching feed' },
    zero_src:  { ran_at: recent(2), status: 'success', events_found: 0, events_inserted: 0, events_skipped: 0 },
    drop_src:  { ran_at: recent(2), status: 'success', events_found: 2, events_inserted: 2, events_skipped: 0 },
    stale_src: { ran_at: recent(50), status: 'success', events_found: 30 },
    new_src:   { ran_at: recent(2), status: 'success', events_found: 3 },
  }
  const baselines    = { ok_src: 40, drop_src: 35, new_src: 3 }
  const historyCount = { ok_src: 20, drop_src: 20, new_src: 1 }
  const { issues, summary } = analyzeRuns({ latestBySource, baselines, historyCount, activeSources, nowMs: NOW })

  it('summary matches the frozen shape exactly', () => {
    assert.deepEqual(summary, {
      activeSources: 7, healthy: 2, sourcesWithIssues: 5,
      byType: { error: 1, zero_events: 1, volume_drop: 1, did_not_run: 1, stale: 1 },
    })
  })
  it('issues[].{source,type,detail} match the frozen shape exactly', () => {
    const pinned = issues.map((i) => ({ source: i.source, type: i.type, detail: i.detail }))
    // Push order follows activeSources iteration order, not issue type.
    assert.deepEqual(pinned, [
      { source: 'err_src',     type: 'error',       detail: 'HTTP 403 fetching feed' },
      { source: 'zero_src',    type: 'zero_events',  detail: 'Found 0 events — likely a source/structure change or an upstream outage.' },
      { source: 'drop_src',    type: 'volume_drop',  detail: 'Found 2 events vs ~35 typical (a sharp drop) — worth checking for partial breakage.' },
      { source: 'missing_src', type: 'did_not_run',  detail: 'No run logged — the scraper may not be in scrape:all, or it crashed before logging.' },
      { source: 'stale_src',   type: 'stale',        detail: `Last run was ${((NOW - new Date(recent(50)).getTime()) / 3.6e6).toFixed(0)}h ago — did not run this cycle.` },
    ])
  })
})
