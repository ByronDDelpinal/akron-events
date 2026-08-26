/**
 * analyticsShared.ts
 *
 * Every pure decision the partner analytics block makes, plus every string it
 * says. No React, no Supabase, no DOM, imports nothing but easternDate.ts, so
 * `node --test` can import it directly the way test-partner-ui.js imports
 * partnerShared.ts.
 *
 * The copy lives here rather than inline in the component for one reason: the
 * honesty rules below are the point of this feature, and a rule that lives in
 * one named export is a rule a test can pin. scripts/tests/test-org-analytics.js
 * pins them.
 *
 * ── THE HONESTY RULES ───────────────────────────────────────────────────────
 *
 * Every number this feature shows a partner is a FLOOR, not a count. Ad
 * blockers and tracking protection drop the GA beacon outright, and the
 * maintainer's own browser network-blocks google-analytics.com, so a partner
 * who visits their own event page and then sees 0 is looking at a true
 * statement about GA and a false one about the world. The moment the product
 * says "we sent you 412 clicks" as a fact, Akron Pulse owns that number's
 * accuracy, and it cannot.
 *
 * So: the tilde is inside the number (floorNum), the words "at least" reach a
 * screen reader (floorLabel), the note is permanently visible in every state
 * including the empty ones, and nothing is ever scaled, grossed up or
 * corrected. An invented correction factor would be worse than an honest
 * undercount. Where the tickets/source split does not add up to the total, the
 * remainder is shown as its own labelled figure rather than hidden or scaled
 * away.
 *
 * ── WHAT THE BLOCK SHOWS, AND WHY IT IS SHAPED THIS WAY ─────────────────────
 *
 * The org roll-up leads and the per-event tables follow. That order is not a
 * layout preference, it is what the data supports. Measured 2026-08-24: 62% of
 * published events in a 30-day window have no measured view at all, the median
 * event that IS measured has 3 views, and both live tenants have zero measured
 * rows across every event they have ever run. A per-event table cannot be the
 * headline when the per-event grain is mostly zero. The roll-up is the first
 * number on this surface that is reliably not zero.
 *
 * Two tables, upcoming above past, and nothing is hidden. An event with nothing
 * measured still gets a row carrying zeros, because "we have never counted a
 * visit to this page" is a fact worth showing and an absent row is not.
 */

import { easternTodayIso } from '../easternDate.ts'

/** GA4 data for this property starts here. Nothing before it exists to query. */
export const TRACKING_START = '2026-05-27'

/**
 * Window sizes the UI offers. 'all' means TRACKING_START through yesterday.
 *
 * 90 is the default rather than 30 or 7. This corpus is weekly and monthly
 * programming on a site whose busiest day carries about 25 outbound clicks in
 * total, so a short window on a small partner's cadence contains too little to
 * read as anything. A number that moves because one person clicked twice is
 * not a signal, and offering it as the default invites reading it as one.
 */
export const WINDOW_OPTIONS = [7, 30, 90, 'all'] as const
export type WindowChoice = (typeof WINDOW_OPTIONS)[number]
export const DEFAULT_WINDOW: WindowChoice = 90

/**
 * How far forward the upcoming section looks, in days, passed to the RPC as
 * p_upcoming_days. Bounded on purpose: an unbounded forward branch returned
 * 1,763 rows for one org before 063 closed it, and 064 caps the argument at
 * 400 server side.
 */
export const UPCOMING_DAYS = 90

/** Table page size, per section. Sorting happens over the whole section. */
export const ROWS_PER_PAGE = 50

/**
 * The day the meaning of page_views changed.
 *
 * Before this date App.tsx fired a GA page_view on every filter change, not
 * only on a real navigation (fixed in c156504). Event-page views before it run
 * about 20% high against the same visitor days. Views is the headline figure
 * now, so any window reaching back past this date has to say so: it is the one
 * number on this surface that is not a floor, it is an overcount.
 */
export const VIEWS_BREAK_DATE = '2026-08-13'

/** The same day in prose, for copy. Kept beside the ISO one so they cannot drift. */
export const VIEWS_BREAK_LABEL = 'August 13, 2026'

/** And the tile-chip form, which has about twenty characters to work with. */
export const VIEWS_BREAK_SHORT = 'Aug 13'

export function crossesViewsBreak(from: string): boolean {
  return from < VIEWS_BREAK_DATE
}

export interface MetricRow {
  event_id: string
  title: string
  start_at: string | null
  status: string | null
  page_views: number
  visitor_days: number
  outbound_clicks: number
  outbound_tickets: number
  outbound_source: number
  /** Set by the RPC against Eastern today, never re-derived in the client. */
  is_upcoming: boolean
}

export interface MetricWindow {
  /** Inclusive first date, yyyy-MM-dd. */
  from: string
  /** Inclusive last date, yyyy-MM-dd. Always yesterday, never today. */
  to: string
  /** True when `from` was pulled forward to TRACKING_START. */
  clamped: boolean
}

// Plain yyyy-MM-dd arithmetic through Date.UTC, which has no timezone to get
// wrong. The only place a real "now" enters is easternTodayIso().
function shiftDays(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d) + delta * 86_400_000
  const out = new Date(t)
  const mm = String(out.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(out.getUTCDate()).padStart(2, '0')
  return `${out.getUTCFullYear()}-${mm}-${dd}`
}

/** The label on a window button. */
export function windowLabel(choice: WindowChoice): string {
  return choice === 'all' ? 'All time' : `${choice} days`
}

/**
 * The date window to ask the RPC for.
 *
 * Ends YESTERDAY, never today. ga-to-db.js never writes today (today is a
 * partial day that keeps growing), so a window including it would always show
 * a guaranteed-empty final day that reads as an outage.
 *
 * 'all' starts at TRACKING_START, which is also where every other choice
 * clamps. That range grows by a day every day; 064 raised the server-side cap
 * to 1200 days so it has somewhere to grow into.
 *
 * `todayIso` is injectable so tests can pin a date without pinning the clock.
 */
export function metricWindow(
  days: WindowChoice,
  todayIso: string = easternTodayIso(),
): MetricWindow {
  const to = shiftDays(todayIso, -1)
  const rawFrom = days === 'all' ? TRACKING_START : shiftDays(to, -(days - 1))
  const clamped = rawFrom <= TRACKING_START
  // The floor is TRACKING_START, but never past `to`: the RPC rejects a window
  // whose end precedes its start, and a caller asking for a range entirely
  // before tracking began should get an empty window, not an error.
  const from = clamped ? (TRACKING_START > to ? to : TRACKING_START) : rawFrom
  return { from, to, clamped }
}

/**
 * A count, rendered as the floor it is: `~412`.
 *
 * The tilde goes INSIDE the number, not beside it, because a partner
 * screenshots a table cell as readily as a headline and the marker has to
 * survive the crop. Zero renders bare: `~0` reads as "about zero", which is
 * weaker than the truth, and zero is the number most likely to be misread as
 * fact.
 *
 * This is the ONLY place a number becomes a string in this feature. The guard
 * test forbids toLocaleString anywhere else, so no figure can escape untagged.
 */
export function floorNum(n: number): string {
  return n > 0 ? `~${n.toLocaleString('en-US')}` : '0'
}

/**
 * The same number for a screen reader, which would otherwise announce the
 * tilde as "tilde" or drop it entirely.
 */
export function floorLabel(n: number, noun: string): string {
  return `at least ${n.toLocaleString('en-US')} ${noun}`
}

/**
 * A figure ready to render: the string a reader sees, and the string a screen
 * reader hears. They are built together, in here, so a tile cannot end up with
 * one and not the other.
 */
export interface Figure {
  text: string
  label: string
}

export function floorFigure(n: number, noun: string): Figure {
  return { text: floorNum(n), label: floorLabel(n, noun) }
}

/**
 * Views, which is the only figure on this surface that is NOT always a floor.
 *
 * Before VIEWS_BREAK_DATE a filter change fired a page_view, so views from
 * before then are an overcount, and "at least N" would be the one claim here
 * that runs in the wrong direction. When the window reaches back past that
 * day the tilde and the "at least" both come off and the figure says what it
 * actually is. It is never scaled or corrected: an invented correction factor
 * would be worse than a number that explains itself.
 */
export function viewsFigure(n: number, noun: string, crossesBreak: boolean): Figure {
  if (!crossesBreak) return floorFigure(n, noun)
  const plain = n.toLocaleString('en-US')
  return {
    text: plain,
    label: `${plain} ${noun} counted, and views from before ${VIEWS_BREAK_LABEL} run high`,
  }
}

export interface MetricTotals {
  views: number
  visitorDays: number
  clicks: number
  tickets: number
  source: number
  /**
   * clicks - (tickets + source), floored at zero. 062 notes the split can lag
   * the total when GA's link_type dimension is unregistered. Shown as its own
   * figure when non-zero: never scale the split up to meet the total, never
   * hide the total to match the split.
   */
  notBrokenOut: number
}

/**
 * The org roll-up. Sums EVERY row the RPC returned, upcoming and past
 * together, which is the whole of what was measured for this org in this
 * window. 064 truncates nothing, and that is what makes this total exact
 * rather than "exact for the rows that fit".
 */
export function totals(rows: MetricRow[]): MetricTotals {
  const t = rows.reduce(
    (acc, r) => ({
      views: acc.views + r.page_views,
      visitorDays: acc.visitorDays + r.visitor_days,
      clicks: acc.clicks + r.outbound_clicks,
      tickets: acc.tickets + r.outbound_tickets,
      source: acc.source + r.outbound_source,
    }),
    { views: 0, visitorDays: 0, clicks: 0, tickets: 0, source: 0 },
  )
  return { ...t, notBrokenOut: Math.max(0, t.clicks - t.tickets - t.source) }
}

/**
 * Split the rows into the two tables the UI renders.
 *
 * The flag comes from the RPC, which compares start_at against Eastern today
 * server side. Deriving it again here would give two answers on either side of
 * midnight and one of them would be wrong for up to five hours.
 */
export function partitionRows(rows: MetricRow[]): { upcoming: MetricRow[]; past: MetricRow[] } {
  const upcoming: MetricRow[] = []
  const past: MetricRow[] = []
  for (const r of rows) (r.is_upcoming ? upcoming : past).push(r)
  return { upcoming, past }
}

export type EmptyKind = 'no-events' | 'no-measured-traffic' | null

/**
 * Which empty state this is, if any. The discriminator is NOT "is the array
 * empty", and that distinction is the whole reason this function exists.
 *
 * no-events: nothing to measure. no-measured-traffic: there are events and
 * every figure is zero, which is the state both live tenants are in right now.
 * They need different words and different next actions.
 */
export function emptyKind(rows: MetricRow[]): EmptyKind {
  if (rows.length === 0) return 'no-events'
  const anyNumber = rows.some(
    (r) => r.page_views > 0 || r.visitor_days > 0 || r.outbound_clicks > 0
      || r.outbound_tickets > 0 || r.outbound_source > 0,
  )
  return anyNumber ? null : 'no-measured-traffic'
}

export const SORT_KEYS = ['title', 'start_at', 'page_views', 'visitor_days', 'outbound_clicks'] as const
export type SortKey = (typeof SORT_KEYS)[number]
export type SortDir = 'asc' | 'desc'

/**
 * Where each section starts.
 *
 * Upcoming reads chronologically because the question there is "what is next
 * and is anybody finding it". Past reads busiest first because the question
 * there is "what worked".
 */
export const UPCOMING_SORT: { key: SortKey; dir: SortDir } = { key: 'start_at', dir: 'asc' }
export const PAST_SORT: { key: SortKey; dir: SortDir } = { key: 'page_views', dir: 'desc' }

/**
 * Client-side sort over one section. It is not small by construction: a
 * library-sized org returns about 1,300 upcoming rows for a 90-day window,
 * which is why each table paginates. Stable on ties:
 * Array.prototype.sort is stable in every engine we target, and the comparator
 * returns 0 rather than falling back to another key so the RPC's own order
 * survives underneath.
 */
export function sortRows(rows: MetricRow[], key: SortKey, dir: SortDir): MetricRow[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    if (key === 'title') return sign * a.title.localeCompare(b.title)
    if (key === 'start_at') {
      const av = a.start_at ?? ''
      const bv = b.start_at ?? ''
      if (av === bv) return 0
      return sign * (av < bv ? -1 : 1)
    }
    const av = a[key]
    const bv = b[key]
    if (av === bv) return 0
    return sign * (av < bv ? -1 : 1)
  })
}

// ── Copy ────────────────────────────────────────────────────────────────────
//
// Informal, plain, second person. "We" is Pulse, "you" is the partner. No em
// dashes. Never apologise for the numbers being low and never editorialise
// about them being good.
//
// And SHORT. A partner reads this surface to find a number, not to be taught
// how analytics works. Every note here is one or two sentences; if a caveat
// needs a third, the caveat is wrong, not the space it was given.

export const FLOOR_NOTE =
  'Read every number as a minimum. Ad blockers stop a lot of visits from being counted, and the last couple of days are still settling.'

export const VISITOR_DAYS_NOTE =
  'Visitor days counts a person once per day, so three days of visits count three times.'

export const VIEWS_BREAK_NOTE =
  `Views before ${VIEWS_BREAK_LABEL} run high: filter changes counted as views back then. Visitor days did not, so they compare better across that date.`

/**
 * The same warning, shrunk to ride ON the views tile.
 *
 * This is the layer-one half of the views break (OSR dashboard guidance: a
 * brief critical warning goes where the number is, the detail goes one
 * interaction away). It is deliberately not a summary of VIEWS_BREAK_NOTE --
 * it is the part a reader must not be able to miss while looking straight at
 * the figure. The full explanation lives under COUNTED_TITLE.
 */
export const VIEWS_BREAK_CHIP = `runs high before ${VIEWS_BREAK_SHORT}`

/**
 * The one row every caveat now lives behind. Named as a question a partner
 * would actually ask, not as "notes" or "about this data": the label has to
 * be worth the click on its own.
 */
export const COUNTED_TITLE = 'How these numbers are counted'

export const ROLLUP_NOTE =
  'Upcoming and past events, added together.'

export const NO_EVENTS_NOTE =
  'No events in this window. Add one, or widen the window.'

export const NO_TRAFFIC_NOTE =
  'No visits recorded for these events in this window.'

/**
 * The zero state's next step. Both live tenants sit at zero across every event
 * they have ever run, so this is the copy most partners actually read, and a
 * flat zero with nothing to do about it is where a partner stops coming back.
 * It says what makes a number move, without promising that it will.
 */
export const NO_TRAFFIC_NEXT =
  'Views count when somebody opens your event page. Handoffs count when they click through to your ticket or site link.'

/** The fold over the zero-filled tables. Nothing is hidden, only shut. */
export const SHOW_ANYWAY = 'Show every event anyway'

export const DENIED_NOTE =
  'This account cannot see that organization. Sign out and back in, and email us if it persists.'

export const LOAD_ERROR_NOTE =
  'Could not load your numbers. That is a problem on our end, not a zero.'

export const UPCOMING_TITLE = 'Coming up'
export const PAST_TITLE = 'Already happened'

export const UPCOMING_NOTE =
  `The next ${UPCOMING_DAYS} days, plus anything further out people are already viewing.`

export const PAST_NOTE =
  'Events already past, busiest first.'

export const NO_UPCOMING_NOTE =
  `Nothing scheduled in the next ${UPCOMING_DAYS} days.`

export const NO_PAST_NOTE =
  'None of your events happened in this window.'

/**
 * The roll-up tiles, in render order. Views leads: it is the most populated
 * honest figure here, and at two to twenty five outbound clicks a day across
 * the whole site a handoff headline reads zero most windows.
 *
 * Every `sub` is a fragment of four words or fewer on purpose. These render as
 * a row of equal-width tiles, and a sub long enough to wrap in one tile and not
 * the next is what made the row look broken.
 */
export const HEADLINE_LABELS = {
  // No `subBroken` twin any more: the break warning is VIEWS_BREAK_CHIP,
  // which renders as a caution chip on this tile whenever the window crosses
  // the break. One warning, on the number, in one place.
  views: { label: 'Views', sub: 'event pages opened', noun: 'views' },
  visitorDays: { label: 'Visitor days', sub: 'one per person daily', noun: 'visitor days' },
  clicks: { label: 'Handoffs', sub: 'sent to your links', noun: 'handoffs' },
  tickets: { label: 'Tickets', sub: 'ticket link clicks', noun: 'ticket clicks' },
  source: { label: 'Your site', sub: 'clicks to your site', noun: 'clicks to your site' },
  notBrokenOut: { label: 'Not broken out', sub: 'could not be split', noun: 'unsplit clicks' },
} as const
