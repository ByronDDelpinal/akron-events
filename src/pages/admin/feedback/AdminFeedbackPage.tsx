import type { LooseRow, LooseQuery } from '@/types'
import { useState, useEffect, useCallback } from 'react'
import { format } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { ConfirmDialog, Pagination } from '@/components/admin'

/**
 * Lean, read-only-ish admin view of feedback-orb notes (plan §6). The
 * public /feedback board is gone — this replaces it with just enough to
 * triage orb submissions: body, page it came from, when, and delete.
 * No category chips, votes, or images (the orb doesn't collect them; all
 * orb rows are `category = 'orb'` and `is_private = true`).
 *
 * Reads/deletes run under the existing authenticated "full access"
 * feedback_posts policy (038) — no new RLS.
 */

const PAGE_SIZE = 50

type Row = LooseRow

export default function AdminFeedbackPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<Row | null>(null)

  const fetchRows = useCallback(async () => {
    setLoading(true)
    const from = page * PAGE_SIZE
    const query: LooseQuery = supabase
      .from('feedback_posts')
      .select('*', { count: 'exact' })
      .eq('category', 'orb')
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)

    const { data, count } = await query
    setRows((data ?? []) as Row[])
    setTotal(count ?? 0)
    setLoading(false)
  }, [page])

  useEffect(() => { fetchRows() }, [fetchRows])

  const handleDelete = async () => {
    if (!deleting) return
    await supabase.from('feedback_posts').delete().eq('id', deleting.id)
    setDeleting(null)
    fetchRows()
  }

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h2 className="admin-section-title">Feedback</h2>
        <span className="admin-section-count">{total}</span>
      </div>

      {loading && <div className="admin-loading">Loading…</div>}

      {!loading && (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Note</th>
                <th>Page</th>
                <th>Sent</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="admin-td-title">{r.body}</td>
                  <td>{r.page_path ? <a href={r.page_path} target="_blank" rel="noreferrer">{r.page_path}</a> : '—'}</td>
                  <td className="admin-td-nowrap">{r.created_at ? format(new Date(r.created_at), 'MMM d, h:mm a') : '—'}</td>
                  <td className="admin-td-actions">
                    <button className="btn-admin-sm btn-admin-sm-danger" onClick={() => setDeleting(r)}>Del</button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="admin-loading">No feedback yet.</td>
                </tr>
              )}
            </tbody>
          </table>
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </div>
      )}

      {deleting && (
        <ConfirmDialog
          message="Delete this feedback note?"
          onConfirm={handleDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
