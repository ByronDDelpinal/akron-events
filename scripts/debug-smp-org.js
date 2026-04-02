/**
 * Quick diagnostic: check if Summit Metro Parks exists as an organization
 * and whether its venues are properly linked.
 *
 * Usage: node scripts/debug-smp-org.js
 */
import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'

async function main() {
  console.log('=== Organization Check ===')

  // 1. Check if "Summit Metro Parks" exists in organizations
  const { data: orgs, error: orgErr } = await supabaseAdmin
    .from('organizations')
    .select('id, name, website, status, created_at')
    .ilike('name', '%summit%metro%')

  if (orgErr) {
    console.error('Error querying organizations:', orgErr.message)
  } else if (orgs.length === 0) {
    console.log('❌ No organization matching "Summit Metro Parks" found.')
  } else {
    console.log(`✅ Found ${orgs.length} matching organization(s):`)
    for (const o of orgs) {
      console.log(`   id=${o.id}  name="${o.name}"  status=${o.status}  created=${o.created_at}`)
    }
  }

  // 2. List ALL organizations to see what's there
  const { data: allOrgs, error: allErr } = await supabaseAdmin
    .from('organizations')
    .select('id, name, status')
    .order('name')

  if (allErr) {
    console.error('Error listing all orgs:', allErr.message)
  } else {
    console.log(`\n=== All Organizations (${allOrgs.length}) ===`)
    for (const o of allOrgs) {
      console.log(`   "${o.name}" (status=${o.status})`)
    }
  }

  // 3. Check venues with organization_id set
  const { data: linkedVenues, error: vErr } = await supabaseAdmin
    .from('venues')
    .select('id, name, organization_id')
    .not('organization_id', 'is', null)
    .order('name')

  if (vErr) {
    console.error('Error querying linked venues:', vErr.message)
  } else {
    console.log(`\n=== Venues with organization_id set (${linkedVenues.length}) ===`)
    for (const v of linkedVenues) {
      console.log(`   "${v.name}" → org_id=${v.organization_id}`)
    }
  }

  // 4. Check venues with "park" or "trail" in the name that should be SMP
  const { data: parkVenues } = await supabaseAdmin
    .from('venues')
    .select('id, name, organization_id')
    .or('name.ilike.%park%,name.ilike.%trail%,name.ilike.%falls%,name.ilike.%metro%')
    .order('name')

  console.log(`\n=== Park-related venues (${parkVenues?.length ?? 0}) ===`)
  for (const v of (parkVenues ?? [])) {
    console.log(`   "${v.name}" → org_id=${v.organization_id ?? 'NULL'}`)
  }

  // 5. Check event_organizations for summit metro parks events
  const { data: smpEvents } = await supabaseAdmin
    .from('events')
    .select('id, title, source, source_id')
    .eq('source', 'summit_metro_parks')
    .limit(5)

  console.log(`\n=== Sample summit_metro_parks events (${smpEvents?.length ?? 0}) ===`)
  for (const e of (smpEvents ?? [])) {
    // Check if this event has org links
    const { data: links } = await supabaseAdmin
      .from('event_organizations')
      .select('organization_id')
      .eq('event_id', e.id)
    console.log(`   "${e.title}" → org links: ${links?.map(l => l.organization_id).join(', ') || 'NONE'}`)
  }
}

main().catch(console.error)
