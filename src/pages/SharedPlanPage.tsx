import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { SEO } from '@/lib/seo'
import { useDayPlan } from '@/hooks/useDayPlan'
import { getDayPlan, removeEventFromPlan, type DayPlan, type DayPlanItem } from '@/lib/dayPlanApi'
import DayPlanTimeline, { type PlanRenderItem } from '@/components/DayPlanTimeline'
import { buildVCalendar, downloadIcs, planIcsFilename, REMOVED_ITEMS_NOTE } from '@/lib/ics.js'
import { eventPath } from '@/lib/slug'
import { trackEvent, EVENTS } from '@/lib/analytics'
import './SharedPlanPage.css'

const SITE_ORIGIN = 'https://akronpulse.com'
// At most one refresh-on-focus call per 10 seconds (§6.2 of the design).
const REFRESH_THROTTLE_MS = 10_000

/** Build the shared ics.js input for one resolved plan item. Returns null
 * for rot_status='gone' (no reliable end time/location to export) --
 * buildVCalendar also filters these, but skipping the canonicalUrl
 * construction here avoids building a URL for an event that doesn't exist. */
function toIcsExportEvent(item: DayPlanItem) {
  if (item.rot_status === 'gone') {
    return { id: item.event_id, title: item.snap_title, description: null, start_at: item.snap_start_at, end_at: item.snap_end_at, updated_at: null, venue: null, ticket_url: null, source_url: null, category_slugs: null, canonicalUrl: '', rot_status: item.rot_status }
  }
  const id = item.resolved_event_id ?? item.event_id
  return {
    id,
    title: item.title ?? item.snap_title,
    description: item.description,
    start_at: item.start_at ?? item.snap_start_at,
    end_at: item.end_at ?? item.snap_end_at,
    updated_at: null,
    venue: item.venue,
    ticket_url: item.ticket_url,
    source_url: item.source_url,
    category_slugs: item.category_slugs,
    canonicalUrl: `${SITE_ORIGIN}/events/${id}`,
    rot_status: item.rot_status,
  }
}

/**
 * /d/:code — the shared, DB-backed plan. Anyone with the link can view and
 * edit it (the code IS the authorization; see migration 052's header). This
 * page is noindex (vercel.json's X-Robots-Tag header + <SEO noindex/> here,
 * belt and braces) and excluded from prerender/sitemap — the code is a
 * bearer credential, not content to index.
 */
export default function SharedPlanPage() {
  const { code = '' } = useParams()
  const { activePlanCode } = useDayPlan()
  const [plan, setPlan] = useState<DayPlan | null>(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const lastRefreshRef = useRef(0)
  const openedTrackedRef = useRef(false)

  const load = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoading(true)
    try {
      const result = await getDayPlan(code)
      if (result) {
        setPlan(result)
        setNotFound(false)
        if (!openedTrackedRef.current) {
          openedTrackedRef.current = true
          trackEvent(EVENTS.PLAN_OPENED, {
            role: activePlanCode === code ? 'owner' : 'visitor',
            item_count: result.item_count,
          })
        }
      } else {
        setNotFound(true)
      }
    } catch {
      setNotFound(true)
    } finally {
      setLoading(false)
      lastRefreshRef.current = Date.now()
    }
  }, [code, activePlanCode])

  useEffect(() => { load() }, [load])

  // Refresh-on-focus: re-call get_day_plan on visibilitychange (to visible)
  // and window focus, throttled to at most once per 10 seconds (§6.2). Every
  // mutation RPC also returns the full plan state, so a mutation IS a
  // refresh and this effect never needs to fire twice in a row for one.
  useEffect(() => {
    const maybeRefresh = () => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastRefreshRef.current < REFRESH_THROTTLE_MS) return
      load({ silent: true })
    }
    document.addEventListener('visibilitychange', maybeRefresh)
    window.addEventListener('focus', maybeRefresh)
    return () => {
      document.removeEventListener('visibilitychange', maybeRefresh)
      window.removeEventListener('focus', maybeRefresh)
    }
  }, [load])

  const handleRemove = useCallback(async (eventId: string) => {
    // Optimistic: drop it locally first, then reconcile with the server's
    // returned state. On error, the reload below restores the true state.
    setPlan((prev) => prev ? { ...prev, items: prev.items.filter((i) => i.event_id !== eventId) } : prev)
    try {
      const result = await removeEventFromPlan(code, eventId)
      if (result) setPlan(result)
      trackEvent(EVENTS.PLAN_ITEM_REMOVED, { surface: 'planner' })
    } catch {
      load({ silent: true })
    }
  }, [code, load])

  const handleExportIcs = useCallback(() => {
    if (!plan) return
    const events = plan.items
      .filter((i) => i.rot_status !== 'merged_duplicate')
      .map(toIcsExportEvent)
    const content = buildVCalendar(events, { name: plan.title ?? undefined })
    downloadIcs(planIcsFilename(plan.title ?? ''), content)
    trackEvent(EVENTS.PLAN_EXPORTED, { format: 'ics', item_count: plan.item_count })
  }, [plan])

  const handlePrint = useCallback(() => {
    if (!plan) return
    trackEvent(EVENTS.PLAN_EXPORTED, { format: 'print', item_count: plan.item_count })
    window.print()
  }, [plan])

  // "Copy link" deliberately does NOT use EVENTS.SHARE / ShareButtons — that
  // event's contract carries item_id (the URL), which here would be the
  // bearer code. plan_shared (fired once, at creation, in DayPlanPage) is
  // the only analytics signal for this feature's sharing behavior; a plain
  // copy-to-clipboard here fires nothing.
  const [copied, setCopied] = useState(false)
  const handleCopyLink = useCallback(async () => {
    const url = `${SITE_ORIGIN}/d/${code}`
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = url
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* ignore */ }
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1800)
  }, [code])

  if (loading) return <div className="day-plan-page"><p>Loading your plan…</p></div>

  if (notFound) {
    return (
      <div className="day-plan-page">
        <SEO title="Plan not found" path={`/d/${code}`} noindex />
        <h1 className="day-plan-heading">We couldn&apos;t find that plan</h1>
        <p className="day-plan-subhead">
          The link may be mistyped, or the plan may have expired. Plans are kept for about a week after
          their last event.
        </p>
      </div>
    )
  }

  if (!plan) return null

  const items: PlanRenderItem[] = plan.items
    .filter((i) => i.rot_status !== 'merged_duplicate')
    .map((i) => ({
      key: i.event_id,
      title: i.title ?? i.snap_title,
      startAt: i.start_at ?? i.snap_start_at,
      oldStartAt: i.rot_status === 'moved' ? i.snap_start_at : null,
      endAt: i.end_at ?? i.snap_end_at,
      venueName: i.venue?.name ?? i.snap_venue,
      venueGeo: i.venue ? { lat: i.venue.lat, lng: i.venue.lng } : null,
      eventPath: i.rot_status === 'gone' ? null : eventPath({ id: i.resolved_event_id ?? i.event_id, title: i.title ?? i.snap_title, start_at: i.start_at ?? i.snap_start_at }),
      rotStatus: i.rot_status,
      onRemove: () => handleRemove(i.event_id),
    }))

  return (
    <div className="day-plan-page">
      <SEO title={plan.title ?? 'A shared day plan'} path={`/d/${code}`} noindex />
      <h1 className="day-plan-heading">{plan.title || 'A shared day plan'}</h1>
      <p className="day-plan-subhead">
        Anyone with this link can view and add to this plan. {REMOVED_ITEMS_NOTE}
      </p>

      <DayPlanTimeline items={items} />

      {plan.items.length > 0 && (
        <div className="day-plan-actions">
          <button type="button" className="btn-nav-cta" onClick={handleCopyLink}>
            {copied ? 'Link copied!' : 'Copy link'}
          </button>
          <button type="button" className="btn-nav-cta btn-nav-cta-outline" onClick={handleExportIcs}>
            Export .ics
          </button>
          <button type="button" className="btn-nav-cta btn-nav-cta-outline" onClick={handlePrint}>
            Print
          </button>
        </div>
      )}
      <p className="day-plan-print-note">
        Your browser may print this page&apos;s URL in the footer — it contains this plan&apos;s link.
      </p>
    </div>
  )
}
