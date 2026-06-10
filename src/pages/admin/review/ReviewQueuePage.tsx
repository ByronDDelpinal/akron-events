import type { TablesUpdate } from '@/lib/database.types'
import type { LooseRow } from '@/types'
import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { CATEGORIES } from '@/lib/admin/constants'
import { ChipSelector } from '@/components/admin'
import { eventPath } from '@/lib/slug'

const PAGE_SIZE = 50

type Row = LooseRow

// Categories available for reassignment — everything except 'other'
const REMAP_OPTIONS = CATEGORIES.filter((c) => c.value !== 'other')

export default function ReviewQueuePage() {
  const [events, setEvents]   = useState<Row[]>([])
  const [total, setTotal]     = useState(0)
  const [page, setPage]       = useState(0)
  const [loading, setLoading] = useState(true)

  // Per-row selected category — keyed by event id
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  // Per-row saving state
  const [saving, setSaving] = useState<Record<string, boolean>>({})

  const fetchQueue = useCallback(async () => {
    setLoading(true)
    const from = page * PAGE_SIZE
    const { data, count, error } = await supabase
      .from('events')
      .select('id, title, start_at, source, source_id, manual_overrides, event_categories ( category )', { count: 'exact' })
      .eq('needs_review', true)
      .order('start_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)

    if (!error) {
      setEvents((data ?? []) as Row[])
      setTotal(count ?? 0)
    }
    setLoading(false)
  }, [page])

  useEffect(() => { fetchQueue() }, [fetchQueue])

  // Seed per-row selections with the event's current non-'other' categories.
  useEffect(() => {
    setSelections((prev) => {
      const next = { ...prev }
      events.forEach((ev) => {
        if (!(ev.id in next)) {
          next[ev.id] = ((ev.event_categories ?? []) as Row[])
            .map((ec) => ec.category)
            .filter((c: string) => c && c !== 'other')
            .slice(0, 2)
        }
      })
      return next
    })
  }, [events])

  async function handleApprove(ev: Row) {
    const cats = [...new Set(selections[ev.id] ?? [])].slice(0, 2)
    if (cats.length === 0) return

    setSaving((s) => ({ ...s, [ev.id]: true }))

    // Merge the category lock into manual_overrides so the scraper can never
    // overwrite this human decision on a future run.
    const existingOverrides = ev.manual_overrides ?? {}
    const updatedOverrides  = { ...existingOverrides, category: true }

    // Replace the event's content categories with the chosen set, then clear
    // the review flag + lock it.
    await supabase.from('event_categories').delete().eq('event_id', ev.id)
    const { error: catErr } = await supabase
      .from('event_categories')
      .insert(cats.map((category) => ({ event_id: ev.id, category })))

    let error = catErr
    if (!error) {
      const res = await supabase
        .from('events')
        .update({ manual_overrides: updatedOverrides, needs_review: false } as TablesUpdate<'events'>)
        .eq('id', ev.id)
      error = res.error
    }

    setSaving((s) => ({ ...s, [ev.id]: false }))
    if (!error) setEvents((prev) => prev.filter((e) => e.id !== ev.id))
  }

  async function handleDismiss(ev: Row) {
    setSaving((s) => ({ ...s, [ev.id]: true }))
    const { error } = await supabase
      .from('events')
      .update({ needs_review: false })
      .eq('id', ev.id)

    setSaving((s) => ({ ...s, [ev.id]: false }))
    if (!error) setEvents((prev) => prev.filter((e) => e.id !== ev.id))
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
                {events.map((ev) => {
                  const isSaving = saving[ev.id]
                  const selected = selections[ev.id] ?? []
                  return (
                    <tr key={ev.id} className={isSaving ? 'admin-row--saving' : ''}>
                      <td>
                        <Link
                          to={`/admin/events/${ev.id}/edit`}
                          className="admin-table-link"
                        >
                          {ev.title}
                        </Link>
                        <a
                          href={eventPath(ev)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="admin-table-ext-link"
                          title="View public event page"
                        >
                          ↗
                        </a>
                      </td>
                      <td className="admin-cell-mono">
                        {ev.start_at
                          ? format(new Date(ev.start_at), 'MMM d, yyyy')
                          : '—'}
                      </td>
                      <td className="admin-cell-mono">{ev.source}</td>
                      <td>
                        <ChipSelector
                          items={REMAP_OPTIONS.map((c) => ({ id: c.value, name: c.label }))}
                          selectedIds={selected}
                          onChange={(ids) => setSelections((s) => ({ ...s, [ev.id]: ids }))}
                          max={2}
                        />
                      </td>
                      <td className="admin-review-actions">
                        <button
                          className="btn-admin-primary btn-admin-sm"
                          onClick={() => handleApprove(ev)}
                          disabled={isSaving || selected.length === 0}
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
                onClick={() => setPage((p) => p - 1)}
                disabled={page === 0}
              >
                ← Prev
              </button>
              <span className="admin-pagination-info">
                Page {page + 1} of {totalPages}
              </span>
              <button
                className="btn-admin-ghost"
                onClick={() => setPage((p) => p + 1)}
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
