/**
 * backfill-family-veto.js
 *
 * One-time cleanup companion to the family-facet safety veto shipped in
 * scripts/lib/category-inference.js (`familySafetyVeto`) and
 * scripts/lib/normalize.js (`resolveFamilyFacet`). See
 * docs/family-facet-safety-veto.md (gitignored — not shipped with the repo;
 * the load-bearing rationale is in code comments next to the veto instead).
 *
 * Incident (2026-08-03): "Baby Doe" (Nightlight Cinema) was flagged
 * `is_family = true` and shown to families; that row is already fixed by
 * hand with a `manual_overrides.is_family` stamp. This script finds anything
 * ELSE already live that the veto would now catch, so the maintainer can
 * review and clear it — same shape of problem, before the resolve-layer fix
 * shipped.
 *
 * Scope, deliberately narrow — a wrong flag is only visible, and only worth
 * touching, when ALL of:
 *   status = 'published'
 *   AND is_family = true
 *   AND start_at >= now()                      -- past events are invisible
 *                                                  in every feed (.gte filter)
 *   AND NOT (manual_overrides ? 'is_family')    -- never touch a human decision
 *
 * DRY RUN BY DEFAULT. Pass --write to clear `is_family` on the proposed rows.
 * Every candidate is printed (title, source, id, matched terms) so the whole
 * list is small enough to eyeball before writing anything.
 *
 * Hard `--max-updates` cap (default 50) that REFUSES the run (nonzero exit)
 * rather than truncating when the plan is larger — same discipline as
 * dedupe-cross-source.js's `--max-deletes` gate: a plan this large is more
 * likely a lexicon bug than a genuine backfill, and there is no flag to raise
 * the cap in the field. Review the printed plan by hand first.
 *
 * Never stamps `manual_overrides`. The next scrape re-derives `false` through
 * the same veto — it lives at the resolve layer and covers structured
 * sources too — so a pin here would be redundant state that freezes the row
 * against future lexicon improvements. Sustainable through re-scrape.
 *
 * The maintainer runs this by hand, once, after the veto has shipped and one
 * nightly scrape has proven the new path in production logs. It is never
 * wired into run-all.js, scrape:all, or any scheduled workflow — DO NOT add
 * it to either without maintainer sign-off.
 *
 * Usage:
 *   node scripts/backfill-family-veto.js                       # dry run
 *   node scripts/backfill-family-veto.js --write                # write
 *   node scripts/backfill-family-veto.js --max-updates=20 --write
 *
 * Env: VITE_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

import { pathToFileURL } from 'node:url'
import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { familySafetyVeto } from './lib/category-inference.js'

const DEFAULT_MAX_UPDATES = 50

/**
 * True when a row is eligible for this backfill: it must not carry a human
 * `manual_overrides.is_family` lock. Exported for tests. The override marker
 * shape is inconsistent in the wild ({at: ISO} from the admin UI, bare `true`
 * from older stamps) — `'is_family' in overrides` covers both, the same way
 * `_stripOverriddenFields` in normalize.js only inspects keys.
 */
export function isEligible(event) {
  const ov = event?.manual_overrides
  return !(ov && typeof ov === 'object' && 'is_family' in ov)
}

/**
 * Pure candidate selection: given rows already scoped to published + future +
 * is_family = true, return the subset the veto now fires on, each paired
 * with the veto's verdict. Never touches a manual_overrides-locked row.
 * Exported for tests. `veto` is injectable so tests don't need the real
 * lexicon to exercise the eligibility/shape logic.
 */
export function findVetoCandidates(events, veto = familySafetyVeto) {
  const out = []
  for (const event of events ?? []) {
    if (!isEligible(event)) continue
    const verdict = veto(event.title, event.description)
    if (verdict) out.push({ event, verdict })
  }
  return out
}

function parseArgs(argv) {
  const write = argv.includes('--write')
  const maxArg = (argv.find((a) => a.startsWith('--max-updates=')) || '').split('=')[1]
  const maxUpdates = maxArg !== undefined ? parseInt(maxArg, 10) : DEFAULT_MAX_UPDATES
  return { write, maxUpdates }
}

async function main() {
  const { write, maxUpdates } = parseArgs(process.argv.slice(2))
  console.log(`🛡  Family-veto backfill — ${write ? 'WRITE' : 'dry run'} (cap ${maxUpdates})`)

  const nowIso = new Date().toISOString()
  const candidates = []
  const PAGE = 1000
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('events')
      .select('id, title, description, source, start_at, manual_overrides')
      .eq('status', 'published')
      .eq('is_family', true)
      .gte('start_at', nowIso)
      .range(from, from + PAGE - 1)
    if (error) { console.error(`  ✗ query failed: ${error.message}`); process.exit(1) }
    if (!data?.length) break
    candidates.push(...data)
    if (data.length < PAGE) break
  }

  const plan = findVetoCandidates(candidates)

  console.log(`  ${candidates.length} published/future/is_family=true row(s) scanned`)
  console.log(`  ${plan.length} candidate(s) the veto now fires on`)
  for (const { event, verdict } of plan) {
    console.log(`    - [${verdict.rule}] "${event.title}" (${event.source}, ${event.id}) — ${verdict.terms.join(', ')}`)
  }

  if (plan.length === 0) {
    console.log('\n✅  Nothing to do.')
    return
  }

  if (plan.length > maxUpdates) {
    console.error(`\n✗  Cap exceeded: ${plan.length} candidate(s) vs cap ${maxUpdates}. Refusing to run — nothing written.`)
    console.error(`   The cap is a confidence gate, not a throttle: a plan this large is more likely a lexicon`)
    console.error(`   bug than a genuine backfill (same discipline as dedupe-cross-source.js's --max-deletes).`)
    console.error(`   Do not raise --max-updates to clear this. Review the plan printed above by hand first.`)
    process.exit(1)
  }

  if (!write) {
    console.log(`\n(dry run — pass --write to clear is_family on these ${plan.length} row(s))`)
    return
  }

  let updated = 0
  for (const { event } of plan) {
    const { error } = await supabaseAdmin
      .from('events')
      .update({ is_family: false })
      .eq('id', event.id)
    if (error) {
      console.error(`  ✗ update failed for ${event.id}: ${error.message}`)
      continue
    }
    updated++
  }
  console.log(`\n✅  Cleared is_family on ${updated}/${plan.length} row(s). No manual_overrides stamp written —`)
  console.log(`   the next scrape re-derives false through the same veto.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
