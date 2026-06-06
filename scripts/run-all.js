/**
 * run-all.js — Sequential runner for all active scrapers.
 *
 * Replaces the 52-entry `scrape:all` chain in package.json. Source of truth
 * is scripts/manifest.js — adding a scraper there is the only step needed.
 *
 * Usage:
 *   node scripts/run-all.js                  # all active scrapers + dedupe
 *   node scripts/run-all.js --dry-run        # print the run plan, do nothing
 *   node scripts/run-all.js --group civicplus # run one group only
 *   node scripts/run-all.js --key blu_jazz   # run one scraper by key
 *
 * Exit codes:
 *   0 — all scrapers succeeded
 *   1 — one or more scrapers failed (check output for details)
 */

import 'dotenv/config'
import { execFileSync } from 'node:child_process'
import { existsSync }   from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { ACTIVE_SCRAPERS } from './manifest.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT      = resolve(__dirname, '..')
const NODE      = process.execPath

// ── CLI parsing ───────────────────────────────────────────────────────────────

const args     = process.argv.slice(2)
const dryRun   = args.includes('--dry-run')
const groupArg = args.find((a, i) => a === '--group' && args[i + 1])
  ? args[args.indexOf('--group') + 1] : null
const keyArg   = args.find((a, i) => a === '--key' && args[i + 1])
  ? args[args.indexOf('--key') + 1] : null

// ── Build the run plan ────────────────────────────────────────────────────────

let plan = ACTIVE_SCRAPERS

if (groupArg) plan = plan.filter((s) => s.group === groupArg)
if (keyArg)   plan = plan.filter((s) => s.key   === keyArg)

// Always run deduplication last (unless filtering to a specific scraper).
const DEDUPE_SCRIPT = 'scripts/dedupe-cross-source.js'
const includesDedupe = !keyArg && !groupArg && existsSync(resolve(ROOT, DEDUPE_SCRIPT))

// ── Execute ───────────────────────────────────────────────────────────────────

if (dryRun) {
  console.log(`\n📋  Run plan (${plan.length} scraper${plan.length !== 1 ? 's' : ''}):\n`)
  for (const s of plan) {
    console.log(`  [${s.group.padEnd(12)}]  ${s.key.padEnd(28)}  ${s.script}`)
  }
  if (includesDedupe) console.log(`\n  [post-run   ]  dedupe-cross-source        ${DEDUPE_SCRIPT} --apply`)
  console.log()
  process.exit(0)
}

const failed  = []
const start   = Date.now()

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
}

// ── Summary ───────────────────────────────────────────────────────────────────

const elapsed = ((Date.now() - start) / 1000 / 60).toFixed(1)
console.log(`\n${'═'.repeat(60)}`)
if (failed.length === 0) {
  console.log(`✅  All ${plan.length} scrapers completed in ${elapsed}m`)
} else {
  console.log(`⚠   ${plan.length - failed.length}/${plan.length} scrapers succeeded in ${elapsed}m`)
  console.log(`    Failed: ${failed.join(', ')}`)
}
console.log('═'.repeat(60))

process.exit(failed.length > 0 ? 1 : 0)
