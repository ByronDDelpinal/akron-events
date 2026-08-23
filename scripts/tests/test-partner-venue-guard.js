/**
 * test-partner-venue-guard.js — JS/SQL agreement test for the partner
 * venue-mint guard (design §3.4).
 *
 * The mint-time law is implemented twice, unavoidably: in JS
 * (isJunkVenueName / looksLikeStreetAddress, scripts/lib/normalize.js) for
 * the scraper path, and in SQL (partner_venue_name_blocked(), migration 061)
 * for the partner RPC path — SQL cannot import JS, so the token lists are
 * duplicated by hand. This test is the drift bound:
 *
 *   1. Every row of the SHARED case table
 *      (scripts/tests/fixtures/partner-venue-guard-cases.js) is asserted
 *      against the real JS functions.
 *   2. The SQL half is asserted by supabase/tests/partner_accounts_rls.test.sql
 *      block 10 (M13) against the live guard function; THIS test parses that
 *      file's M13 values list and asserts it carries exactly the same rows
 *      (name + family), so the two halves cannot silently diverge.
 *
 * No database, no network. Run:  node --test scripts/tests/test-partner-venue-guard.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { isJunkVenueName, looksLikeStreetAddress } = await import('../lib/normalize.js')
const { GUARD_CASES } = await import('./fixtures/partner-venue-guard-cases.js')

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SQL_TEST_PATH = join(repoRoot, 'supabase', 'tests', 'partner_accounts_rls.test.sql')

describe('shared case table sanity', () => {
  it('has rows and unique names', () => {
    assert.ok(GUARD_CASES.length >= 20, 'the case table should stay substantial')
    const names = GUARD_CASES.map((c) => c.name)
    assert.equal(new Set(names).size, names.length, 'case names must be unique')
  })

  it('family is consistent with the JS verdict pair (family <=> junk || address)', () => {
    for (const c of GUARD_CASES) {
      const blocked = c.junk || c.address
      assert.equal(
        c.family !== null,
        blocked,
        `"${c.name}": family=${c.family} disagrees with junk=${c.junk} / address=${c.address}`
      )
    }
  })
})

describe('JS guard verdicts match the shared case table', () => {
  for (const c of GUARD_CASES) {
    it(`isJunkVenueName(${JSON.stringify(c.name)}) === ${c.junk}`, () => {
      assert.equal(isJunkVenueName(c.name), c.junk)
    })
    it(`looksLikeStreetAddress(${JSON.stringify(c.name)}) === ${c.address}`, () => {
      assert.equal(looksLikeStreetAddress(c.name), c.address)
    })
  }
})

describe('SQL test file (M13) carries the same case table', () => {
  const sql = readFileSync(SQL_TEST_PATH, 'utf8')

  // Extract the M13 values list: rows shaped ('Name', 'family') or
  // ('Name', null), between "select * from (values" and ") as t(name, family)".
  const block = sql.match(/select \* from \(values([\s\S]*?)\) as t\(name, family\)/)
  it('the M13 values block exists', () => {
    assert.ok(block, `could not find the M13 values block in ${SQL_TEST_PATH}`)
  })

  const rows = new Map()
  for (const m of block[1].matchAll(/\('((?:[^']|'')+)',\s*(?:'(\w+)'|null)\)/g)) {
    rows.set(m[1].replace(/''/g, "'"), m[2] ?? null)
  }

  it('row counts match', () => {
    assert.equal(
      rows.size,
      GUARD_CASES.length,
      `SQL M13 has ${rows.size} cases, the shared table has ${GUARD_CASES.length} — update both together`
    )
  })

  for (const c of GUARD_CASES) {
    it(`SQL M13 carries ${JSON.stringify(c.name)} as ${c.family ?? 'pass'}`, () => {
      assert.ok(rows.has(c.name), `"${c.name}" is missing from the SQL M13 block`)
      assert.equal(
        rows.get(c.name),
        c.family,
        `"${c.name}": SQL family ${rows.get(c.name)} != shared table family ${c.family}`
      )
    })
  }
})
