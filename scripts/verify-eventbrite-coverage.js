/**
 * verify-eventbrite-coverage.js
 *
 * Reports which "known Akron organizations that publish to Eventbrite"
 * are currently flowing through the citywide Eventbrite geo-feed scraper
 * vs. which appear to be missing.
 *
 * Use this to decide whether a per-source scraper is actually needed, or
 * whether the existing `scrape-eventbrite.js` (Akron geo search) is
 * already capturing the organization's events.
 *
 * Usage:
 *   node scripts/verify-eventbrite-coverage.js
 *   node scripts/verify-eventbrite-coverage.js --org-id 75403967663   # one org
 *   node scripts/verify-eventbrite-coverage.js --days 90              # lookback
 *
 * Required .env vars:
 *   VITE_SUPABASE_URL         — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'

// ── Organizations worth verifying ─────────────────────────────────────────
// Each entry has:
//   name        — canonical org name to match against organizations.name
//   orgId       — Eventbrite organizer numeric ID (from eventbrite.com/o/NAME-ID)
//   aliases     — additional name variants to match (case-insensitive substring)
//   note        — why we care
//
// When adding new orgs, the orgId is what appears in the URL after the org
// page slug, e.g.  eventbrite.com/o/the-matinee-115017075871  →  115017075871

const TARGET_ORGS = [
  {
    name:    'The Matinee',
    orgId:   '115017075871',
    aliases: ['matinee'],
    note:    'Music venue — high event volume',
  },
  {
    name:    'Summit County Historical Society',
    orgId:   '7983656113',
    aliases: ['summit historical', 'summit county historical'],
    note:    'Monthly programs + seasonal signature events',
  },
  {
    name:    'Bounce Innovation Hub',
    orgId:   '18686428731',
    aliases: ['bounce innovation', 'bouncehub', 'bounce hub'],
    note:    'I-Pitch + Creative Exchange programming',
  },
  {
    name:    'Akron Black Artist Guild',
    orgId:   '32981973935',
    aliases: ['abaguild', 'black artist guild', 'akron black artist'],
    note:    'Active arts org',
  },
  {
    name:    'Interbelt Nite Club',
    orgId:   '106311661571',
    aliases: ['interbelt'],
    note:    'Music venue',
  },
  {
    name:    'Black Chamber of Commerce Summit County',
    orgId:   '102626988151',
    aliases: ['black chamber', 'blackchambersc'],
    note:    'Business networking — newly launched',
  },
  {
    name:    'The Green Dragon Inn',
    orgId:   '75403967663',
    aliases: ['green dragon'],
    note:    'Board game bar with regular programming',
  },
  {
    name:    'House Three Thirty',
    orgId:   '61445316323',
    aliases: ['house three thirty', 'h330', 'house 330'],
    note:    'Monthly R&B, poetry, markets, concerts',
  },
  {
    name:    'Akron-Canton Regional Foodbank',
    orgId:   '9038926658',
    aliases: ['akron-canton regional foodbank', 'akron canton food bank', 'foodbank'],
    note:    'Pop-up pantries, Harvest for Hunger',
  },
  {
    name:    'BLU-Tique Hotel',
    orgId:   null,  // verify — org page URL to be confirmed
    aliases: ['blu-tique', 'blutique', 'blu tique'],
    note:    'Hybrid: Eventbrite tickets + custom entertainment calendar',
  },
]

// ── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const onlyOrgId = args.includes('--org-id') ? args[args.indexOf('--org-id') + 1] : null
const daysArg   = args.includes('--days')   ? parseInt(args[args.indexOf('--days') + 1], 10) : 120
const LOOKBACK_DAYS = Number.isFinite(daysArg) && daysArg > 0 ? daysArg : 120

// ── Queries ───────────────────────────────────────────────────────────────

async function countRecentEventbriteEvents() {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString()
  const { count, error } = await supabaseAdmin
    .from('events')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'eventbrite')
    .gt('start_at', cutoff)
  if (error) throw new Error(`Count query failed: ${error.message}`)
  return count ?? 0
}

/**
 * Find events joined to a named organization via event_organizations.
 * Uses an org name filter (case-insensitive exact or ilike) rather than
 * requiring the Eventbrite ticket_url to contain the orgId, because many
 * events land under their venue organizer and only match via the org table.
 */
async function findEventsByOrg(target) {
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString()

  // 1. Resolve organization IDs — by name and by aliases
  const nameFilters = [target.name, ...(target.aliases || [])]
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)

  let orgIds = []
  {
    const { data, error } = await supabaseAdmin
      .from('organizations')
      .select('id, name')
      // Build an OR chain across name ilikes — Supabase OR syntax
      .or(nameFilters.map(n => `name.ilike.%${n}%`).join(','))
    if (error) throw new Error(`Org lookup failed: ${error.message}`)
    orgIds = (data ?? []).map(r => ({ id: r.id, matched: r.name }))
  }

  if (orgIds.length === 0) {
    return { orgIds: [], directEventCount: 0, urlMatchCount: 0 }
  }

  // 2. Count events in junction table for those orgs, from source=eventbrite only
  const { count: directEventCount, error: joinErr } = await supabaseAdmin
    .from('event_organizations')
    .select('event_id, events!inner(id, source, start_at)', { count: 'exact', head: true })
    .in('organization_id', orgIds.map(o => o.id))
    .eq('events.source', 'eventbrite')
    .gt('events.start_at', cutoff)

  if (joinErr) {
    // Fallback: older schema may not support the inner join syntax — just count by org
    return { orgIds, directEventCount: null, urlMatchCount: 0 }
  }

  // 3. Secondary signal — ticket URLs that contain the orgId
  let urlMatchCount = 0
  if (target.orgId) {
    const { count, error: urlErr } = await supabaseAdmin
      .from('events')
      .select('id', { count: 'exact', head: true })
      .eq('source', 'eventbrite')
      .ilike('ticket_url', `%${target.orgId}%`)
      .gt('start_at', cutoff)
    if (!urlErr) urlMatchCount = count ?? 0
  }

  return { orgIds, directEventCount: directEventCount ?? 0, urlMatchCount }
}

async function latestEventbriteRun() {
  const { data, error } = await supabaseAdmin
    .from('scraper_runs')
    .select('ran_at, status, events_inserted, events_updated, events_skipped, duration_ms, error_message')
    .eq('scraper_name', 'eventbrite')
    .order('ran_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return null
  return data
}

// ── Report ────────────────────────────────────────────────────────────────

function fmt(n) { return n == null ? '—' : String(n) }

async function main() {
  console.log('🔎  Eventbrite geo-feed coverage report')
  console.log('    Lookback window:', LOOKBACK_DAYS, 'days')
  console.log('    Criteria: events with source="eventbrite" where either')
  console.log('      (a) event_organizations matches a target org name/alias, or')
  console.log('      (b) ticket_url contains the target Eventbrite org ID\n')

  try {
    const total = await countRecentEventbriteEvents()
    console.log(`📊  Total source="eventbrite" events in window: ${total}\n`)

    const lastRun = await latestEventbriteRun()
    if (lastRun) {
      const age = Math.round((Date.now() - new Date(lastRun.ran_at).getTime()) / 3_600_000)
      console.log(`🕒  Last Eventbrite scraper run: ${lastRun.ran_at} (${age}h ago) — ${lastRun.status}`)
      console.log(`    inserted=${lastRun.events_inserted}  updated=${lastRun.events_updated}  skipped=${lastRun.events_skipped}`)
      if (lastRun.error_message) console.log(`    error: ${lastRun.error_message}`)
      console.log('')
    } else {
      console.log('🕒  No scraper_runs rows found for "eventbrite"\n')
    }

    // Per-org verification
    const results = []
    const targets = onlyOrgId
      ? TARGET_ORGS.filter(t => t.orgId === onlyOrgId)
      : TARGET_ORGS

    if (targets.length === 0) {
      console.log(`⚠  No target org found matching --org-id ${onlyOrgId}`)
      process.exit(1)
    }

    for (const t of targets) {
      const r = await findEventsByOrg(t)
      results.push({ target: t, ...r })
    }

    console.log('Org coverage (by org name/alias match + ticket URL match):')
    console.log('─'.repeat(92))
    console.log('Status  Org                                             Direct  URL     Matched orgs')
    console.log('─'.repeat(92))
    let missing = 0, covered = 0, unknown = 0
    for (const { target, orgIds, directEventCount, urlMatchCount } of results) {
      const hits = (directEventCount ?? 0) + (urlMatchCount ?? 0)
      const matchedNames = orgIds.map(o => o.matched).join(', ') || '(no org row)'
      const status = hits > 0 ? '✅ OK '
                    : orgIds.length === 0 ? '❔ NEW'
                    : '⚠ MISS'
      if      (hits > 0)            covered++
      else if (orgIds.length === 0) unknown++
      else                          missing++
      console.log(
        `${status}  ${target.name.padEnd(46)} ${String(fmt(directEventCount)).padStart(6)}  ${String(urlMatchCount).padStart(6)}  ${matchedNames.slice(0, 28)}`
      )
    }
    console.log('─'.repeat(92))
    console.log(`\n✅  covered: ${covered}   ⚠  missing: ${missing}   ❔  new (no org row yet): ${unknown}\n`)

    if (missing > 0) {
      console.log('Recommendation: for each ⚠ MISS row, decide whether to:')
      console.log('  1. Widen the Akron Eventbrite geo-search (scrape-eventbrite.js) — or')
      console.log('  2. Add an explicit per-organizer fetch using the Eventbrite org ID.')
    }
    if (unknown > 0) {
      console.log('❔ NEW rows have no matching organizations table entry yet — they may not')
      console.log('   have appeared in any scrape yet, or the org name in our DB differs.')
    }

  } catch (err) {
    console.error('\n❌  Verification failed:', err.message)
    process.exit(1)
  }
}

main()
