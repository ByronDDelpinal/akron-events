/**
 * test-tangier.js — parsers for the Tangier (Webflow /events) scraper.
 *
 * THE FIXTURE IS A VERBATIM CAPTURE of the live page's raw HTML
 * (scripts/tests/fixtures/tangier-events.html), not hand-written markup. That
 * is the whole point: the previous fixture was hand-written with <p> wrappers
 * while the live page is Webflow <div>s, and htmlToText newlines </p> but NOT
 * </div>. The hand-written version therefore separated the four CTA buttons
 * with blank lines, which is exactly the condition under which the old
 * \b-anchored description scrubber DID work — so the test constructed its own
 * passing case and a broken scrubber shipped. On the real page the buttons
 * flatten into one unseparated run, "Purchase TicketsReserve A TableView
 * MenuPurchase Tickets", where every \b sits between two word characters and
 * none of the alternatives can match.
 *
 * If the page changes, RE-CAPTURE the fixture with
 *     curl -sL https://www.thetangier.com/events
 * and trim length, never structure.
 *
 * Run:  node --test scripts/tests/test-tangier.js
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.VITE_SUPABASE_URL         = process.env.VITE_SUPABASE_URL         || 'https://dummy.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy-key'

const { parseTangierEvents, parseDate, parseStartTime, parseHeldAt, parsePrices, titleCase, cleanDescription } =
  await import('../scrape-tangier.js')

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = readFileSync(join(__dirname, 'fixtures/tangier-events.html'), 'utf8')

// The live page ships fully minified (one line). Webflow's published output has
// varied between minified and pretty-printed, and a line break between the CTA
// <a>s un-glues the button run — so exercise BOTH shapes of the same document.
const SINGLE_LINE = FIXTURE.replace(/\n\s*/g, '')
const LINE_BROKEN = FIXTURE.replace(/></g, '>\n<')
const VARIANTS = [
  ['as captured (single-line / minified)', SINGLE_LINE],
  ['line-broken between tags',             LINE_BROKEN],
]

const BUTTON_NOISE = /Purchase Tickets|Reserve A Table|View Menu/i
const EXPECTED = [
  { title: 'Frankie Scinta',                  dateYmd: '2026-08-19', time: '18:00',
    sourceId: 'tangier-83269894', imageFrag: 'Frankie-Scinta-Banner',
    ticketUrl: 'https://www.etix.com/ticket/p/83269894/frankie-scintathe-showman-fairlawn-tangier-west',
    priceMin: 105.70, priceMax: 105.70, descFrag: 'GRAND OPENING' },
  { title: 'Halloween Party with Roxxymoron', dateYmd: '2026-10-31', time: '19:00',
    sourceId: 'tangier-92258107', imageFrag: 'Halloween-Party-Banner',
    ticketUrl: 'https://www.etix.com/ticket/p/92258107/tangier-west-1st-annual-halloween-party-featuring-roxxymoron-fairlawn-tangier-west',
    priceMin: 32.20, priceMax: 105.70, descFrag: 'Roxxymoron' },
  { title: "New Year's Eve with Disco Inferno", dateYmd: '2026-12-31', time: '18:30',
    sourceId: 'tangier-92344237', imageFrag: 'NewYears-bkg',
    ticketUrl: 'https://www.etix.com/ticket/p/92344237/disco-inferno-new-years-eve-fairlawn-tangier-west',
    priceMin: 142.45, priceMax: 142.45, descFrag: 'Disco Inferno' },
]

describe('tangier: field parsers', () => {
  it('parseDate', () => { assert.equal(parseDate('August 19, 2026'), '2026-08-19') })

  it('parseStartTime — prefers the doors/start CUE over any earlier clock time', () => {
    // The three live cards happen to state the start first, so they alone cannot
    // tell "first clock time" apart from "cued time". These can.
    assert.equal(parseStartTime('Box office opens at 10 am. Doors open at 7 pm.'), '19:00')
    assert.equal(parseStartTime('Tickets go on sale 9 am Friday. Showtime at 8 pm.'), '20:00')
    assert.equal(parseStartTime('Live band 9 pm. Doors open at 6:30PM.'), '18:30')
    // Cue alternation is leftmost-wins, so the EARLIEST stated opening wins
    // (Frankie: the lounge opens before dinner starts).
    assert.equal(parseStartTime("Isabella's lounge at 6:00 pm; dinner will start at 7:00 pm"), '18:00')
  })

  it('parseStartTime — the cue is anchored, so "restarts at" is not a start cue', () => {
    // Without the leading \b the bare "starts at" alternative matched mid-word
    // and published 21:00 for a card whose doors are at 6.
    assert.equal(parseStartTime('Concert restarts at 9 pm after the intermission; doors open at 6 pm'), '18:00')
    assert.equal(parseStartTime('The show begins at 8 pm'), '20:00')  // still a cue
  })

  it('parseStartTime — ACCEPTED: a cued buffet time outranks a later doors time', () => {
    // "starts at" is itself a cue, so the leftmost-cue rule takes the buffet.
    // Documented, not fixed: dropping the bare "starts at" alternative would
    // lose the only cue matching "the show begins at 8 pm", and on these
    // dinner-show cards the buffet time is when the room actually opens.
    assert.equal(parseStartTime('Buffet starts at 5 pm for VIPs. Doors open at 6:30PM.'), '17:00')
    assert.equal(parseStartTime('The buffet starts at 5:30 pm. Doors open at 7 pm.'), '17:30')
  })

  it('parseStartTime — falls back to the first clock time when no cue is present', () => {
    assert.equal(parseStartTime('Open Bar from 7 pm to 11 pm'), '19:00')   // cued
    assert.equal(parseStartTime('Music from 9 pm until late'), '21:00')    // uncued fallback
    assert.equal(parseStartTime('no time here'), '')  // date-only, never fabricated
    assert.equal(parseStartTime(''), '')
  })

  it('parseHeldAt', () => {
    assert.deepEqual(
      parseHeldAt('This EVENT WILL BE HELD AT tangier west: 3150 w market street Fairlawn, Oh 44333'),
      { name: 'Tangier West', address: '3150 W Market Street', city: 'Fairlawn', state: 'OH', zip: '44333' })
  })
  it('parsePrices', () => { assert.deepEqual(parsePrices('$32.20 / $105.70'), { min: 32.20, max: 105.70 }) })
  it('titleCase', () => { assert.equal(titleCase('tangier west'), 'Tangier West') })
})

describe('tangier: cleanDescription', () => {
  it('strips the GLUED button run (the \\b bug: no boundary exists inside it)', () => {
    const glued = 'Real description text.\n\nPurchase TicketsReserve A TableView MenuPurchase Tickets'
    assert.equal(cleanDescription(glued), 'Real description text.')
  })

  it('strips a trailing button run even when the buttons are separated', () => {
    assert.equal(
      cleanDescription('Real description text.\n\nPurchase Tickets\nReserve A Table\nView Menu'),
      'Real description text.')
  })

  // REGRESSION: JS \s does not match U+200B–U+200D, so a joiner BETWEEN two
  // buttons defeats both scrubbers at once — GLUED_BUTTONS needs the labels
  // literally adjacent, and TRAILING_BUTTONS's \s* cannot step over it. Before
  // ZERO_WIDTH was hoisted above them this returned the half-stripped
  // 'Body.\n\nPurchase TicketsReserve A Table' and shipped it.
  it('strips a button run glued with ZERO-WIDTH JOINERS, not just with nothing', () => {
    const zwj = String.fromCharCode(0x200D)
    assert.equal(
      cleanDescription(`Body.\n\nPurchase Tickets${zwj}Reserve A Table${zwj}View Menu`),
      'Body.')
    // …and one joiner inside a single label must not shield it either.
    assert.equal(
      cleanDescription(`Body.\n\nPurchase Tic${zwj}ketsReserve A TableView Menu`),
      'Body.')
  })

  it('does NOT gut legitimate prose that happens to say "purchase tickets"', () => {
    // Why the fix is not simply "drop the \\b": a global case-insensitive
    // replace would leave "You may  at the box office."
    const prose = 'You may purchase tickets at the box office, or view menu options online first.'
    assert.equal(cleanDescription(prose), prose)
  })

  it('strips zero-width joiners from Webflow spacer paragraphs', () => {
    assert.equal(cleanDescription('First para.\n\n\u200d\n\nSecond para.'), 'First para.\n\nSecond para.')
    assert.equal(cleanDescription('a\u200Bb\u200Cc\uFEFFd'), 'abcd')
  })

  // ACCEPTED RESIDUAL, pinned so the trade-off stays deliberate. TRAILING_BUTTONS
  // is anchored to end-of-string, not start-of-line, so an un-punctuated label
  // phrase that is the literal LAST token of the block is eaten. The scope is
  // narrow — the same sentence with any trailing punctuation survives intact —
  // and closing it by anchoring to line-start is a separate call, not this one.
  it('ACCEPTED: eats a bare trailing label phrase, but only as the final token', () => {
    assert.equal(cleanDescription('Seating is limited so reserve a table'), 'Seating is limited so')
    // Trailing punctuation, or any following prose, and it survives.
    assert.equal(cleanDescription('Seating is limited so reserve a table.'),
      'Seating is limited so reserve a table.')
    assert.equal(cleanDescription('Reserve a table early; seating is limited.'),
      'Reserve a table early; seating is limited.')
  })

  it('still drops the HELD AT block, price lines, and the date', () => {
    const block = 'August 19, 2026\nThis EVENT WILL BE HELD AT tangier west: 3150 w market street Fairlawn, Oh 44333\nBody copy.\n$105.70 Reserved Table'
    assert.equal(cleanDescription(block), 'Body copy.')
  })

  it('returns null (not "") when nothing is left', () => {
    assert.equal(cleanDescription('Purchase TicketsReserve A TableView Menu'), null)
    assert.equal(cleanDescription(''), null)
  })
})

for (const [label, html] of VARIANTS) {
  describe(`tangier: parseTangierEvents — ${label}`, () => {
    const events = parseTangierEvents(html)

    it('parses all three cards', () => {
      assert.equal(events.length, 3)
    })

    // The shipped bug was card N inheriting card N-1's buttons, so EVERY card
    // must be asserted individually — a single-card fixture, or a test that only
    // checks events[0], cannot reproduce it.
    EXPECTED.forEach((want, i) => {
      it(`card ${i + 1}: ${want.title}`, () => {
        const e = events[i]
        assert.equal(e.title, want.title)
        assert.equal(e.dateYmd, want.dateYmd)
        assert.equal(e.time, want.time)
        assert.equal(e.ticketUrl, want.ticketUrl)
        assert.equal(e.sourceId, want.sourceId)
        assert.equal(e.priceMin, want.priceMin)
        assert.equal(e.priceMax, want.priceMax)
        assert.deepEqual(e.venue,
          { name: 'Tangier West', address: '3150 W Market Street', city: 'Fairlawn', state: 'OH', zip: '44333' })
        assert.ok(e.description && e.description.includes(want.descFrag),
          `card ${i + 1} description missing ${want.descFrag}: ${JSON.stringify(e.description)}`)
      })
    })

    it('titles carry no button noise from the PREVIOUS card', () => {
      assert.deepEqual(events.map((e) => e.title), EXPECTED.map((w) => w.title))
      assert.ok(events.every((e) => !BUTTON_NOISE.test(e.title)))
    })

    // REGRESSION: this is the assertion the old fixture could not make fail.
    it('no description contains "Purchase Tickets" / "Reserve A Table" / "View Menu"', () => {
      for (const e of events) {
        assert.ok(!BUTTON_NOISE.test(e.description || ''),
          `button noise in description: ${JSON.stringify((e.description || '').slice(-120))}`)
      }
    })

    it('no description contains a zero-width character', () => {
      for (const e of events) {
        assert.ok(!/[\u200B-\u200D\u2060\uFEFF]/.test(e.description || ''),
          `zero-width char in description: ${JSON.stringify(e.description)}`)
      }
    })

    // A null image_url permanently downgrades an event to a plain row in the
    // digest (the image gate is a GATE, not a score), and all three live rows
    // shipped with image_url = null.
    it('every card has a non-null imageUrl — its OWN banner', () => {
      EXPECTED.forEach((want, i) => {
        assert.ok(events[i].imageUrl, `card ${i + 1} (${want.title}) has no imageUrl`)
        assert.ok(events[i].imageUrl.includes(want.imageFrag),
          `card ${i + 1} got the wrong banner: ${events[i].imageUrl}`)
        assert.ok(!/\s/.test(events[i].imageUrl), 'imageUrl must stay percent-encoded')
      })
      // Non-null is not enough: the "last banner before this <h2>" lookup would
      // hand every card the SAME url if the per-card banners were ever missed.
      assert.equal(new Set(events.map((e) => e.imageUrl)).size, events.length,
        `banners are not distinct: ${JSON.stringify(events.map((e) => e.imageUrl))}`)
    })

    it('never publishes the boilerplate Etix product as the ticket link', () => {
      assert.ok(events.every((e) => !e.ticketUrl.includes('51986841')))
    })
  })
}

describe('tangier: parseTangierEvents — degenerate input', () => {
  it('returns [] rather than throwing', () => {
    assert.deepEqual(parseTangierEvents(''), [])
    assert.deepEqual(parseTangierEvents('<html><body>no events here</body></html>'), [])
  })
})
