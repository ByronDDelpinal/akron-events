/**test-summit-humane.js — pure parsers for the Humane Society (Tribe) scraper*/
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { cleanDescription, parseVenue, parseCategory, buildSourceId } =
  await import('../scrape-summit-humane.js')

describe('humane: cleanDescription strips WPBakery shortcodes', () => {
  it('removes [vc_*] shortcodes and HTML, keeps the real text', () => {
    const raw = '[vc_row type="x"][vc_column width="2/3"]<strong>Tuesday, July 14</strong> ' +
      '<div>3pm &#8211; 10pm</div> Stow location[/vc_column][/vc_row]'
    const out = cleanDescription(raw)
    assert.ok(out.includes('Tuesday, July 14'))
    assert.ok(out.includes('Stow location'))
    assert.ok(!out.includes('[vc_'))
    assert.ok(!out.includes('vc_column'))
  })
  it('returns null for empty', () => {
    assert.equal(cleanDescription(''), null)
    assert.equal(cleanDescription('[vc_row][/vc_row]'), null)
  })
})

describe('humane: parseVenue', () => {
  it('maps a Tribe venue object to name + details', () => {
    const v = parseVenue({ venue: 'Texas Roadhouse', address: '4310 Lakepoint Corporate Drive', city: 'Stow', province: 'OH' })
    assert.equal(v.name, 'Texas Roadhouse')
    assert.equal(v.details.city, 'Stow')
    assert.equal(v.details.state, 'OH')
  })
  it('returns null when the venue is absent (empty array)', () => {
    assert.equal(parseVenue([]), null)
    assert.equal(parseVenue(null), null)
  })
})

describe('humane: parseCategory', () => {
  it('detects fitness and food, else null', () => {
    assert.equal(parseCategory({ title: 'Downward Dog for Shelter Dogs', description: 'yoga class' }), 'fitness')
    assert.equal(parseCategory({ title: 'Texas Roadhouse Dine to Donate' }), 'food')
    assert.equal(parseCategory({ title: 'Adopt-a-thon' }), null)
  })
})

describe('humane: buildSourceId', () => {
  it('keys on id + occurrence day', () => {
    assert.equal(buildSourceId({ id: 3293, start_date: '2026-07-14 15:00:00' }), '3293-2026-07-14')
  })
})
