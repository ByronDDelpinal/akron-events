/**
 * test-scrape-report.js — pure analysis for the scrape:all run-health report.
 *
 * Run:  node --test scripts/tests/test-scrape-report.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const { analyzeRuns, median, renderMarkdown } = await import('../scrape-report.js')

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
})
