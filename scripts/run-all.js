/**
 * run-all.js — Sequential runner for all active scrapers.
 *
 * Replaces the 52-entry `scrape:all` chain in package.json. Source of truth
 * is scripts/manifest.js — adding a scraper there is the only step needed.
 *
 * Usage:
 *   node scripts/run-all.js                     # all active scrapers + dedupe
 *   node scripts/run-all.js --dry-run           # print the run plan, do nothing
 *   node scripts/run-all.js --group civicplus   # run one group only
 *   node scripts/run-all.js --key blu_jazz      # run one scraper by key
 *   node scripts/run-all.js --no-dedupe         # skip dedupe-cross-source --apply
 *   node scripts/run-all.js --max-failures=10   # override the failure threshold
 *
 * Exit codes:
 *   0 — the run is healthy: scraper failures (if any) stayed at or under the
 *       failure threshold AND dedupe (if it ran) succeeded
 *   1 — the run is unhealthy: scraper failures exceeded the threshold, OR
 *       dedupe-cross-source failed. Check output for per-source detail.
 *
 * Failure threshold: with every active scraper in scripts/manifest.js running
 * unattended (well over a hundred independent third-party sources),
 * expecting a fully green run every night is not a useful signal — sources
 * go down transiently and that's normal churn. `--max-failures=<n>` sets an
 * absolute cap; without it, the cap defaults to floor(15% of the plan)
 * scraper failures. A dedupe failure is ALWAYS red regardless of the cap —
 * it isn't part of the per-source noise the threshold exists to filter out.
 */

import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync as _mkdirSync, writeFileSync as _writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

import { ACTIVE_SCRAPERS } from './manifest.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT      = resolve(__dirname, '..')
const NODE      = process.execPath

const DEDUPE_SCRIPT = 'scripts/dedupe-cross-source.js'

// run.json is the provenance manifest scrape-report.js reads to know whether
// (and how) THIS run was filtered, so a `--key`/`--group` run's per-source
// census doesn't get misread as "the run broke 13 things" (see buildRunManifest).
const REPORT_DIR        = resolve(ROOT, 'scrape-reports')
const RUN_MANIFEST_PATH = resolve(REPORT_DIR, 'run.json')

// ── Pure helpers (exported for tests) ────────────────────────────────────────

const DEFAULT_MAX_FAILURES_PCT = 0.15

/** Parse a `--flag=value` style CLI arg out of an argv array. undefined when absent. */
export function parseEqualsFlag(argv, flag) {
  const hit = argv.find((a) => a.startsWith(`${flag}=`))
  return hit ? hit.slice(flag.length + 1) : undefined
}

/**
 * Absolute failure-count threshold for a run of `planLength` scrapers.
 * `override` (from `--max-failures=<n>`) wins when it parses as a
 * non-negative number; otherwise the default is floor(15% of the plan).
 */
export function computeMaxFailures(planLength, override) {
  if (override !== undefined && override !== null && override !== '') {
    const n = Number(override)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return Math.floor(planLength * DEFAULT_MAX_FAILURES_PCT)
}

/**
 * Decide whether run-all should exit non-zero.
 *
 * A dedupe failure is always red: it isn't one of the independent
 * third-party sources the percentage threshold is meant to tolerate noise
 * from, and a broken dedupe pass means duplicate cleanup silently stopped
 * happening. Scraper failures (everything in `failed` other than the
 * literal 'dedupe' sentinel) are compared against the threshold.
 */
export function shouldExitFailure(failed, planLength, maxFailuresOverride) {
  if (failed.includes('dedupe')) return true
  const scraperFailureCount = failed.filter((k) => k !== 'dedupe').length
  return scraperFailureCount > computeMaxFailures(planLength, maxFailuresOverride)
}

// ── CLI parsing ───────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const dryRun   = argv.includes('--dry-run')
  const noDedupe = argv.includes('--no-dedupe')
  const groupArg = argv.find((a, i) => a === '--group' && argv[i + 1])
    ? argv[argv.indexOf('--group') + 1] : null
  const keyArg   = argv.find((a, i) => a === '--key' && argv[i + 1])
    ? argv[argv.indexOf('--key') + 1] : null
  const maxFailuresArg = parseEqualsFlag(argv, '--max-failures')
  return { dryRun, noDedupe, groupArg, keyArg, maxFailuresArg }
}

// ── Run manifest (provenance for scrape-report.js) ────────────────────────────
//
// scrape-report.js's census reads scraper_runs over a 14-day window and grades
// ALL active sources regardless of what ran tonight — that's deliberate (it's
// also the fleet-health view the nightly-qa-pipeline consumes) but it means the
// report has no idea whether tonight's invocation was `--key musica` or the
// full 137-source run. This manifest is the seam: run-all.js is the only thing
// that knows the true plan, so it writes that plan out for the report to read
// and label itself with, instead of a `--key` run reading as "the run broke 13
// things" when those 13 predate it entirely.

/** Identify the CI runner (or lack of one) from env vars, for provenance. */
function deriveRunner(env = process.env) {
  if (env.GITHUB_ACTIONS === 'true') {
    const runId     = env.GITHUB_RUN_ID     ?? null
    const runNumber = env.GITHUB_RUN_NUMBER ?? null
    const url = (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && runId)
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${runId}`
      : null
    return { kind: 'github-actions', runId, runNumber, url }
  }
  return { kind: 'local', runId: null, runNumber: null, url: null }
}

/**
 * Build the run.json provenance manifest. Pure — derives `scope`/`filter` from
 * `argv` via the same `parseArgs` main() uses, so there is exactly one place
 * that decides what a given CLI invocation means. `--key` wins over `--group`
 * when both are given, matching the sequential filtering at the top of main()
 * (group filter applied, then key filter applied on top of it).
 *
 * Called twice by main(): once right after the plan is computed (only
 * `startedAt` and `includesDedupe` are known — this copy survives a mid-run
 * crash, and resolves to `dedupe: 'pending'` rather than optimistically
 * claiming 'ran'), and once more before exit with `finishedAt`/`failedKeys`/
 * `dedupeFailed`/`exitCode` filled in from the completed run. `includesDedupe`
 * (whether dedupe-cross-source.js is on disk and in scope for this run) must
 * be passed both times so a missing script resolves to 'skipped_missing'
 * instead of 'ran'.
 */
export function buildRunManifest({
  argv,
  plan,
  activeCount,
  startedAt,
  finishedAt = null,
  failedKeys = [],
  dedupeFailed = false,
  includesDedupe = false,
  exitCode = null,
  env = process.env,
}) {
  const { groupArg, keyArg, noDedupe } = parseArgs(argv)
  const scope = keyArg ? 'single' : groupArg ? 'group' : 'full'
  const dedupe =
    scope !== 'full'   ? 'skipped_filtered' :
    noDedupe           ? 'skipped_flag' :
    !includesDedupe    ? 'skipped_missing' :
    finishedAt == null ? 'pending' :
    dedupeFailed       ? 'failed' : 'ran'

  return {
    schemaVersion: 1,
    startedAt,
    finishedAt,
    scope,
    filter: { key: keyArg ?? null, group: groupArg ?? null, noDedupe },
    plannedKeys: plan.map((s) => s.key),
    plannedCount: plan.length,
    activeCount,
    failedKeys,
    dedupe,
    exitCode,
    runner: deriveRunner(env),
  }
}

/**
 * Write the run manifest to scrape-reports/run.json. `run-all.js`'s main()
 * has no top-level try/catch, so an unhandled throw here (e.g. mkdirSync
 * failing on a read-only filesystem) would abort the entire scrape before any
 * scraper runs — the manifest is provenance, never worth that. Each write is
 * wrapped individually so a directory-creation failure and a file-write
 * failure both degrade to a warning rather than propagating.
 */
export function writeRunManifest(manifest, {
  mkdirSync    = _mkdirSync,
  writeFileSync = _writeFileSync,
  dir          = REPORT_DIR,
  path         = RUN_MANIFEST_PATH,
} = {}) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    console.warn(`  ⚠ Could not create ${dir} for run manifest (non-fatal): ${err.message}`)
    return
  }
  try {
    writeFileSync(path, JSON.stringify(manifest, null, 2))
  } catch (err) {
    console.warn(`  ⚠ Could not write run manifest (non-fatal): ${err.message}`)
  }
}

// ── Edge-cache invalidation ───────────────────────────────────────────────────
// The homepage AND every category/neighborhood/city hub first page are
// CDN-cached by Vercel, all carrying the shared `events` cache tag (set in
// api/events-first-page.js and api/events-hub.js). Purging that one tag here
// busts the whole set, so fresh scrape results reach visitors on the very
// next request instead of waiting out the (now 8h) s-maxage window.
//
// Deliberately non-fatal: the cache self-heals via its TTL, so a purge
// hiccup should never mark a successful scrape run as failed. Skipped
// silently when the Vercel env vars aren't present (local dev, CI).
//
// Requires in .env:
//   VERCEL_TOKEN        — access token with cache-purge permission
//   VERCEL_PROJECT_ID   — project id (or name) on Vercel
//   VERCEL_TEAM_ID      — only if the project lives under a team
async function invalidateEventsCache() {
  const token   = process.env.VERCEL_TOKEN
  const project = process.env.VERCEL_PROJECT_ID
  if (!token || !project) {
    console.log('\nℹ  Skipping CDN cache invalidation (VERCEL_TOKEN / VERCEL_PROJECT_ID not set)')
    return
  }

  const params = new URLSearchParams({ projectIdOrName: project })
  if (process.env.VERCEL_TEAM_ID) params.set('teamId', process.env.VERCEL_TEAM_ID)

  try {
    const res = await fetch(
      `https://api.vercel.com/v1/edge-cache/invalidate-by-tags?${params}`,
      {
        method: 'POST',
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        // The shared tag every cached events response carries — one purge
        // busts the homepage first page and all hub first pages.
        body: JSON.stringify({ tags: 'events', target: 'production' }),
      },
    )
    if (res.ok) {
      console.log('\n🧹  CDN cache invalidated (events)')
    } else {
      console.warn(`\n⚠   CDN cache invalidation returned ${res.status} — cache will self-heal within its TTL`)
    }
  } catch (err) {
    console.warn(`\n⚠   CDN cache invalidation failed (${err?.message}) — cache will self-heal within its TTL`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const { dryRun, noDedupe, groupArg, keyArg, maxFailuresArg } = parseArgs(args)

  let plan = ACTIVE_SCRAPERS
  if (groupArg) plan = plan.filter((s) => s.group === groupArg)
  if (keyArg)   plan = plan.filter((s) => s.key   === keyArg)

  // Always run deduplication last (unless filtering to a specific scraper,
  // or explicitly skipped with --no-dedupe).
  const includesDedupe = !keyArg && !groupArg && !noDedupe && existsSync(resolve(ROOT, DEDUPE_SCRIPT))

  if (dryRun) {
    console.log(`\n📋  Run plan (${plan.length} scraper${plan.length !== 1 ? 's' : ''}):\n`)
    for (const s of plan) {
      console.log(`  [${s.group.padEnd(12)}]  ${s.key.padEnd(28)}  ${s.script}`)
    }
    if (includesDedupe) console.log(`\n  [post-run   ]  dedupe-cross-source        ${DEDUPE_SCRIPT} --apply`)
    else if (noDedupe)  console.log('\n  [post-run   ]  dedupe-cross-source        SKIPPED (--no-dedupe)')
    console.log(`\n  Failure threshold: ${computeMaxFailures(plan.length, maxFailuresArg)} scraper failure(s) allowed before exit 1${maxFailuresArg !== undefined ? ' (from --max-failures)' : ' (default 15% of plan)'}`)
    console.log()
    process.exit(0)
  }

  const failed  = []
  const start   = Date.now()
  const startedAt = new Date(start).toISOString()

  // First write: provenance survives a mid-run crash (no top-level try/catch
  // below — see writeRunManifest's own doc comment for why every write here
  // is individually guarded rather than allowed to throw).
  writeRunManifest(buildRunManifest({
    argv: args, plan, activeCount: ACTIVE_SCRAPERS.length, startedAt, includesDedupe,
  }))

  console.log(`\n🚀  run-all — ${plan.length} scraper${plan.length !== 1 ? 's' : ''}\n`)

  for (const scraper of plan) {
    const scriptPath = resolve(ROOT, scraper.script)
    if (!existsSync(scriptPath)) {
      console.warn(`  ⚠  Script not found, skipping: ${scraper.script}`)
      failed.push(scraper.key)
      continue
    }

    console.log(`\n${'─'.repeat(60)}`)
    console.log(`▶  ${scraper.label} (${scraper.key})`)
    console.log(`${'─'.repeat(60)}`)

    try {
      execFileSync(NODE, [scriptPath], {
        stdio:  'inherit',
        env:    process.env,
        cwd:    ROOT,
      })
    } catch {
      console.error(`\n✗  ${scraper.key} FAILED`)
      failed.push(scraper.key)
      // Continue with remaining scrapers — don't abort the whole run.
    }
  }

  // Post-run deduplication
  if (includesDedupe) {
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`▶  Cross-source deduplication`)
    console.log(`${'─'.repeat(60)}`)
    try {
      execFileSync(NODE, [resolve(ROOT, DEDUPE_SCRIPT), '--apply'], {
        stdio: 'inherit', env: process.env, cwd: ROOT,
      })
    } catch {
      console.error('\n✗  dedupe-cross-source FAILED')
      failed.push('dedupe')
    }
  } else if (noDedupe) {
    console.log('\nℹ  Skipping dedupe-cross-source (--no-dedupe)')
  }

  await invalidateEventsCache()

  // ── Summary ───────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - start) / 1000 / 60).toFixed(1)
  const exitFailure  = shouldExitFailure(failed, plan.length, maxFailuresArg)
  const maxFailures  = computeMaxFailures(plan.length, maxFailuresArg)

  console.log(`\n${'═'.repeat(60)}`)
  if (failed.length === 0) {
    console.log(`✅  All ${plan.length} scrapers completed in ${elapsed}m`)
  } else {
    console.log(`⚠   ${plan.length - failed.length}/${plan.length} scrapers succeeded in ${elapsed}m`)
    console.log(`    Failed: ${failed.join(', ')}`)
    if (exitFailure) {
      const reason = failed.includes('dedupe')
        ? 'dedupe-cross-source failed'
        : `scraper failures exceeded the threshold (${failed.filter((k) => k !== 'dedupe').length} > ${maxFailures})`
      console.log(`    ✗  Exiting 1: ${reason}`)
    } else {
      console.log(`    ✓  Within failure threshold (${failed.filter((k) => k !== 'dedupe').length} <= ${maxFailures}) — exiting 0`)
    }
  }
  console.log('═'.repeat(60))

  // Second write: fill in the outcome now that the run (and dedupe) finished.
  writeRunManifest(buildRunManifest({
    argv: args, plan, activeCount: ACTIVE_SCRAPERS.length, startedAt, includesDedupe,
    finishedAt:   new Date().toISOString(),
    failedKeys:   failed.filter((k) => k !== 'dedupe'),
    dedupeFailed: failed.includes('dedupe'),
    exitCode:     exitFailure ? 1 : 0,
  }))

  process.exit(exitFailure ? 1 : 0)
}

// Run only when invoked directly (`node scripts/run-all.js`); importing the
// module (tests) must never kick off scraper execution or process.exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
