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

  const value = useMemo<DayPlanContextValue>(
    () => ({ draft, activePlanCode, isInPlan, addItem, removeItem, setTitle, setActivePlanCode }),
    [draft, activePlanCode, isInPlan, addItem, removeItem, setTitle, setActivePlanCode],
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
