/**
 * PartnerEventsPage (design §4.5): the scoped events list + drawer, modeled
 * on ReviewQueueSurface's row+drawer surface (the drawer standard is the
 * spec for slide-out editing), NOT on the admin table. Rendered whole on
 * /admin/events for partners and embedded whole by PartnerHomePage.
 *
 * Reads go through the partner's own RLS lens; the explicit scope filter is
 * UX (which rows to SHOW -- published events of other orgs are publicly
 * readable by design), RLS is what guarantees no cross-tenant non-published
 * row can ever arrive. Writes leave ONLY through the 061 RPCs.
 */

import type { LooseRow, LooseQuery } from '@/types'
import { useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { format } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { notEndedFilter } from '@/lib/admin/expiry'
import { ConfirmDialog, IncludePastToggle, Pagination, StatusBadge } from '@/components/admin'
import { usePartnerContext } from '@/lib/admin/usePartnerContext'
import {
  partnerCanWrite, coHostNamesOutsideScope, writeOrgId, predictedReviewBlocker,
  reviewOutcomeCopy, rpcFriendlyMessage, cancelConfirmCopy, CANCELLED_FINAL_COPY,
} from '@/lib/admin/partnerShared'
import PartnerEventDrawer from '@/pages/admin/partner/PartnerEventDrawer'
import type { VenueOption } from '@/pages/admin/partner/PartnerVenueControl'

const PAGE_SIZE = 50

/** Same debounce as the review queue's published-row tag auto-save. */
const AUTOSAVE_DEBOUNCE_MS = 800

// The columns the rows and drawer narrate, plus the FULL organizations
// array (design §6.10 item 2: never organizations[0] -- a co-hosted row
// shows every name). `scope_links` is a second, filtered embed of the same
// junction used only to scope the parent rows; the unfiltered embed keeps
// the display list complete.
const SELECT_LIST =
  'id, title, description, start_at, end_at, price_min, price_max, age_restriction, ' +
  'ticket_url, source_url, image_url, status, source, needs_review, manual_overrides, created_at, ' +
  'event_categories ( category ), ' +
  'event_venues ( venue:venues ( id, name ) ), ' +
  'event_organizations ( organization:organizations ( id, name ) ), ' +
  'scope_links:event_organizations!inner ( organization_id )'

type Row = LooseRow

interface ConfirmState {
  kind: 'publish' | 'cancel'
  ev: Row
}

interface RpcResult {
  id: string
  status: string
  review_required_by: string | null
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((x) => b.includes(x))

function truncate(title: string, max = 34): string {
  return title.length > max ? `${title.slice(0, max)}…` : title
}

/** The /admin/events surface for partners. */
export default function PartnerEventsPage() {
  return <PartnerEventsSurface />
}

interface PartnerEventsSurfaceProps {
  /** Org ids to show; null/empty means the whole scope (design §4.4). */
  orgFilter?: string[] | null
}

export function PartnerEventsSurface({ orgFilter = null }: PartnerEventsSurfaceProps) {
  const { orgs, scopeIds } = usePartnerContext()

  const [events, setEvents] = useState<Row[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [includePast, setIncludePast] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Venue options for the drawer, fetched once on the first drawer open.
  const [venues, setVenues] = useState<VenueOption[] | null>(null)

  // Per-row tag selections + the auto-save machinery, ported from the
  // review queue (pendingSave/saveBusy/savePromise/latestRow) -- the RPC's
  // single-transaction swap retires the interleaving dance, so this
  // implementation is simpler than the admin one.
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [autoSaving, setAutoSaving] = useState<Record<string, boolean>>({})
  const selectionsRef = useRef<Record<string, string[]>>({})
  const lastCommitted = useRef<Record<string, string[]>>({})
  const pendingSave = useRef<Record<string, { timer: ReturnType<typeof setTimeout>; ev: Row }>>({})
  const saveBusy = useRef<Record<string, boolean>>({})
  const saveQueued = useRef<Record<string, boolean>>({})
  const savePromise = useRef<Record<string, Promise<void>>>({})
  const latestRow = useRef<Record<string, Row>>({})

  const filterIds = useMemo(
    () => (orgFilter && orgFilter.length > 0 ? orgFilter : scopeIds),
    [orgFilter, scopeIds],
  )
  const filterKey = filterIds.join(',')

  const showToast = useCallback((message: string) => {
    setToast(message)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 4200)
  }, [])
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

  const fetchSeq = useRef(0)
  const fetchEvents = useCallback(async () => {
    const seq = ++fetchSeq.current
    setLoading(true)
    const ids = filterKey === '' ? [] : filterKey.split(',')
    if (ids.length === 0) {
      setEvents([]); setTotal(0); setFetchError(null); setLoading(false)
      return
    }
    const from = page * PAGE_SIZE
    let query: LooseQuery = supabase
      .from('events')
      .select(SELECT_LIST, { count: 'exact' })
      .in('scope_links.organization_id', ids)
      .order('start_at', { ascending: !includePast })
      .range(from, from + PAGE_SIZE - 1)
    if (!includePast) query = query.or(notEndedFilter())

    const { data, count, error } = await query
    if (seq !== fetchSeq.current) return
    if (error) {
      // A failed fetch must not render as an empty list; "no events" and
      // "we could not ask" are opposite facts (queue precedent).
      setEvents([]); setTotal(0); setFetchError(error.message); setLoading(false)
      return
    }
    setEvents((data ?? []) as Row[])
    setTotal(count ?? 0)
    setFetchError(null)
    setLoading(false)
  }, [page, includePast, filterKey])

  useEffect(() => { fetchEvents() }, [fetchEvents])
  useEffect(() => { setPage(0); setOpenId(null) }, [includePast, filterKey])

  // Seed per-row selections from server truth; keep latestRow fresh.
  useEffect(() => {
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

  const freshRow = (ev: Row): Row => latestRow.current[ev.id] ?? ev

  const applyPatch = useCallback((id: string, patch: Partial<Row>) => {
    const before = latestRow.current[id]
    const after = { ...(before ?? {}), ...patch } as Row
    latestRow.current[id] = after
    setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)))
  }, [])

  const ensureVenues = useCallback(async () => {
    if (venues != null) return
    const { data, error } = await supabase.from('venues').select('id, name').order('name')
    if (!error) setVenues((data ?? []) as VenueOption[])
    else setVenues([])
  }, [venues])
  useEffect(() => { if (openId != null) ensureVenues() }, [openId, ensureVenues])

  const addVenueOption = useCallback((v: VenueOption) => {
    setVenues((prev) => {
      const list = prev ?? []
      if (list.some((x) => x.id === v.id)) return list
      return [...list, v].sort((a, b) => a.name.localeCompare(b.name))
    })
  }, [])

  // ── Tag auto-save (published rows) through partner_set_event_categories ──
  function runAutoSave(ev: Row): Promise<void> {
    if (saveBusy.current[ev.id]) {
      saveQueued.current[ev.id] = true
      return savePromise.current[ev.id] ?? Promise.resolve()
    }
    saveBusy.current[ev.id] = true
    const run = (async () => {
      setAutoSaving((s) => ({ ...s, [ev.id]: true }))
      try {
        let again = true
        while (again) {
          saveQueued.current[ev.id] = false
          const cats = [...new Set(selectionsRef.current[ev.id] ?? [])].slice(0, 2)
          const committed = lastCommitted.current[ev.id] ?? []
          if (cats.length === 0) {
            // A published event keeps at least one category; revert honestly.
            if (committed.length > 0) {
              selectionsRef.current = { ...selectionsRef.current, [ev.id]: committed }
              setSelections((s) => ({ ...s, [ev.id]: committed }))
              showToast('A published event keeps at least one category. Your change was reverted.')
            }
          } else if (!sameSet(cats, committed)) {
            const org = writeOrgId(linkedOrgIds(freshRow(ev)), scopeIds)
            const { error } = org == null
              ? { error: { message: 'this event is not editable as this organization', code: '42501' } }
              : await supabase.rpc('partner_set_event_categories', {
                p_org: org, p_event: ev.id, p_slugs: cats,
              })
            if (error) {
              const nowSel = [...new Set(selectionsRef.current[ev.id] ?? [])].slice(0, 2)
              if (sameSet(nowSel, cats)) {
                selectionsRef.current = { ...selectionsRef.current, [ev.id]: committed }
                setSelections((s) => ({ ...s, [ev.id]: committed }))
                showToast(`${rpcFriendlyMessage(error, 'Could not save categories.')} Your change was reverted.`)
                break
              }
              showToast(rpcFriendlyMessage(error, 'Could not save categories.'))
            } else {
              lastCommitted.current[ev.id] = cats
              applyPatch(ev.id, { event_categories: cats.map((category) => ({ category })) })
              showToast(`Updated "${truncate(ev.title)}".`)
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

  const flushAutoSave = (id: string) => {
    const pending = pendingSave.current[id]
    if (!pending) return
    clearTimeout(pending.timer)
    delete pendingSave.current[id]
    void runAutoSaveRef.current(pending.ev)
  }
  const flushAutoSaveRef = useRef(flushAutoSave)
  flushAutoSaveRef.current = flushAutoSave

  const settleAutoSave = (id: string): Promise<void> => {
    flushAutoSave(id)
    return savePromise.current[id] ?? Promise.resolve()
  }

  // Closing a drawer (or switching rows) flushes that row's pending save;
  // unmount flushes everything (fire-and-forget), queue precedent.
  useEffect(() => {
    Object.keys(pendingSave.current).forEach((id) => {
      if (id !== openId) flushAutoSaveRef.current(id)
    })
  }, [openId])
  useEffect(() => {
    const pending = pendingSave.current
    return () => { Object.keys(pending).forEach((id) => flushAutoSaveRef.current(id)) }
  }, [])

  const changeSelection = (ev: Row, ids: string[]) => {
    selectionsRef.current = { ...selectionsRef.current, [ev.id]: ids }
    setSelections((s) => ({ ...s, [ev.id]: ids }))
    if (freshRow(ev).status === 'published') scheduleAutoSave(ev)
  }

  // ── Status changes through partner_set_event_status ────────────────────
  const linkedOrgIds = (ev: Row): string[] =>
    ((ev.event_organizations ?? []) as Row[])
      .map((eo) => eo.organization?.id)
      .filter(Boolean) as string[]

  async function handleStatus(ev: Row, target: 'published' | 'cancelled') {
    const row = freshRow(ev)
    const org = writeOrgId(linkedOrgIds(row), scopeIds)
    if (org == null) {
      showToast('This event is not editable as your organization.')
      return
    }
    const { data, error } = await supabase.rpc('partner_set_event_status', {
      p_org: org, p_event: row.id, p_status: target,
    })
    if (error) {
      showToast(rpcFriendlyMessage(error, target === 'published' ? 'Could not publish.' : 'Could not cancel.'))
      return
    }
    const result = data as unknown as RpcResult
    applyPatch(row.id, { status: result.status })
    if (target === 'cancelled') {
      // Cancelled is final for partners (fix-pass finding 5); say so now,
      // not when they later look for a republish button.
      showToast(`Cancelled "${truncate(row.title)}". Only Akron Pulse can restore it.`)
    } else if (result.status === 'published') {
      showToast(`Published "${truncate(row.title)}". It is live on the public site.`)
    } else {
      // The RPC resolved publish to review. That covers a tenant's
      // auto_publish rule (review_required_by names the org) AND the
      // moderation gate on flagged or still-flagging rows (fix-pass
      // finding 1, review_required_by null) -- both get the same honest
      // treatment, never a generic error. The truth is the RPC's return,
      // never the client's guess.
      showToast(reviewOutcomeCopy(result.review_required_by))
    }
  }

  const openConfirm = async (kind: ConfirmState['kind'], ev: Row) => {
    await settleAutoSave(ev.id)
    setConfirm({ kind, ev: freshRow(ev) })
  }

  const confirmMessage = (c: ConfirmState): string => {
    if (c.kind === 'cancel') {
      // Pinned copy (partnerShared): cancelling is permanent for partners,
      // restoring is admin-only.
      return cancelConfirmCopy(c.ev.title)
    }
    const blocker = predictedReviewBlocker(linkedOrgIds(c.ev), orgs)
    return blocker
      ? `Publish "${c.ev.title}"? ${blocker}'s events are reviewed first, so this will go to Akron Pulse for review.`
      : `Publish "${c.ev.title}" to the public site?`
  }

  return (
    <section className="ashell-work" aria-label="Your events">
      <div className="ashell-surface-hd">
        <h2>Your events</h2>
        {fetchError ? (
          <span className="ashell-count" aria-label="Count unavailable">…</span>
        ) : (
          !loading && <span className="ashell-count">{total.toLocaleString()}</span>
        )}
        <div className="ashell-grow" />
        <IncludePastToggle includePast={includePast} onChange={setIncludePast} showHint={false} />
      </div>

      {loading && <div className="admin-loading">Loading your events…</div>}

      {!loading && fetchError && (
        <div className="admin-review-error" role="alert">
          <p>Could not load your events. This is a fetch failure, not an empty list.</p>
          <p className="admin-review-error-detail">{fetchError}</p>
          <button className="btn-admin-ghost btn-admin-sm" onClick={fetchEvents}>
            Retry
          </button>
        </div>
      )}

      {!loading && !fetchError && events.length === 0 && (
        <div className="ashell-empty">
          <div className="ashell-empty-ring" aria-hidden="true">✓</div>
          <h3>No events in this view</h3>
          <p>Nothing upcoming here yet. New event in the rail starts one.</p>
        </div>
      )}

      {!loading && !fetchError && events.length > 0 && (
        <>
          <div className="ashell-queue-scroll">
            <div className="ashell-queue">
              <div className="ashell-phead" aria-hidden="true">
                <span>Event</span>
                <span className="ashell-pcol-orgs">Organizations</span>
                <span className="ashell-pcol-status">Status</span>
                <span className="ashell-pcol-when">When</span>
                <span className="ashell-pcol-chev" />
              </div>
              <ul role="list" className="ashell-qlist">
                {events.map((ev) => (
                  <PartnerRow
                    key={ev.id}
                    ev={freshRow(ev)}
                    isOpen={openId === ev.id}
                    onToggleOpen={() => setOpenId((prev) => (prev === ev.id ? null : ev.id))}
                  >
                    {openId === ev.id && (
                      <PartnerEventDrawer
                        key={ev.id}
                        ev={freshRow(ev)}
                        writeOrg={writeOrgId(linkedOrgIds(freshRow(ev)), scopeIds)}
                        canWrite={partnerCanWrite(linkedOrgIds(freshRow(ev)), scopeIds)}
                        unwritableNames={coHostNamesOutsideScope(
                          (((freshRow(ev).event_organizations ?? []) as Row[])
                            .map((eo) => eo.organization)
                            .filter(Boolean)) as { id: string; name: string }[],
                          scopeIds,
                        )}
                        venues={venues ?? []}
                        onVenueKnown={addVenueOption}
                        selection={selections[ev.id] ?? []}
                        onSelectionChange={(ids) => changeSelection(ev, ids)}
                        isAutoSaving={!!autoSaving[ev.id]}
                        onPublish={() => { void openConfirm('publish', ev) }}
                        onCancelEvent={() => { void openConfirm('cancel', ev) }}
                        onApplied={(patch) => applyPatch(ev.id, patch)}
                        showToast={showToast}
                      />
                    )}
                  </PartnerRow>
                ))}
              </ul>
            </div>
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </>
      )}

      {toast && (
        <div className="ashell-toast" role="status">
          <span>{toast}</span>
        </div>
      )}

      {confirm && (
        <ConfirmDialog
          message={confirmMessage(confirm)}
          confirmLabel={confirm.kind === 'publish' ? 'Publish' : 'Cancel event'}
          tone={confirm.kind === 'publish' ? 'primary' : 'danger'}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            const { kind, ev } = confirm
            setConfirm(null)
            await settleAutoSave(ev.id)
            handleStatus(freshRow(ev), kind === 'publish' ? 'published' : 'cancelled')
          }}
        />
      )}
    </section>
  )
}

// ── Row ───────────────────────────────────────────────────────────────────

interface PartnerRowProps {
  ev: Row
  isOpen: boolean
  onToggleOpen: () => void
  children?: ReactNode
}

function PartnerRow({ ev, isOpen, onToggleOpen, children }: PartnerRowProps) {
  const drawerId = `pdrawer-${ev.id}`
  const titleId = `ptitle-${ev.id}`
  // The FULL organizations array, never organizations[0] (design §6.10).
  const orgNames = ((ev.event_organizations ?? []) as Row[])
    .map((eo) => eo.organization?.name)
    .filter(Boolean) as string[]

  return (
    <li
      className="ashell-qitem"
      onKeyDown={(e) => {
        // Escape closes an open drawer (WAI-ARIA disclosure convention).
        if (e.key === 'Escape' && isOpen) {
          e.stopPropagation()
          onToggleOpen()
        }
      }}
    >
      {/* Row click toggles; the title button stays the accessible
          disclosure control (queue precedent -- controls excluded via
          closest(), a live in-row text selection must not toggle). */}
      <div
        className={`ashell-prow ${isOpen ? 'ashell-qrow--open' : ''}`}
        onClick={(e) => {
          const target = e.target as HTMLElement
          if (target.closest('button, a, input, [role="button"]')) return
          const sel = window.getSelection()
          if (sel && !sel.isCollapsed && e.currentTarget.contains(sel.anchorNode)) return
          onToggleOpen()
        }}
      >
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
        <div className="ashell-pcol-orgs ashell-porgs">
          {orgNames.length > 0 ? orgNames.join(' · ') : '—'}
        </div>
        <div
          className="ashell-pcol-status"
          // Cancelled is final for partners; the row says so on hover, the
          // drawer says so in full.
          title={ev.status === 'cancelled' ? CANCELLED_FINAL_COPY : undefined}
        >
          <StatusBadge status={ev.status} />
        </div>
        <div className="ashell-pcol-when ashell-when">
          {ev.start_at ? (
            <>
              {format(new Date(ev.start_at), 'MMM d')}
              <span className="ashell-when-sub">{format(new Date(ev.start_at), 'h:mm a')}</span>
            </>
          ) : (
            '—'
          )}
        </div>
        <div className="ashell-pcol-chev ashell-acts" aria-hidden="true">
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
        {children}
      </div>
    </li>
  )
}
