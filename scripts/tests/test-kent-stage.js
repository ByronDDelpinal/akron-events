/**
 * test-kent-stage.js — the og:description fallback that backfills the Kent
 * Stage description (its Event JSON-LD omits `description`, but every detail
 * page carries the blurb in <meta property="og:description">).
 *
 * Run:  node --test scripts/tests/test-kent-stage.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseMetaDescription } = await import('../scrape-kent-stage.js')

describe('Kent Stage parseMetaDescription', () => {
  it('reads og:description and decodes entities', () => {
    const html = `<head><meta property="og:description" content="Doors @ 11:00 &nbsp; Tickets are $13 &amp; up. Don&#8217;t miss it!" /></head>`
    const d = parseMetaDescription(html)
    assert.ok(d.includes('Tickets are $13 & up'))
    assert.ok(d.includes('Don’t miss it!'))
    assert.ok(!/&nbsp;|&amp;|&#8217;/.test(d), 'entities decoded')
  })

  it('falls back to name="description" when og is absent', () => {
    const html = `<head><meta name="description" content="A folk show at the Kent Stage."></head>`
    assert.equal(parseMetaDescription(html), 'A folk show at the Kent Stage.')
  })

  it('returns null when no meta description exists', () => {
    assert.equal(parseMetaDescription('<head><title>x</title></head>'), null)
  })
})
