import type { LooseRow } from '@/types'
import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { format } from 'date-fns'
import { Pagination } from '@/components/admin'

const PAGE_SIZE = 50

type Row = LooseRow

export default function ScraperRunsPage() {
  const [runs, setRuns] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  // Out-of-order guard: a slow response for an earlier page must not
  // overwrite a later one (same ticket pattern as the review queue).
  const fetchSeq = useRef(0)

  const fetchRuns = useCallback(async () => {
    const ticket = ++fetchSeq.current
    setLoading(true)
    const from = page * PAGE_SIZE
    // The table's timestamp column is `ran_at` (migration 003). The page
    // previously ordered by `created_at`, which does not exist here, so
    // PostgREST returned 400 and the page rendered as an empty list.
    const { data, count, error } = await supabase
      .from('scraper_runs')
      .select('*', { count: 'exact' })
      .order('ran_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    if (ticket !== fetchSeq.current) return
    if (error) {
      // A failed fetch must not render as "no runs". Same honesty rule as
      // the review queue: "no data" and "we could not ask" are opposite facts.
      setRuns([])
      setTotal(0)
      setFetchError(error.message)
      setLoading(false)
      return
    }
    setFetchError(null)
    setRuns((data ?? []) as Row[])
    setTotal(count ?? 0)
    setLoading(false)
  }, [page])

  useEffect(() => { fetchRuns() }, [fetchRuns])

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h2 className="admin-section-title">Scraper Runs</h2>
        <span className="admin-section-count">{total}</span>
      </div>

      {loading && <div className="admin-loading">Loading…</div>}

      {!loading && fetchError && (
        <div className="admin-review-error" role="alert">
          <p>Could not load scraper runs. This is a fetch failure, not an empty history.</p>
          <p className="admin-review-error-detail">{fetchError}</p>
          <button className="btn-admin-ghost btn-admin-sm" onClick={fetchRuns}>
            Retry
          </button>
        </div>
      )}

      {!loading && !fetchError && runs.length === 0 && (
        <div className="admin-loading">No runs recorded yet.</div>
      )}

      {!loading && !fetchError && runs.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Scraper</th>
                <th>Status</th>
                <th>Found</th>
                <th>New</th>
                <th>Updated</th>
                <th>Skipped</th>
                <th>Duration</th>
                <th>Ran At</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="admin-td-title">{r.scraper_name}</td>
                  <td>
                    <span className={`admin-status-badge ${r.status === 'error' ? 'status-cancelled' : 'status-published'}`}>
                      {r.status}
                    </span>
                  </td>
                  <td>{r.events_found ?? 0}</td>
                  <td>{r.events_inserted ?? 0}</td>
                  <td>{r.events_updated ?? 0}</td>
                  <td>{r.events_skipped ?? 0}</td>
                  <td>{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                  <td className="admin-td-nowrap">{r.ran_at ? format(new Date(r.ran_at), 'MMM d, h:mm a') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </div>
      )}
    </div>
  )
}
