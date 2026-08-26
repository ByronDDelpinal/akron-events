/**
 * test-org-analytics.js - guards on the partner analytics block.
 *
 * Two kinds of check, no bundler and no DOM, following test-partner-ui.js:
 *
 *   1. Pure logic in src/lib/admin/analyticsShared.ts, imported directly.
 *   2. Textual guards on the pieces where a careless edit silently removes an
 *      honesty rule. Those rules are the reason this feature is allowed to
 *      exist: every figure it shows is a FLOOR, because ad blockers and
 *      tracking protection drop the GA beacon and a meaningful share of real
 *      visits are never counted. A number that loses its marker on the way to
 *      the screen becomes a claim Akron Pulse cannot back, and nothing about
 *      that failure is visible in review.
 *
 * The SQL guards point at 064, which is the LIVE definition of
 * partner_event_metrics. 063 stays on disk as history and is not scanned here:
 * a guard on a superseded file passes while the thing it protects rots.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_WINDOW,
  FLOOR_NOTE,
  HEADLINE_LABELS,
  VIEWS_BREAK_CHIP,
  VIEWS_BREAK_SHORT,
  NO_UPCOMING_NOTE,
  UPCOMING_NOTE,
  VIEWS_BREAK_LABEL,
  PAST_SORT,
  SORT_KEYS,
  TRACKING_START,
  UPCOMING_DAYS,
  UPCOMING_SORT,
  VIEWS_BREAK_DATE,
  VISITOR_DAYS_NOTE,
  WINDOW_OPTIONS,
  crossesViewsBreak,
  emptyKind,
  floorFigure,
  floorLabel,
  floorNum,
  metricWindow,
  partitionRows,
  sortRows,
  totals,
  viewsFigure,
  windowLabel,
} from '../../src/lib/admin/analyticsShared.ts'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const read = (rel) => readFileSync(new URL(rel, `file://${ROOT}`), 'utf8')
const exists = (rel) => existsSync(fileURLToPath(new URL(rel, `file://${ROOT}`)))

function row(over = {}) {
  return {
    event_id: over.event_id ?? 'e1',
    title: over.title ?? 'A show',
    start_at: over.start_at ?? '2026-08-10T23:00:00.000Z',
    status: over.status ?? 'published',
    page_views: over.page_views ?? 0,
    visitor_days: over.visitor_days ?? 0,
    outbound_clicks: over.outbound_clicks ?? 0,
    outbound_tickets: over.outbound_tickets ?? 0,
    outbound_source: over.outbound_source ?? 0,
    is_upcoming: over.is_upcoming ?? false,
  }
}

describe('metricWindow ends yesterday and never today', () => {
  it('a 30 day window ends on yesterday', () => {
    const w = metricWindow(30, '2026-08-24')
    assert.equal(w.to, '2026-08-23', 'the window must END yesterday: ga-to-db.js never writes today, so ' +
      'including today would always show a guaranteed-empty final day that reads as an outage')
    assert.equal(w.from, '2026-07-25')
    assert.equal(w.clamped, false)
  })

  it('crosses a month boundary correctly', () => {
    assert.deepEqual(metricWindow(7, '2026-09-01'), { from: '2026-08-25', to: '2026-08-31', clamped: false })
  })

  it('crosses a year boundary correctly', () => {
    assert.deepEqual(metricWindow(7, '2027-01-01'), { from: '2026-12-25', to: '2026-12-31', clamped: false })
  })

  it('holds across the spring and autumn DST switches', () => {
    // Plain yyyy-MM-dd arithmetic through Date.UTC has no offset to lose. If
    // this ever regresses it will be because somebody reached for a local Date.
    // Both dates sit after TRACKING_START so the clamp is not what is being
    // measured here.
    assert.equal(metricWindow(7, '2027-03-15').from, '2027-03-08')
    assert.equal(metricWindow(7, '2026-11-02').from, '2026-10-26')
  })

  it('never returns a window that ends before it starts', () => {
    // A range entirely before tracking began should come back empty, not
    // inverted: the RPC rejects p_to < p_from outright.
    const w = metricWindow(7, '2026-03-09')
    assert.ok(w.from <= w.to, `metricWindow returned an inverted window: ${w.from} to ${w.to}`)
  })

  it('clamps a 90 day window to TRACKING_START and says that it did', () => {
    const w = metricWindow(90, '2026-06-10')
    assert.equal(w.from, TRACKING_START)
    assert.equal(w.clamped, true, 'a clamped window must report it, so the UI can say how far back the data goes ' +
      'instead of silently showing a narrower range than the button claims')
  })

  it('a window landing exactly on TRACKING_START counts as clamped', () => {
    // The boundary case, live from 2026-08-25: a 90 day window resolves to
    // rawFrom === TRACKING_START. `clamped` is <=, not <, so the UI still says
    // "as far back as we have", which is true, rather than implying there is
    // more behind it.
    const w = metricWindow(90, '2026-08-25')
    assert.equal(w.from, TRACKING_START)
    assert.equal(w.clamped, true)
  })

  it('all time starts at TRACKING_START and still ends yesterday', () => {
    const w = metricWindow('all', '2026-08-24')
    assert.equal(w.from, TRACKING_START)
    assert.equal(w.to, '2026-08-23')
    assert.equal(w.clamped, true, 'all time is by definition as far back as we have, and the UI says so through ' +
      'this flag')
  })

  it('all time never inverts, even on the first day of tracking', () => {
    const w = metricWindow('all', TRACKING_START)
    assert.ok(w.from <= w.to, `all time inverted on day one: ${w.from} to ${w.to}`)
  })

  it('90 is the default, and every option is a positive integer or all time', () => {
    // 90 rather than 30 or 7: the whole site carries two to twenty five
    // outbound clicks a DAY, so a short window on one partner's cadence moves
    // on single events and reads as signal when it is not.
    assert.equal(DEFAULT_WINDOW, 90)
    assert.ok(WINDOW_OPTIONS.includes(DEFAULT_WINDOW))
    assert.ok(WINDOW_OPTIONS.includes('all'), 'the all time option is what a small partner actually has a ' +
      'non-zero number in')
    for (const d of WINDOW_OPTIONS) {
      assert.ok(d === 'all' || (Number.isInteger(d) && d > 0), `bad window option: ${d}`)
    }
  })

  it('every option has a label and none of them is blank', () => {
    for (const d of WINDOW_OPTIONS) {
      assert.ok(windowLabel(d).trim().length > 0, `no label for window option ${d}`)
    }
    assert.equal(windowLabel('all'), 'All time')
    assert.equal(windowLabel(90), '90 days')
  })

  it('the forward window is bounded and matches what 064 will accept', () => {
    assert.ok(Number.isInteger(UPCOMING_DAYS) && UPCOMING_DAYS > 0 && UPCOMING_DAYS <= 400,
      'an unbounded forward branch returned 1,763 rows for one org before 063 closed it, and 064 caps ' +
      'p_upcoming_days at 400')
  })
})

describe('every number carries its floor marker', () => {
  it('a positive count gets a tilde inside the string', () => {
    assert.equal(floorNum(412), '~412')
    assert.equal(floorNum(1234), '~1,234')
  })

  it('zero renders bare', () => {
    // "~0" reads as "about zero", which is weaker than the truth, and zero is
    // the figure most likely to be mistaken for a fact.
    assert.equal(floorNum(0), '0')
  })

  it('no positive count can render without the marker', () => {
    for (const n of [1, 7, 99, 100, 1000, 999999]) {
      assert.ok(floorNum(n).startsWith('~'), `floorNum(${n}) lost its marker`)
    }
  })

  it('floorLabel says "at least" and agrees with floorNum on the same input', () => {
    assert.equal(floorLabel(412, 'handoffs'), 'at least 412 handoffs')
    assert.ok(floorLabel(1234, 'views').includes('1,234'))
    assert.ok(floorLabel(0, 'views').includes('at least 0'))
  })
})

describe('a figure decides once what a number claims', () => {
  it('an ordinary figure is a floor in both halves', () => {
    const f = floorFigure(412, 'handoffs')
    assert.equal(f.text, '~412')
    assert.equal(f.label, 'at least 412 handoffs')
  })

  it('views inside the corrected era is an ordinary floor', () => {
    const f = viewsFigure(412, 'views', false)
    assert.equal(f.text, '~412')
    assert.ok(f.label.startsWith('at least '))
  })

  it('views across the break drops the tilde AND the "at least"', () => {
    // This is the one figure on the surface that is not a floor: before the
    // break a filter change fired a page_view, so the number runs HIGH. "At
    // least 412" would be the only claim here pointing the wrong way, and it
    // would be the biggest number on the page.
    const f = viewsFigure(412, 'views', true)
    assert.equal(f.text, '412', 'no tilde: the tilde means "at least", which is false here')
    assert.ok(!/at least/i.test(f.label), 'the accessible name must not say "at least" either. A correction ' +
      'further down the page does not un-say a claim already made in the name of the figure.')
    assert.ok(f.label.includes(VIEWS_BREAK_LABEL), 'and it has to name the date, where the number is')
  })

  it('never scales or corrects the number itself', () => {
    for (const crossed of [true, false]) {
      assert.ok(viewsFigure(412, 'views', crossed).text.includes('412'),
        'an invented correction factor would be worse than a number that explains itself')
    }
    assert.equal(viewsFigure(0, 'views', true).text, '0')
  })

  it('every figure helper returns both halves, always', () => {
    const all = [floorFigure(0, 'views'), floorFigure(9, 'views'), viewsFigure(0, 'views', true), viewsFigure(9, 'views', true)]
    for (const f of all) {
      assert.ok(f.text.length > 0 && f.label.length > 0, 'a tile with a value and no accessible name is the ' +
        'exact failure the sr-only twin exists to prevent')
    }
  })

  it('the views tile has copy for both eras', () => {
    assert.ok(HEADLINE_LABELS.views.sub.length > 0)
    // The broken-era copy is the chip, not a second sub. The tile itself has
    // to say the number runs high, and it has to name the day it changed, or
    // a reader cannot tell whether their own window is affected.
    assert.ok(VIEWS_BREAK_CHIP.length > 0)
    assert.ok(VIEWS_BREAK_CHIP.includes(VIEWS_BREAK_SHORT))
    assert.ok(VIEWS_BREAK_LABEL.includes(VIEWS_BREAK_SHORT.split(' ')[0]),
      'the long and short forms of the break date must name the same month')
    assert.ok(VIEWS_BREAK_CHIP.length < 32, 'the chip has a tile corner to fit into')
  })
})

describe('totals', () => {
  it('sums the additive columns', () => {
    const t = totals([
      row({ page_views: 10, visitor_days: 4, outbound_clicks: 3, outbound_tickets: 2, outbound_source: 1 }),
      row({ event_id: 'e2', page_views: 5, visitor_days: 2, outbound_clicks: 1, outbound_tickets: 1, outbound_source: 0 }),
    ])
    assert.equal(t.views, 15)
    assert.equal(t.visitorDays, 6)
    assert.equal(t.clicks, 4)
    assert.equal(t.tickets, 3)
    assert.equal(t.source, 1)
  })

  it('the roll-up counts upcoming and past together', () => {
    // The tiles are the headline and the two tables are the detail beneath
    // them, so a row missing from the total would make the tables disagree
    // with the number they are supposed to explain.
    const t = totals([
      row({ event_id: 'a', page_views: 4, is_upcoming: true }),
      row({ event_id: 'b', page_views: 6, is_upcoming: false }),
    ])
    assert.equal(t.views, 10)
  })

  it('notBrokenOut is zero when the split is complete', () => {
    const t = totals([row({ outbound_clicks: 5, outbound_tickets: 3, outbound_source: 2 })])
    assert.equal(t.notBrokenOut, 0)
  })

  it('notBrokenOut carries the remainder when link_type is missing', () => {
    // 062: the tickets/source split can lag the total when GA's link_type
    // dimension is unregistered. Show the shortfall, never scale the split up.
    const t = totals([row({ outbound_clicks: 9, outbound_tickets: 0, outbound_source: 0 })])
    assert.equal(t.notBrokenOut, 9)
  })

  it('notBrokenOut is never negative', () => {
    const t = totals([row({ outbound_clicks: 2, outbound_tickets: 5, outbound_source: 5 })])
    assert.equal(t.notBrokenOut, 0)
  })

  it('empty input totals to zeros, not NaN', () => {
    const t = totals([])
    for (const v of Object.values(t)) assert.equal(v, 0)
  })
})

describe('emptyKind tells the two empty states apart', () => {
  it('no rows is no-events', () => {
    assert.equal(emptyKind([]), 'no-events')
  })

  it('rows that are all zero is no-measured-traffic, NOT null', () => {
    // This is the state both live tenants are in. It has to be
    // distinguishable from "you have no events": the words and the next action
    // are different, and rendering a blank panel here would tell them we do
    // not know about their events, which is false.
    assert.equal(emptyKind([row(), row({ event_id: 'e2' })]), 'no-measured-traffic')
  })

  it('an upcoming event with nothing measured is still no-measured-traffic', () => {
    // The upcoming branch means rows now arrive for events that have never
    // been measured at all. That is the common case for a new partner, and it
    // must not read as "no events".
    assert.equal(emptyKind([row({ is_upcoming: true })]), 'no-measured-traffic')
  })

  it('any positive figure means not empty', () => {
    assert.equal(emptyKind([row({ page_views: 1 })]), null)
    assert.equal(emptyKind([row({ visitor_days: 1 })]), null)
    assert.equal(emptyKind([row({ outbound_clicks: 1 })]), null)
  })
})

describe('partitionRows splits the two tables', () => {
  const rows = [
    row({ event_id: 'a', is_upcoming: true }),
    row({ event_id: 'b', is_upcoming: false }),
    row({ event_id: 'c', is_upcoming: true }),
  ]

  it('sorts every row into exactly one section', () => {
    const { upcoming, past } = partitionRows(rows)
    assert.deepEqual(upcoming.map((r) => r.event_id), ['a', 'c'])
    assert.deepEqual(past.map((r) => r.event_id), ['b'])
    assert.equal(upcoming.length + past.length, rows.length,
      'every row the RPC returns has to land in a table. A row in neither section is an event we told the ' +
      'partner nothing about while still counting it in the roll-up above.')
  })

  it('keeps the RPC order inside each section', () => {
    assert.deepEqual(partitionRows(rows).upcoming.map((r) => r.event_id), ['a', 'c'])
  })

  it('trusts the flag rather than re-deriving it from start_at', () => {
    // The RPC compares start_at against EASTERN today. Re-deriving it in the
    // browser would give a different answer for up to five hours a day, and
    // the wrong one would be the client's.
    const past = row({ event_id: 'x', start_at: '2099-01-01T00:00:00.000Z', is_upcoming: false })
    assert.equal(partitionRows([past]).past.length, 1)
    assert.equal(partitionRows([past]).upcoming.length, 0)
  })

  it('handles an empty result without inventing a section', () => {
    const { upcoming, past } = partitionRows([])
    assert.deepEqual(upcoming, [])
    assert.deepEqual(past, [])
  })
})

describe('the views definition break is disclosed', () => {
  it('a window reaching back before the break says so', () => {
    assert.equal(crossesViewsBreak('2026-05-27'), true)
    assert.equal(crossesViewsBreak('2026-08-12'), true)
  })

  it('a window starting on or after the break does not', () => {
    assert.equal(crossesViewsBreak(VIEWS_BREAK_DATE), false)
    assert.equal(crossesViewsBreak('2026-08-20'), false)
  })

  it('all time always crosses it, so the note is not optional', () => {
    // Views is the headline figure now. Before 2026-08-13 a filter change fired
    // a page_view, so views from before then are an OVERCOUNT, which is the one
    // direction the floor note does not cover.
    assert.equal(crossesViewsBreak(metricWindow('all', '2026-12-01').from), true)
  })
})

describe('sortRows', () => {
  const rows = [
    row({ event_id: 'a', title: 'Beta',  outbound_clicks: 1, page_views: 9 }),
    row({ event_id: 'b', title: 'Alpha', outbound_clicks: 5, page_views: 2 }),
    row({ event_id: 'c', title: 'Gamma', outbound_clicks: 5, page_views: 7 }),
  ]

  it('sorts numerically both directions', () => {
    assert.deepEqual(sortRows(rows, 'outbound_clicks', 'desc').map((r) => r.event_id), ['b', 'c', 'a'])
    assert.deepEqual(sortRows(rows, 'outbound_clicks', 'asc').map((r) => r.event_id), ['a', 'b', 'c'])
  })

  it('is stable on ties, so the RPC order survives underneath', () => {
    assert.deepEqual(sortRows(rows, 'outbound_clicks', 'desc').slice(0, 2).map((r) => r.event_id), ['b', 'c'])
  })

  it('sorts titles alphabetically', () => {
    assert.deepEqual(sortRows(rows, 'title', 'asc').map((r) => r.title), ['Alpha', 'Beta', 'Gamma'])
  })

  it('does not mutate its input', () => {
    const before = rows.map((r) => r.event_id)
    sortRows(rows, 'page_views', 'asc')
    assert.deepEqual(rows.map((r) => r.event_id), before)
  })

  it('tolerates a null start_at', () => {
    const withNull = [row({ event_id: 'x', start_at: null }), row({ event_id: 'y' })]
    assert.equal(sortRows(withNull, 'start_at', 'asc').length, 2)
  })

  it('every SORT_KEYS entry names a real field on a row', () => {
    const sample = row()
    for (const k of SORT_KEYS) {
      assert.ok(k in sample, `SORT_KEYS has "${k}", which is not a column the RPC returns`)
    }
  })

  it('each section starts from a sort its own question asks for', () => {
    // Upcoming is chronological (what is next), past is busiest first (what
    // worked). Both keys have to be sortable keys or the header click that
    // first toggles them throws.
    assert.equal(UPCOMING_SORT.key, 'start_at')
    assert.equal(UPCOMING_SORT.dir, 'asc')
    assert.equal(PAST_SORT.key, 'page_views')
    assert.equal(PAST_SORT.dir, 'desc')
    assert.ok(SORT_KEYS.includes(UPCOMING_SORT.key))
    assert.ok(SORT_KEYS.includes(PAST_SORT.key))
  })
})

describe('the honesty rules survive in the component', () => {
  const comp = read('src/components/admin/OrgAnalytics.tsx')

  it('renders the floor note as text, never only in a title attribute', () => {
    assert.ok(comp.includes('{FLOOR_NOTE}'), 'OrgAnalytics must render FLOOR_NOTE in a text position')
    assert.ok(
      !/title=\{?FLOOR_NOTE/.test(comp),
      'FLOOR_NOTE must not live in a tooltip. A caveat nobody opens is a caveat nobody read, and this ' +
        'one is the reason the feature is allowed to show numbers at all.',
    )
  })

  it('gates the counted-how row on the denial ONLY, never on there being numbers', () => {
    // The floor note lives in the counted-how <details> since the 2026-08-25
    // hierarchy pass. What has to hold is unchanged: move that row inside the
    // block that renders the tiles and it vanishes from both empty states and
    // the error state while every other guard here still passes. Zero is a
    // floor too, and it is the number most likely to be read as fact.
    const row = comp.indexOf('{state !== \'denied\' && (')
    const details = comp.indexOf('<details className="ashell-an-counted">')
    assert.ok(row > -1, 'the counted-how row must be guarded by the denial check and nothing else')
    assert.ok(details > row && details - row < 200,
      'and that guard has to be the one wrapping the <details>, not some other block')
    assert.ok(comp.indexOf('{FLOOR_NOTE}') > details,
      'FLOOR_NOTE belongs inside that row')
  })

  it('keeps the caveats on the page, never behind a tooltip or a link away', () => {
    // <details> is the layer-two device the OSR dashboard guidance calls for:
    // in the document, in the flow, findable by ctrl-F, one click from the
    // number. A title attribute or an href would be neither.
    assert.ok(comp.includes('<details className="ashell-an-counted">'))
    assert.ok(!/href=/.test(comp), 'no caveat may be a link off this surface')
  })

  it('puts the views warning ON the number it is about, not near it', () => {
    // A correction below the figure does not un-say a claim already made, and
    // a paragraph above it is read before the reader knows what it applies to.
    // The warning is a chip on the views tile, fed by the break check.
    assert.ok(/caution=\{broken \? VIEWS_BREAK_CHIP : null\}/.test(comp),
      'the views tile must carry the break warning itself, conditioned on the window crossing it')
    const caution = comp.indexOf('caution={broken')
    const tile = comp.indexOf('figure={viewsFigure(')
    assert.ok(caution > -1 && tile > -1 && Math.abs(tile - caution) < 400,
      'and the chip has to be on the SAME tile as the views figure')
    assert.ok(!/caution=/.test(comp.split('floorFigure(')[1] ?? ''),
      'no other tile carries a break warning: the break is about views only')
  })

  it('builds every tile through a figure helper rather than a bare number', () => {
    assert.ok(comp.includes('figure={floorFigure('), 'tiles take a Figure, so the decision about what a ' +
      'number claims is made once in analyticsShared and cannot be made differently here')
    assert.ok(comp.includes('figure={viewsFigure('), 'and views takes the helper that knows about the break')
    assert.ok(!/noun=\{/.test(comp), 'a tile that still takes a noun is a tile still formatting its own number')
  })

  it('keeps the two sections independent across an org or window change', () => {
    // Sort and page live inside each section. The key is what resets them: drop
    // `days` from it and a reader who sorted the past table by title, moved to
    // page 3, then switched to a 7 day window keeps page 3 of a sort that no
    // longer matches what is on screen.
    assert.ok(/key=\{`up-\$\{orgId\}-\$\{days\}`\}/.test(comp),
      'the upcoming section key must carry BOTH the org and the window')
    assert.ok(/key=\{`past-\$\{orgId\}-\$\{days\}`\}/.test(comp),
      'and so must the past section key')
  })

  it('clamps the page index during render rather than after it', () => {
    // Pagination renders nothing below one page, so a stale index on a section
    // that shrank strands the reader on an empty table with no control back.
    assert.ok(/const safePage = Math\.min\(page, lastPage\)/.test(comp))
    assert.ok(/page=\{safePage\}/.test(comp), 'and the control has to be handed the clamped index too')
  })

  it('never shows a section its empty copy while the load is still in flight', () => {
    // "Nothing on your calendar in the next 90 days" is a factual claim. Said
    // over a pending request it is a claim about data nobody has yet.
    assert.ok(/!loading && rows\.length === 0 && <p className="admin-hint" role="status">/.test(comp))
  })

  it('announces the empty states instead of swapping them in silently', () => {
    const statuses = (comp.match(/role="status"/g) ?? []).length
    assert.ok(statuses >= 3, `only ${statuses} role="status" in the component. Every empty state here ` +
      'replaces a table that was on screen a moment ago.')
  })

  it('never renders one org or window over another one\'s numbers', () => {
    const hook = read('src/lib/admin/useOrgMetrics.ts')
    assert.ok(/settledFor/.test(hook) && /settledFor\.current === key/.test(hook),
      'setState(loading) happens in an effect, and a passive effect is not guaranteed to run before paint, ' +
      'so without a key comparison during render there is a committed frame showing the previous org\'s ' +
      'numbers under the new org name and the new window heading.')
  })

  it('renders the visitor-days note as text', () => {
    assert.ok(comp.includes('{VISITOR_DAYS_NOTE}'))
    assert.ok(!/title=\{?VISITOR_DAYS_NOTE/.test(comp))
  })

  it('discloses the views break wherever a window reaches back past it', () => {
    assert.ok(comp.includes('crossesViewsBreak('), 'the component must ASK whether the window crosses the break')
    assert.ok(comp.includes('{VIEWS_BREAK_NOTE}'), 'and it must render the note when it does. Views is the ' +
      'headline figure, and before 2026-08-13 it was an overcount, which the floor note does not cover.')
    assert.ok(!/title=\{?VIEWS_BREAK_NOTE/.test(comp))
  })

  it('formats every number through floorNum, never toLocaleString directly', () => {
    assert.ok(
      !comp.includes('toLocaleString'),
      'OrgAnalytics must not call toLocaleString. floorNum in analyticsShared.ts is the only place a count ' +
        'becomes a string, which is what guarantees no figure reaches the screen without its marker.',
    )
  })

  // The negative check above is not enough on its own: strip every floorNum
  // and floorLabel call out of the component and it still passes, because
  // "does not call toLocaleString" is also true of a component that renders
  // every number bare. These are the positive counterparts.
  it('actually applies the marker and the accessible name', () => {
    assert.ok(comp.includes('floorNum('), 'OrgAnalytics must call floorNum, or nothing carries the tilde')
    assert.ok(comp.includes('floorLabel('), 'OrgAnalytics must call floorLabel, or no figure has an accessible name')
  })

  it('no metric field reaches JSX without passing through floorNum', () => {
    const raw = comp.match(/\{\s*[a-z]\.(page_views|visitor_days|outbound_clicks|outbound_tickets|outbound_source)\s*\}/g)
    assert.deepEqual(raw ?? [], [], 'a metric field is rendered directly: ' + (raw ?? []).join(', '))
  })

  it('every rendered figure gets both the tilde and the accessible name', () => {
    const nums = (comp.match(/floorNum\(/g) ?? []).length
    const labels = (comp.match(/floorLabel\(/g) ?? []).length
    assert.equal(nums, labels,
      `${nums} floorNum call(s) but ${labels} floorLabel call(s). Every figure needs both: the tilde for ` +
      'anyone reading the screen, the "at least" for anyone hearing it.')
  })

  it('the headline figures name themselves somewhere a screen reader will read', () => {
    // aria-label on a role-less <span> is ignored by browsers and AT, so the
    // visually-hidden twin is what actually carries the name.
    assert.ok(
      comp.includes('className="sr-only"'),
      'the headline figures must carry their floorLabel in an sr-only element. An aria-label on a bare ' +
        '<span> is dropped, which silently removes "at least" from the biggest numbers on the page.',
    )
  })

  it('renders both event sections and hides neither', () => {
    assert.ok(comp.includes('{UPCOMING_TITLE}') || comp.includes('title={UPCOMING_TITLE}'))
    assert.ok(comp.includes('{PAST_TITLE}') || comp.includes('title={PAST_TITLE}'))
    assert.ok(comp.includes('partitionRows('), 'the two sections come from partitionRows, not from a filter ' +
      'written inline that can drift from the flag the RPC set')
    assert.ok(!/showPast|hidePast|collapsedPast/i.test(comp),
      'past events are a section, never a disclosure. An event that already happened is the only kind whose ' +
      'numbers are final, so hiding it hides the only settled data on the page.')
  })

  it('never labels visitor days as people', () => {
    for (const bad of ['>Users<', '>Visitors<', '>People<', '>Unique<', 'label="Users"', 'label="Visitors"', 'label="People"']) {
      assert.ok(!comp.includes(bad), `OrgAnalytics uses "${bad}". Visitor days counts a person once per DAY, ` +
        'so any of these labels overstates it and the overstatement is invisible.')
    }
    const shared = read('src/lib/admin/analyticsShared.ts')
    assert.ok(shared.includes("label: 'Visitor days'"))
  })

  it('has no em dash in any string it renders', () => {
    assert.ok(!comp.includes('—'), 'no em dashes in user-facing copy (house rule)')
  })

  it('the copy module has no em dash either', () => {
    const shared = read('src/lib/admin/analyticsShared.ts')
    assert.ok(!shared.includes('—'))
  })

  it('treats a failed load as an error and never as an empty state', () => {
    const hook = read('src/lib/admin/useOrgMetrics.ts')
    assert.ok(/'denied'/.test(hook) && /'error'/.test(hook) && /isDenial/.test(hook),
      'useOrgMetrics must distinguish a denial from a transport failure, and neither may fall through to ' +
      'a zero. Zero is a legitimate answer here, so rendering a failure as zero is a quiet lie.')
  })

  it('sends the forward window explicitly rather than trusting the server default', () => {
    const hook = read('src/lib/admin/useOrgMetrics.ts')
    assert.ok(/p_upcoming_days:\s*UPCOMING_DAYS/.test(hook),
      'the copy promises the next 90 days. If the argument is left to the server default, the promise and ' +
      'the query can drift apart with nothing failing.')
  })
})

describe('the live migration keeps 062 closed', () => {
  // Comments stripped: the header quotes 062's own "grant select on
  // page_metrics_daily" line while explaining why this migration does NOT do
  // that, and scanning the explanation would fail on the explanation.
  const sql = read('supabase/migrations/064_partner_metrics_upcoming.sql')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')

  it('revokes execute from anon by name', () => {
    // Supabase default privileges grant EXECUTE to anon directly, so revoking
    // from public alone leaves anon holding it.
    assert.ok(/revoke all on function partner_event_metrics[\s\S]*?anon/i.test(sql))
  })

  it('grants execute to authenticated', () => {
    assert.ok(/grant execute on function partner_event_metrics[\s\S]*?to authenticated/i.test(sql))
  })

  it('grants and revokes on the four argument signature, not the old three', () => {
    assert.ok(/grant execute on function partner_event_metrics\(uuid, date, date, int\)/i.test(sql),
      'a grant written against the dropped three-argument signature fails outright, and one written against ' +
      'no signature is ambiguous')
  })

  it('drops the superseded three argument function', () => {
    assert.ok(/drop function if exists partner_event_metrics\(uuid, date, date\)/i.test(sql),
      'leaving both signatures in place makes every call ambiguous')
  })

  it('grants nothing on the metrics tables and creates no policy', () => {
    assert.ok(
      !/grant\s+select[\s\S]*?(site_metrics_daily|page_metrics_daily|embed_metrics_daily)/i.test(sql),
      'this migration must not grant select on the metrics tables. 062 deliberately withheld that, and the ' +
        'RPC exists so it can stay withheld.',
    )
    assert.ok(!/create\s+policy/i.test(sql), 'this migration must not create any policy')
  })

  it('raises on an unauthorized org rather than returning zero rows', () => {
    assert.ok(/raise exception[\s\S]*?insufficient_privilege/i.test(sql),
      'the refusal must be a raise. Zero rows is this feature\'s honest empty state, so a silent refusal ' +
      'would be indistinguishable from the truth.')
  })

  it('rejects a null org before the scope check, which three-valued logic would swallow', () => {
    const guard = sql.indexOf('p_org is null')
    const gate = sql.indexOf('partner_scope()')
    assert.ok(guard > -1, 'a null p_org makes `null = any(scope)` evaluate to NULL, so `if not (NULL or ' +
      'is_admin())` takes the ELSE branch and the raise never fires. Check for null FIRST.')
    assert.ok(guard < gate, 'the null check has to come BEFORE the scope gate, not after it')
  })

  it('rejects a null forward window rather than treating it as the default', () => {
    assert.ok(/p_upcoming_days is null/i.test(sql),
      'the default only applies when the argument is OMITTED. An explicitly null p_upcoming_days would make ' +
      'every comparison against it NULL, so the forward branch would silently match nothing.')
  })

  it('bounds all three branches, in Eastern', () => {
    assert.ok(/s\.start_at\s*<\s*\(\(p_to \+ 1\)/.test(sql),
      'an unbounded backward start_at branch returns every event in history')
    assert.ok(/s\.start_at\s*<\s*v_up_ts/.test(sql),
      'the upcoming branch needs an upper bound too. Unbounded, one org returned 1,763 rows for a 30-day ' +
      'window, 95% of them zero-filled future events.')
    assert.ok(/p_upcoming_days\s*>\s*400/.test(sql), 'and the forward argument itself has to be capped')
    assert.ok(/America\/New_York/.test(sql),
      'a bare ::timestamptz anchors at UTC midnight, which is 8pm the previous Eastern evening')
  })

  it('derives today in Eastern, never in UTC', () => {
    assert.ok(/now\(\) at time zone 'America\/New_York'/i.test(sql),
      'a UTC today moves an event from upcoming to past up to five hours early')
  })

  it('flags each row rather than making the client guess', () => {
    assert.ok(/is_upcoming\s+boolean/i.test(sql), 'the split has to come back from the server, because the ' +
      'server is where "today" is decided')
  })

  it('leaves room for the all time window to grow', () => {
    assert.ok(/p_to - p_from\)\s*>\s*1200/.test(sql),
      'all time is TRACKING_START through yesterday and grows by a day every day. At the old 400-day cap it ' +
      'would have started raising a load error in mid-2027.')
  })

  it('aggregates by event_id', () => {
    assert.ok(/group by p\.event_id/i.test(sql),
      'renaming an event changes the date-suffixed slug in its URL, so GA reports two page_paths for one ' +
      'uuid on the same day. One row per event-day is an assumption production already violates.')
  })

  it('calls partner_scope() rather than re-deriving the membership join', () => {
    assert.ok(/partner_scope\(\)/.test(sql))
    assert.ok(!/from\s+partner_memberships/i.test(sql),
      'partner_scope() carries the p.active filter; a hand-rolled join drops it and un-suspends a ' +
      'suspended tenant\'s analytics.')
  })

  it('truncates nothing, because the client totals what it is handed', () => {
    assert.ok(!/\blimit\s+\d+/i.test(sql),
      'a row cap here would silently shrink the roll-up above the tables. If a library-sized tenant ever ' +
      'signs up, move the totals into their own RPC FIRST, then cap the list.')
  })

  it('has a rollback that lives outside supabase/migrations', () => {
    assert.ok(exists('supabase/rollbacks/064_partner_metrics_upcoming_rollback.sql'))
    assert.ok(!exists('supabase/migrations/064_partner_metrics_upcoming_rollback.sql'),
      'a rollback inside supabase/migrations is a file the CLI will APPLY')
  })

  it('the rollback restores the signature it replaced', () => {
    const back = read('supabase/rollbacks/064_partner_metrics_upcoming_rollback.sql')
    assert.ok(/drop function if exists partner_event_metrics\(uuid, date, date, int\)/i.test(back))
    assert.ok(/create or replace function partner_event_metrics\([\s\S]*?p_to\s+date\s*\)/i.test(back),
      'rolling back has to leave a working three-argument function behind, not just remove the four-argument one')
  })
})

describe('the loader is actually scheduled', () => {
  const WF = '.github/workflows/nightly-ga-metrics.yml'

  it('a workflow runs scripts/ga-to-db.js', () => {
    assert.ok(exists(WF), `${WF} is missing. Without a scheduled loader the metrics tables stop growing and ` +
      'this whole surface quietly freezes on its last good day, which nothing goes red about.')
    assert.ok(read(WF).includes('scripts/ga-to-db.js'))
  })

  it('that workflow passes all four env vars the loader needs', () => {
    const wf = read(WF)
    for (const key of ['GA4_PROPERTY_ID', 'GA4_SA_KEY_B64', 'VITE_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
      assert.ok(wf.includes(key), `${WF} does not pass ${key}, so the loader cannot do its job`)
    }
  })

  it('the loader script it names exists', () => {
    assert.ok(exists('scripts/ga-to-db.js'))
  })
})

describe('copy is the plain kind', () => {
  it('the floor note says minimum in words, not just a symbol', () => {
    assert.ok(/minimum/i.test(FLOOR_NOTE))
    assert.ok(/blocker/i.test(FLOOR_NOTE))
  })

  it('the visitor-days note explains the once-per-day rule', () => {
    assert.ok(/once per day/i.test(VISITOR_DAYS_NOTE))
  })

  it('the upcoming copy promises exactly the horizon the query asks for', () => {
    // The note and the RPC argument are two constants. Change one and the
    // product promises a window it never queried, with nothing failing.
    assert.ok(UPCOMING_NOTE.includes(`${UPCOMING_DAYS} days`))
    assert.ok(NO_UPCOMING_NOTE.includes(`${UPCOMING_DAYS} days`))
  })

  it('the upcoming copy also admits the events beyond that horizon', () => {
    // is_upcoming means "has not happened yet", not "inside the forward
    // window": an event further out that people are already looking at comes
    // back through the measured branch and lands in this section. Calling it
    // "already happened" to keep the flag inside 90 days would be a lie about
    // time, so the copy carries the horizon instead.
    assert.ok(/further out/i.test(UPCOMING_NOTE),
      'the section lists more than the next ' + UPCOMING_DAYS + ' days, and has to say so')
  })
})
