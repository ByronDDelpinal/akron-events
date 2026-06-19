/**
 * test-akron-civic.js — pure parsers for the Akron Civic Theatre scraper
 * (official akroncivic.com / Bolt CMS, list → detail).
 *
 * Run:  node --test scripts/tests/test-akron-civic.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const {
  extractShowPaths, parseTitle, parseCivicDateTime, upsizeCivicImage,
  extractImage, extractDescription, venueForName, parseDetail,
} = await import('../scrape-akron-civic.js')

// A detail page shaped like a real akroncivic.com Bolt CMS show page.
const DETAIL = `
<header><a href="/">Home</a></header>
<div class="eventresults"><div><div>
  <h1></h1><h1>Party on the Plaza:</h1><h1>Afi Scruggs</h1>
  <p>&nbsp;</p>
</div></div></div>
<div><div><div>
  <div><img src="/thumbs/320×240×80/shows/2026/05/POTP-AfiScruggs-Web.jpg" alt="Afi"></div>
  <h6>Friday, June 19, 2026 at 6:00 PM</h6>
  <h6>PNC Plaza at The Civic</h6>
  <div>
    <p><strong>Party on the Plaza Summer<br>2026 Concert Series</strong><br>Every Friday from 6 - 7 PM<br>Admission is FREE</p>
    <p>We&rsquo;re excited to bring back Party on the Plaza, our summer concert series at PNC Plaza at The Civic.</p>
    <p>Love the blues? You&rsquo;ll love Afi.&nbsp;She plays bass and keys.</p>
  </div>
</div></div></div>
<div>GENERAL INFORMATION</div>
<div>Free Admission</div>
<p>this boilerplate paragraph must be excluded</p>
`

describe('extractShowPaths', () => {
  const list = `
    <a href="/ian-maksin-2026-06-18">x</a>
    <a href="/party-on-the-plaza-afi-scruggs-2026-06-19">x</a>
    <a href="/party-on-the-plaza-afi-scruggs-2026-06-19">dup</a>
    <a href="/plan-visit">nav</a>
    <a href="https://www.akroncivic.com/lou-harris-2026-06-20">abs</a>
    <a href="/box-office?x=1">junk</a>`
  it('keeps only -YYYY-MM-DD show slugs, deduped + absolutized', () => {
    const paths = extractShowPaths(list)
    assert.deepEqual(paths, [
      'https://www.akroncivic.com/ian-maksin-2026-06-18',
      'https://www.akroncivic.com/party-on-the-plaza-afi-scruggs-2026-06-19',
      'https://www.akroncivic.com/lou-harris-2026-06-20',
    ])
  })
})

describe('parseTitle', () => {
  it('joins the <h1> fragments into one title', () => {
    assert.equal(parseTitle(DETAIL), 'Party on the Plaza: Afi Scruggs')
  })
})

describe('parseCivicDateTime', () => {
  it('parses "Weekday, Month D, YYYY at H:MM AM/PM"', () => {
    assert.deepEqual(parseCivicDateTime('Friday, June 19, 2026 at 6:00 PM'),
      { datePart: '2026-06-19', time: '6:00 PM' })
  })
  it('handles a date with no time', () => {
    assert.deepEqual(parseCivicDateTime('Saturday, October 3, 2026'),
      { datePart: '2026-10-03', time: '' })
  })
  it('returns null for a non-date (venue line)', () => {
    assert.equal(parseCivicDateTime('PNC Plaza at The Civic'), null)
  })
})

describe('upsizeCivicImage', () => {
  it('upsizes a /thumbs/{w}×{h}×{q}/ rendition to ~1200w, preserving ratio', () => {
    assert.equal(
      upsizeCivicImage('/thumbs/320×240×80/shows/2026/05/POTP-AfiScruggs-Web.jpg'),
      'https://www.akroncivic.com/thumbs/1200×900×90/shows/2026/05/POTP-AfiScruggs-Web.jpg')
  })
  it('absolutizes a non-thumb path unchanged', () => {
    assert.equal(upsizeCivicImage('/shows/x.jpg'), 'https://www.akroncivic.com/shows/x.jpg')
  })
})

describe('extractImage', () => {
  it('finds the /shows/ poster and upsizes it', () => {
    assert.equal(extractImage(DETAIL),
      'https://www.akroncivic.com/thumbs/1200×900×90/shows/2026/05/POTP-AfiScruggs-Web.jpg')
  })
})

describe('extractDescription', () => {
  const desc = extractDescription(DETAIL)
  it('keeps paragraph + line breaks and excludes boilerplate', () => {
    assert.match(desc, /Party on the Plaza Summer\n2026 Concert Series/)        // <br> → \n
    assert.match(desc, /Every Friday from 6 - 7 PM\nAdmission is FREE/)
    assert.ok(desc.includes('\n\n'))                                            // paragraph breaks
    assert.match(desc, /We're excited to bring back/)                           // smart-quote decoded
    assert.ok(!/boilerplate paragraph/.test(desc))                             // GENERAL INFORMATION cut
    assert.ok(!/&nbsp;|&rsquo;/.test(desc))                                     // entities resolved
  })
})

describe('venueForName', () => {
  it('routes each stage to its own venue record', () => {
    assert.equal(venueForName('PNC Plaza at The Civic').name, 'PNC Plaza at The Civic')
    assert.equal(venueForName('The Knight Stage').name, 'The Knight Stage')
    assert.equal(venueForName("Wild Oscar's").name, "Wild Oscar's")
    assert.equal(venueForName('Akron Civic Theatre').name, 'Akron Civic Theatre')
    assert.equal(venueForName('').name, 'Akron Civic Theatre')
  })
})

describe('parseDetail (integration of the pure parsers)', () => {
  const row = parseDetail(DETAIL, 'https://www.akroncivic.com/party-on-the-plaza-afi-scruggs-2026-06-19')
  it('produces the full event shape from a detail page', () => {
    assert.equal(row.title, 'Party on the Plaza: Afi Scruggs')
    assert.equal(row.startIso, new Date('2026-06-19T22:00:00Z').toISOString()) // 6PM EDT → 22:00Z
    assert.equal(row.venue.name, 'PNC Plaza at The Civic')
    assert.equal(row.isFree, true)                                              // "Admission is FREE"
    assert.match(row.imageUrl, /\/thumbs\/1200×900×90\/shows\//)
    assert.match(row.description, /summer concert series/i)
  })
})
