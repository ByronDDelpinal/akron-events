import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { CATEGORIES } from '@/lib/admin/constants'

const PAGE_SIZE = 50

// Categories available for reassignment — everything except 'other'
const REMAP_OPTIONS = CATEGORIES.filter(c => c.value !== 'other')

export default function ReviewQueuePage() {
  const [events, setEvents]   = useState([])
  const [total, setTotal]     = useState(0)
  const [page, setPage]       = useState(0)
  const [loading, setLoading] = useState(true)

  // Per-row selected category — keyed by event id
  const [selections, setSelections] = useState({})
  // Per-row saving state
  const [saving, setSaving] = useState({})

  const fetchQueue = useCallback(async () => {
    setLoading(true)
    const from = page * PAGE_SIZE
    const { data, count, error } = await supabase
      .from('events')
      .select('id, title, start_at, category, source, source_id, manual_overrides', { count: 'exact' })
      .eq('needs_review', true)
      .order('start_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)

    if (!error) {
      setEvents(data ?? [])
      setTotal(count ?? 0)
    }
    setLoading(false)
  }, [page])

  useEffect(() => { fetchQueue() }, [fetchQueue])

  // Seed per-row selections with the event's current category so the
  // dropdown is pre-populated to something useful on first render.
  useEffect(() => {
    setSelections(prev => {
      const next = { ...prev }
      events.forEach(ev => {
        if (!(ev.id in next)) next[ev.id] = ev.category === 'other' ? '' : ev.category
      })
      return next
    })
  }, [events])

  async function handleApprove(ev) {
    const newCategory = selections[ev.id]
    if (!newCategory) return

    setSaving(s => ({ ...s, [ev.id]: true }))

    // Merge the new category into manual_overrides so the scraper can
    // never overwrite this human decision on a future run.
    const existingOverrides = ev.manual_overrides ?? {}
    const updatedOverrides  = { ...existingOverrides, category: true }

    const { error } = await supabase
      .from('events')
      .update({
        category:         newCategory,
        manual_overrides: updatedOverrides,
        needs_review:     false,
      })
      .eq('id', ev.id)

    setSaving(s => ({ ...s, [ev.id]: false }))
    if (!error) setEvents(prev => prev.filter(e => e.id !== ev.id))
  }

  async function handleDismiss(ev) {
    setSaving(s => ({ ...s, [ev.id]: true }))
    const { error } = await supabase
      .from('events')
      .update({ needs_review: false })
      .eq('id', ev.id)

    setSaving(s => ({ ...s, [ev.id]: false }))
    if (!error) setEvents(prev => prev.filter(e => e.id !== ev.id))
  }

  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h2 className="admin-section-title">Review Queue</h2>
        {!loading && <span className="admin-section-count">{total}</span>}
      </div>

      <p className="admin-review-desc">
        Events below were categorized as <strong>Other</strong> — the scraper
        couldn't confidently place them. Assign the correct category and
        approve to lock it in; the scraper will never overwrite it.
      </p>

      {loading && <div className="admin-loading">Loading queue…</div>}

      {!loading && events.length === 0 && (
        <div className="admin-review-empty">
          <span className="admin-review-empty-icon">✓</span>
          <p>Queue is clear — no events need review.</p>
        </div>
      )}

      {!loading && events.length > 0 && (
        <>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Date</th>
                  <th>Source</th>
                  <th>Category</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {events.map(ev => {
                  const isSaving = saving[ev.id]
                  const selected = selections[ev.id] ?? ''
                  return (
                    <tr key={ev.id} className={isSaving ? 'admin-row--saving' : ''}>
                      <td>
                        <Link
                          to={`/admin/events/${ev.id}/edit`}
                          className="admin-table-link"
                        >
                          {ev.title}
                        </Link>
                      </td>
                      <td className="admin-cell-mono">
                        {ev.start_at
                          ? format(new Date(ev.start_at), 'MMM d, yyyy')
                          : '—'}
                      </td>
                      <td className="admin-cell-mono">{ev.source}</td>
                      <td>
                        <select
                          className="admin-select admin-select--inline"
                          value={selected}
                          onChange={e =>
                            setSelections(s => ({ ...s, [ev.id]: e.target.value }))
                          }
                          disabled={isSaving}
                        >
                          <option value="" disabled>Pick a category…</option>
                          {REMAP_OPTIONS.map(c => (
                            <option key={c.value} value={c.value}>{c.label}</option>
                          ))}
                        </select>
                      </td>
                      <td className="admin-review-actions">
                        <button
                          className="btn-admin-primary btn-admin-sm"
                          onClick={() => handleApprove(ev)}
                          disabled={isSaving || !selected}
                          title="Save this category and lock it against future scraper overwrites"
                        >
                          {isSaving ? 'Saving…' : 'Approve'}
                        </button>
                        <button
                          className="btn-admin-ghost btn-admin-sm"
                          onClick={() => handleDismiss(ev)}
                          disabled={isSaving}
                          title="Remove from queue without changing the category"
                        >
                          Dismiss
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="admin-pagination">
              <button
                className="btn-admin-ghost"
                onClick={() => setPage(p => p - 1)}
                disabled={page === 0}
              >
                ← Prev
              </button>
              <span className="admin-pagination-info">
                Page {page + 1} of {totalPages}
              </span>
              <button
                className="btn-admin-ghost"
                onClick={() => setPage(p => p + 1)}
                disabled={page >= totalPages - 1}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
