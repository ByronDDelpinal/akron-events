/**
 * test-send-digest-schema.js
 *
 * Guards against the class of bug where a DB migration changes the events
 * table schema (adding or dropping columns) but the send-digest edge function
 * is not updated — causing silent 500s on every cron run until someone
 * notices the emails stopped.
 *
 * Both tests are pure static analysis: they parse migration SQL files and
 * the edge function TypeScript source. No DB connection, no env vars needed.
 *
 * Test 1 — Select columns vs schema
 *   Derives the current `events` table column set by replaying every
 *   CREATE TABLE, ADD COLUMN, and DROP COLUMN statement across all migrations.
 *   Asserts that every top-level column name in send-digest's
 *   `supabase.from('events').select(...)` call exists in that derived set.
 *
 * Test 2 — Category maps vs constraint
 *   Finds the CHECK constraint on `event_categories.category` (the source of
 *   truth for valid slugs) and asserts that CATEGORY_GRADIENT and
 *   CATEGORY_LABEL in send-digest each contain an entry for every slug.
 *   Missing entries cause no-image events to silently fall through to the
 *   'other' gradient instead of rendering their correct color.
 *
 * Run:  node --test scripts/tests/test-send-digest-schema.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')
const SEND_DIGEST = join(ROOT, 'supabase', 'functions', 'send-digest', 'index.ts')

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Replay all migration SQL files in order to derive the current column set
 * for a given table. Handles CREATE TABLE, ADD COLUMN, and DROP COLUMN.
 */
function deriveTableColumns(tableName) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  const columns = new Set()

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')

    // ── CREATE TABLE ──
    // Match `create table [if not exists] <table> (` and capture everything
    // up to the balancing `)`. We walk character-by-character to handle
    // nested parens (constraints, CHECK expressions, etc.).
    const createRe = new RegExp(
      `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${tableName}\\s*\\(`,
      'i',
    )
    const startMatch = createRe.exec(sql)
    if (startMatch) {
      let depth = 1
      let i = startMatch.index + startMatch[0].length
      let body = ''
      while (i < sql.length && depth > 0) {
        if (sql[i] === '(') depth++
        else if (sql[i] === ')') depth--
        if (depth > 0) body += sql[i]
        i++
      }

      for (const line of body.split('\n')) {
        const trimmed = line.trim().replace(/,\s*$/, '')
        if (!trimmed || trimmed.startsWith('--')) continue
        // Skip table-level constraints
        if (/^(primary\s+key|unique|foreign\s+key|check|constraint)\b/i.test(trimmed)) continue
        // First token is the column name (unquoted identifiers only)
        const col = trimmed.match(/^([a-z_][a-z0-9_]*)\s+/i)
        if (col) columns.add(col[1].toLowerCase())
      }
    }

    // ── ADD COLUMN ──
    const addRe = new RegExp(
      `alter\\s+table\\s+${tableName}\\s+add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?([a-z_][a-z0-9_]*)`,
      'gi',
    )
    for (const m of sql.matchAll(addRe)) {
      columns.add(m[1].toLowerCase())
    }

    // ── DROP COLUMN ──
    const dropRe = new RegExp(
      `alter\\s+table\\s+${tableName}\\s+drop\\s+column\\s+(?:if\\s+exists\\s+)?([a-z_][a-z0-9_]*)`,
      'gi',
    )
    for (const m of sql.matchAll(dropRe)) {
      columns.delete(m[1].toLowerCase())
    }
  }

  return columns
}

/**
 * Extract the top-level column names from the send-digest
 * `supabase.from('events').select(...)` call. Relation sub-selects
 * (e.g. `event_venues!inner ( venues!inner ( id, name, address ) )`) are
 * excluded — they reference join table columns, not columns on the events row.
 */
function digestEventsSelectColumns() {
  const src = readFileSync(SEND_DIGEST, 'utf8')

  // Find the backtick select string that follows .from('events')
  const m = src.match(/\.from\(['"]events['"]\)[\s\S]*?\.select\(`([\s\S]*?)`\)/)
  assert.ok(m, "Could not locate .from('events').select(`...`) in send-digest/index.ts")

  const selectStr = m[1]

  // Split the select string at depth-0 commas only, so that comma-separated
  // column names inside a relation sub-select (e.g. `id, name, address` inside
  // `venues!inner ( id, name, address )`) are treated as a single segment and
  // not mistaken for top-level event columns.
  const segments = []
  let current = ''
  let depth = 0
  for (const ch of selectStr) {
    if (ch === '(') { depth++; current += ch }
    else if (ch === ')') { depth--; current += ch }
    else if (ch === ',' && depth === 0) { segments.push(current.trim()); current = '' }
    else { current += ch }
  }
  if (current.trim()) segments.push(current.trim())

  const columns = []
  for (const segment of segments) {
    // Any segment that still contains `(` is a relation sub-select — skip it
    if (segment.includes('(')) continue
    // Strip PostgREST join modifiers (`!inner`, `!left`, etc.) and aliases
    const colName = segment.split(/[!: ]/)[0].trim()
    if (colName) columns.push(colName.toLowerCase())
  }

  return columns
}

/**
 * Extract the keys of a named `const` object literal from TypeScript source.
 * Handles both `'key':` and `key:` forms, including hyphenated keys like
 * `'visual-art':`.
 */
function extractObjectKeys(src, constName) {
  // Match `const NAME: ... = { ... }` — capture everything inside the braces
  const re = new RegExp(`const\\s+${constName}[^=]*=\\s*\\{([^}]+)\\}`)
  const m = src.match(re)
  assert.ok(m, `Could not locate const ${constName} in send-digest/index.ts`)

  // Match both quoted keys ('visual-art':) and unquoted keys (music:)
  return [...m[1].matchAll(/['"]?([a-z][a-z0-9-]*)['"]?\s*:/g)].map((x) => x[1])
}

/**
 * Find the CHECK constraint on `event_categories.category` in the migrations
 * and return the allowed slug list. Processes migrations in order so the last
 * definition wins.
 */
function eventCategoryConstraintSlugs() {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  let latest = null

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')

    // Match either:
    //   category = any (array['a','b',...])   ← Postgres array form
    //   category in ('a','b',...)             ← IN list form
    const arrayForm = sql.match(/category\s*=\s*any\s*\(\s*array\s*\[([^\]]+)\]/i)
    const inForm = sql.match(/category\s+in\s*\(([^)]+)\)/i)
    const raw = arrayForm ? arrayForm[1] : inForm ? inForm[1] : null
    if (!raw) continue

    const slugs = [...raw.matchAll(/'([^']+)'/g)].map((x) => x[1])

    // Confirm this is the event_categories constraint (must include 'music'
    // and 'other', which have been present since the V2 taxonomy)
    if (slugs.includes('music') && slugs.includes('other')) {
      latest = { file, slugs }
    }
  }

  assert.ok(
    latest,
    'Could not find the event_categories.category CHECK constraint in supabase/migrations. ' +
    'Check that the constraint is defined using `category = any(array[...])` or `category in (...)`.',
  )

  return latest
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('send-digest: events select columns vs DB schema', () => {
  it('all top-level columns in .select() exist in the current events table', () => {
    const schemaColumns = deriveTableColumns('events')
    const selectedColumns = digestEventsSelectColumns()

    assert.ok(
      selectedColumns.length > 0,
      'digestEventsSelectColumns() returned an empty list — check the regex',
    )

    const missing = selectedColumns.filter((c) => !schemaColumns.has(c))

    assert.deepEqual(
      missing,
      [],
      `send-digest selects column(s) that no longer exist in the events table: [${missing.join(', ')}]. ` +
      `Either update the migration to keep the column, or update the .select() call in ` +
      `supabase/functions/send-digest/index.ts — then redeploy the function.`,
    )
  })

  it('schema has the core columns the digest logic depends on', () => {
    // Belt-and-suspenders: ensure the migration parser itself isn't silently
    // returning an empty set due to a parsing failure.
    const schemaColumns = deriveTableColumns('events')
    const required = ['id', 'title', 'start_at', 'status', 'featured', 'image_url']

    const missingCore = required.filter((c) => !schemaColumns.has(c))
    assert.deepEqual(
      missingCore,
      [],
      `deriveTableColumns('events') is missing core columns: [${missingCore.join(', ')}]. ` +
      `The migration parser may have failed to read CREATE TABLE events correctly.`,
    )
  })
})

describe('send-digest: CATEGORY_GRADIENT and CATEGORY_LABEL cover all constraint slugs', () => {
  const src = readFileSync(SEND_DIGEST, 'utf8')

  it('finds the event_categories constraint in the migrations', () => {
    const result = eventCategoryConstraintSlugs()
    assert.ok(result.slugs.length > 0)
  })

  it('CATEGORY_GRADIENT has an entry for every category slug', () => {
    const { file, slugs } = eventCategoryConstraintSlugs()
    const gradientKeys = new Set(extractObjectKeys(src, 'CATEGORY_GRADIENT'))

    const missing = slugs.filter((s) => !gradientKeys.has(s))
    assert.deepEqual(
      missing,
      [],
      `CATEGORY_GRADIENT in send-digest/index.ts is missing entries for: [${missing.join(', ')}] ` +
      `(defined in ${file}). Events with these categories will silently fall back to the 'other' gradient.`,
    )
  })

  it('CATEGORY_LABEL has an entry for every category slug', () => {
    const { file, slugs } = eventCategoryConstraintSlugs()
    const labelKeys = new Set(extractObjectKeys(src, 'CATEGORY_LABEL'))

    const missing = slugs.filter((s) => !labelKeys.has(s))
    assert.deepEqual(
      missing,
      [],
      `CATEGORY_LABEL in send-digest/index.ts is missing entries for: [${missing.join(', ')}] ` +
      `(defined in ${file}). Events with these categories will render as 'Event' instead of their real label.`,
    )
  })
})
