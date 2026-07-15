/**
 * check-attribution.js
 *
 * Asserts the attribution invariant against live data:
 *
 *   An aggregator source must carry either the REAL hosting organization or
 *   NO organization at all. It may never name ITSELF as the presenter.
 *
 * WHY THIS EXISTS AS A RUNTIME CHECK: the unit suite (test-attribution-guard.js)
 * proves the guards are correct, but it runs env-less and cannot see the
 * database. Org links reach event_organizations from paths the guards don't
 * cover — the admin UI writes directly (EventEditPage), and a human can link
 * any org to any event. This check is what notices when data drifts anyway,
 * whatever the cause.
 *
 * WHY IT MATTERS: the site renders event_organizations as "Presented by X".
 * A self-credit tells the public that Downtown Akron Partnership or Visit Akron
 * HOSTS an event they merely republish, and sends them the resulting phone
 * calls. That was 171 rows on 2026-07-15.
 *
 * Exits 1 when any violation is found, so it can gate a nightly job.
 *
 * Usage:
 *   node scripts/check-attribution.js
 *   node scripts/check-attribution.js --quiet   (summary only)
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'
import { AGGREGATOR_SELF_ORG, isSelfCredit } from './lib/source-tiers.js'
import { isDapHostedTitle } from './scrape-downtown-akron.js'

const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m'
const DIM = '\x1b[2m', R = '\x1b[0m'

const QUIET = process.argv.includes('--quiet')

/**
 * A self-credit that is legitimate because the aggregator really does host the
 * event. Must mirror the scrapers' own allowlists exactly — if these drift, the
 * check either cries wolf or goes blind.
 */
function isSanctionedSelfCredit(source, title) {
  if (source === 'downtown_akron') return isDapHostedTitle(title)
  return false
}

/**
 * Every event↔organization link, paginated.
 *
 * PostgREST caps a response at 1000 rows and does NOT tell you it truncated —
 * a plain select() here silently checked 1000 of 5562 links and reported a
 * clean bill of health. A blind check is worse than no check, so page
 * explicitly and order by the composite PK: the ordering must be total and
 * stable, or rows straddling a page boundary get skipped between queries
 * (the same trap documented in dedupe-cross-source.js's paging).
 */
async function fetchAllLinks() {
  const PAGE = 1000
  const all = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('event_organizations')
      .select('event_id, organization_id, events!inner(source, title, status, start_at), organizations!inner(name)')
      .order('event_id', { ascending: true })
      .order('organization_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`Query failed: ${error.message}`)
    if (!data?.length) break
    all.push(...data)
    if (data.length < PAGE) break
  }
  return all
}

async function main() {
  console.log('🔍  Checking attribution invariant (aggregators must not self-credit)\n')

  const data = await fetchAllLinks()

  const violations = []
  const sanctioned = []

  for (const row of data ?? []) {
    const source = row.events?.source
    const title  = row.events?.title
    const org    = row.organizations?.name
    if (!isSelfCredit(source, org)) continue
    if (isSanctionedSelfCredit(source, title)) sanctioned.push({ source, title, org })
    else violations.push({ source, title, org, status: row.events?.status })
  }

  if (sanctioned.length > 0 && !QUIET) {
    console.log(`${DIM}Sanctioned self-credits (aggregator genuinely hosts these): ${sanctioned.length}${R}`)
    for (const s of sanctioned) console.log(`${DIM}    ✓ [${s.source}] ${s.title}${R}`)
    console.log('')
  }

  if (violations.length === 0) {
    console.log(`${GREEN}✅  No aggregator self-credits found.${R}`)
    console.log(`${DIM}    Checked ${data?.length ?? 0} event↔organization links against ` +
                `${Object.keys(AGGREGATOR_SELF_ORG).length} aggregator identities.${R}\n`)
    process.exit(0)
  }

  console.log(`${RED}❌  ${violations.length} event(s) credit their own source as presenter${R}\n`)

  const bySource = {}
  for (const v of violations) (bySource[v.source] ??= []).push(v)

  for (const [source, rows] of Object.entries(bySource)) {
    console.log(`  ${YELLOW}${source}${R} → "${rows[0].org}"  ${DIM}(${rows.length} event(s))${R}`)
    if (!QUIET) for (const r of rows.slice(0, 10)) {
      console.log(`      • ${r.title?.slice(0, 60)} ${DIM}[${r.status}]${R}`)
    }
    if (!QUIET && rows.length > 10) console.log(`      ${DIM}…and ${rows.length - 10} more${R}`)
  }

  console.log(`\n  ${DIM}An aggregator must carry the REAL organizer or none at all.${R}`)
  console.log(`  ${DIM}If the scraper produced these, fix the scraper — see AGGREGATOR_SELF_ORG${R}`)
  console.log(`  ${DIM}in src/lib/sourceTiers.js. If a human linked them in the admin UI, either${R}`)
  console.log(`  ${DIM}unlink them or add the series to that scraper's host allowlist.${R}\n`)

  process.exit(1)
}

main().catch(err => {
  console.error(`${RED}Fatal:${R}`, err.message)
  process.exit(1)
})
