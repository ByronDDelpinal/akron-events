import { useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { Pagination, StatusBadge } from '@/components/admin'
import { useOrgMetrics } from '@/lib/admin/useOrgMetrics'
import {
  DEFAULT_WINDOW,
  ROWS_PER_PAGE,
  COUNTED_TITLE,
  FLOOR_NOTE,
  HEADLINE_LABELS,
  LOAD_ERROR_NOTE,
  DENIED_NOTE,
  NO_EVENTS_NOTE,
  NO_PAST_NOTE,
  NO_TRAFFIC_NEXT,
  NO_TRAFFIC_NOTE,
  NO_UPCOMING_NOTE,
  PAST_NOTE,
  PAST_SORT,
  PAST_TITLE,
  ROLLUP_NOTE,
  SHOW_ANYWAY,
  TRACKING_START,
  UPCOMING_NOTE,
  UPCOMING_SORT,
  UPCOMING_TITLE,
  VIEWS_BREAK_CHIP,
  VIEWS_BREAK_NOTE,
  VISITOR_DAYS_NOTE,
  WINDOW_OPTIONS,
  crossesViewsBreak,
  emptyKind,
  floorFigure,
  floorLabel,
  floorNum,
  partitionRows,
  sortRows,
  totals,
  viewsFigure,
  windowLabel,
  type Figure,
  type MetricRow,
  type SortDir,
  type SortKey,
  type WindowChoice,
} from '@/lib/admin/analyticsShared'

interface OrgAnalyticsProps {
  /**
   * The orgs this block may show. PartnersPage passes exactly one.
   */
  orgs: { organization_id: string; name: string }[]
  /**
   * The page's scope, when the page has one. Non-null locks this block to
   * that org and hides its own switch: the page-level control is then the
   * only thing choosing an org, which is the whole point of passing it.
   * Null means "the page is showing everything", and since the RPC takes
   * exactly one org, the block picks one and offers a quiet switch.
   */
  focusId?: string | null
}

/**
 * OrgAnalytics -- the partner traffic block, rendered in exactly two places:
 * PartnerHomePage (a partner looking at their own orgs) and the expanded
 * tenant card on PartnersPage (an admin looking at one org).
 *
 * There is no isAdmin prop and no mode flag on purpose. The admin case is the
 * one-element case, and the RPC decides server side whether the caller may see
 * the org it was handed. That is what keeps this one component rather than two
 * implementations that drift.
 *
 * SHAPE: the org roll-up leads, then upcoming events, then past events. The
 * roll-up leads because the per-event grain is mostly zero (62% of published
 * events have no measured view in a 30-day window, and the median measured
 * event has 3 views), so a table of per-event numbers cannot carry the answer
 * on its own.
 *
 * ── HIERARCHY PASS, 2026-08-25 ──────────────────────────────────────────────
 *
 * Three things changed and the honesty rules survived all of them.
 *
 * 1. The figures render through the SAME tile as the overview band above.
 *    They used to be bare text sized by their own caption, so the longest
 *    caption set the column width and the row read as a mistake.
 *
 * 2. The caveats are LAYERED rather than stacked. Four notes in three
 *    positions used to surround three digits. Now: the one caveat that is
 *    about a specific number rides ON that number as a caution chip, and the
 *    rest sit in one open-able row directly under the figures. This is the
 *    OSR dashboard model (brief critical warning where the number is, detail
 *    one interaction away, nothing buried further). It is NOT a tooltip and
 *    it is NOT off-page: <details> is on the page, in the flow, one click,
 *    and it renders in every state including both empty ones and the error.
 *
 * 3. The no-measured-traffic state stops rendering the whole apparatus. Both
 *    live tenants are in that state, so it is the default view, and it used
 *    to spend ~700px of notes and zero-filled tables to report nothing. The
 *    zeros stay (a zero is a fact) and the tables stay reachable.
 *
 * On the honesty rules that shape every number here, see analyticsShared.ts.
 * The short version: GA under-counts, so everything is a floor, nothing is
 * ever scaled up to compensate, and the floor note is never more than one
 * click from any number it describes.
 */
export default function OrgAnalytics({ orgs, focusId = null }: OrgAnalyticsProps) {
  const [orgId, setOrgId] = useState<string | null>(
    focusId ?? orgs[0]?.organization_id ?? null,
  )
  const [days, setDays] = useState<WindowChoice>(DEFAULT_WINDOW)

  // Re-sync when the caller's org list or page scope changes. A selection that
  // silently outlives the list it came from is the kind of thing that surfaces
  // later as one partner seeing another's name in a picker.
  const orgKey = orgs.map((o) => o.organization_id).join(',')
  useEffect(() => {
    setOrgId((prev) => {
      if (focusId && orgs.some((o) => o.organization_id === focusId)) return focusId
      if (prev && orgs.some((o) => o.organization_id === prev)) return prev
      return orgs[0]?.organization_id ?? null
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgKey, focusId])

  const orgName = orgs.find((o) => o.organization_id === orgId)?.name ?? null
  // The block offers its own switch ONLY when the page is not already
  // scoping it. Two controls choosing the same thing is what this replaced.
  const canSwitch = focusId == null && orgs.length > 1

  const { rows, state, range, reload } = useOrgMetrics(orgId, days)
  const t = useMemo(() => totals(rows), [rows])
  const { upcoming, past } = useMemo(() => partitionRows(rows), [rows])
  const empty = state === 'ready' ? emptyKind(rows) : null
  const loading = state === 'loading' || state === 'idle'
  const showNumbers = state !== 'error' && state !== 'denied' && empty !== 'no-events'
  const broken = crossesViewsBreak(range.from)
  const quiet = empty === 'no-measured-traffic'

  const tables = (
    <>
      <MetricSection
        key={`up-${orgId}-${days}`}
        title={UPCOMING_TITLE}
        note={UPCOMING_NOTE}
        emptyNote={NO_UPCOMING_NOTE}
        rows={upcoming}
        loading={loading}
        initial={UPCOMING_SORT}
      />
      <MetricSection
        key={`past-${orgId}-${days}`}
        title={PAST_TITLE}
        note={PAST_NOTE}
        emptyNote={NO_PAST_NOTE}
        rows={past}
        loading={loading}
        initial={PAST_SORT}
      />
    </>
  )

  return (
    // The org name is in the region label because the admin call site renders
    // this inside a tenant card whose name is not a heading, so a screen reader
    // arriving here otherwise has no way to tell whose numbers these are.
    <section
      className="ashell-an"
      aria-label={orgName ? `Traffic and handoffs for ${orgName}` : 'Traffic and handoffs'}
    >
      <div className="ashell-an-head">
        {/* Peer of the band's "Right now" overline, deliberately. Two rows of
            the same kind of tile, each with a label saying what its numbers
            are about. */}
        <h2 className="ashell-an-lbl">
          Traffic
          {/* Named here only when nothing else on the row names it: with the
              switch visible the org is already on screen twice otherwise. */}
          {orgName && orgs.length > 1 && !canSwitch && (
            <span className="ashell-an-lbl-org">{orgName}</span>
          )}
          <span className="ashell-an-lbl-win">{windowLabel(days)}</span>
        </h2>

        <div className="ashell-an-controls">
          {canSwitch && (
            <div className="ashell-an-win" role="group" aria-label="Organization">
              {orgs.map((o) => (
                <button
                  key={o.organization_id}
                  type="button"
                  className={`ashell-an-winbtn ashell-an-winbtn--org ${o.organization_id === orgId ? 'ashell-an-winbtn--on' : ''}`}
                  aria-pressed={o.organization_id === orgId}
                  onClick={() => setOrgId(o.organization_id)}
                  title={o.name}
                >
                  {o.name}
                </button>
              ))}
            </div>
          )}

          <div className="ashell-an-win" role="group" aria-label="Date window">
            {WINDOW_OPTIONS.map((d) => (
              <button
                key={String(d)}
                type="button"
                className={`ashell-an-winbtn ${d === days ? 'ashell-an-winbtn--on' : ''}`}
                aria-pressed={d === days}
                onClick={() => setDays(d)}
              >
                {windowLabel(d)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="ashell-an-window">
        {range.from} to {range.to}
        {range.clamped && `, back to when tracking started on ${TRACKING_START}.`}
      </p>

      {state === 'error' && (
        <div className="ashell-an-err" role="alert">
          <p>{LOAD_ERROR_NOTE}</p>
          <button type="button" className="btn-admin-sm" onClick={reload}>Try again</button>
        </div>
      )}

      {state === 'denied' && (
        <div className="ashell-an-err" role="alert">
          <p>{DENIED_NOTE}</p>
        </div>
      )}

      {/* The roll-up. This is the headline, not the tables: it is the one
          figure on this surface that is reliably not zero for a small partner,
          and it is exact because 064 truncates nothing. Views leads because at
          two to twenty five outbound clicks a day across the entire site, a
          handoff headline reads zero most windows. */}
      {showNumbers && (
        <>
          <div className="ashell-tiles ashell-tiles--3">
            <Fig
              big
              label={HEADLINE_LABELS.views.label}
              sub={HEADLINE_LABELS.views.sub}
              // Views is the one figure here that is not a floor before
              // 2026-08-13: it was an OVERCOUNT. The warning therefore rides
              // ON the tile rather than in a paragraph nearby, so it cannot be
              // read after the number it corrects. The full explanation is one
              // click away in the counted-how row below.
              caution={broken ? VIEWS_BREAK_CHIP : null}
              figure={viewsFigure(t.views, HEADLINE_LABELS.views.noun, broken)}
              loading={loading}
            />
            <Fig
              label={HEADLINE_LABELS.visitorDays.label}
              sub={HEADLINE_LABELS.visitorDays.sub}
              figure={floorFigure(t.visitorDays, HEADLINE_LABELS.visitorDays.noun)}
              loading={loading}
            />
            <Fig
              label={HEADLINE_LABELS.clicks.label}
              sub={HEADLINE_LABELS.clicks.sub}
              figure={floorFigure(t.clicks, HEADLINE_LABELS.clicks.noun)}
              loading={loading}
            />
          </div>

          {/* The split of the handoffs above. Rendered only when there are
              handoffs to split: three more zeros under a zero says nothing the
              zero did not already say. Where the split falls short of the
              total (GA's link_type dimension can be unregistered), the
              shortfall gets its own figure and is never scaled away. */}
          {!loading && t.clicks > 0 && (
            <div className="ashell-tiles ashell-tiles--3 ashell-tiles--split">
              <Fig
                label={HEADLINE_LABELS.tickets.label}
                sub={HEADLINE_LABELS.tickets.sub}
                figure={floorFigure(t.tickets, HEADLINE_LABELS.tickets.noun)}
                loading={false}
              />
              <Fig
                label={HEADLINE_LABELS.source.label}
                sub={HEADLINE_LABELS.source.sub}
                figure={floorFigure(t.source, HEADLINE_LABELS.source.noun)}
                loading={false}
              />
              {t.notBrokenOut > 0 && (
                <Fig
                  label={HEADLINE_LABELS.notBrokenOut.label}
                  sub={HEADLINE_LABELS.notBrokenOut.sub}
                  figure={floorFigure(t.notBrokenOut, HEADLINE_LABELS.notBrokenOut.noun)}
                  loading={false}
                />
              )}
            </div>
          )}
        </>
      )}

      {quiet && (
        <div className="ashell-an-quiet" role="status">
          <p>{NO_TRAFFIC_NOTE}</p>
          <p className="ashell-an-quiet-next">{NO_TRAFFIC_NEXT}</p>
        </div>
      )}

      {/* Every caveat, in one row, directly under the figures, open-able in
          one click and rendered in EVERY state that has numbers in it --
          including both empty ones and the error, because zero is a floor too
          and it is the number most likely to be read as fact. The only state
          without it is a denial, where there are no numbers on the page and
          telling somebody how to read them is noise.

          This is a <details>, not a tooltip and not a link off the page: the
          text is in the document, in the flow, findable by ctrl-F, and one
          interaction from any number it describes. */}
      {state !== 'denied' && (
        <details className="ashell-an-counted">
          <summary>{COUNTED_TITLE}</summary>
          <div className="ashell-an-counted-body">
            <p>{FLOOR_NOTE}</p>
            <p>{VISITOR_DAYS_NOTE}</p>
            {broken && <p>{VIEWS_BREAK_NOTE}</p>}
            <p>{ROLLUP_NOTE}</p>
          </div>
        </details>
      )}

      {/* role="status" because these replace a table that was there a moment
          ago. Without it a window change swaps the whole answer with nothing
          announced. */}
      {empty === 'no-events' && <p className="admin-hint" role="status">{NO_EVENTS_NOTE}</p>}

      {/* Nothing is hidden, only folded: an event with nothing measured still
          has a row of zeros waiting in here. What changed is that the fold is
          shut by default in the state where every row is zeros. */}
      {showNumbers && quiet && (
        <details className="ashell-an-more">
          <summary>{SHOW_ANYWAY}</summary>
          <div className="ashell-an-more-body">{tables}</div>
        </details>
      )}
      {showNumbers && !quiet && tables}
    </section>
  )
}

/**
 * One table of events, with its own sort and its own page.
 *
 * Sort and page are per section rather than shared: the two sections answer
 * different questions (what is next, versus what worked), they start from
 * different orders, and a shared page index would land a reader on page 3 of a
 * two-row table. The parent remounts these on an org or window change by key,
 * which resets both without an effect.
 */
function MetricSection({ title, note, emptyNote, rows, loading, initial }: {
  title: string
  note: string
  emptyNote: string
  rows: MetricRow[]
  loading: boolean
  initial: { key: SortKey; dir: SortDir }
}) {
  const [sortKey, setSortKey] = useState<SortKey>(initial.key)
  const [sortDir, setSortDir] = useState<SortDir>(initial.dir)
  const [page, setPage] = useState(0)

  const sorted = useMemo(() => sortRows(rows, sortKey, sortDir), [rows, sortKey, sortDir])

  // Clamped during render rather than corrected afterwards in an effect. The
  // row set can shrink under a page index that is still valid state: the hook
  // refetches when Eastern midnight rolls the window's end date, so a tab left
  // open overnight can land on page 5 of a section that now has two rows. An
  // effect would fix that a frame late, and Pagination renders nothing at all
  // below one page, so the reader would be stranded on an empty table with no
  // control to get back.
  const lastPage = Math.max(0, Math.ceil(sorted.length / ROWS_PER_PAGE) - 1)
  const safePage = Math.min(page, lastPage)
  const visible = sorted.slice(safePage * ROWS_PER_PAGE, (safePage + 1) * ROWS_PER_PAGE)

  // Sorting is over the whole section, so a re-sort has to return to page one
  // or the reader lands mid-list with no idea why.
  useEffect(() => { setPage(0) }, [sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(key)
    setSortDir(key === 'title' ? 'asc' : key === 'start_at' ? 'asc' : 'desc')
  }

  function ariaSort(key: SortKey): 'ascending' | 'descending' | 'none' {
    if (key !== sortKey) return 'none'
    return sortDir === 'asc' ? 'ascending' : 'descending'
  }

  return (
    <section className="ashell-an-sect" aria-label={title}>
      <h3 className="ashell-an-sect-title">{title}</h3>
      <p className="ashell-an-sect-note">{note}</p>

      {!loading && rows.length === 0 && <p className="admin-hint" role="status">{emptyNote}</p>}

      {(loading || rows.length > 0) && (
        <>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <Th label="Event" k="title" onSort={toggleSort} sort={ariaSort} />
                  <Th label="Date" k="start_at" onSort={toggleSort} sort={ariaSort} />
                  <Th label="Views" k="page_views" onSort={toggleSort} sort={ariaSort} />
                  <Th label="Visitor days" k="visitor_days" onSort={toggleSort} sort={ariaSort} />
                  <Th label="Handoffs" k="outbound_clicks" onSort={toggleSort} sort={ariaSort} />
                </tr>
              </thead>
              <tbody>
                {loading && [0, 1, 2].map((i) => (
                  <tr key={`sk-${i}`} className="ashell-an-skel">
                    <td colSpan={5} aria-hidden="true">…</td>
                  </tr>
                ))}
                {!loading && visible.map((r) => (
                  <tr key={r.event_id}>
                    <td>
                      {r.title}
                      {r.status && r.status !== 'published' && (
                        <> <StatusBadge status={r.status} /></>
                      )}
                    </td>
                    <td className="admin-td-nowrap">
                      {r.start_at ? format(new Date(r.start_at), 'MMM d, yyyy') : 'no date'}
                    </td>
                    {/* Same reason as the tiles: an author-supplied name on a
                        cell is commonly overridden by the cell's own contents
                        in a screen reader's table mode, so "at least" would be
                        dropped and the tilde read aloud as "tilde". The
                        visually-hidden twin is what actually gets announced. */}
                    <td className="admin-td-num">
                      <span aria-hidden="true">{floorNum(r.page_views)}</span>
                      <span className="sr-only">{floorLabel(r.page_views, 'views')}</span>
                    </td>
                    <td className="admin-td-num">
                      <span aria-hidden="true">{floorNum(r.visitor_days)}</span>
                      <span className="sr-only">{floorLabel(r.visitor_days, 'visitor days')}</span>
                    </td>
                    <td className="admin-td-num">
                      <span aria-hidden="true">{floorNum(r.outbound_clicks)}</span>
                      <span className="sr-only">{floorLabel(r.outbound_clicks, 'handoffs')}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={safePage}
            pageSize={ROWS_PER_PAGE}
            total={sorted.length}
            onPageChange={setPage}
          />
        </>
      )}
    </section>
  )
}

function Th({ label, k, onSort, sort }: {
  label: string
  k: SortKey
  onSort: (k: SortKey) => void
  sort: (k: SortKey) => 'ascending' | 'descending' | 'none'
}) {
  return (
    <th aria-sort={sort(k)}>
      <button type="button" className="ashell-an-sort" onClick={() => onSort(k)}>
        {label}
      </button>
    </th>
  )
}

/**
 * One roll-up tile -- the SAME .ashell-tile the overview band renders, so the
 * two number rows on the partner home page read as one system rather than a
 * card row followed by loose text.
 *
 * It takes a Figure rather than a number, so the decision about what a number
 * claims is made once, in analyticsShared, and cannot be made differently here.
 * That is what lets the views tile drop its floor marker on a window that
 * crosses the 2026-08-13 break while every other tile keeps it.
 */
function Fig({ label, sub, figure, loading, big, caution }: {
  label: string
  sub: string
  figure: Figure
  loading: boolean
  big?: boolean
  caution?: string | null
}) {
  return (
    <div className={`ashell-tile ${big ? 'ashell-tile--lead' : ''}`}>
      <span className="ashell-tile-lbl">{label}</span>
      {/* aria-label on a role-less <span> is ignored by browsers and screen
          readers, so the marker would be silently dropped on the biggest
          numbers on the page. The visually-hidden twin is the version that
          actually reaches assistive tech, and it renders while loading too:
          a tile that announces its label and no value reads as a value of
          nothing. */}
      <span className="ashell-tile-big">
        <span aria-hidden="true">{loading ? '…' : figure.text}</span>
        <span className="sr-only">{loading ? 'loading' : figure.label}</span>
      </span>
      {/* aria-hidden because figure.label above already carries this fact to a
          screen reader in a full sentence. The chip is the visual half of the
          same disclosure, not a second one. */}
      {caution && (
        <span className="ashell-tile-caution" aria-hidden="true">{caution}</span>
      )}
      <span className="ashell-tile-sub">{sub}</span>
    </div>
  )
}
