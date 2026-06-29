/**
 * scrape-report.js
 *
 * Runs LAST in `npm run scrape:all`. Reads the scraper_runs health log, compares
 * each active source's latest run against the manifest + its own recent history,
 * and writes a run-health report to the gitignored scrape-reports/ folder:
 *
 *   scrape-reports/latest.json            — machine-readable (latest run)
 *   scrape-reports/latest.md              — human summary
 *   scrape-reports/scrape-report-<date>.json — daily archive
 *
 * A nightly scheduled task reads latest.json, surfaces any issues, and proposes
 * fixes for approval. The report flags: fatal errors, zero-event runs, large
 * volume drops vs the source's typical output, and sources that didn't run.
 *
 * Best-effort: never fails the scrape:all chain (always exits 0).
 *
 * Usage:  node scripts/scrape-report.js
 */

import 'dotenv/config'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { ACTIVE_SOURCE_KEYS } from './manifest.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPORT_DIR = join(ROOT, 'scrape-reports')

// Tuning
const HISTORY_DAYS   = 14    // window for "latest run" + baseline
const STALE_HOURS    = 36    // a source whose last run is older than this didn't run this cycle
const BASELINE_MIN   = 5     // only flag a volume drop when the source normally yields ≥ this
const BASELINE_MIN_N = 4     // …and we have at least this many historical data points
const DROP_RATIO     = 0.4   // flag when found < baseline * ratio (a ≥60% drop)

// ── Pure analysis (exported for tests) ──────────────────────────────────────

export function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y)
  if (!a.length) return null
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

const counts = (r) => ({ found: r.events_found ?? 0, inserted: r.events_inserted ?? 0, skipped: r.events_skipped ?? 0 })

/**
 * @param {object} p
 *   latestBySource — { [source]: run }   the most-recent run per source
 *   baselines      — { [source]: number|null }  typical events_found (median of history)
 *   historyCount   — { [source]: number }  how many historical runs informed the baseline
 *   activeSources  — string[]  manifest active source keys
 *   nowMs          — number
 * @returns {{ issues: object[], summary: object }}
 */
export function analyzeRuns({ latestBySource = {}, baselines = {}, historyCount = {}, activeSources = [], nowMs = Date.now() }) {
  const issues = []
  for (const source of activeSources) {
    const run = latestBySource[source]
    if (!run) {
      issues.push({ source, type: 'did_not_run', detail: 'No run logged — the scraper may not be in scrape:all, or it crashed before logging.' })
      continue
    }
    const ageHours = (nowMs - new Date(run.ran_at).getTime()) / 3.6e6
    if (ageHours > STALE_HOURS) {
      issues.push({ source, type: 'stale', detail: `Last run was ${ageHours.toFixed(0)}h ago — did not run this cycle.`, ran_at: run.ran_at })
      continue
    }
    if (run.status === 'error') {
      issues.push({ source, type: 'error', detail: run.error_message || 'Unknown error.', counts: counts(run) })
      continue
    }
    if ((run.events_found ?? 0) === 0) {
      issues.push({ source, type: 'zero_events', detail: 'Found 0 events — likely a source/structure change or an upstream outage.', counts: counts(run) })
      continue
    }
    const base = baselines[source]
    if (base != null && base >= BASELINE_MIN && (historyCount[source] ?? 0) >= BASELINE_MIN_N && run.events_found < base * DROP_RATIO) {
      issues.push({ source, type: 'volume_drop', detail: `Found ${run.events_found} events vs ~${base} typical (a sharp drop) — worth checking for partial breakage.`, counts: counts(run), baseline: base })
    }
  }
  const byType = {}
  for (const i of issues) byType[i.type] = (byType[i.type] || 0) + 1
  return {
    issues,
    summary: {
      activeSources: activeSources.length,
      healthy: activeSources.length - new Set(issues.map((i) => i.source)).size,
      sourcesWithIssues: new Set(issues.map((i) => i.source)).size,
      byType,
    },
  }
}

const TYPE_LABEL = {
  error: '❌ Fatal error', zero_events: '🟡 Zero events', volume_drop: '📉 Volume drop',
  did_not_run: '⚠️ Did not run', stale: '⚠️ Stale (skipped this cycle)',
}

export function renderMarkdown(report) {
  const { generatedAt, summary, issues } = report
  const lines = []
  lines.push(`# Scrape Health Report`, '', `Generated: ${generatedAt}`, '')
  lines.push(`**${summary.healthy}/${summary.activeSources}** sources healthy · **${issues.length}** issue(s) across **${summary.sourcesWithIssues}** source(s)`, '')
  if (!issues.length) {
    lines.push('✅ No issues detected — all active scrapers ran and returned a normal volume of events.')
    return lines.join('\n')
  }
  const order = ['error', 'did_not_run', 'stale', 'zero_events', 'volume_drop']
  for (const type of order) {
    const group = issues.filter((i) => i.type === type)
    if (!group.length) continue
    lines.push(`## ${TYPE_LABEL[type] || type} (${group.length})`, '')
    for (const i of group) lines.push(`- **${i.source}** — ${i.detail}`)
    lines.push('')
  }
  lines.push('---', '_Reviewed nightly. Reply with approval to apply the proposed fixes._')
  return lines.join('\n')
}

// ── Main (IO) ───────────────────────────────────────────────────────────────

async function main() {
  const since = new Date(Date.now() - HISTORY_DAYS * 24 * 3.6e6).toISOString()
  const { data: runs, error } = await supabaseAdmin
    .from('scraper_runs')
    .select('scraper_name,ran_at,status,events_found,events_inserted,events_updated,events_skipped,error_message,duration_ms')
    .gte('ran_at', since)
    .order('ran_at', { ascending: false })
  if (error) throw new Error(`scraper_runs query failed: ${error.message}`)

  const latestBySource = {}
  const history = {}
  for (const r of runs ?? []) {
    if (!latestBySource[r.scraper_name]) latestBySource[r.scraper_name] = r
    else (history[r.scraper_name] ||= []).push(r.events_found ?? 0)  // history EXCLUDING the latest run
  }
  const baselines = {}, historyCount = {}
  for (const [s, vals] of Object.entries(history)) {
    const nonzero = vals.filter((v) => v > 0)
    baselines[s] = median(nonzero)
    historyCount[s] = nonzero.length
  }

  const { issues, summary } = analyzeRuns({ latestBySource, baselines, historyCount, activeSources: ACTIVE_SOURCE_KEYS, nowMs: Date.now() })

  const report = {
    generatedAt: new Date().toISOString(),
    summary,
    issues,
    runs: Object.values(latestBySource)
      .map((r) => ({ source: r.scraper_name, status: r.status, ran_at: r.ran_at, ...counts(r), duration_ms: r.duration_ms, error_message: r.error_message }))
      .sort((a, b) => a.source.localeCompare(b.source)),
  }

  mkdirSync(REPORT_DIR, { recursive: true })
  const json = JSON.stringify(report, null, 2)
  writeFileSync(join(REPORT_DIR, 'latest.json'), json)
  writeFileSync(join(REPORT_DIR, `scrape-report-${report.generatedAt.slice(0, 10)}.json`), json)
  writeFileSync(join(REPORT_DIR, 'latest.md'), renderMarkdown(report))

  console.log(`\n📋  Scrape report: ${issues.length} issue(s) across ${summary.sourcesWithIssues}/${summary.activeSources} source(s) → scrape-reports/latest.md`)
}

main().catch((err) => {
  // Never break the scrape:all chain — the report is best-effort.
  console.warn(`  ⚠ scrape-report failed (non-fatal): ${err.message}`)
  process.exit(0)
})
