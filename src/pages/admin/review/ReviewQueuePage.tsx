import type { TablesUpdate } from '@/lib/database.types'
import type { LooseRow, LooseQuery } from '@/types'
import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { CATEGORIES } from '@/lib/admin/constants'
import { notEndedFilter, expiredCount } from '@/lib/admin/expiry'
import { ChipSelector, IncludePastToggle } from '@/components/admin'
import { eventPath } from '@/lib/slug'

const PAGE_SIZE = 50

type Row = LooseRow

// The two review surfaces this page exposes.
//   categorize  → events the scraper dumped into 'Other' (needs_review = true)
//   unpublished → events still awaiting publish (status = 'pending_review')
type Tab = 'categorize' | 'unpublished'

// Categories available for reassignment — everything except 'other'
const REMAP_OPTIONS = CATEGORIES.filter((c) => c.value !== 'other')

export default function ReviewQueuePage() {
  const [tab, setTab]         = useState<Tab>('categorize')
  const [events, setEvents]   = useState<Row[]>([])
  const [total, setTotal]     = useState(0)
  const [page, setPage]       = useState(0)
  const [loading, setLoading] = useState(true)
  // Ended events are hidden by default. `hidden` is what that costs, shown
  // next to the toggle so the default never silently swallows work.
  const [includePast, setIncludePast] = useState(false)
  const [hidden, setHidden] = useState<number | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Per-row selected category — keyed by event id
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  // Per-row saving state
  const [saving, setSaving] = useState<Record<string, boolean>>({})

  // The signed-in administrator, stamped onto every triage decision so the
  // queue has an audit trail. Null until the session resolves, and null is an
  // acceptable value to write — `reviewed_at` is what the queue predicate keys
  // on, `reviewed_by` is attribution.
  const [reviewerId, setReviewerId] = useState<string | null>(null)
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setReviewerId(data.user?.id ?? null))
  }, [])

  // Every triage action records WHO decided and WHEN. Clearing `needs_review`
  // alone does NOT stick: the nightly scrape recomputes that column, so an
  // approval without a `reviewed_at` is undone before morning (migration 060).
  const triageStamp = () =>
    ({ reviewed_at: new Date().toISOString(), reviewed_by: reviewerId }) as TablesUpdate<'events'>

  const fetchQueue = useCallback(async () => {
    setLoading(true)
    const from = page * PAGE_SIZE

    // Applied to both the page query and the hidden-count query so the two
    // can never describe different queues.
    const scope = (q: LooseQuery): LooseQuery =>
      tab === 'categorize'
        // `needs_review` is the SCRAPER's per-run confidence signal and is
        // recomputed on every run (scripts/lib/normalize.js:1803). `reviewed_at`
        // is the HUMAN decision, and no scraper payload ever contains it. The
        // queue is the intersection: flagged, and not yet adjudicated. Without
        // the second clause every approval reappears after the nightly scrape.
        // See the migration 060 header for the full reasoning.
        ? q.eq('needs_review', true).is('reviewed_at', null)
        : q.eq('status', 'pending_review')

    let query: LooseQuery = supabase
      .from('events')
      .select(
        'id, title, start_at, end_at, source, source_id, status, manual_overrides, event_categories ( category )',
        { count: 'exact' },
      )
      // Soonest first while triaging forward; most recent first when looking
      // back, because the useful end of a historical list is the near past.
      .order('start_at', { ascending: !includePast })
      .range(from, from + PAGE_SIZE - 1)

    // Hide events that have ALREADY ENDED. Not events that have already
    // started: something running right now is exactly what an admin needs to
    // be able to reach. See lib/admin/expiry.ts.
    if (!includePast) query = query.or(notEndedFilter())

    const { data, count, error } = await scope(query)

    if (error) {
      // A failed fetch must not render as an empty queue. "Queue is clear"
      // and "we could not ask" are opposite facts.
      setEvents([])
      setTotal(0)
      setFetchError(error.message)
      setLoading(false)
      return
    }

    setFetchError(null)
    setEvents((data ?? []) as Row[])
    setTotal(count ?? 0)
    setLoading(false)

    // Second round trip, only while the default filter is on: how many rows
    // it is hiding. Derived by subtraction because negating the filter would
    // drop null-`end_at` rows through SQL's three-valued logic.
    if (includePast) {
      setHidden(null)
      return
    }
    const { count: all, error: allErr } = await scope(
      supabase.from('events').select('id', { count: 'exact', head: true }),
    )
    setHidden(allErr ? null : expiredCount(all ?? 0, count ?? 0))
  }, [page, tab, includePast])

  useEffect(() => { fetchQueue() }, [fetchQueue])

  // Reset to the first page whenever the active tab or the time scope
  // changes — the old offset points into a different result set.
  useEffect(() => { setPage(0) }, [tab, includePast])

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
        .update({ ...triageStamp(), manual_overrides: updatedOverrides, needs_review: false } as TablesUpdate<'events'>)
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
      .update({ ...triageStamp(), needs_review: false } as TablesUpdate<'events'>)
      .eq('id', ev.id)

    setSaving((s) => ({ ...s, [ev.id]: false }))
    if (!error) setEvents((prev) => prev.filter((e) => e.id !== ev.id))
  }

  // One-click publish: flip status to 'published' and clear the review flag so
  // the event drops off every review surface at once.
  async function handlePublish(ev: Row) {
    setSaving((s) => ({ ...s, [ev.id]: true }))
    const { error } = await supabase
      .from('events')
      .update({ ...triageStamp(), status: 'published', needs_review: false } as TablesUpdate<'events'>)
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

      <div className="admin-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'categorize'}
          className={`admin-tab ${tab === 'categorize' ? 'admin-tab--active' : ''}`}
          onClick={() => setTab('categorize')}
        >
          Needs categorization
        </button>
        <button
          role="tab"
          aria-selected={tab === 'unpublished'}
          className={`admin-tab ${tab === 'unpublished' ? 'admin-tab--active' : ''}`}
          onClick={() => setTab('unpublished')}
        >
          Unpublished
        </button>
      </div>

      <p className="admin-review-desc">
        {tab === 'categorize' ? (
          <>
            Events below were categorized as <strong>Other</strong> — the scraper
            couldn't confidently place them. Assign the correct category and
            approve to lock it in; the scraper will never overwrite it.
          </>
        ) : (
          <>
            Events below are still <strong>pending review</strong> and aren't
            visible to the public yet. Publish to make them live; this also
            clears them from the categorization queue.
          </>
        )}
      </p>

      <div className="admin-toolbar admin-toolbar--scope">
        <IncludePastToggle
          includePast={includePast}
          onChange={setIncludePast}
          hiddenCount={hidden}
        />
      </div>

      {loading && <div className="admin-loading">Loading queue…</div>}

      {!loading && fetchError && (
        <div className="admin-review-error" role="alert">
          <p>Could not load the queue. This is a fetch failure, not an empty queue.</p>
          <p className="admin-review-error-detail">{fetchError}</p>
          <button className="btn-admin-ghost btn-admin-sm" onClick={fetchQueue}>
            Retry
          </button>
        </div>
      )}

      {!loading && !fetchError && events.length === 0 && (
        <div className="admin-review-empty">
          <span className="admin-review-empty-icon">✓</span>
          <p>
            {tab === 'categorize'
              ? 'Queue is clear. No events need review.'
              : 'Nothing to publish. Every upcoming event is live.'}
          </p>
          {!includePast && hidden !== null && hidden > 0 && (
            <p className="admin-review-empty-note">
              {hidden.toLocaleString()} ended {hidden === 1 ? 'event is' : 'events are'} hidden.
              Turn on Include past to see them.
            </p>
          )}
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
                  {tab === 'categorize' && <th>Category</th>}
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
                      {tab === 'categorize' && (
                        <td>
                          <ChipSelector
                            items={REMAP_OPTIONS.map((c) => ({ id: c.value, name: c.label }))}
                            selectedIds={selected}
                            onChange={(ids) => setSelections((s) => ({ ...s, [ev.id]: ids }))}
                            max={2}
                          />
                        </td>
                      )}
                      <td className="admin-review-actions">
                        {tab === 'categorize' ? (
                          <>
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
                          </>
                        ) : (
                          <button
                            className="btn-admin-primary btn-admin-sm"
                            onClick={() => handlePublish(ev)}
                            disabled={isSaving}
                            title="Publish this event and clear it from the review queue"
                          >
                            {isSaving ? 'Publishing…' : 'Publish'}
                          </button>
                        )}
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
