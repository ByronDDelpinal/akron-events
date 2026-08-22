import type { TablesUpdate } from '@/lib/database.types'
import type { LooseRow, LooseQuery } from '@/types'
import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { CATEGORIES } from '@/lib/admin/constants'
import { notEndedFilter, expiredCount, upcomingBounds, hasEnded } from '@/lib/admin/expiry'
import {
  REASONS, FACET_IDS, FACET_FILTERS, reviewQueueScope,
  isCategoryUnsure, isAwaitingPublish, isMissingEnd, rowReason,
  type ReasonId,
} from '@/lib/admin/reviewReasons'
import { ChipSelector, ConfirmDialog, IncludePastToggle, Pagination } from '@/components/admin'
import { eventPath } from '@/lib/slug'
import { normalizeOverrides } from '@/lib/admin/useOverrides'
import { useShellCounts } from '@/lib/admin/useShellCounts'

const PAGE_SIZE = 50

// Everything the rows, chips, and drawer narrate. All real columns; the
// drawer invents nothing and omits what is null.
const SELECT_LIST =
  'id, title, start_at, end_at, source, source_id, source_url, status, ' +
  'needs_review, reviewed_at, created_at, manual_overrides, event_categories ( category )'

type Row = LooseRow
type Facet = 'all' | ReasonId
type FacetCounts = Record<Facet, number | null>

// Categories available for reassignment -- everything except 'other'
const REMAP_OPTIONS = CATEGORIES.filter((c) => c.value !== 'other')

const EMPTY_COUNTS: FacetCounts = { all: null, cat: null, pend: null, time: null }

interface ToastState {
  message: string
  /** Event id a single dismiss can undo; null for non-undoable toasts. */
  undoId: string | null
}

/** Which triage action failed, so the inline Retry re-runs THAT action. */
type RowAction = 'approve' | 'dismiss' | 'publish' | 'cancel'

interface RowError {
  message: string
  action: RowAction
}

interface ConfirmState {
  kind: 'publish' | 'cancel'
  ev: Row
}

/**
 * The one review queue: membership is the union of "flagged, not yet
 * adjudicated" and "awaiting publish" (reviewReasons.ts, the single
 * definition the rail pip shares). Rendered on /admin/review and embedded
 * on the admin home surface.
 */
export default function ReviewQueueSurface() {
  const { includeEnded, setIncludeEnded, decrementReview, refresh } = useShellCounts()

  const [events, setEvents]   = useState<Row[]>([])
  const [total, setTotal]     = useState(0)
  const [page, setPage]       = useState(0)
  const [loading, setLoading] = useState(true)
  const [facet, setFacet]     = useState<Facet>('all')
  const [counts, setCounts]   = useState<FacetCounts>(EMPTY_COUNTS)
  // Ended events are hidden by default. `hidden` is what that costs, shown
  // next to the toggle so the default never silently swallows work.
  const [hidden, setHidden] = useState<number | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)

  // Per-row selected categories, saving state, and inline action errors.
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, RowError>>({})

  const [openId, setOpenId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [toast, setToast] = useState<ToastState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The signed-in administrator, stamped onto every triage decision so the
  // queue has an audit trail. Null until the session resolves, and null is an
  // acceptable value to write -- `reviewed_at` is what the queue predicate
  // keys on, `reviewed_by` is attribution.
  const [reviewerId, setReviewerId] = useState<string | null>(null)
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setReviewerId(data.user?.id ?? null))
  }, [])

  // Every triage action records WHO decided and WHEN. Clearing `needs_review`
  // alone does NOT stick: the nightly scrape recomputes that column, so an
  // approval without a `reviewed_at` is undone before morning (migration 060).
  const triageStamp = () =>
    ({ reviewed_at: new Date().toISOString(), reviewed_by: reviewerId }) as TablesUpdate<'events'>

  const showToast = useCallback((message: string, undoId: string | null = null) => {
    setToast({ message, undoId })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 4200)
  }, [])
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

  // Monotonic ticket so a slow, earlier response can never overwrite the
  // state a faster, later one already committed (rapid facet/toggle flips).
  const fetchSeq = useRef(0)

  const fetchQueue = useCallback(async () => {
    const seq = ++fetchSeq.current
    setLoading(true)
    const from = page * PAGE_SIZE

    // Membership + (facet) applied to page query, hidden-count query, and
    // facet counts alike so no two numbers describe different queues. The
    // time scope is added separately and POSITIVELY (never negated -- see
    // expiry.ts); PostgREST ANDs successive .or() params.
    const membership = (q: LooseQuery): LooseQuery => reviewQueueScope(q)
    const timeScoped = (q: LooseQuery): LooseQuery =>
      includeEnded ? q : q.or(notEndedFilter())

    let query: LooseQuery = supabase
      .from('events')
      .select(SELECT_LIST, { count: 'exact' })
      // Soonest first while triaging forward; most recent first when looking
      // back, because the useful end of a historical list is the near past.
      .order('start_at', { ascending: !includeEnded })
      .range(from, from + PAGE_SIZE - 1)
    query = timeScoped(membership(query))
    if (facet !== 'all') query = FACET_FILTERS[facet](query)

    const { data, count, error } = await query
    if (seq !== fetchSeq.current) return

    if (error) {
      // A failed fetch must not render as an empty queue. "Queue is clear"
      // and "we could not ask" are opposite facts. The same goes for the
      // numbers: counts and the hidden tally are cleared (never a hard "0",
      // never a stale figure from an earlier load) so the header shows an
      // honest "unknown" state instead.
      setEvents([])
      setTotal(0)
      setCounts(EMPTY_COUNTS)
      setHidden(null)
      setFetchError(error.message)
      setLoading(false)
      return
    }

    const rows = (data ?? []) as Row[]
    setFetchError(null)
    setEvents(rows)
    setTotal(count ?? 0)
    setSelected(new Set())
    setRowErrors({})
    setLoading(false)

    // Facet counts. When the whole unfaceted queue fits on one page, derive
    // every count from the loaded rows (zero extra round trips); otherwise
    // fire parallel head counts under the same membership + time scope.
    if (facet === 'all' && (count ?? 0) <= PAGE_SIZE) {
      setCounts({
        all: count ?? 0,
        cat: rows.filter(isCategoryUnsure).length,
        pend: rows.filter(isAwaitingPublish).length,
        time: rows.filter(isMissingEnd).length,
      })
    } else {
      const head = () =>
        supabase.from('events').select('id', { count: 'exact', head: true })
      const facetHead = (id: ReasonId) =>
        FACET_FILTERS[id](timeScoped(membership(head())))
      const allPromise: PromiseLike<{ count: number | null }> | null =
        facet === 'all' ? null : timeScoped(membership(head()))
      const [catRes, pendRes, timeRes, allRes] = await Promise.all([
        facetHead('cat'), facetHead('pend'), facetHead('time'),
        allPromise ?? Promise.resolve(null),
      ])
      if (seq !== fetchSeq.current) return
      setCounts({
        all: facet === 'all' ? (count ?? 0) : (allRes?.count ?? null),
        cat: catRes.error ? null : (catRes.count ?? 0),
        pend: pendRes.error ? null : (pendRes.count ?? 0),
        time: timeRes.error ? null : (timeRes.count ?? 0),
      })
    }

    // Second round trip, only while the default filter is on: how many rows
    // it is hiding. Derived by subtraction because negating the filter would
    // drop null-`end_at` rows through SQL's three-valued logic.
    if (includeEnded) {
      setHidden(null)
      return
    }
    let allQ: LooseQuery = membership(
      supabase.from('events').select('id', { count: 'exact', head: true }),
    )
    if (facet !== 'all') allQ = FACET_FILTERS[facet](allQ)
    const { count: all, error: allErr } = await allQ
    if (seq !== fetchSeq.current) return
    setHidden(allErr ? null : expiredCount(all ?? 0, count ?? 0))
  }, [page, facet, includeEnded])

  useEffect(() => { fetchQueue() }, [fetchQueue])

  // Reset to the first page whenever the facet or time scope changes -- the
  // old offset points into a different result set.
  useEffect(() => { setPage(0); setOpenId(null) }, [facet, includeEnded])

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

  /**
   * Apply a successful triage to local state without a refetch (the shipped
   * stale-total bug was exactly this sync going missing). A row leaves the
   * VISIBLE list when it no longer satisfies membership, or when it no
   * longer matches the active facet (an approved cat+pend row must not
   * linger under the Category-unsure facet); it leaves the QUEUE — and the
   * pip decrements — only when membership itself ends.
   */
  const applyTransition = useCallback((before: Row, patch: Partial<Row>) => {
    const after = { ...before, ...patch }
    const wasCat = isCategoryUnsure(before)
    const wasPend = isAwaitingPublish(before)
    const wasTime = isMissingEnd(before)
    const stillMember = isCategoryUnsure(after) || isAwaitingPublish(after)
    const facetTwin: Record<ReasonId, (r: Row) => boolean> = {
      cat: isCategoryUnsure, pend: isAwaitingPublish, time: isMissingEnd,
    }
    const leavesFacet = facet !== 'all' && !facetTwin[facet](after)
    const leavesList = !stillMember || leavesFacet

    setSelected((prev) => {
      if (!prev.has(before.id) || !leavesList) return prev
      const next = new Set(prev)
      next.delete(before.id)
      return next
    })

    if (!leavesList) {
      setEvents((prev) => prev.map((e) => (e.id === before.id ? after : e)))
      setCounts((prev) => ({
        ...prev,
        cat: prev.cat != null && wasCat && !isCategoryUnsure(after) ? prev.cat - 1 : prev.cat,
        pend: prev.pend != null && wasPend && !isAwaitingPublish(after) ? prev.pend - 1 : prev.pend,
      }))
      return
    }

    setEvents((prev) => {
      const next = prev.filter((e) => e.id !== before.id)
      return next
    })
    // `total` counts the CURRENT view (facet included), so it drops whenever
    // the row leaves the visible list; counts.all only when membership ends.
    setTotal((t) => Math.max(0, t - 1))
    setCounts((prev) => ({
      all: prev.all != null && !stillMember ? Math.max(0, prev.all - 1) : prev.all,
      cat: prev.cat != null && wasCat && !isCategoryUnsure(after) ? prev.cat - 1 : prev.cat,
      pend: prev.pend != null && wasPend && !isAwaitingPublish(after) ? prev.pend - 1 : prev.pend,
      time: prev.time != null && wasTime && !stillMember ? prev.time - 1 : prev.time,
    }))
    // Pip, tile, and queue header agree without a refetch — but only for a
    // row the pip actually counted: the pip's scope is not-ended, so an
    // ended row triaged under "Include past" must not decrement it.
    const endedRow = hasEnded({ start_at: before.start_at ?? null, end_at: before.end_at ?? null })
    if (!stillMember && !(includeEnded && endedRow)) decrementReview()
    if (openId === before.id) setOpenId(null)
  }, [decrementReview, openId, facet, includeEnded])

  // When the visible page empties (and rows remain), resync from the server:
  // the authoritative counts and the next page's rows land together.
  useEffect(() => {
    if (loading || fetchError) return
    if (events.length > 0) return
    if (total > 0) {
      if (page > 0) setPage((p) => p - 1)
      else fetchQueue()
    }
  }, [events.length, total, loading, fetchError, page, fetchQueue])

  const setRowSaving = (id: string, value: boolean) =>
    setSaving((s) => ({ ...s, [id]: value }))
  const setRowError = (id: string, error: RowError | null) =>
    setRowErrors((prev) => {
      const next = { ...prev }
      if (error == null) delete next[id]
      else next[id] = error
      return next
    })

  /**
   * Approve: replace the event's categories with the chosen set, then stamp.
   *
   * No transaction is available without a migration, and two constraints
   * squeeze the ordering from both sides: a flagged row can be
   * status='published' and live on the public site, so it should never sit
   * at ZERO categories between steps -- and `trg_event_categories_max2`
   * (migration 029, a per-row AFTER trigger) raises whenever a statement
   * leaves the event with MORE than two junction rows, so a plain
   * "upsert first, prune second" can raise at three. Neither simple order
   * is safe, so the steps are interleaved to hold the row count between 1
   * and 2 at every statement boundary, judged against our fetched snapshot
   * of the event's current categories:
   *   - no stale rows -> one idempotent upsert (count can only reach
   *     |chosen| <= 2);
   *   - otherwise: (1) prune to at most {anchor, keeper} where `anchor` is
   *     a chosen category (preferring one already present) and `keeper` is
   *     one existing stale row that survives so the count never hits zero;
   *     (2) upsert the anchor (<= 2 rows); (3) prune to the chosen set --
   *     the keeper leaves, the anchor stays; (4) upsert the second chosen
   *     category, if any (exactly 2 rows).
   * A concurrent write landing BETWEEN steps can still momentarily break
   * the guarantee -- only the Phase-2 `approve_event_review` RPC (one
   * transaction server-side) closes that for good. The stamp goes LAST: a
   * failure at any earlier step leaves the row in the queue with
   * `reviewed_at` unset, an inline error, and a retry -- re-approve is
   * safe and idempotent. Every step's error is checked.
   */
  async function handleApprove(ev: Row): Promise<boolean> {
    const cats = [...new Set(selections[ev.id] ?? [])].slice(0, 2)
    if (cats.length === 0) return false

    setRowSaving(ev.id, true)
    setRowError(ev.id, null)

    const existing = [...new Set(
      ((ev.event_categories ?? []) as Row[])
        .map((ec) => ec.category)
        .filter((c: string | null): c is string => !!c),
    )]
    const stale = existing.filter((c) => !cats.includes(c))

    const keepOnly = (keep: string[]) =>
      supabase
        .from('event_categories')
        .delete()
        .eq('event_id', ev.id)
        .not('category', 'in', `(${keep.join(',')})`)
    const addCats = (list: string[]) =>
      supabase
        .from('event_categories')
        .upsert(
          list.map((category) => ({ event_id: ev.id, category })),
          { onConflict: 'event_id,category', ignoreDuplicates: true },
        )

    let steps: Array<() => LooseQuery>
    if (stale.length === 0) {
      steps = [() => addCats(cats)]
    } else {
      const anchor = cats.find((c) => existing.includes(c)) ?? cats[0]
      const keeper = stale[0]
      const second = cats.filter((c) => c !== anchor)
      steps = [
        () => keepOnly([anchor, keeper]),
        () => addCats([anchor]),
        () => keepOnly(cats),
        ...(second.length > 0 ? [() => addCats(second)] : []),
      ]
    }
    for (const step of steps) {
      const { error } = await step()
      if (error) {
        setRowSaving(ev.id, false)
        setRowError(ev.id, {
          message: `Could not update categories: ${error.message}`,
          action: 'approve',
        })
        return false
      }
    }

    // Merge the category lock into manual_overrides so the scraper can never
    // overwrite this human decision on a future run. The key stays
    // `category` -- the scraper checks key presence, not shape -- and the
    // whole object goes through normalizeOverrides so a legacy bare-`true`
    // row self-heals to the canonical `{ at }` shape on this write.
    const stamp = triageStamp()
    const updatedOverrides = {
      ...normalizeOverrides(ev.manual_overrides),
      category: { at: new Date().toISOString() },
    }
    const { error: stampErr } = await supabase
      .from('events')
      .update({ ...stamp, manual_overrides: updatedOverrides, needs_review: false } as TablesUpdate<'events'>)
      .eq('id', ev.id)
    setRowSaving(ev.id, false)
    if (stampErr) {
      setRowError(ev.id, {
        message: `Could not save the approval: ${stampErr.message}`,
        action: 'approve',
      })
      return false
    }

    applyTransition(ev, {
      needs_review: false,
      reviewed_at: stamp.reviewed_at,
      manual_overrides: updatedOverrides,
      event_categories: cats.map((category) => ({ category })),
    })
    return true
  }

  async function handleDismiss(ev: Row): Promise<boolean> {
    setRowSaving(ev.id, true)
    setRowError(ev.id, null)
    const stamp = triageStamp()
    const { error } = await supabase
      .from('events')
      .update({ ...stamp, needs_review: false } as TablesUpdate<'events'>)
      .eq('id', ev.id)
    setRowSaving(ev.id, false)
    if (error) {
      setRowError(ev.id, { message: `Could not dismiss: ${error.message}`, action: 'dismiss' })
      return false
    }
    applyTransition(ev, { needs_review: false, reviewed_at: stamp.reviewed_at })
    return true
  }

  /**
   * Publish flips status to 'published' AND clears the review flag, so the
   * event drops off every review surface at once (current documented
   * behavior, kept). Only ever reached through the ConfirmDialog: one
   * activation can never publish flagged content.
   */
  async function handlePublish(ev: Row) {
    setRowSaving(ev.id, true)
    setRowError(ev.id, null)
    const stamp = triageStamp()
    const { error } = await supabase
      .from('events')
      .update({ ...stamp, status: 'published', needs_review: false } as TablesUpdate<'events'>)
      .eq('id', ev.id)
    setRowSaving(ev.id, false)
    if (error) {
      setRowError(ev.id, { message: `Could not publish: ${error.message}`, action: 'publish' })
      return
    }
    applyTransition(ev, { needs_review: false, reviewed_at: stamp.reviewed_at, status: 'published' })
    showToast(`Published "${truncate(ev.title)}". It is live on the public site.`)
  }

  /**
   * Cancel: a pending row cannot leave the queue through `reviewed_at`
   * alone under the union predicate, so "this should not go out" needs a
   * real status. Confirmed, danger-styled.
   */
  async function handleCancel(ev: Row) {
    setRowSaving(ev.id, true)
    setRowError(ev.id, null)
    const stamp = triageStamp()
    const { error } = await supabase
      .from('events')
      .update({ ...stamp, status: 'cancelled', needs_review: false } as TablesUpdate<'events'>)
      .eq('id', ev.id)
    setRowSaving(ev.id, false)
    if (error) {
      setRowError(ev.id, { message: `Could not cancel: ${error.message}`, action: 'cancel' })
      return
    }
    applyTransition(ev, { needs_review: false, reviewed_at: stamp.reviewed_at, status: 'cancelled' })
    showToast(`Cancelled "${truncate(ev.title)}". It will not publish.`)
  }

  async function approveWithToast(ev: Row) {
    const ok = await handleApprove(ev)
    if (ok) showToast(`Approved "${truncate(ev.title)}". Category locked against re-scrape.`)
  }

  async function dismissWithToast(ev: Row) {
    const ok = await handleDismiss(ev)
    // A both-reasons row stays visibly in the queue after a dismiss (it is
    // still awaiting publish), so the toast must not claim it was removed.
    if (ok) {
      showToast(
        isAwaitingPublish(ev)
          ? 'Category flag cleared. Still awaiting publish, so it stays in the queue.'
          : 'Dismissed. It will not return tonight.',
        ev.id,
      )
    }
  }

  /** Undo a single dismiss: one reverse update, then an authoritative resync. */
  async function handleUndo(id: string) {
    setToast(null)
    const { error } = await supabase
      .from('events')
      .update({ reviewed_at: null, reviewed_by: null, needs_review: true } as TablesUpdate<'events'>)
      .eq('id', id)
    if (error) {
      showToast(`Could not undo: ${error.message}`)
      return
    }
    await fetchQueue()
    refresh()
  }

  async function handleBulkDismiss() {
    const rows = events.filter((e) => selected.has(e.id) && isCategoryUnsure(e))
    let done = 0
    for (const ev of rows) {
      if (await handleDismiss(ev)) done += 1
    }
    const skipped = selected.size - rows.length
    showToast(
      `${done} ${done === 1 ? 'event' : 'events'} dismissed.` +
      (skipped > 0 ? ` ${skipped} awaiting publish skipped; publishing is never bulk.` : ''),
    )
    setSelected(new Set())
  }

  async function handleBulkApprove() {
    const eligible = events.filter(
      (e) => selected.has(e.id) && isCategoryUnsure(e) && (selections[e.id] ?? []).length > 0,
    )
    let done = 0
    for (const ev of eligible) {
      if (await handleApprove(ev)) done += 1
    }
    const skipped = selected.size - eligible.length
    showToast(
      `${done} ${done === 1 ? 'event' : 'events'} approved.` +
      (skipped > 0 ? ` ${skipped} skipped: no category picked, or awaiting publish.` : ''),
    )
    setSelected(new Set())
  }

  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const bounds = upcomingBounds()
  const visibleCount = counts.all ?? (facet === 'all' ? total : null)

  return (
    <section className="ashell-work" aria-label="Review queue">
      <div className="ashell-surface-hd">
        <h2>Review queue</h2>
        {/* In the error state the count is UNKNOWN, not zero: an em-dash,
            never a hard "0" the error card below would contradict. */}
        {fetchError ? (
          <span className="ashell-count" aria-label="Count unavailable">—</span>
        ) : (
          visibleCount != null && (
            <span className="ashell-count">{visibleCount.toLocaleString()}</span>
          )
        )}
        <div className="ashell-grow" />
        <IncludePastToggle
          includePast={includeEnded}
          onChange={setIncludeEnded}
          hiddenCount={hidden}
          countUnavailable={fetchError != null}
        />
      </div>

      <div className="ashell-facets" role="group" aria-label="Filter by reason">
        <button
          type="button"
          className={`ashell-facet ${facet === 'all' ? 'ashell-facet--on' : ''}`}
          aria-pressed={facet === 'all'}
          onClick={() => setFacet('all')}
        >
          Everything
          {counts.all != null && <span className="ashell-facet-n">{counts.all.toLocaleString()}</span>}
        </button>
        {FACET_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className={`ashell-facet ${facet === id ? 'ashell-facet--on' : ''}`}
            aria-pressed={facet === id}
            onClick={() => setFacet((f) => (f === id ? 'all' : id))}
          >
            <span className={`ashell-swatch ashell-swatch--${id}`} aria-hidden="true" />
            {REASONS[id].label}
            {counts[id] != null && (
              <span className="ashell-facet-n">{(counts[id] as number).toLocaleString()}</span>
            )}
          </button>
        ))}
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
        <div className="ashell-empty">
          <div className="ashell-empty-ring" aria-hidden="true">✓</div>
          <h3>Queue is clear</h3>
          <p>Nothing needs review in this view.</p>
          {!includeEnded && hidden != null && hidden > 0 && (
            <p className="ashell-empty-note">
              {hidden.toLocaleString()} ended {hidden === 1 ? 'event stays' : 'events stay'} tucked
              away. Turn on Include past to see them.
            </p>
          )}
        </div>
      )}

      {!loading && !fetchError && events.length > 0 && (
        <>
          <div className="ashell-queue-scroll">
            <div className="ashell-queue">
              <div className="ashell-qhead" aria-hidden="true">
                <span />
                <span>Event</span>
                <span className="ashell-qcol-why">Why it is here</span>
                <span className="ashell-qcol-when">When</span>
                <span className="ashell-qcol-src">Source</span>
                <span className="ashell-qcol-acts">Actions</span>
              </div>
              <ul role="list" className="ashell-qlist">
                {events.map((ev) => (
                  <QueueRow
                    key={ev.id}
                    ev={ev}
                    nowIso={bounds.nowIso}
                    isOpen={openId === ev.id}
                    isSelected={selected.has(ev.id)}
                    isSaving={!!saving[ev.id]}
                    rowError={rowErrors[ev.id] ?? null}
                    selection={selections[ev.id] ?? []}
                    onToggleOpen={() => setOpenId((prev) => (prev === ev.id ? null : ev.id))}
                    onToggleSelected={() => toggleSelected(ev.id)}
                    onSelectionChange={(ids) => setSelections((s) => ({ ...s, [ev.id]: ids }))}
                    onApprove={() => approveWithToast(ev)}
                    onDismiss={() => dismissWithToast(ev)}
                    onPublish={() => setConfirm({ kind: 'publish', ev })}
                    onCancelEvent={() => setConfirm({ kind: 'cancel', ev })}
                  />
                ))}
              </ul>
            </div>
          </div>

          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </>
      )}

      {selected.size > 0 && (
        <div className="ashell-bulk" role="toolbar" aria-label="Bulk actions">
          <span><b>{selected.size}</b> selected</span>
          <button type="button" className="ashell-btn ashell-btn--onnav ashell-btn--primary" onClick={handleBulkApprove}>
            Approve selected
          </button>
          <button type="button" className="ashell-btn ashell-btn--onnav" onClick={handleBulkDismiss}>
            Dismiss selected
          </button>
          <button type="button" className="ashell-btn ashell-btn--onnav" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      {toast && (
        <div className="ashell-toast" role="status">
          <span>{toast.message}</span>
          {toast.undoId != null && (
            <button type="button" onClick={() => handleUndo(toast.undoId as string)}>
              Undo
            </button>
          )}
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          message={
            confirm.kind === 'publish'
              ? `Publish "${confirm.ev.title}" to the public site?`
              : `Cancel "${confirm.ev.title}"? It will never publish and shows as cancelled.`
          }
          confirmLabel={confirm.kind === 'publish' ? 'Publish' : 'Cancel event'}
          tone={confirm.kind === 'publish' ? 'primary' : 'danger'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const { kind, ev } = confirm
            setConfirm(null)
            if (kind === 'publish') handlePublish(ev)
            else handleCancel(ev)
          }}
        />
      )}
    </section>
  )
}

// ── Row ───────────────────────────────────────────────────────────────────

interface QueueRowProps {
  ev: Row
  nowIso: string
  isOpen: boolean
  isSelected: boolean
  isSaving: boolean
  rowError: RowError | null
  selection: string[]
  onToggleOpen: () => void
  onToggleSelected: () => void
  onSelectionChange: (ids: string[]) => void
  onApprove: () => void
  onDismiss: () => void
  onPublish: () => void
  onCancelEvent: () => void
}

function QueueRow({
  ev, nowIso, isOpen, isSelected, isSaving, rowError, selection,
  onToggleOpen, onToggleSelected, onSelectionChange,
  onApprove, onDismiss, onPublish, onCancelEvent,
}: QueueRowProps) {
  const reason = rowReason(ev)
  const cat = isCategoryUnsure(ev)
  const pend = isAwaitingPublish(ev)
  const missingEnd = isMissingEnd(ev)
  const runningNow = !!ev.end_at && !!ev.start_at && ev.start_at <= nowIso && ev.end_at >= nowIso
  const drawerId = `qdrawer-${ev.id}`
  const titleId = `qtitle-${ev.id}`
  // Retry re-runs the action that actually failed -- a failed Cancel must
  // never route through the Publish confirm. Publish/cancel retries go back
  // through their confirms; publishing stays behind a confirm, always.
  const retryHandlers: Record<RowAction, () => void> = {
    approve: onApprove, dismiss: onDismiss, publish: onPublish, cancel: onCancelEvent,
  }

  return (
    <li
      className={`ashell-qitem ${isSaving ? 'ashell-qitem--saving' : ''}`}
      onKeyDown={(e) => {
        // Escape closes an open drawer (WAI-ARIA disclosure convention, an
        // a11y requirement, not a shortcut). Only when the drawer is open.
        if (e.key === 'Escape' && isOpen) {
          e.stopPropagation()
          onToggleOpen()
        }
      }}
    >
      <div
        className={`ashell-qrow ${isSelected ? 'ashell-qrow--selected' : ''} ${isOpen ? 'ashell-qrow--open' : ''}`}
      >
        <button
          type="button"
          className="ashell-cb"
          aria-pressed={isSelected}
          aria-label={`Select ${ev.title}`}
          onClick={onToggleSelected}
          disabled={isSaving}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <path d="m5 13 4 4L19 7" />
          </svg>
        </button>

        <div className="ashell-ev">
          <button
            type="button"
            id={titleId}
            className="ashell-ev-title"
            aria-expanded={isOpen}
            aria-controls={drawerId}
            onClick={onToggleOpen}
          >
            {ev.title}
          </button>
        </div>

        <div className="ashell-qcol-why ashell-why">
          {reason && (
            <span className={`ashell-chip ashell-chip--${reason}`}>
              <span className="ashell-chip-dot" aria-hidden="true" />
              {REASONS[reason].label}
            </span>
          )}
          {missingEnd && (
            <span className="ashell-chip ashell-chip--time ashell-chip--mini">no end</span>
          )}
        </div>

        <div className="ashell-qcol-when ashell-when">
          {runningNow ? (
            <>
              <span className="ashell-rn">
                <span className="ashell-dot ashell-dot--live" aria-hidden="true" />
                Running now
              </span>
              <span className="ashell-when-sub">ends {format(new Date(ev.end_at), 'h:mm a')}</span>
            </>
          ) : ev.start_at ? (
            <>
              {format(new Date(ev.start_at), 'MMM d')}
              <span className="ashell-when-sub">{format(new Date(ev.start_at), 'h:mm a')}</span>
            </>
          ) : (
            '—'
          )}
        </div>

        <div className="ashell-qcol-src ashell-src">
          <code>{ev.source}</code>
        </div>

        <div className="ashell-qcol-acts ashell-acts">
          {cat && (
            <>
              <button
                type="button"
                className="ashell-ibtn ashell-ibtn--ok"
                aria-label={`Approve ${ev.title}`}
                title={selection.length === 0 ? 'Pick a category first' : 'Approve with the picked categories'}
                onClick={onApprove}
                disabled={isSaving || selection.length === 0}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                  <path d="m4 12.5 5 5L20 6.5" />
                </svg>
              </button>
              <button
                type="button"
                className="ashell-ibtn ashell-ibtn--no"
                aria-label={`Dismiss ${ev.title}`}
                title="Remove from the queue without changing the category"
                onClick={onDismiss}
                disabled={isSaving}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" focusable="false">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </>
          )}
          <button
            type="button"
            className="ashell-ibtn"
            aria-label={`Open details for ${ev.title}`}
            title="Open details"
            aria-expanded={isOpen}
            aria-controls={drawerId}
            onClick={onToggleOpen}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>

      <div
        id={drawerId}
        role="region"
        aria-labelledby={titleId}
        className={`ashell-drawer ${isOpen ? 'ashell-drawer--open' : ''}`}
        hidden={!isOpen}
      >
        {isOpen && (
          <div className="ashell-drawer-in">
            <div className="ashell-dcol">
              <h4>Why this is in review</h4>
              <p className="ashell-why-p">{narrative(ev, cat, pend, missingEnd)}</p>
              <dl className="ashell-kv">
                <dt>Starts</dt>
                <dd>{ev.start_at ? format(new Date(ev.start_at), 'MMM d, yyyy · h:mm a') : 'not supplied'}</dd>
                <dt>Ends</dt>
                <dd>
                  {ev.end_at
                    ? format(new Date(ev.end_at), 'MMM d, yyyy · h:mm a')
                    : 'not supplied; stays visible until its Eastern day closes'}
                </dd>
                <dt>Source</dt>
                <dd><code>{ev.source}</code></dd>
                {ev.created_at && (
                  <>
                    <dt>First seen</dt>
                    <dd>{format(new Date(ev.created_at), 'MMM d, yyyy')}</dd>
                  </>
                )}
                <dt>Status</dt>
                <dd>{ev.status}</dd>
                {ev.source_url && (
                  <>
                    <dt>Source page</dt>
                    <dd>
                      <a href={ev.source_url} target="_blank" rel="noopener noreferrer">
                        view original ↗
                      </a>
                    </dd>
                  </>
                )}
              </dl>
              <div className="ashell-p2">
                <b>Run history and payload diff</b> arrive with Phase 2 (the event_review_flags
                table). Nothing here is guessed; if we cannot derive it, we say so.
              </div>
            </div>
            <div className="ashell-dcol">
              <h4>Set it right</h4>
              {cat && (
                <div className="ashell-catpick">
                  <ChipSelector
                    items={REMAP_OPTIONS.map((c) => ({ id: c.value, name: c.label }))}
                    selectedIds={selection}
                    onChange={onSelectionChange}
                    max={2}
                  />
                </div>
              )}
              {rowError && (
                <p className="ashell-row-error" role="alert">
                  {rowError.message}{' '}
                  <button type="button" className="ashell-linkbtn" onClick={retryHandlers[rowError.action]}>
                    Retry
                  </button>
                </p>
              )}
              <div className="ashell-dactions">
                {cat && (
                  <>
                    <button
                      type="button"
                      className="ashell-btn ashell-btn--primary"
                      onClick={onApprove}
                      disabled={isSaving || selection.length === 0}
                      title="Save this category and lock it against future scraper overwrites"
                    >
                      {isSaving ? 'Saving…' : 'Approve'}
                    </button>
                    <button
                      type="button"
                      className="ashell-btn"
                      onClick={onDismiss}
                      disabled={isSaving}
                      title="Remove from the queue without changing the category"
                    >
                      Dismiss
                    </button>
                  </>
                )}
                {pend && (
                  <>
                    <button
                      type="button"
                      className={`ashell-btn ${cat ? '' : 'ashell-btn--primary'}`}
                      onClick={onPublish}
                      disabled={isSaving}
                      title="Publish this event to the public site; a confirm follows"
                    >
                      Publish…
                    </button>
                    <button
                      type="button"
                      className="ashell-btn ashell-btn--danger"
                      onClick={onCancelEvent}
                      disabled={isSaving}
                      title="Mark this event cancelled so it never publishes; a confirm follows"
                    >
                      Cancel event…
                    </button>
                  </>
                )}
                <Link className="ashell-edit-link" to={`/admin/events/${ev.id}/edit`}>
                  Open full editor →
                </Link>
                {ev.status === 'published' && (
                  <a
                    className="ashell-edit-link"
                    href={eventPath(ev)}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="View the public event page"
                  >
                    View public page ↗
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </li>
  )
}

function narrative(ev: Row, cat: boolean, pend: boolean, missingEnd: boolean): string {
  const parts: string[] = []
  if (cat) {
    parts.push(
      `The scraper read this from ${ev.source} but could not place a category with confidence, so it filed the event under Other and flagged it for a human call.`,
    )
    if (pend) {
      parts.push('It is also still awaiting its first publish; publishing has its own confirm.')
    }
  } else if (pend) {
    parts.push(
      'Scraped and stored, but not visible to the public yet. Publishing makes it live; cancelling makes sure it never goes out.',
    )
  }
  if (missingEnd) {
    parts.push(
      'The source lists a start but no end. Rather than invent a duration, the event stays visible until its Eastern day closes.',
    )
  }
  if (parts.length === 0) {
    parts.push('This row no longer matches a review reason. A refresh should clear it.')
  }
  return parts.join(' ')
}

function truncate(title: string, max = 34): string {
  return title.length > max ? `${title.slice(0, max)}…` : title
}
