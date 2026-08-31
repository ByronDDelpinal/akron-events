/**
 * test-org-opt-out-fold.js
 *
 * Pins the org-name fold contract that migration 066's SQL function
 * org_name_match_key(text) MUST mirror. The JS side is the SINGLE SOURCE OF
 * TRUTH (orgNameMatchKey in src/lib/sourceTiers.js); the SQL side is a twin
 * written to fold identically so a name folded in the browser/scraper and a
 * name folded inside the opt-out triggers resolve to the same key.
 *
 * These are pure-function assertions with no database dependency.
 *
 * Run:
 *   node --test scripts/tests/test-org-opt-out-fold.js
 *
 * SQL PARITY. This file cannot reach Postgres, so it pins the JS OUTPUTS. The
 * developer separately diffed these exact byte-for-byte inputs against
 * org_name_match_key() running in a real PostgreSQL 17: 10 of 11 ASCII cases
 * matched exactly. The ONE documented divergence is NBSP (U+00A0): JS `\s`
 * (and String.trim) treat NBSP as whitespace and collapse it to a space, while
 * Postgres `\s` is POSIX [[:space:]] = [ \t\n\r\f\v] and leaves NBSP intact.
 * The 066 header documents this; it does not occur in scraped ASCII org names,
 * and the table CHECK plus both guard functions all route through the SQL twin,
 * so the database stays internally consistent regardless. The `nbsp` case below
 * is labeled so a future reader knows it is the sole intentional gap.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { orgNameMatchKey } from '../../src/lib/sourceTiers.js'

describe('orgNameMatchKey fold parity (066 org_name_match_key twin)', () => {
  it('drops a leading "The " and trims surrounding whitespace', () => {
    assert.equal(orgNameMatchKey('  The Downtown Akron Partnership  '), 'downtown akron partnership')
  })

  it('treats a tab after "The" as the stripped whitespace', () => {
    assert.equal(orgNameMatchKey('The\tDowntown Akron'), 'downtown akron')
  })

  it('collapses interior double spaces and a newline to single spaces', () => {
    assert.equal(orgNameMatchKey('Downtown  Akron\nPartnership'), 'downtown akron partnership')
  })

  it('collapses a CRLF, a tab and a double space together', () => {
    assert.equal(orgNameMatchKey('The\r\nMusica  Guild\t'), 'musica guild')
  })

  it('folds a lowercase leading "the"', () => {
    assert.equal(orgNameMatchKey('the well cdc'), 'well cdc')
  })

  it('folds case and collapses runs of spaces around an uppercase THE', () => {
    assert.equal(orgNameMatchKey('THE   STRAY   CATS'), 'stray cats')
  })

  it('does NOT strip "the" when it is not followed by whitespace', () => {
    // "Theatre" must survive intact; the fold strips only "the" + \s+.
    assert.equal(orgNameMatchKey('Theatre Guild'), 'theatre guild')
  })

  it('preserves punctuation (the fold is case/whitespace/The only)', () => {
    assert.equal(orgNameMatchKey("St. Bernard's Parish & Friends!"), "st. bernard's parish & friends!")
  })

  it('folds empty, null and undefined to the empty string', () => {
    assert.equal(orgNameMatchKey(''), '')
    assert.equal(orgNameMatchKey(null), '')
    assert.equal(orgNameMatchKey(undefined), '')
  })

  it('folds a whitespace-only name to the empty string', () => {
    assert.equal(orgNameMatchKey(' \t\n '), '')
  })

  it('nbsp: JS collapses U+00A0 to a space (the SOLE documented SQL divergence)', () => {
    // JS `\s` matches NBSP; the SQL twin does not (see the file header and the
    // 066 header). This asserts the JS behavior only.
    assert.equal(orgNameMatchKey('Akron Life'), 'akron life')
  })
})
