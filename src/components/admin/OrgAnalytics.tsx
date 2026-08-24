import { useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { Pagination, StatusBadge } from '@/components/admin'
import { useOrgMetrics } from '@/lib/admin/useOrgMetrics'
import {
  DEFAULT_WINDOW,
  ROWS_PER_PAGE,
  FLOOR_NOTE,
  HEADLINE_LABELS,
  LOAD_ERROR_NOTE,
  DENIED_NOTE,
  NO_EVENTS_NOTE,
  NO_TRAFFIC_NOTE,
  TRACKING_START,
  VISITOR_DAYS_NOTE,
  WINDOW_OPTIONS,
  emptyKind,
  floorLabel,
  floorNum,
  sortRows,
  totals,
  type SortDir,
  type SortKey,
} from '@/lib/admin/analyticsShared'

interface OrgAnalyticsProps {
  /**
   * The orgs this block may show. Renders its own picker only when there is
   * more than one. PartnersPage passes exactly one.
   */
  orgs: { organization_id: string; name: string }[]
}

/**
 * OrgAnalytics -- the partner analytics block, rendered in exactly two places:
 * PartnerHomePage (a partner looking at their own orgs) and the expanded
 * tenant card on PartnersPage (an admin looking at one org).
 *
 * There is no isAdmin prop and no mode flag on purpose. The admin case is the
 * one-element case, and the RPC decides server side whether the caller may see
 * the org it was handed. That is what keeps this one component rather than two
 * implementations that drift.
 *
 * The org picker here is deliberately NOT wired to PartnerHomePage's chip
 * strip. That strip is a multi-select filter where empty means all; this needs
 * exactly one org because the RPC takes exactly one, and coupling a
 * multi-select to a single-select is where the bug would live.
 *
 * On the honesty rules that shape every number here, see analyticsShared.ts.
 * The short version: GA under-counts, so everything is a floor, the floor note
 * renders in every state including the empty ones, and nothing is ever scaled
 * up to compensate.
 */
export default function OrgAnalytics({ orgs }: OrgAnalyticsProps) {
  const [orgId, setOrgId] = useState<string | null>(orgs[0]?.organization_id ?? null)
  const [days, setDays] = useState<number>(DEFAULT_WINDOW)
  const [sortKey, setSortKey] = useState<SortKey>('outbound_clicks')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [page, setPage] = useState(0)

  // Re-sync when the caller's org list changes. Both call sites are stable
  // today, but a selection that silently outlives the list it came from is the
  // kind of thing that surfaces later as one partner seeing another's name in
  // a picker.
  const orgKey = orgs.map((o) => o.organization_id).join(',')
  useEffect(() => {
    setOrgId((prev) => (prev && orgs.some((o) => o.organization_id === prev)
      ? prev
      : orgs[0]?.organization_id ?? null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgKey])

  const { rows, state, range, reload } = useOrgMetrics(orgId, days)
  const t = useMemo(() => totals(rows), [rows])
  const sorted = useMemo(() => sortRows(rows, sortKey, sortDir), [rows, sortKey, sortDir])
  const empty = state === 'ready' ? emptyKind(rows) : null
  const visible = sorted.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE)

  // Sorting is over the whole result, so a re-sort has to return to page one
  // or the reader lands mid-list with no idea why.
  useEffect(() => { setPage(0) }, [orgId, days, sortKey, sortDir])

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortKey(key)
    setSortDir(key === 'title' ? 'asc' : 'desc')
  }

  function ariaSort(key: SortKey): 'ascending' | 'descending' | 'none' {
    if (key !== sortKey) return 'none'
    return sortDir === 'asc' ? 'ascending' : 'descending'
  }

  const loading = state === 'loading' || state === 'idle'

  return (
    <section className="ashell-an" aria-label="Traffic and handoffs">
      <div className="ashell-an-head">
        <h2 className="ashell-an-title">What your events did</h2>

        <div className="ashell-an-controls">
          {orgs.length > 1 && (
            <label className="ashell-an-ctl">
              <span className="ashell-an-ctl-lbl">Organization</span>
              <select
                className="admin-select"
                value={orgId ?? ''}
                onChange={(e) => setOrgId(e.target.value)}
              >
                {orgs.map((o) => (
                  <option key={o.organization_id} value={o.organization_id}>{o.name}</option>
                ))}
              </select>
            </label>
          )}

          <div className="ashell-an-win" role="group" aria-label="Date window">
            {WINDOW_OPTIONS.map((d) => (
              <button
                key={d}
                type="button"
                className={`ashell-an-winbtn ${d === days ? 'ashell-an-winbtn--on' : ''}`}
                aria-pressed={d === days}
                onClick={() => setDays(d)}
              >
                {d} days
              </button>
            ))}
          </div>
        </div>
      </div>

      <p className="ashell-an-window">
        {range.from} to {range.to}
        {range.clamped && `, which is as far back as we have. Tracking starts ${TRACKING_START}.`}
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

      {state !== 'error' && state !== 'denied' && empty !== 'no-events' && (
        <div className="ashell-an-figs">
          <Fig
            big
            label={HEADLINE_LABELS.clicks.label}
            sub={HEADLINE_LABELS.clicks.sub}
            noun={HEADLINE_LABELS.clicks.noun}
            n={t.clicks}
            loading={loading}
          />
          <Fig
            label={HEADLINE_LABELS.tickets.label}
            sub={HEADLINE_LABELS.tickets.sub}
            noun={HEADLINE_LABELS.tickets.noun}
            n={t.tickets}
            loading={loading}
          />
          <Fig
            label={HEADLINE_LABELS.source.label}
            sub={HEADLINE_LABELS.source.sub}
            noun={HEADLINE_LABELS.source.noun}
            n={t.source}
            loading={loading}
          />
          {t.notBrokenOut > 0 && (
            <Fig
              label={HEADLINE_LABELS.notBrokenOut.label}
              sub={HEADLINE_LABELS.notBrokenOut.sub}
              noun={HEADLINE_LABELS.notBrokenOut.noun}
              n={t.notBrokenOut}
              loading={loading}
            />
          )}
        </div>
      )}

      {/* Permanently visible wherever numbers are, including both empty states
          and the error state. Not a tooltip, not behind a disclosure, not
          dismissible: zero is a floor too, and it is the number most likely to
          be read as fact. The one exception is a denial, where there are no
          numbers on the page and telling somebody how to read them is noise. */}
      {state !== 'denied' && <p className="ashell-an-floor">{FLOOR_NOTE}</p>}

      {empty === 'no-events' && <p className="admin-hint">{NO_EVENTS_NOTE}</p>}
      {empty === 'no-measured-traffic' && <p className="admin-hint">{NO_TRAFFIC_NOTE}</p>}

      {state !== 'error' && state !== 'denied' && empty !== 'no-events' && (
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
                    <td className="admin-td-num" aria-label={floorLabel(r.page_views, 'views')}>
                      {floorNum(r.page_views)}
                    </td>
                    <td className="admin-td-num" aria-label={floorLabel(r.visitor_days, 'visitor days')}>
                      {floorNum(r.visitor_days)}
                    </td>
                    <td className="admin-td-num" aria-label={floorLabel(r.outbound_clicks, 'handoffs')}>
                      {floorNum(r.outbound_clicks)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pageSize={ROWS_PER_PAGE}
            total={sorted.length}
            onPageChange={setPage}
          />
          <p className="ashell-an-foot">{VISITOR_DAYS_NOTE}</p>
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

function Fig({ label, sub, noun, n, loading, big }: {
  label: string
  sub: string
  noun: string
  n: number
  loading: boolean
  big?: boolean
}) {
  return (
    <div className={`ashell-an-fig ${big ? 'ashell-an-fig--big' : ''}`}>
      <span className="ashell-an-fig-lbl">{label}</span>
      {/* aria-label on a role-less <span> is ignored by browsers and screen
          readers, so the "at least" would be silently dropped on the four
          biggest numbers on the page. The visually-hidden twin is the version
          that actually reaches assistive tech. */}
      <span className="ashell-an-fig-big">
        <span aria-hidden="true">{loading ? '…' : floorNum(n)}</span>
        {!loading && <span className="sr-only">{floorLabel(n, noun)}</span>}
      </span>
      <span className="ashell-an-fig-sub">{sub}</span>
    </div>
  )
}
