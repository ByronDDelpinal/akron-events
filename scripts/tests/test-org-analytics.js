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
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_WINDOW,
  FLOOR_NOTE,
  SORT_KEYS,
  TRACKING_START,
  VISITOR_DAYS_NOTE,
  WINDOW_OPTIONS,
  emptyKind,
  floorLabel,
  floorNum,
  metricWindow,
  sortRows,
  totals,
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

  it('30 is the default and every offered option is a positive integer', () => {
    assert.equal(DEFAULT_WINDOW, 30)
    assert.ok(WINDOW_OPTIONS.includes(DEFAULT_WINDOW))
    for (const d of WINDOW_OPTIONS) assert.ok(Number.isInteger(d) && d > 0)
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
    // This is the state the first real partner is in. It has to be
    // distinguishable from "you have no events": the words and the next action
    // are different, and rendering a blank panel here would tell them we do
    // not know about their events, which is false.
    assert.equal(emptyKind([row(), row({ event_id: 'e2' })]), 'no-measured-traffic')
  })

  it('any positive figure means not empty', () => {
    assert.equal(emptyKind([row({ page_views: 1 })]), null)
    assert.equal(emptyKind([row({ visitor_days: 1 })]), null)
    assert.equal(emptyKind([row({ outbound_clicks: 1 })]), null)
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

  it('renders the visitor-days note as text', () => {
    assert.ok(comp.includes('{VISITOR_DAYS_NOTE}'))
    assert.ok(!/title=\{?VISITOR_DAYS_NOTE/.test(comp))
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
        '<span> is dropped, which silently removes "at least" from the four biggest numbers on the page.',
    )
  })

  it('never labels visitor days as people', () => {
    for (const bad of ['>Users<', '>Visitors<', '>People<', '>Unique<', 'label="Users"', 'label="Visitors"', 'label="People"']) {
      assert.ok(!comp.includes(bad), `OrgAnalytics uses "${bad}". Visitor days counts a person once per DAY, ` +
        'so any of these labels overstates it and the overstatement is invisible.')
    }
    assert.ok(comp.includes('Visitor days'))
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
})

describe('the migration keeps 062 closed', () => {
  // Comments stripped: the header quotes 062's own "grant select on
  // page_metrics_daily" line while explaining why this migration does NOT do
  // that, and scanning the explanation would fail on the explanation.
  const sql = read('supabase/migrations/063_partner_metrics_rpc.sql')
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

  it('grants nothing on the metrics tables and creates no policy', () => {
    assert.ok(
      !/grant\s+select[\s\S]*?(site_metrics_daily|page_metrics_daily|embed_metrics_daily)/i.test(sql),
      '063 must not grant select on the metrics tables. 062 deliberately withheld that, and the RPC exists ' +
        'so it can stay withheld.',
    )
    assert.ok(!/create\s+policy/i.test(sql), '063 must not create any policy')
  })

  it('raises on an unauthorized org rather than returning zero rows', () => {
    assert.ok(/raise exception[\s\S]*?insufficient_privilege/i.test(sql),
      'the refusal must be a raise. Zero rows is this feature\'s honest empty state, so a silent refusal ' +
      'would be indistinguishable from the truth.')
  })

  it('rejects a null org before the scope check, which three-valued logic would swallow', () => {
    assert.ok(/p_org is null/i.test(sql),
      'a null p_org makes `null = any(scope)` evaluate to NULL, so `if not (NULL or is_admin())` takes the ' +
      'ELSE branch and the raise never fires. The caller then gets zero rows, which is exactly the silent ' +
      'refusal this function exists to prevent. Check for null FIRST.')
  })

  it('bounds the start_at branch on both sides, in Eastern', () => {
    assert.ok(/s\.start_at\s*<\s*\(\(p_to \+ 1\)/.test(sql),
      'an unbounded start_at branch returns every future event the org ever scheduled regardless of the ' +
      'window; measured at 1,763 rows for the largest org before this bound was added')
    assert.ok(/America\/New_York/.test(sql),
      'a bare ::timestamptz anchors at UTC midnight, which is 8pm the previous Eastern evening')
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

  it('has a rollback that lives outside supabase/migrations', () => {
    assert.ok(exists('supabase/rollbacks/063_partner_metrics_rpc_rollback.sql'))
    assert.ok(!exists('supabase/migrations/063_partner_metrics_rpc_rollback.sql'),
      'a rollback inside supabase/migrations is a file the CLI will APPLY')
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
})
