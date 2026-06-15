/**
 * test-hiho-brewing.js — category/tag mapping for the HiHO Brewing Squarespace
 * scraper (feed parsing itself is covered by the shared squarespace lib tests).
 *
 * Run:  node --test scripts/tests/test-hiho-brewing.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { mapCategory, mapTags } = await import('../scrape-hiho-brewing.js')

describe('HiHO mapCategory', () => {
  it('music for live music / Shakedown', () => {
    assert.equal(mapCategory({ title: 'Live Music: The Conway Brothers' }), 'music')
    assert.equal(mapCategory({ title: 'Shakedown Street' }), 'music')
  })
  it('games for trivia', () => {
    assert.equal(mapCategory({ title: 'Think & Drink Trivia' }), 'games')
  })
  it('null (defer to inference) otherwise', () => {
    assert.equal(mapCategory({ title: 'New IPA Release Party' }), null)
  })
})

describe('HiHO mapTags', () => {
  it('always tags brewery + city, adds live-music/trivia', () => {
    assert.deepEqual(mapTags({ title: 'Trivia Night' }).sort(), ['brewery', 'cuyahoga-falls', 'hiho-brewing', 'trivia'])
    assert.ok(mapTags({ title: 'Live Music' }).includes('live-music'))
  })
})
