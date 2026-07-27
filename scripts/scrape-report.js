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
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { ACTIVE_SOURCE_KEYS } from './manifest.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const REPORT_DIR = join(ROOT, 'scrape-reports')
const RUN_MANIFEST_PATH = join(REPORT_DIR, 'run.json')

// Tuning
const HISTORY_DAYS   = 14    // window for "latest run" + baseline
const STALE_HOURS    = 36    // a source whose last run is older than this didn't run this cycle
const BASELINE_MIN   = 5     // only flag a volume drop when the source normally yields ≥ this
const BASELINE_MIN_N = 4     // …and we have at least this many historical data points
const DROP_RATIO     = 0.4   // flag when found < baseline * ratio (a ≥60% drop)

// A run.json older than this (startedAt vs generatedAt) is presumed stale —
// a leftover from a previous local `node run-all.js` invocation rather than
// tonight's run — and is ignored so it can't mislabel a standalone
// `npm run scrape:report` as belonging to a run that happened half a day ago.
export const RUN_CONTEXT_MAX_AGE_HOURS = 12

// ── Pure analysis (exported for tests) ──────────────────────────────────────

export function median(nums) {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y)
  if (!a.length) return null
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2
}

// events_updated was always selected from scraper_runs but silently dropped
// here, so the insert/update split has never been displayed even on the runs
// where it was recorded correctly.
const counts = (r) => ({ found: r.events_found ?? 0, inserted: r.events_inserted ?? 0, updated: r.events_updated ?? 0, skipped: r.events_skipped ?? 0 })

/**
 * Decide whether a run.json provenance manifest should be trusted to label
 * this report, or ignored in favor of an unlabeled corpus census.
 *
 * Never throws: an absent file, a malformed/non-manifest-shaped object, and
 * a too-old manifest all degrade to `{ run: null, ignored: true }` rather
 * than blowing up scrape-report.js's best-effort main(). `runJson` is
 * whatever the caller managed to read+parse (or null/undefined if the read
 * or parse failed) — this function does not do its own file IO so it stays
 * pure and independently testable.
 *
 * @param {object|null|undefined} runJson  — parsed run.json, or null/undefined
 * @param {number} generatedAtMs           — Date.now() of this report
 * @returns {{ run: object|null, ignored: boolean, reason: string|null }}
 */
export function resolveRunContext(runJson, generatedAtMs) {
  if (runJson == null) return { run: null, ignored: true, reason: 'absent' }
  if (typeof runJson !== 'object' || Array.isArray(runJson)) {
    return { run: null, ignored: true, reason: 'malformed' }
  }
  const startedAtMs = Date.parse(runJson.startedAt)
  if (!runJson.startedAt || Number.isNaN(startedAtMs)) {
    return { run: null, ignored: true, reason: 'malformed' }
  }
  const ageHours = (generatedAtMs - startedAtMs) / 3.6e6
  if (ageHours > RUN_CONTEXT_MAX_AGE_HOURS) {
    return { run: null, ignored: true, reason: 'stale' }
  }
  return { run: runJson, ignored: false, reason: null }
}

/**
 * Slice the corpus-wide `latestBySource` down to just what THIS run planned,
 * using the accepted run context from resolveRunContext. A planned source
 * only counts as "this run's" result when its latest scraper_runs row is at
 * or after the run's startedAt — an older row means the source is planned
 * but didn't log (crashed before logging, or scrape:all never reached it).
 *
 * @param {{ runContext: {run:object|null,ignored:boolean}, latestBySource: object }} p
 * @returns {object|null} null when there is no accepted run context
 */
export function summarizeThisRun({ runContext, latestBySource = {} }) {
  if (!runContext?.run || runContext.ignored) return null
  const { run } = runContext
  const startedAtMs = Date.parse(run.startedAt)
  const plannedKeys = run.plannedKeys ?? []

  const results = []
  const plannedButNotLogged = []
  const totals = { found: 0, inserted: 0, updated: 0, skipped: 0 }

  for (const source of plannedKeys) {
    const latest = latestBySource[source]
    const ranAtMs = latest ? Date.parse(latest.ran_at) : NaN
    if (!latest || Number.isNaN(ranAtMs) || ranAtMs < startedAtMs) {
      plannedButNotLogged.push(source)
      continue
    }
    const c = counts(latest)
    results.push({ source, status: latest.status, ran_at: latest.ran_at, ...c })
    totals.found    += c.found
    totals.inserted += c.inserted
    totals.updated  += c.updated
    totals.skipped  += c.skipped
  }

  return {
    scope:        run.scope,
    filter:       run.filter ?? null,
    plannedCount: run.plannedCount ?? plannedKeys.length,
    loggedCount:  results.length,
    plannedButNotLogged,
    results,
    totals,
  }
}

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

/** Human label for a run's filter, e.g. `musica` or `civicplus` — null when unfiltered. */
function filterLabel(filter) {
  return filter?.key || filter?.group || null
}

export function renderMarkdown(report) {
  const { generatedAt, summary, issues, scope = {}, thisRun = null } = report
  const runScope = scope.kind ?? 'unknown' // 'full' | 'group' | 'single' | 'unknown'
  const activeTotal = summary.activeSources
  const isFiltered = runScope === 'single' || runScope === 'group'
  const label = filterLabel(scope.filter)
  const plannedCount = thisRun?.plannedCount ?? null

  const lines = []

  // ── Title ──────────────────────────────────────────────────────────────
  if (isFiltered) {
    lines.push(`# Scrape Health Report — ${plannedCount ?? '?'} of ${activeTotal} sources${label ? ` (\`${label}\`)` : ''}`)
  } else if (runScope === 'full') {
    lines.push(`# Scrape Health Report — full run (${activeTotal} sources)`)
  } else {
    lines.push(`# Scrape Health Report`)
  }
  lines.push('', `Generated: ${generatedAt}`, '')

  // ── Optional "This run" section — only when a run manifest was accepted ──
  if (thisRun) {
    lines.push(`## This run`, '')
    lines.push(`Scope: **${thisRun.scope}**${label ? ` (\`${label}\`)` : ''} — planned **${thisRun.plannedCount}**, logged **${thisRun.loggedCount}**.`, '')
    if (thisRun.results.length) {
      for (const r of thisRun.results) {
        lines.push(`- **${r.source}** — ${r.status} · ${r.inserted} inserted / ${r.updated} updated / ${r.skipped} skipped (found ${r.found})`)
      }
      lines.push('')
    }
    if (thisRun.plannedButNotLogged.length) {
      lines.push(`⚠️ Planned but not logged (no \`scraper_runs\` row at/after this run's start): ${thisRun.plannedButNotLogged.join(', ')}`, '')
    }
    lines.push(`Totals — **${thisRun.totals.inserted}** inserted, **${thisRun.totals.updated}** updated, **${thisRun.totals.skipped}** skipped (found ${thisRun.totals.found}).`, '')
  }

  // ── Corpus health — ALWAYS present. This is the standing 14-day census
  // over every active source, regardless of what ran tonight (also read by
  // the nightly-qa-pipeline for fleet health) — so it must never be scoped
  // down to just the sources that ran. The disclaimer is what stops that
  // full census from being misread as this run's own outcome.
  lines.push(`## Corpus health — all ${activeTotal} active sources`, '')
  if (isFiltered) {
    const n = plannedCount ?? 1
    lines.push(
      `_This run scraped ${n} of ${activeTotal} sources${label ? ` (\`${label}\`)` : ''}. The issues below are the ` +
      `standing health of the whole corpus over the last 14 days — most predate this run and are unrelated to it._`,
      '',
    )
  } else if (runScope === 'full') {
    lines.push(`_This run scraped all ${activeTotal} active sources — the census below reflects this run's own outcome._`, '')
  }

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
  const generatedAtMs = Date.now()

  // Best-effort read of the provenance manifest run-all.js writes. Absent
  // (no run.json — e.g. a standalone `npm run scrape:report`) and malformed
  // (bad JSON) both collapse to null here; resolveRunContext further ignores
  // a manifest that's too old to plausibly be tonight's run.
  let runJson = null
  try {
    runJson = JSON.parse(readFileSync(RUN_MANIFEST_PATH, 'utf8'))
  } catch {
    runJson = null
  }
  const runContext = resolveRunContext(runJson, generatedAtMs)

  const since = new Date(generatedAtMs - HISTORY_DAYS * 24 * 3.6e6).toISOString()
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

  // The census stays full (ALL active sources, unscoped) regardless of what
  // this run planned — see the "Corpus health" comment on renderMarkdown for
  // why: scoping it down would blind the nightly-qa-pipeline, which reads
  // this same latest.json for fleet health.
  const { issues, summary } = analyzeRuns({ latestBySource, baselines, historyCount, activeSources: ACTIVE_SOURCE_KEYS, nowMs: generatedAtMs })

  const thisRun = summarizeThisRun({ runContext, latestBySource })

  const report = {
    schemaVersion: 2,
    generatedAt: new Date(generatedAtMs).toISOString(),
    scope: {
      kind:            runContext.run ? runContext.run.scope : 'unknown',
      filter:          runContext.run ? runContext.run.filter : null,
      ignoredManifest: runContext.ignored,
      ignoredReason:   runContext.reason,
    },
    thisRun,
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

// Run only when invoked directly (`node scripts/scrape-report.js`), matching
// run-all.js's guard. Without this, importing the module (as every test that
// exercises its pure functions does) unconditionally executes main() — a
// real Supabase query and real writes to scrape-reports/*.json — in any
// environment with live credentials in .env, silently breaking the "tests
// never hit the database" contract.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // Never break the scrape:all chain — the report is best-effort.
    console.warn(`  ⚠ scrape-report failed (non-fatal): ${err.message}`)
    process.exit(0)
  })
}
