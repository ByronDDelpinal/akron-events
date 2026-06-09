/**
 * load-moderation-terms.js
 *
 * Seeds the RLS-protected moderation_terms / moderation_allowlist tables (used by
 * the database trigger in migration 030) from the MODERATION_TERMS_B64 env var.
 *
 * The blocklist is never committed; this script is how the env-var list reaches
 * the database. Run it once after applying migration 030, and again whenever you
 * rotate the term list.
 *
 *   node scripts/load-moderation-terms.js      # or: npm run moderation:load
 *
 * Requires (server-side only):
 *   MODERATION_TERMS_B64       — base64 JSON blocklist
 *   SUPABASE_SERVICE_ROLE_KEY  — service role (bypasses RLS to write the tables)
 *   VITE_SUPABASE_URL
 */

import 'dotenv/config'
import { supabaseAdmin } from './lib/supabase-admin.js'

const SEVERITY_RANK = { contextual: 1, high: 2, extreme: 3 }

function loadConfig() {
  const b64 = process.env.MODERATION_TERMS_B64
  if (!b64) {
    console.error('✖ MODERATION_TERMS_B64 is not set. Generate it with `npm run moderation:encode` and set it in your environment.')
    process.exit(1)
  }
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
}

function buildRows(json) {
  // Flatten categories → unique terms, keeping the highest severity per term.
  const byTerm = new Map()
  for (const cat of json.categories ?? []) {
    for (const raw of cat.terms ?? []) {
      const term = String(raw).toLowerCase().trim()
      if (!term) continue
      const kind = /^[a-z0-9]+$/.test(term) ? 'word' : 'phrase'
      const existing = byTerm.get(term)
      if (!existing || SEVERITY_RANK[cat.severity] > SEVERITY_RANK[existing.severity]) {
        byTerm.set(term, { term, severity: cat.severity, kind })
      }
    }
  }
  const terms = [...byTerm.values()]
  const allowlist = [...new Set((json.allowlist?.phrases ?? [])
    .map((p) => String(p).toLowerCase().trim())
    .filter(Boolean))].map((phrase) => ({ phrase }))
  return { terms, allowlist }
}

async function replaceTable(table, rows, conflictCol) {
  // Clear then insert. PostgREST requires a filter on delete; the PK is never null.
  const { error: delErr } = await supabaseAdmin.from(table).delete().not(conflictCol, 'is', null)
  if (delErr) throw new Error(`clearing ${table}: ${delErr.message}`)
  if (rows.length) {
    const { error: insErr } = await supabaseAdmin.from(table).insert(rows)
    if (insErr) throw new Error(`inserting into ${table}: ${insErr.message}`)
  }
}

async function main() {
  const json = loadConfig()
  const { terms, allowlist } = buildRows(json)

  console.log(`🔐  Loading moderation list "${json.version ?? 'unknown'}" → database…`)
  await replaceTable('moderation_terms', terms, 'term')
  await replaceTable('moderation_allowlist', allowlist, 'phrase')

  const counts = terms.reduce((m, t) => ((m[t.severity] = (m[t.severity] ?? 0) + 1), m), {})
  console.log(`✅  Loaded ${terms.length} terms (${JSON.stringify(counts)}) + ${allowlist.length} allowlist phrases.`)
}

main().catch((err) => {
  console.error(`✖ load-moderation-terms failed: ${err.message}`)
  process.exit(1)
})
