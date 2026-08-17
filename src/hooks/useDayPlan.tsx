import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  readDraft,
  writeDraft,
  readActivePlanCode,
  writeActivePlanCode,
  clearActivePlanCode as clearActivePlanCodeStorage,
  addItemToDraft,
  removeItemFromDraft,
  isItemInDraft,
  setDraftTitle,
  emptyDraft,
  MAX_ITEMS,
  type DayPlanDraft,
  type DraftItem,
  type SnapshotSource,
} from '@/lib/dayPlanDraft'
import { addEventToPlan, removeEventFromPlan, type DayPlanItem } from '@/lib/dayPlanApi'
import { trackEvent, EVENTS } from '@/lib/analytics'
import type { PlanSurface } from '@/lib/analyticsEvents'

/**
 * DayPlanContext — the local draft, MIRRORED to the shared plan once one
 * exists. (It was draft-only by design at first; that was wrong, because
 * DayPlanPage redirects /day to /d/<code> as soon as a plan is shared, so a
 * draft-only add became invisible and unrecoverable. See syncToSharedPlan.)
 * Mounted once at the top of App.tsx, above both
 * the /embed route group and the full-site SiteChrome group, so every
 * consumer (Header's "Plan · N" pill, EventCard/EventPage's add-to-plan
 * button, DayPlanPage) reads the same in-memory + localStorage-backed state
 * without a network round trip.
 *
 * AddToPlanButton itself decides not to render inside the embed
 * (useEmbed() !== null, decision 8) — this provider still wraps the embed
 * route tree so that check can run as an unconditional hook call rather than
 * a conditional one.
 *
 * Also owns the one shared `aria-live="polite"` region every plan mutation
 * (add, remove, cap, sync failure) announces through -- see `announce`
 * below and the day-plan audit's P1-9.
 */
interface RemoveItemOpts {
  /** false when the caller (SharedPlanPage.handleRemove) already owns the
   *  server call itself and only wants this hook to update the local
   *  draft/pill count -- see P0-6: without this, removing an item from
   *  your OWN shared plan issued the day_plan_remove_event RPC twice
   *  (once from here, once from the page), halving the anti-abuse budget
   *  and racing two responses against each other. */
  syncToServer?: boolean
}

interface DayPlanContextValue {
  draft: DayPlanDraft
  activePlanCode: string | null
  isInPlan: (eventId: string) => boolean
  /** True once the draft holds MAX_ITEMS -- drives the "+ Plan" chip's
   *  full-but-not-disabled aria-label (day-plan-audit.md, Ask 1). */
  isFull: boolean
  /** Returns false (no-op) when the draft is already at the 30-item cap and this event isn't in it yet. */
  addItem: (event: SnapshotSource & { category?: string | null }, surface: PlanSurface) => boolean
  removeItem: (eventId: string, surface: PlanSurface, opts?: RemoveItemOpts) => void
  setTitle: (title: string | null) => void
  /** Two-way heal against the server's truth for the active plan (P1-2):
   *  drops items the server no longer has AND restores items the server
   *  still has that the local draft is missing (the signature of a failed
   *  syncToSharedPlan('remove') that never reached the server). */
  reconcileDraft: (serverItems: DayPlanItem[]) => void
  setActivePlanCode: (code: string) => void
  /** Forget this device's remembered plan code without touching the draft.
   *  P1-17: called when a code is confirmed dead (get_day_plan returned
   *  null) so every future /day visit doesn't pay a wasted round trip. */
  clearActivePlanCode: () => void
  /** Decision 1 of the day-plan audit: the "Start a new plan" escape hatch
   *  on /d/:code. Clears BOTH the remembered code and the local draft and
   *  returns to a blank slate -- the old plan keeps working at its own link
   *  for anyone still holding it; this device just stops treating it as
   *  "mine". Navigation to /day is the caller's job. */
  startNewPlan: () => void
  /** Announce a message through the shared aria-live="polite" region
   *  mounted by this provider (P1-9). Safe to call from anywhere reading
   *  this context. */
  announce: (message: string) => void
}

/**
 * True when a mutation RPC failed because the plan row no longer exists.
 * All three day-plan mutation RPCs raise `'no day plan found for that code'`
 * with errcode check_violation (SQLSTATE 23514) for this case — see
 * migrations/052 §11. The message match matters: the 30-item cap raise uses
 * the SAME sqlstate, and treating a cap hit as "plan gone" would silently
 * discard a live shared plan.
 */
function isPlanGoneError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null
  return e?.code === '23514' && /no day plan found/i.test(e?.message ?? '')
}

const DayPlanContext = createContext<DayPlanContextValue | null>(null)

export function DayPlanProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<DayPlanDraft>(() => readDraft())
  const [activePlanCode, setActivePlanCodeState] = useState<string | null>(() => readActivePlanCode())
  const [liveMessage, setLiveMessage] = useState('')
  const liveClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isInPlan = useCallback((eventId: string) => isItemInDraft(draft, eventId), [draft])
  const isFull = draft.items.length >= MAX_ITEMS

  /**
   * Push a message into the shared aria-live region. Clears first (even
   * when the incoming message is identical to the current one) so a screen
   * reader registers a genuine content change every time rather than
   * silently swallowing a repeat announcement -- e.g. hitting the 30-item
   * cap twice in a row on two different cards.
   */
  const announce = useCallback((message: string) => {
    if (liveClearRef.current) clearTimeout(liveClearRef.current)
    setLiveMessage('')
    liveClearRef.current = setTimeout(() => setLiveMessage(message), 30)
  }, [])

  /**
   * Once a plan has been shared, the local draft is NOT the source of truth
   * any more -- /day redirects to /d/<code> (DayPlanPage), so the draft
   * becomes invisible and anything added to it alone is effectively lost.
   * That is exactly what happened on 2026-08-09: three events were added from
   * event cards, the header pill counted them, and clicking through landed on
   * a shared plan the server had never heard about them for.
   *
   * So every local mutation is mirrored to the shared plan when one exists.
   * Fire-and-forget on the HAPPY path only: the draft update is optimistic
   * and instant, but a failed sync now REVERTS the optimistic change (P1-3)
   * instead of leaving a UI that lies until reconcileDraft next runs.
   * `revert` is supplied by the caller (addItem/removeItem) because only
   * they know how to undo their own specific mutation.
   */
  const syncToSharedPlan = useCallback(
    (op: 'add' | 'remove', eventId: string, revert: () => void) => {
      const code = readActivePlanCode()
      if (!code) return
      const call = op === 'add' ? addEventToPlan(code, eventId) : removeEventFromPlan(code, eventId)
      call.catch((err) => {
        // The plan being GONE — expired and reaped, or a stale code from an
        // earlier session — is NOT a transient failure, and reverting for it
        // bricks the whole feature on this device: the code never gets
        // cleared, so EVERY future add lights up, fails the mirror the same
        // way, and reverts again ("the button lights up, then goes away",
        // 2026-08-17, reproduced against a purged code). Drop the dead code
        // and KEEP the optimistic change instead — with no active plan, the
        // local draft is legitimately the source of truth again, which is
        // exactly the pre-share state this device started in.
        if (isPlanGoneError(err)) {
          clearActivePlanCodeStorage()
          setActivePlanCodeState(null)
          announce('That shared plan has expired — your changes are saved to a new draft here.')
          trackEvent(EVENTS.PLAN_SYNC_FAILED, { op, reason: 'plan_gone' })
          return
        }
        console.warn(`[day plan] ${op} did not reach the shared plan`, err)
        revert()
        announce("That didn't save. Try again.")
        trackEvent(EVENTS.PLAN_SYNC_FAILED, { op })
      })
    },
    [announce],
  )

  const addItem = useCallback(
    (event: SnapshotSource & { category?: string | null }, surface: PlanSurface) => {
      const next = addItemToDraft(draft, event)
      if (!next) {
        trackEvent(EVENTS.PLAN_CAP_REACHED, { plan_surface: surface })
        announce('Your day plan is full at 30 events.')
        return false
      }
      setDraft(next)
      writeDraft(next)
      syncToSharedPlan('add', event.id, () => {
        // The server never got this add -- undo the optimistic insert.
        setDraft((prev) => {
          const reverted = removeItemFromDraft(prev, event.id)
          writeDraft(reverted)
          return reverted
        })
      })
      trackEvent(EVENTS.PLAN_ITEM_ADDED, { plan_surface: surface, category: event.category ?? 'other' })
      announce(`Added to your day plan. ${next.items.length} events.`)
      return true
    },
    [draft, syncToSharedPlan, announce],
  )

  const removeItem = useCallback(
    (eventId: string, surface: PlanSurface, opts: RemoveItemOpts = {}) => {
      const { syncToServer = true } = opts
      const removedItem = draft.items.find((i) => i.event_id === eventId) ?? null
      const next = removeItemFromDraft(draft, eventId)
      setDraft(next)
      writeDraft(next)
      if (syncToServer) {
        syncToSharedPlan('remove', eventId, () => {
          // The server never got this remove -- restore the item if it's
          // still absent (a later, unrelated mutation may have already
          // re-added it, in which case leave that alone).
          if (!removedItem) return
          setDraft((prev) => {
            if (isItemInDraft(prev, eventId)) return prev
            const restored: DayPlanDraft = {
              ...prev,
              items: [...prev.items, removedItem],
              updated_at: new Date().toISOString(),
            }
            writeDraft(restored)
            return restored
          })
        })
      }
      trackEvent(EVENTS.PLAN_ITEM_REMOVED, { plan_surface: surface })
      announce(`Removed from your day plan. ${next.items.length} events.`)
    },
    [draft, syncToSharedPlan, announce],
  )

  const setTitle = useCallback(
    (title: string | null) => {
      const next = setDraftTitle(draft, title)
      setDraft(next)
      writeDraft(next)
    },
    [draft],
  )

  const setActivePlanCode = useCallback((code: string) => {
    writeActivePlanCode(code)
    setActivePlanCodeState(code)
  }, [])

  const clearActivePlanCode = useCallback(() => {
    clearActivePlanCodeStorage()
    setActivePlanCodeState(null)
  }, [])

  const startNewPlan = useCallback(() => {
    const fresh = emptyDraft()
    setDraft(fresh)
    writeDraft(fresh)
    clearActivePlanCodeStorage()
    setActivePlanCodeState(null)
  }, [])

  /**
   * Two-way heal against the server's truth for the active plan (P1-2).
   *
   * The header's "Plan · N" pill counts the LOCAL draft while /d/<code> reads
   * the SERVER, so the two drift apart the moment anything changes the plan
   * outside this device: a collaborator removing an event, or a failed
   * syncToSharedPlan('remove') that quietly never reached the server (the
   * item vanishes from the draft here on the NEXT reconcile, having been
   * "removed" twice: once locally, once by this healing pass mistaking a
   * network failure for a real removal -- P1-3's revert-on-failure is what
   * prevents that particular case, but reconcileDraft must still heal drift
   * from BEFORE that fix existed, or from any other source).
   *
   * Previously prune-only: items the server no longer had were dropped, but
   * an item the server still holds that the LOCAL draft is missing was never
   * restored, so the pill could under-count permanently. Restored items are
   * rebuilt from the server's own snapshot columns (snap_title/snap_start_at/
   * snap_venue) -- the only fields available -- so snap_venue_lat/lng come
   * back null and degrade to "unmapped", exactly as dayPlanDraft.ts's
   * SnapshotSource doc already describes for any item missing those fields.
   *
   * Called on every successful shared-plan load when the plan is this
   * device's own, so the pill self-corrects on visit rather than needing the
   * draft to be cleared by hand. Fires plan_draft_reconciled only when the
   * draft actually changes -- most loads are already in step and firing an
   * event on every visit would be noise, not signal.
   */
  const reconcileDraft = useCallback((serverItems: DayPlanItem[]) => {
    setDraft((prev) => {
      const serverIds = new Set(serverItems.map((i) => i.event_id))
      const prevIds = new Set(prev.items.map((i) => i.event_id))
      const kept = prev.items.filter((i) => serverIds.has(i.event_id))
      const missing = serverItems.filter((i) => !prevIds.has(i.event_id))

      if (kept.length === prev.items.length && missing.length === 0) return prev // already in step

      const restored: DraftItem[] = missing.map((i) => ({
        event_id: i.event_id,
        snap_title: i.snap_title,
        snap_start_at: i.snap_start_at,
        snap_end_at: i.snap_end_at,
        snap_venue: i.snap_venue,
        snap_venue_lat: null,
        snap_venue_lng: null,
        added_at: i.added_at,
      }))
      const items = [...kept, ...restored]
      const next: DayPlanDraft = { ...prev, items, updated_at: new Date().toISOString() }
      writeDraft(next)

      const removed = prev.items.length - kept.length
      trackEvent(EVENTS.PLAN_DRAFT_RECONCILED, { removed, item_count: items.length })
      return next
    })
  }, [])

  const value = useMemo<DayPlanContextValue>(
    () => ({
      draft,
      activePlanCode,
      isInPlan,
      isFull,
      addItem,
      removeItem,
      setTitle,
      setActivePlanCode,
      clearActivePlanCode,
      startNewPlan,
      reconcileDraft,
      announce,
    }),
    [draft, activePlanCode, isInPlan, isFull, addItem, removeItem, setTitle, setActivePlanCode, clearActivePlanCode, startNewPlan, reconcileDraft, announce],
  )

  return (
    <DayPlanContext.Provider value={value}>
      {children}
      {/* Shared live region (P1-9): add/remove counts, the cap message, and
          sync-failure announcements all funnel through `announce` above.
          role="status" + aria-live="polite" so it's picked up without
          stealing focus. Visually hidden -- the same information is always
          ALSO visible on-screen (a toggled button, a count, an error text). */}
      <div role="status" aria-live="polite" className="sr-only">{liveMessage}</div>
    </DayPlanContext.Provider>
  )
}

/** Context module exports its provider + hook together by design (mirrors useEmbed.tsx). */
// eslint-disable-next-line react-refresh/only-export-components
export function useDayPlan(): DayPlanContextValue {
  const ctx = useContext(DayPlanContext)
  if (!ctx) throw new Error('useDayPlan must be used within a DayPlanProvider')
  return ctx
}
