/**
 * .claude/agents/*.md ↔ _shared/slack.ts AGENT_IDENTITIES sync test.
 *
 * Tier 2 Slack notifications (`agent_post`) resolve a posted identity
 * (username + avatar) from AGENT_IDENTITIES in supabase/functions/_shared/slack.ts,
 * keyed by AgentId. That registry is meant to have exactly one entry per role
 * file under .claude/agents/ (architect.md, developer.md, code-reviewer.md,
 * qa.md, data-steward.md, analyst.md, support.md) — EXCLUDING README.md,
 * which documents the roles rather than being one itself.
 *
 * Same shape as test-slack-category-labels.js (CATEGORIES ↔ CATEGORY_LABELS)
 * and test-slack-intent-labels.js (INTENTS ↔ INTENT_LABELS): slack.ts is
 * TypeScript running in the Deno edge-function runtime, which this Node test
 * can't import directly, so AGENT_IDENTITIES is extracted textually from the
 * file's source. This test fails CI when a role is added to .claude/agents/
 * without a matching AGENT_IDENTITIES entry, or vice versa.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const agentsDir = path.join(ROOT, '.claude', 'agents')
const roleFiles = fs.readdirSync(agentsDir)
  .filter((f) => f.endsWith('.md') && f !== 'README.md')
  .map((f) => f.replace(/\.md$/, ''))
  .sort()

const src = fs.readFileSync(path.join(ROOT, 'supabase/functions/_shared/slack.ts'), 'utf8')

function section(startMarker, endMarker) {
  const i = src.indexOf(startMarker)
  assert.notEqual(i, -1, `marker not found: ${startMarker}`)
  const j = src.indexOf(endMarker, i)
  assert.notEqual(j, -1, `end marker not found after: ${startMarker}`)
  return src.slice(i, j)
}

const block = section('export const AGENT_IDENTITIES', '\n}')

// Matches lines like: 'architect':     { username: 'Architect',     iconUrl: '...' },
const identityKeys = [...block.matchAll(/'([a-z0-9-]+)':\s*\{\s*username:/g)]
  .map((m) => m[1])
  .sort()

// Same block, but also capturing iconUrl so its basename can be checked
// against public/agents/ on disk (see the describe block below). A rename
// or a missed `-v2.png` version bump would otherwise leave AGENT_IDENTITIES
// pointing at a URL Slack's CDN 404s on — Slack silently falls back to the
// bot's default avatar with no error anywhere, so nothing short of a human
// noticing a wrong avatar in the channel would ever catch it.
const identityIconUrls = [...block.matchAll(/'([a-z0-9-]+)':\s*\{\s*username:\s*'[^']*',\s*iconUrl:\s*'([^']+)'/g)]
  .map((m) => ({ agent: m[1], iconUrl: m[2] }))

describe('.claude/agents/*.md ↔ _shared/slack.ts AGENT_IDENTITIES sync', () => {
  it('parsed a plausible number of role files', () => {
    assert.ok(roleFiles.length > 0, 'found zero role files under .claude/agents/ (excluding README.md) — check the directory/filter')
  })

  it('parsed a plausible number of AGENT_IDENTITIES entries', () => {
    assert.ok(
      identityKeys.length > 0,
      'parsed zero AGENT_IDENTITIES entries — check the marker/regex still match _shared/slack.ts',
    )
  })

  it('every role file has a matching AGENT_IDENTITIES entry', () => {
    const drift = roleFiles.filter((role) => !identityKeys.includes(role))
    assert.deepEqual(drift, [], `role file(s) missing from AGENT_IDENTITIES: ${drift.join(', ')}`)
  })

  it('AGENT_IDENTITIES has no stale entries absent from .claude/agents/', () => {
    const stale = identityKeys.filter((key) => !roleFiles.includes(key))
    assert.deepEqual(stale, [], `stale AGENT_IDENTITIES entries — remove from _shared/slack.ts or add the role file: ${stale.join(', ')}`)
  })

  it('entry counts match exactly', () => {
    assert.equal(
      identityKeys.length, roleFiles.length,
      `AGENT_IDENTITIES has ${identityKeys.length} entries, .claude/agents/ has ${roleFiles.length} role files (excluding README.md) — update both together`,
    )
  })

  it('README.md is excluded from the comparison, not accidentally required', () => {
    assert.equal(roleFiles.includes('README'), false)
    assert.equal(identityKeys.includes('README'), false)
  })

  it('parsed an iconUrl for every AGENT_IDENTITIES entry', () => {
    assert.equal(
      identityIconUrls.length, identityKeys.length,
      `parsed ${identityIconUrls.length} iconUrl(s) but ${identityKeys.length} AGENT_IDENTITIES key(s) — check the iconUrl regex still matches _shared/slack.ts`,
    )
  })

  it('every AGENT_IDENTITIES iconUrl basename exists under public/agents/', () => {
    // Prevention, not detection: filenames match today, but a rename or a
    // missed version bump (e.g. shipping a new avatar under -v2.png without
    // updating this URL, or vice versa) gives every gate a false green while
    // Slack quietly serves the default avatar. Deliberately does NOT modify
    // anything under public/agents/ — read-only existence check.
    const missing = identityIconUrls.filter(({ iconUrl }) => {
      const basename = path.basename(new URL(iconUrl).pathname)
      return !fs.existsSync(path.join(ROOT, 'public', 'agents', basename))
    })
    assert.deepEqual(
      missing,
      [],
      `AGENT_IDENTITIES iconUrl(s) with no matching file under public/agents/: ${missing.map((m) => `${m.agent} -> ${m.iconUrl}`).join(', ')}`,
    )
  })
})
