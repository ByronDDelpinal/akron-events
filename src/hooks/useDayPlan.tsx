import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import {
  readDraft,
  writeDraft,
  readActivePlanCode,
  writeActivePlanCode,
  addItemToDraft,
  removeItemFromDraft,
  isItemInDraft,
  setDraftTitle,
  type DayPlanDraft,
  type SnapshotSource,
} from '@/lib/dayPlanDraft'
import { trackEvent, EVENTS } from '@/lib/analytics'
import type { PlanSurface } from '@/lib/analyticsEvents'

/**
 * DayPlanContext — the LOCAL draft only (never touches the network; see
 * dayPlanDraft.ts's header). Mounted once at the top of App.tsx, above both
 * the /embed route group and the full-site SiteChrome group, so every
 * consumer (Header's "Plan · N" pill, EventCard/EventPage's add-to-plan
 * button, DayPlanPage) reads the same in-memory + localStorage-backed state
 * without a network round trip.
 *
 * AddToPlanButton itself decides not to render inside the embed
 * (useEmbed() !== null, decision 8) — this provider still wraps the embed
 * route tree so that check can run as an unconditional hook call rather than
 * a conditional one.
 */
interface DayPlanContextValue {
  draft: DayPlanDraft
  activePlanCode: string | null
  isInPlan: (eventId: string) => boolean
  /** Returns false (no-op) when the draft is already at the 30-item cap and this event isn't in it yet. */
  addItem: (event: SnapshotSource & { category?: string | null }, surface: PlanSurface) => boolean
  removeItem: (eventId: string, surface: PlanSurface) => void
  setTitle: (title: string | null) => void
  /** Drop draft items the server no longer has, so the header pill self-corrects. */
  reconcileDraft: (serverEventIds: string[]) => void
  setActivePlanCode: (code: string) => void
}

const DayPlanContext = createContext<DayPlanContextValue | null>(null)

export function DayPlanProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<DayPlanDraft>(() => readDraft())
  const [activePlanCode, setActivePlanCodeState] = useState<string | null>(() => readActivePlanCode())

  const isInPlan = useCallback((eventId: string) => isItemInDraft(draft, eventId), [draft])

  const addItem = useCallback(
    (event: SnapshotSource & { category?: string | null }, surface: PlanSurface) => {
      const next = addItemToDraft(draft, event)
      if (!next) return false
      setDraft(next)
      writeDraft(next)
      trackEvent(EVENTS.PLAN_ITEM_ADDED, { surface, category: event.category ?? 'other' })
      return true
    },
    [draft],
  )

  const removeItem = useCallback(
    (eventId: string, surface: PlanSurface) => {
      const next = removeItemFromDraft(draft, eventId)
      setDraft(next)
      writeDraft(next)
      trackEvent(EVENTS.PLAN_ITEM_REMOVED, { surface })
    },
    [draft],
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

  /**
   * Replace the draft's items with the server's truth for the active plan.
   *
   * The header's "Plan · N" pill counts the LOCAL draft while /d/<code> reads
   * the SERVER, so the two drift apart the moment anything changes the plan
   * outside this device: a collaborator removing an event, or (before the
   * draft-sync fix) your own removals on the shared page. The drift is
   * one-directional and sticky -- the pill sat at 4 against an empty plan --
   * and nothing healed it, because every other path only ever mutates one
   * item at a time.
   *
   * Called on every successful shared-plan load when the plan is this
   * device's own, so the pill self-corrects on visit rather than needing the
   * draft to be cleared by hand.
   */
  const reconcileDraft = useCallback((serverEventIds: string[]) => {
    setDraft((prev) => {
      const keep = new Set(serverEventIds)
      const items = prev.items.filter((i) => keep.has(i.event_id))
      if (items.length === prev.items.length) return prev // already in step
      const next = { ...prev, items }
      writeDraft(next)
      return next
    })
  }, [])

  const value = useMemo<DayPlanContextValue>(
    () => ({ draft, activePlanCode, isInPlan, addItem, removeItem, setTitle, setActivePlanCode, reconcileDraft }),
    [draft, activePlanCode, isInPlan, addItem, removeItem, setTitle, setActivePlanCode, reconcileDraft],
  )

  return <DayPlanContext.Provider value={value}>{children}</DayPlanContext.Provider>
}

/** Context module exports its provider + hook together by design (mirrors useEmbed.tsx). */
// eslint-disable-next-line react-refresh/only-export-components
export function useDayPlan(): DayPlanContextValue {
  const ctx = useContext(DayPlanContext)
  if (!ctx) throw new Error('useDayPlan must be used within a DayPlanProvider')
  return ctx
}
