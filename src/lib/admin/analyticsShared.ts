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
 */

import { easternTodayIso } from '../easternDate.ts'

/** GA4 data for this property starts here. Nothing before it exists to query. */
export const TRACKING_START = '2026-05-27'

/** Window sizes the UI offers, in days. 30 is the default, see metricWindow. */
export const WINDOW_OPTIONS = [7, 30, 90] as const
export type WindowDays = (typeof WINDOW_OPTIONS)[number]
export const DEFAULT_WINDOW: WindowDays = 30

/** Table page size. Sorting happens over the whole result, not the page. */
export const ROWS_PER_PAGE = 50

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

/**
 * The date window to ask the RPC for.
 *
 * Ends YESTERDAY, never today. ga-to-db.js never writes today (today is a
 * partial day that keeps growing), so a window including it would always show
 * a guaranteed-empty final day that reads as an outage.
 *
 * 30 days is the default rather than 7 for two reasons. GA4 keeps revising a
 * day for roughly 48 hours after it closes, which is under 7% of a 30-day
 * window and 29% of a 7-day one, so the shorter window visibly wobbles between
 * refreshes. And this corpus is weekly and monthly programming: a 7-day window
 * on a small partner's cadence often contains no events at all, which is a
 * worse answer than an honest zero.
 *
 * `todayIso` is injectable so tests can pin a date without pinning the clock.
 */
export function metricWindow(days: number, todayIso: string = easternTodayIso()): MetricWindow {
  const to = shiftDays(todayIso, -1)
  const rawFrom = shiftDays(to, -(days - 1))
  const clamped = rawFrom < TRACKING_START
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

export type EmptyKind = 'no-events' | 'no-measured-traffic' | null

/**
 * Which empty state this is, if any. The discriminator is NOT "is the array
 * empty", and that distinction is the whole reason this function exists.
 *
 * no-events: nothing to measure. no-measured-traffic: there are events and
 * every figure is zero, which is the state the first real partner is in right
 * now. They need different words and different next actions.
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
 * Client-side sort over the page the RPC returned. It is not small by
 * construction: the largest org in prod returns about 140 rows for a 30-day
 * window, which is why the table paginates. Stable on ties:
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

export const FLOOR_NOTE =
  'These come from Google Analytics, so read every number as a minimum. Ad blockers and privacy settings stop a lot of visits from ever being counted, which means the real numbers are higher than what you see here. The last couple of days are still settling.'

export const VISITOR_DAYS_NOTE =
  'Visitor days counts a person once per day, so somebody who comes back on three days counts three times. If an event was renamed partway through, a visitor can also land on both versions of its address in one day and be counted twice. Treat it as a shape, not a headcount.'

export const NO_EVENTS_NOTE =
  'No events in this window, so there is nothing to measure yet. Add an event or widen the window.'

export const NO_TRAFFIC_NOTE =
  'Nothing measured yet for these events. That does not mean nobody looked. It means Google Analytics has not recorded a visit to these pages in this window.'

export const DENIED_NOTE =
  'This account cannot see that organization right now. If that is a surprise, your access may have changed since you signed in. Sign out and back in, and email us if it persists.'

export const LOAD_ERROR_NOTE =
  'Could not load your numbers. This is a problem on our end, not a zero.'

export const HEADLINE_LABELS = {
  clicks: { label: 'Handoffs', sub: 'people we sent to your links', noun: 'handoffs' },
  tickets: { label: 'Tickets', sub: 'clicks on a ticket link', noun: 'ticket clicks' },
  source: { label: 'Your site', sub: 'clicks through to your own page', noun: 'clicks to your site' },
  notBrokenOut: { label: 'Not broken out', sub: 'clicks we could not split', noun: 'unsplit clicks' },
} as const
