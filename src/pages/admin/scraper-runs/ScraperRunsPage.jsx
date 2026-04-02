import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { format } from 'date-fns'
import { Pagination } from '@/components/admin'

const PAGE_SIZE = 50

export default function ScraperRunsPage() {
  const [runs, setRuns] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)

  const fetchRuns = useCallback(async () => {
    setLoading(true)
    const from = page * PAGE_SIZE
    const { data, count } = await supabase
      .from('scraper_runs')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)
    setRuns(data ?? [])
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

      {!loading && (
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
              {runs.map(r => (
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
                  <td className="admin-td-nowrap">{r.created_at ? format(new Date(r.created_at), 'MMM d, h:mm a') : '—'}</td>
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
