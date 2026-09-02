import type { TablesUpdate } from '@/lib/database.types'
import type { LooseRow, LooseQuery } from '@/types'
import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { CATEGORIES } from '@/lib/admin/constants'
import { notEndedFilter, upcomingBounds, hasEnded } from '@/lib/admin/expiry'
import {
  REASONS, FACET_IDS, FACET_FILTERS, reviewQueueScope,
  isCategoryUnsure, isAwaitingPublish, isMissingEnd, rowReason,
  type ReasonId,
} from '@/lib/admin/reviewReasons'
import { ChipSelector, ConfirmDialog, IncludePastToggle, Pagination } from '@/components/admin'
import { eventPath } from '@/lib/slug'
import { normalizeOverrides, withStatusLock } from '@/lib/admin/useOverrides'
import { useShellCounts } from '@/lib/admin/useShellCounts'

const PAGE_SIZE = 50

/**
 * Debounce for auto-saved tag changes on published rows: long enough to pick
 * a second chip before the save commits and the row transitions out.
 */
const AUTOSAVE_DEBOUNCE_MS = 800

// Everything the rows, chips, and drawer narrate. All real columns; the
// drawer invents nothing and omits what is null.
const SELECT_LIST =
  'id, title, start_at, end_at, source, source_id, source_url, status, ' +
  'needs_review, reviewed_at, created_at, manual_overrides, series_id, ' +
  'event_categories ( category )'

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
type RowAction = 'approve' | 'dismiss' | 'publish' | 'cancel' | 'unpublish'

interface RowError {
  message: string
  action: RowAction
}

interface ConfirmState {
  kind: 'publish' | 'cancel' | 'unpublish'
  ev: Row
}

/**
 * What the queue RENDERS about one series, fetched once per page load: the
 * chip's count and the confirm dialog's date range. Nothing more. A batch
 * action never writes from this snapshot; `handleSeriesTransition` re-reads
 * the row set immediately before the write, because an operator can change a
 * row between load and click.
 *
 * Not derived from the loaded page either: the queue is server-paginated at
 * 50, and a 13-date series straddling a page boundary would report a wrong
 * number to an operator about to act on it.
 */
interface SeriesFacts {
  count: number
  firstIso: string | null
  lastIso: string | null
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.includes(x))

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
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [seriesInfo, setSeriesInfo] = useState<Record<string, SeriesFacts>>({})

  // Per-row selected categories, saving state, and inline action errors.
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [rowErrors, setRowErrors] = useState<Record<string, RowError>>({})
  // Auto-save busyness per row: a light drawer hint (aria-busy + "Saving…"),
  // deliberately NOT the row-wide `saving` flag -- that one applies
  // pointer-events:none and would freeze the drawer mid-interaction.
  const [autoSaving, setAutoSaving] = useState<Record<string, boolean>>({})

  const [openId, setOpenId] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [toast, setToast] = useState<ToastState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Mirror of `selections` readable from debounced auto-save callbacks
  // without stale-closure risk. Written in the same call sites that call
  // setSelections.
  const selectionsRef = useRef<Record<string, string[]>>({})
  // Last category set known to be persisted per row, seeded from
  // event_categories. Auto-save compares against and reverts to this.
  const lastCommitted = useRef<Record<string, string[]>>({})
  // Pending debounce timers (with the row they belong to, so a flush can
  // still run the save after the timer is cleared).
  const pendingSave = useRef<Record<string, { timer: ReturnType<typeof setTimeout>; ev: Row }>>({})
  // Per-row in-flight flag + queued follow-up: a toggle landing mid-flight
  // queues exactly one more save after the current one resolves (last write
  // wins, never interleaved). `savePromise` holds the active run so other
  // writers (confirm actions, explicit Update) can await it instead of
  // interleaving with it.
  const saveBusy = useRef<Record<string, boolean>>({})
  const saveQueued = useRef<Record<string, boolean>>({})
  const savePromise = useRef<Record<string, Promise<void>>>({})
  // Freshest known state per row, updated on fetch and on every
  // applyTransition. Confirm-based actions read from here, never from a
  // snapshot captured before an auto-save landed: a statusLock built from a
  // stale snapshot would rewrite manual_overrides WITHOUT the category lock
  // the auto-save just stamped, and the tag decision would silently revert
  // on the next scrape. (The Phase-2 RPC with a server-side jsonb merge is
  // the durable fix.)
  const latestRow = useRef<Record<string, Row>>({})

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

  // Status decisions get the same survive-the-scraper treatment as category
  // locks: scraper payloads carry `status` (ics/wix/squarespace/dice all set
  // 'published') and moderation re-sets 'pending_review' on unchanged
  // content, and `_stripOverriddenFields` only protects keys present in
  // `manual_overrides`. So Publish, Unpublish, and Cancel all stamp
  // `manual_overrides.status` -- key presence is all the scraper checks, and
  // the `{ at }` shape matches the category lock. Without this stamp, a
  // publish or cancel silently reverts on the next scrape (the same
  // "decision undone before morning" failure class migration 060 fixed for
  // `needs_review`). The shape contract lives in withStatusLock
  // (useOverrides.ts), pinned by scripts/tests/test-review-reasons.js.
  // Callers must pass the LATEST row state (see latestRow above), never a
  // snapshot from before a pending auto-save.
  const statusLock = (ev: Row) => withStatusLock(ev.manual_overrides)

  /** The freshest known state for a row, falling back to the given snapshot. */
  const freshRow = (ev: Row): Row => latestRow.current[ev.id] ?? ev

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
    setSeriesInfo({})
    const from = page * PAGE_SIZE

    // Membership + (facet) applied to page query and facet counts alike so
    // no two numbers describe different queues. The time scope is added
    // separately and POSITIVELY (never negated -- see expiry.ts); PostgREST
    // ANDs successive .or() params.
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
      // numbers: counts are cleared (never a hard "0", never a stale figure
      // from an earlier load) so the header shows an honest "unknown" state
      // instead.
      setEvents([])
      setTotal(0)
      setCounts(EMPTY_COUNTS)
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

    // Series facts for every series represented on this page, in one query.
    // Render-only (see SeriesFacts): the count on the chip and the span in the
    // confirm. On error we leave seriesInfo empty on purpose: the chip then
    // renders a bare "Series" and the batch actions fall back to single-row
    // ones. A guessed count on a destructive confirm is worse than no count.
    const seriesIds = [...new Set(rows.map((r) => r.series_id).filter(Boolean))] as string[]
    if (seriesIds.length > 0) {
      const { data: sData, error: sError } = await supabase
        .from('events')
        .select('series_id, start_at')
        .in('series_id', seriesIds)
        .is('reviewed_at', null)
        .order('start_at', { ascending: true })
      if (seq !== fetchSeq.current) return
      if (!sError) {
        const facts: Record<string, SeriesFacts> = {}
        for (const r of (sData ?? []) as Row[]) {
          const sid = r.series_id as string
          if (!facts[sid]) facts[sid] = { count: 0, firstIso: null, lastIso: null }
          const f = facts[sid]
          f.count += 1
          if (r.start_at) {
            if (f.firstIso == null) f.firstIso = r.start_at
            f.lastIso = r.start_at
          }
        }
        setSeriesInfo(facts)
      }
    }

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
    // The hidden-ended-rows head count that used to follow here was removed
    // with the hidden-count hint itself (drawer spec, 2026-08-23). That is a
    // deliberate reversal of the "always show what the default filter hides"
    // invariant -- see IncludePastToggle's doc comment before restoring it.
  }, [page, facet, includeEnded])

  useEffect(() => { fetchQueue() }, [fetchQueue])

  // Reset to the first page whenever the facet or time scope changes -- the
  // old offset points into a different result set.
  useEffect(() => { setPage(0); setOpenId(null) }, [facet, includeEnded])

  // Seed per-row selections with the event's current non-'other' categories,
  // and remember that set as the last persisted one for auto-save.
  useEffect(() => {
    // Fetched rows are server truth; transitions keep this fresh afterwards.
    events.forEach((ev) => { latestRow.current[ev.id] = ev })
    setSelections((prev) => {
      const next = { ...prev }
      events.forEach((ev) => {
        if (!(ev.id in next)) {
          next[ev.id] = ((ev.event_categories ?? []) as Row[])
            .map((ec) => ec.category)
            .filter((c: string) => c && c !== 'other')
            .slice(0, 2)
        }
        if (!(ev.id in lastCommitted.current)) {
          lastCommitted.current[ev.id] = next[ev.id]
        }
      })
      selectionsRef.current = next
      return next
    })
  }, [events])

  /**
   * Apply a successful triage to local state without a refetch (the shipped
   * stale-total bug was exactly this sync going missing). A row leaves the
   * VISIBLE list when it no longer satisfies membership, or when it no
   * longer matches the active facet (an approved cat+pend row must not
   * linger under the Category-unsure facet); it leaves the QUEUE — and the
   * pip decrements — only when membership itself ends. Facet counts sync
   * SYMMETRICALLY: a transition can also add a reason (an unpublished row
   * gains "Awaiting publish" while staying a member via its cat flag), so
   * each reason count moves by wasX/isX delta in both directions.
   */
  const applyTransition = useCallback((before: Row, patch: Partial<Row>) => {
    const after = { ...before, ...patch }
    latestRow.current[before.id] = after
    const wasCat = isCategoryUnsure(before)
    const wasPend = isAwaitingPublish(before)
    const wasTime = isMissingEnd(before)
    const stillMember = isCategoryUnsure(after) || isAwaitingPublish(after)
    const facetTwin: Record<ReasonId, (r: Row) => boolean> = {
      cat: isCategoryUnsure, pend: isAwaitingPublish, time: isMissingEnd,
    }
    const leavesFacet = facet !== 'all' && !facetTwin[facet](after)
    const leavesList = !stillMember || leavesFacet

    const shift = (n: number | null, was: boolean, is: boolean) =>
      n == null ? n : Math.max(0, n + (was && !is ? -1 : 0) + (!was && is ? 1 : 0))

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
        cat: shift(prev.cat, wasCat, isCategoryUnsure(after)),
        pend: shift(prev.pend, wasPend, isAwaitingPublish(after)),
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
      cat: shift(prev.cat, wasCat, isCategoryUnsure(after)),
      pend: shift(prev.pend, wasPend, isAwaitingPublish(after)),
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
   * Persist a category set: replace the event's categories with `cats`, then
   * stamp. The one pipeline behind both the explicit Update button and the
   * published-row auto-save.
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
   * failure at any earlier step leaves the row with `reviewed_at` unset --
   * re-running is safe and idempotent. Every step's error is checked.
   *
   * Returns the applyTransition patch on success, or an error message.
   */
  async function persistCategories(
    ev: Row,
    cats: string[],
  ): Promise<{ error: string | null; patch: Partial<Row> | null }> {
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
        return { error: `Could not update categories: ${error.message}`, patch: null }
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
    if (stampErr) {
      return { error: `Could not save the update: ${stampErr.message}`, patch: null }
    }
    return {
      error: null,
      patch: {
        needs_review: false,
        reviewed_at: stamp.reviewed_at,
        manual_overrides: updatedOverrides,
        event_categories: cats.map((category) => ({ category })),
      },
    }
  }

  /**
   * Update (the button formerly labeled Approve; semantics unchanged):
   * persist the chosen categories, lock the category override, stamp
   * reviewed_at/reviewed_by, clear needs_review. Explicit human tag choice
   * must survive re-scrape regardless of why the row queued, so this stamps
   * and locks on pend-only rows too.
   */
  async function handleApprove(ev: Row): Promise<boolean> {
    // Serialize with the per-row auto-save pipeline: this explicit Update
    // supersedes any pending debounce (clear it), and an in-flight save must
    // finish first -- two interleaved persistCategories runs for one row can
    // transiently exceed two junction rows and trip trg_event_categories_max2.
    const pending = pendingSave.current[ev.id]
    if (pending) {
      clearTimeout(pending.timer)
      delete pendingSave.current[ev.id]
    }
    if (saveBusy.current[ev.id]) await (savePromise.current[ev.id] ?? Promise.resolve())

    // Selections and row state re-read AFTER the await, so this commits the
    // set the admin sees now against the row as it now stands.
    const row = freshRow(ev)
    const cats = [...new Set(selectionsRef.current[row.id] ?? [])].slice(0, 2)
    if (cats.length === 0) return false

    setRowSaving(row.id, true)
    setRowError(row.id, null)
    const { error, patch } = await persistCategories(row, cats)
    setRowSaving(row.id, false)
    if (error || !patch) {
      setRowError(row.id, { message: error ?? 'Could not save the update.', action: 'approve' })
      return false
    }
    lastCommitted.current[row.id] = cats
    applyTransition(row, patch)
    return true
  }

  /**
   * Auto-save for published rows: a chip toggle IS the human decision, so it
   * commits through the same persistCategories pipeline (stamp + category
   * lock included -- an unstamped tag change reverts on the nightly scrape).
   * Debounced by the caller; here we serialize per row. Failure is honest:
   * revert the chips to the last persisted set and toast the error, no
   * silent retry.
   */
  function runAutoSave(ev: Row): Promise<void> {
    if (saveBusy.current[ev.id]) {
      // Queue exactly one follow-up on the active run and hand back ITS
      // promise, so awaiting callers wait for the whole serialized batch.
      saveQueued.current[ev.id] = true
      return savePromise.current[ev.id] ?? Promise.resolve()
    }
    saveBusy.current[ev.id] = true
    const run = (async () => {
      setAutoSaving((s) => ({ ...s, [ev.id]: true }))
      let cur = freshRow(ev)
      let transitioned = false
      try {
        let again = true
        while (again) {
          saveQueued.current[ev.id] = false
          const cats = [...new Set(selectionsRef.current[ev.id] ?? [])].slice(0, 2)
          const committed = lastCommitted.current[ev.id] ?? []
          if (cats.length === 0) {
            // An empty set never commits: a published event must not reach
            // zero categories (the same invariant handleApprove enforces).
            // But silence here would strand the UI out of sync with the DB,
            // so the chips revert to the last persisted set, honestly.
            if (committed.length > 0) {
              selectionsRef.current = { ...selectionsRef.current, [ev.id]: committed }
              setSelections((s) => ({ ...s, [ev.id]: committed }))
              showToast('A published event keeps at least one category. Your change was reverted.')
            }
          } else if (!sameSet(cats, committed)) {
            const { error, patch } = await persistCategories(cur, cats)
            if (error || !patch) {
              // Revert only if nothing newer arrived mid-flight: a newer
              // selection is not this failed attempt and must not be
              // stomped -- its own debounce will try it.
              const nowSel = [...new Set(selectionsRef.current[ev.id] ?? [])].slice(0, 2)
              if (sameSet(nowSel, cats)) {
                selectionsRef.current = { ...selectionsRef.current, [ev.id]: committed }
                setSelections((s) => ({ ...s, [ev.id]: committed }))
                showToast(`${error ?? 'Could not save categories.'} Your change was reverted.`)
                break
              }
              showToast(error ?? 'Could not save categories.')
            } else {
              lastCommitted.current[ev.id] = cats
              if (!transitioned) {
                applyTransition(cur, patch)
                transitioned = true
              }
              cur = { ...cur, ...patch }
              latestRow.current[ev.id] = cur
              showToast(`Updated "${truncate(ev.title)}". Category locked against re-scrape.`)
            }
          }
          again = saveQueued.current[ev.id]
        }
      } finally {
        saveBusy.current[ev.id] = false
        setAutoSaving((s) => {
          const next = { ...s }
          delete next[ev.id]
          return next
        })
      }
    })()
    savePromise.current[ev.id] = run
    return run
  }
  // Debounced callbacks and flush effects reach the latest closure through a
  // ref, so a timer set three renders ago never runs against stale state.
  const runAutoSaveRef = useRef(runAutoSave)
  runAutoSaveRef.current = runAutoSave

  const scheduleAutoSave = (ev: Row) => {
    const prev = pendingSave.current[ev.id]
    if (prev) clearTimeout(prev.timer)
    const timer = setTimeout(() => {
      delete pendingSave.current[ev.id]
      void runAutoSaveRef.current(ev)
    }, AUTOSAVE_DEBOUNCE_MS)
    pendingSave.current[ev.id] = { timer, ev }
  }

  /** Run a pending debounced save NOW (a toggle the admin saw must not evaporate). */
  const flushAutoSave = (id: string) => {
    const pending = pendingSave.current[id]
    if (!pending) return
    clearTimeout(pending.timer)
    delete pendingSave.current[id]
    void runAutoSaveRef.current(pending.ev)
  }
  const flushAutoSaveRef = useRef(flushAutoSave)
  flushAutoSaveRef.current = flushAutoSave

  /**
   * Flush any pending debounce for the row and wait for every in-flight
   * save (queued follow-up included) to land. Confirm-based actions call
   * this BEFORE opening and before acting, so they never race a save and
   * never act on a snapshot older than what just committed.
   */
  const settleAutoSave = (id: string): Promise<void> => {
    flushAutoSave(id)
    return savePromise.current[id] ?? Promise.resolve()
  }

  // Closing a drawer (or switching rows) flushes that row's pending save.
  useEffect(() => {
    Object.keys(pendingSave.current).forEach((id) => {
      if (id !== openId) flushAutoSaveRef.current(id)
    })
  }, [openId])
  // Unmount flushes everything still pending (fire-and-forget).
  useEffect(() => {
    const pending = pendingSave.current
    return () => { Object.keys(pending).forEach((id) => flushAutoSaveRef.current(id)) }
  }, [])

  const changeSelection = (ev: Row, ids: string[]) => {
    selectionsRef.current = { ...selectionsRef.current, [ev.id]: ids }
    setSelections((s) => ({ ...s, [ev.id]: ids }))
    // Published rows save on toggle (debounced); unpublished rows commit via
    // the Update button.
    if (ev.status === 'published') scheduleAutoSave(ev)
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
   * activation can never publish flagged content. Stamps the
   * manual_overrides.status lock so a re-scrape of still-moderation-matching
   * content cannot revert the publish (see statusLock).
   */
  async function handlePublish(ev: Row) {
    ev = freshRow(ev) // never build the status lock from a stale snapshot
    setRowSaving(ev.id, true)
    setRowError(ev.id, null)
    const stamp = triageStamp()
    const updatedOverrides = statusLock(ev)
    const { error } = await supabase
      .from('events')
      .update({
        ...stamp, status: 'published', needs_review: false, manual_overrides: updatedOverrides,
      } as TablesUpdate<'events'>)
      .eq('id', ev.id)
    setRowSaving(ev.id, false)
    if (error) {
      setRowError(ev.id, { message: `Could not publish: ${error.message}`, action: 'publish' })
      return
    }
    applyTransition(ev, {
      needs_review: false, reviewed_at: stamp.reviewed_at, status: 'published',
      manual_overrides: updatedOverrides,
    })
    showToast(`Published "${truncate(ev.title)}". It is live on the public site.`)
  }

  /**
   * Unpublish: take a published event off the public site, back to
   * 'pending_review'. A visibility decision, not a category adjudication --
   * it does NOT stamp reviewed_at or clear needs_review, because that would
   * silently clear the cat branch of the union predicate for a
   * still-unadjudicated flag. It DOES stamp the manual_overrides.status
   * lock, or the next scrape would flip the event straight back to
   * 'published'. The row stays in the queue (cat) and gains the pend reason.
   * Confirmed, danger-styled: it destroys public visibility in one decision.
   */
  async function handleUnpublish(ev: Row) {
    ev = freshRow(ev) // never build the status lock from a stale snapshot
    setRowSaving(ev.id, true)
    setRowError(ev.id, null)
    const updatedOverrides = statusLock(ev)
    const { error } = await supabase
      .from('events')
      .update({ status: 'pending_review', manual_overrides: updatedOverrides } as TablesUpdate<'events'>)
      .eq('id', ev.id)
    setRowSaving(ev.id, false)
    if (error) {
      setRowError(ev.id, { message: `Could not unpublish: ${error.message}`, action: 'unpublish' })
      return
    }
    applyTransition(ev, { status: 'pending_review', manual_overrides: updatedOverrides })
    showToast(`Unpublished "${truncate(ev.title)}". It is off the public site and back in review.`)
  }

  /**
   * Cancel: a pending row cannot leave the queue through `reviewed_at`
   * alone under the union predicate, so "this should not go out" needs a
   * real status. Confirmed, danger-styled. Stamps the manual_overrides.status
   * lock so the next scrape's moderation pass cannot revert the cancel back
   * to 'pending_review' (see statusLock).
   */
  async function handleCancel(ev: Row) {
    ev = freshRow(ev) // never build the status lock from a stale snapshot
    setRowSaving(ev.id, true)
    setRowError(ev.id, null)
    const stamp = triageStamp()
    const updatedOverrides = statusLock(ev)
    const { error } = await supabase
      .from('events')
      .update({
        ...stamp, status: 'cancelled', needs_review: false, manual_overrides: updatedOverrides,
      } as TablesUpdate<'events'>)
      .eq('id', ev.id)
    setRowSaving(ev.id, false)
    if (error) {
      setRowError(ev.id, { message: `Could not cancel: ${error.message}`, action: 'cancel' })
      return
    }
    applyTransition(ev, {
      needs_review: false, reviewed_at: stamp.reviewed_at, status: 'cancelled',
      manual_overrides: updatedOverrides,
    })
    showToast(`Cancelled "${truncate(ev.title)}". It will not publish.`)
  }

  /**
   * Series publish / cancel: one operator decision acting on every unreviewed
   * occurrence of the series, not just the row that was clicked.
   *
   * Written per DISTINCT manual_overrides value, not as one flat
   * `.eq('series_id', sid)` update. A single UPDATE writes one jsonb value to
   * every matched row, so if two occurrences carry different locks (one had
   * its category adjudicated earlier, say) the flat write homogenises them
   * and silently DROPS the other row's `category` key. Key presence is the
   * whole protection mechanism the scraper checks, so that row's category
   * would be overwritten on the next nightly run with no error and no trace.
   * A freshly submitted series is one group and this reduces to one call.
   *
   * The row set is re-read HERE, immediately before the write, never taken
   * from the page-load snapshot in `seriesInfo`. That snapshot is only for
   * rendering (the chip count and the confirm's date range). Between load and
   * click, an operator can Update one occurrence's categories in this very
   * drawer, which writes that row a `manual_overrides.category` lock and a
   * `reviewed_at`: grouping on the stale snapshot would file it under `{}`,
   * homogenise its overrides and clobber the lock, and re-stamp a row the
   * predicate should already have excluded. This is the same freshness
   * invariant `latestRow` / `settleAutoSave` enforce for the single-row
   * actions, and it is why the write keys on the FRESH ids.
   */
  async function handleSeriesTransition(ev: Row, kind: 'publish' | 'cancel') {
    const sid = ev.series_id as string
    const action: RowAction = kind
    setRowSaving(ev.id, true)
    setRowError(ev.id, null)

    // The ADR predicate, evaluated now. A row published by another operator
    // since this page loaded is simply not in the set, which is the desired
    // outcome, not a race to defend against.
    const { data: freshData, error: readError } = await supabase
      .from('events')
      .select('id, manual_overrides')
      .eq('series_id', sid)
      .is('reviewed_at', null)
    if (readError) {
      setRowSaving(ev.id, false)
      setRowError(ev.id, { message: `Could not read the series: ${readError.message}`, action })
      return
    }
    const fresh = (freshData ?? []) as Row[]

    // The series row goes FIRST on a cancel. extend-series.js filters
    // `cancelled_at is null`, so a batch that fails halfway leaves an inert
    // series rather than a live one that keeps minting dates overnight. It is
    // also the only gate that survives a later hand-publish of one occurrence,
    // which is why it is stamped even when there are zero rows left to write:
    // "every date was already reviewed" is exactly the state where a live
    // series would quietly keep adding new ones.
    if (kind === 'cancel') {
      const { error } = await supabase
        .from('event_series')
        .update({ cancelled_at: new Date().toISOString() } as TablesUpdate<'event_series'>)
        .eq('id', sid)
      if (error) {
        setRowSaving(ev.id, false)
        setRowError(ev.id, { message: `Could not cancel: ${error.message}`, action })
        return
      }
    }
    // Publish deliberately does NOT touch event_series: clearing a
    // cancelled_at would be a resurrect action with its own semantics.

    if (fresh.length === 0) {
      // Everything was already adjudicated elsewhere. Resync and say so
      // rather than reporting a write that touched nothing. On a cancel the
      // series is now stopped even though no occurrence changed, so the toast
      // says that too.
      setRowSaving(ev.id, false)
      await fetchQueue()
      refresh()
      showToast(
        kind === 'cancel'
          ? 'Every date in this series has already been reviewed; the series will not add new dates.'
          : 'Every date in this series has already been reviewed.',
      )
      return
    }

    const groups = new Map<string, Row[]>()
    for (const r of fresh) {
      const key = JSON.stringify(normalizeOverrides(r.manual_overrides))
      const bucket = groups.get(key)
      if (bucket) bucket.push(r)
      else groups.set(key, [r])
    }

    for (const group of groups.values()) {
      const stamp = triageStamp()
      const { error } = await supabase
        .from('events')
        .update({
          ...stamp,
          status: kind === 'publish' ? 'published' : 'cancelled',
          needs_review: false,
          manual_overrides: withStatusLock(group[0].manual_overrides),
        } as TablesUpdate<'events'>)
        .in('id', group.map((r) => r.id))
      if (error) {
        setRowSaving(ev.id, false)
        // Resync FIRST: an earlier group may already have landed, and
        // fetchQueue clears rowErrors, so setting the message before it would
        // wipe the Retry affordance before it ever painted. The toast is the
        // backstop for the case where the clicked row published in an earlier
        // group and has left the visible list entirely.
        await fetchQueue()
        refresh()
        setRowError(ev.id, { message: `Could not ${kind}: ${error.message}`, action })
        showToast(`Could not ${kind} every date of "${truncate(ev.title)}". Some may already have gone through.`)
        return
      }
    }

    setRowSaving(ev.id, false)
    // Authoritative resync rather than N hand-rolled applyTransition calls:
    // it cannot drift from that function's delta arithmetic, and it picks up
    // the occurrences that live on other pages.
    await fetchQueue()
    refresh()
    const n = fresh.length
    const dates = `${n} ${n === 1 ? 'date' : 'dates'}`
    showToast(
      kind === 'publish'
        ? `Published ${dates} of "${truncate(ev.title)}". They are live on the public site.`
        : `Cancelled ${dates} of "${truncate(ev.title)}". None of them will publish.`,
    )
  }

  async function approveWithToast(ev: Row) {
    const ok = await handleApprove(ev)
    if (ok) showToast(`Updated "${truncate(ev.title)}". Category locked against re-scrape.`)
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
      `${done} ${done === 1 ? 'event' : 'events'} updated.` +
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

  /**
   * Open a confirm dialog row-fresh: settle the row's auto-save first, then
   * capture the LATEST row. Without this, a pending auto-save could land
   * between opening and confirming, and the confirm's stale snapshot would
   * rebuild manual_overrides without the just-written category lock -- the
   * tag decision would then silently revert on the next scrape.
   */
  const openConfirm = async (kind: ConfirmState['kind'], ev: Row) => {
    await settleAutoSave(ev.id)
    setConfirm({ kind, ev: freshRow(ev) })
  }

  const seriesFactsFor = (ev: Row): SeriesFacts | null =>
    (ev.series_id ? seriesInfo[ev.series_id as string] : null) ?? null

  const confirmMessage = (c: ConfirmState): string => {
    const facts = seriesFactsFor(c.ev)
    if (facts && c.kind !== 'unpublish') {
      const span = facts.firstIso && facts.lastIso
        ? `${format(new Date(facts.firstIso), 'MMM d')} through ${format(new Date(facts.lastIso), 'MMM d')}`
        : null
      if (c.kind === 'cancel') {
        return `Cancel all ${facts.count} dates of "${c.ev.title}"? None of them will publish, and the series stops adding new dates.`
      }
      // Same moderation caveat the single-row publish carries below: an
      // extreme-moderation row (status 'cancelled') can sit in the queue via
      // its cat flag, and publishing would override that call.
      const moderated = c.ev.status === 'cancelled'
        ? 'This event was cancelled by moderation. '
        : ''
      return `${moderated}Publish all ${facts.count} dates of "${c.ev.title}"? They go live on the public site${span ? `, ${span}` : ''}.`
    }
    if (c.kind === 'publish') {
      // An extreme-moderation row (status 'cancelled') can sit in the queue
      // via its cat flag; "Publish first" would foreground it, so the
      // confirm says what publishing would override.
      return c.ev.status === 'cancelled'
        ? `This event was cancelled by moderation. Publish "${c.ev.title}" anyway?`
        : `Publish "${c.ev.title}" to the public site?`
    }
    if (c.kind === 'unpublish') {
      return `Take "${c.ev.title}" off the public site? It returns to the review queue.`
    }
    return `Cancel "${c.ev.title}"? It will never publish and shows as cancelled.`
  }

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
        {/* showHint={false}: the hidden-count copy was deliberately removed
            here (drawer spec, 2026-08-23), reversing the earlier "always
            show what the default hides" rule. Documented in
            IncludePastToggle; do not restore as a bug fix. */}
        <IncludePastToggle
          includePast={includeEnded}
          onChange={setIncludeEnded}
          showHint={false}
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
          {/* The "N ended events stay tucked away" note that used to render
              here was deliberately removed (drawer spec, 2026-08-23) along
              with the hidden-count hint. See IncludePastToggle. */}
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
                <span className="ashell-qcol-acts" />
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
                    isAutoSaving={!!autoSaving[ev.id]}
                    rowError={rowErrors[ev.id] ?? null}
                    selection={selections[ev.id] ?? []}
                    seriesFacts={seriesFactsFor(ev)}
                    onToggleOpen={() => setOpenId((prev) => (prev === ev.id ? null : ev.id))}
                    onToggleSelected={() => toggleSelected(ev.id)}
                    onSelectionChange={(ids) => changeSelection(ev, ids)}
                    onApprove={() => approveWithToast(ev)}
                    onDismiss={() => dismissWithToast(ev)}
                    onPublish={() => { void openConfirm('publish', ev) }}
                    onUnpublish={() => { void openConfirm('unpublish', ev) }}
                    onCancelEvent={() => { void openConfirm('cancel', ev) }}
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
            Update selected
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
          message={confirmMessage(confirm)}
          confirmLabel={
            confirm.kind === 'publish' ? 'Publish'
              : confirm.kind === 'unpublish' ? 'Unpublish'
                : 'Cancel event'
          }
          tone={confirm.kind === 'publish' ? 'primary' : 'danger'}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const { kind, ev } = confirm
            setConfirm(null)
            // Settle again (cheap when idle): the handler must act on the
            // row as it stands NOW, not as it stood when the dialog opened.
            await settleAutoSave(ev.id)
            const row = freshRow(ev)
            const facts = seriesFactsFor(row)
            if (kind === 'unpublish') handleUnpublish(row)
            else if (facts) handleSeriesTransition(row, kind)
            else if (kind === 'publish') handlePublish(row)
            else handleCancel(row)
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
  isAutoSaving: boolean
  rowError: RowError | null
  selection: string[]
  /** Null when the row is not in a series, or the series query failed. */
  seriesFacts: SeriesFacts | null
  onToggleOpen: () => void
  onToggleSelected: () => void
  onSelectionChange: (ids: string[]) => void
  onApprove: () => void
  onDismiss: () => void
  onPublish: () => void
  onUnpublish: () => void
  onCancelEvent: () => void
}

function QueueRow({
  ev, nowIso, isOpen, isSelected, isSaving, isAutoSaving, rowError, selection,
  seriesFacts, onToggleOpen, onToggleSelected, onSelectionChange,
  onApprove, onDismiss, onPublish, onUnpublish, onCancelEvent,
}: QueueRowProps) {
  const reason = rowReason(ev)
  const cat = isCategoryUnsure(ev)
  const pend = isAwaitingPublish(ev)
  const missingEnd = isMissingEnd(ev)
  const published = ev.status === 'published'
  const runningNow = !!ev.end_at && !!ev.start_at && ev.start_at <= nowIso && ev.end_at >= nowIso
  const drawerId = `qdrawer-${ev.id}`
  const titleId = `qtitle-${ev.id}`
  // Retry re-runs the action that actually failed -- a failed Cancel must
  // never route through the Publish confirm. Publish/unpublish/cancel
  // retries go back through their confirms; publishing stays behind a
  // confirm, always.
  const retryHandlers: Record<RowAction, () => void> = {
    approve: onApprove, dismiss: onDismiss, publish: onPublish,
    cancel: onCancelEvent, unpublish: onUnpublish,
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
      {/* Clicking anywhere on the row toggles the drawer. This is a pointer
          convenience only: the title <button> below stays the accessible
          disclosure control (aria-expanded/aria-controls, native Enter and
          Space). No role="button" on the row -- interactive descendants
          inside a button role are invalid ARIA. Controls are excluded
          structurally via closest(); a live text selection must not toggle. */}
      <div
        className={`ashell-qrow ${isSelected ? 'ashell-qrow--selected' : ''} ${isOpen ? 'ashell-qrow--open' : ''}`}
        onClick={(e) => {
          const target = e.target as HTMLElement
          if (target.closest('button, a, input, [role="button"]')) return
          // Only a selection INSIDE this row suppresses the toggle; a live
          // selection elsewhere on the page is not this row's business.
          const sel = window.getSelection()
          if (sel && !sel.isCollapsed && e.currentTarget.contains(sel.anchorNode)) return
          onToggleOpen()
        }}
      >
        <button
          type="button"
          className="ashell-cb"
          aria-pressed={isSelected}
          aria-label={`Select ${ev.title}`}
          onClick={(e) => {
            // Belt-and-braces: the row's closest() check already excludes
            // buttons, but selecting must never fall through to a toggle.
            e.stopPropagation()
            onToggleSelected()
          }}
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
          {ev.series_id && (
            <span className="ashell-chip ashell-chip--pend ashell-chip--mini">
              {seriesFacts ? `Series (${seriesFacts.count})` : 'Series'}
            </span>
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

        {/* Decorative open/closed affordance only. The old ✓/✗ quick actions
            are gone (approve/dismiss live in the drawer now), and the
            chevron's <button> wrapper with them: with the whole row as the
            toggle, a second interactive disclosure control would be
            duplicate tab-stop noise. */}
        <div className="ashell-qcol-acts ashell-acts" aria-hidden="true">
          <span className={`ashell-chev ${isOpen ? 'ashell-chev--open' : ''}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" focusable="false">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </span>
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
            <div className="ashell-dcol ashell-dcol--why">
              <h4>Why this is in review</h4>
              <p className="ashell-why-p">{narrative(ev, cat, pend, missingEnd, seriesFacts)}</p>
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
            <div className="ashell-dcol ashell-dcol--fix">
              <h4>Set it right</h4>
              {/* The tag picker renders in EVERY drawer and stays editable
                  even when tags are already set (drawer standard, item 1.1).
                  On published rows a toggle auto-saves (debounced); the
                  aria-busy hint below is the light per-drawer signal, never
                  the row-wide saving freeze. */}
              <div className="ashell-catpick" aria-busy={isAutoSaving || undefined}>
                <ChipSelector
                  items={REMAP_OPTIONS.map((c) => ({ id: c.value, name: c.label }))}
                  selectedIds={selection}
                  onChange={onSelectionChange}
                  max={2}
                  maxHint="Only two categories can be selected at a time"
                />
                {isAutoSaving && <span className="ashell-autosave" role="status">Saving…</span>}
              </div>
              {rowError && (
                <p className="ashell-row-error" role="alert">
                  {rowError.message}{' '}
                  <button type="button" className="ashell-linkbtn" onClick={retryHandlers[rowError.action]}>
                    Retry
                  </button>
                </p>
              )}
              <div className="ashell-dactions">
                {/* Publish/Unpublish is ALWAYS the first button (drawer
                    standard, item 2.1). Both go through a confirm. */}
                {published ? (
                  <button
                    type="button"
                    className="ashell-btn ashell-btn--danger-ghost"
                    onClick={onUnpublish}
                    disabled={isSaving}
                    title="Take this event off the public site; a confirm follows"
                  >
                    Unpublish…
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ashell-btn ashell-btn--primary"
                    onClick={onPublish}
                    disabled={isSaving}
                    title="Publish this event to the public site; a confirm follows"
                  >
                    {seriesFacts ? `Publish series (${seriesFacts.count})…` : 'Publish…'}
                  </button>
                )}
                {/* Published rows have no Update button: tag toggles
                    auto-save there. */}
                {!published && (
                  <button
                    type="button"
                    className="ashell-btn"
                    onClick={onApprove}
                    disabled={isSaving || selection.length === 0}
                    title="Save these categories and lock them against future scraper overwrites"
                  >
                    {isSaving ? 'Saving…' : 'Update'}
                  </button>
                )}
                {cat && (
                  <button
                    type="button"
                    className="ashell-btn"
                    onClick={onDismiss}
                    disabled={isSaving}
                    title="Remove from the queue without changing the category"
                  >
                    Dismiss
                  </button>
                )}
                {pend && (
                  <button
                    type="button"
                    className="ashell-btn ashell-btn--danger"
                    onClick={onCancelEvent}
                    disabled={isSaving}
                    title="Mark this event cancelled so it never publishes; a confirm follows"
                  >
                    {seriesFacts ? `Cancel series (${seriesFacts.count})…` : 'Cancel event…'}
                  </button>
                )}
                <Link className="ashell-edit-link" to={`/admin/events/${ev.id}/edit`}>
                  Open full editor →
                </Link>
                {published && (
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

function narrative(
  ev: Row, cat: boolean, pend: boolean, missingEnd: boolean, seriesFacts: SeriesFacts | null,
): string {
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
  // The rows of a series are NOT contiguous in this list (the sort is
  // start_at, and other events fall between the dates), so say plainly that
  // the repetition is a series and that one action covers all of it.
  if (seriesFacts) {
    parts.push(
      `This is 1 of ${seriesFacts.count} dates in a repeating series. ` +
      `Publishing or cancelling acts on all ${seriesFacts.count}. ` +
      'To change a single date, open the full editor.',
    )
  }
  return parts.join(' ')
}

function truncate(title: string, max = 34): string {
  return title.length > max ? `${title.slice(0, max)}…` : title
}
