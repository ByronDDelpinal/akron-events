import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SEO } from '@/lib/seo'
import { useDayPlan } from '@/hooks/useDayPlan'
import { readActivePlanCode } from '@/lib/dayPlanDraft'
import { getDayPlan, createDayPlan } from '@/lib/dayPlanApi'
import DayPlanBoard from '@/components/DayPlanBoard'
import { type PlanRenderItem } from '@/components/DayPlanTimeline'
import { buildVCalendar, downloadIcs, planIcsFilename } from '@/lib/ics.js'
import { eventPath } from '@/lib/slug'
import { trackEvent, EVENTS } from '@/lib/analytics'
import './DayPlan.shared.css'
import './DayPlanPage.css'

const SITE_ORIGIN = 'https://akronpulse.com'

/**
 * /day — the local, network-free draft. A visitor can build and print a
 * plan without a row ever being written (§6.1 of the design). "Share"
 * (below) is the ONE action that creates a database row.
 *
 * Redirects to /d/<code> when this device already holds an active plan code
 * AND that plan still resolves (§6.5) -- a device that already shared stays
 * in "server mode" for that code. The draft key itself is never cleared on
 * share (kept 7 days as insurance -- dayPlanDraft.ts), so a failed redirect
 * (plan purged, code typo'd into storage) still leaves the local draft
 * intact and this page usable.
 */
export default function DayPlanPage() {
  const navigate = useNavigate()
  const { draft, removeItem, setActivePlanCode } = useDayPlan()
  const [redirectChecked, setRedirectChecked] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [shareError, setShareError] = useState<string | null>(null)
  const planIdRef = useRef<string>(crypto.randomUUID())

  useEffect(() => {
    let cancelled = false
    const code = readActivePlanCode()
    if (!code) {
      setRedirectChecked(true)
      return
    }
    getDayPlan(code)
      .then((plan) => {
        if (cancelled) return
        if (plan) navigate(`/d/${code}`, { replace: true })
        else setRedirectChecked(true)
      })
      .catch(() => { if (!cancelled) setRedirectChecked(true) })
    return () => { cancelled = true }
  }, [navigate])

  const items: PlanRenderItem[] = draft.items.map((i) => ({
    key: i.event_id,
    title: i.snap_title,
    startAt: i.snap_start_at,
    endAt: i.snap_end_at,
    venueName: i.snap_venue,
    // Add-time coordinates (dayPlanDraft.ts §1.1). Drafts written before
    // this shipped have neither field -- `?? null` degrades them to
    // "unmapped" (planMapPoints.ts's isMapped) exactly like a real event
    // with no venue coordinates, never a crash. Re-adding the event
    // refreshes the snapshot in place (addItemToDraft) and self-heals it.
    venueGeo: { lat: i.snap_venue_lat ?? null, lng: i.snap_venue_lng ?? null },
    eventPath: eventPath({ id: i.event_id, title: i.snap_title, start_at: i.snap_start_at }),
    onRemove: () => removeItem(i.event_id, 'planner'),
  }))

  const handleShare = useCallback(async () => {
    if (draft.items.length === 0) return
    setSharing(true)
    setShareError(null)
    try {
      const code = await createDayPlan(
        planIdRef.current,
        draft.title,
        draft.items.map((i) => i.event_id),
      )
      trackEvent(EVENTS.PLAN_SHARED, { item_count: draft.items.length })
      setActivePlanCode(code)
      navigate(`/d/${code}`)
    } catch {
      setShareError("Something didn't work. Your plan is still saved on this device — try again in a moment.")
      setSharing(false)
    }
  }, [draft, navigate, setActivePlanCode])

  const handleExportIcs = useCallback(() => {
    const events = draft.items.map((i) => ({
      id: i.event_id,
      title: i.snap_title,
      description: null,
      start_at: i.snap_start_at,
      end_at: i.snap_end_at,
      updated_at: null,
      venue: i.snap_venue ? { name: i.snap_venue } : null,
      ticket_url: null,
      source_url: null,
      category_slugs: null,
      canonicalUrl: `${SITE_ORIGIN}/events/${i.event_id}`,
    }))
    const content = buildVCalendar(events, { name: draft.title ?? undefined })
    downloadIcs(planIcsFilename(draft.title ?? ''), content)
    trackEvent(EVENTS.PLAN_EXPORTED, { format: 'ics', item_count: draft.items.length })
  }, [draft])

  const handlePrint = useCallback(() => {
    trackEvent(EVENTS.PLAN_EXPORTED, { format: 'print', item_count: draft.items.length })
    window.print()
  }, [draft.items.length])

  if (!redirectChecked) return null

  return (
    <div className="day-plan-page">
      <SEO title="Your day plan" path="/day" noindex />
      <h1 className="day-plan-heading">{draft.title || 'Your day plan'}</h1>
      <p className="day-plan-subhead">
        Built on this device. Nothing is saved online until you share it.
      </p>

      <DayPlanBoard items={items} />

      {draft.items.length > 0 && (
        <div className="day-plan-actions">
          <button type="button" className="btn-nav-cta" onClick={handleShare} disabled={sharing}>
            {sharing ? 'Sharing…' : 'Share this plan'}
          </button>
          <button type="button" className="btn-nav-cta btn-nav-cta-outline" onClick={handleExportIcs}>
            Export .ics
          </button>
          <button type="button" className="btn-nav-cta btn-nav-cta-outline" onClick={handlePrint}>
            Print
          </button>
        </div>
      )}
      {shareError && <p className="day-plan-error" role="alert">{shareError}</p>}
      {draft.items.length === 0 && (
        <p className="day-plan-subhead">
          Add events to your plan from any event card — look for the plus button.
        </p>
      )}
    </div>
  )
}
