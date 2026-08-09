import { Fragment, useMemo } from 'react'
import { Link } from 'react-router-dom'
import DateHeading from '@/components/DateHeading'
import { easternDateKey } from '@/lib/dayPlanDate'
import { findOverlaps, gapMinutes, distanceMiles } from '@/lib/dayPlanGap'
import { formatEventDate } from '@/lib/eventFormatting'
import type { RotStatus } from '@/lib/dayPlanApi'
import './DayPlanTimeline.css'

export interface PlanRenderItem {
  key: string
  title: string
  startAt: string
  /** Present and different from startAt only for rot_status='moved'. */
  oldStartAt?: string | null
  endAt: string | null
  venueName: string | null
  venueGeo?: { lat: number | null; lng: number | null } | null
  /** null when there's nothing left to link to (rot_status='gone'). */
  eventPath: string | null
  /** undefined = plain 'ok' (the local pre-share draft has no rot concept at all). */
  rotStatus?: RotStatus
  onRemove: () => void
}

const ROT_COPY: Partial<Record<RotStatus, string>> = {
  cancelled: 'Cancelled by the organizer',
  gone: 'This event is no longer on Akron Pulse',
  merged: 'This listing was merged with a duplicate',
}

function isStruck(status: RotStatus | undefined): boolean {
  return status === 'cancelled' || status === 'gone'
}

/**
 * The day planner's rendered list: grouped by EASTERN calendar date (§6.3 —
 * a deliberate, narrow exception to the site's viewer-local grouping rule;
 * see dayPlanDate.ts), ordered by resolved start time within each day, with
 * a neutral gap/distance line and a soft overlap note between consecutive
 * items. `merged_duplicate` items are never rendered here — filter them out
 * before passing `items` in (get_day_plan never drops them from the API
 * response, so the caller is where that happens, matching "never filtered
 * out at the data layer, the frontend decides what to render").
 */
export default function DayPlanTimeline({ items }: { items: PlanRenderItem[] }) {
  const groups = useMemo(() => {
    const byDay = new Map<string, PlanRenderItem[]>()
    for (const item of items) {
      const key = easternDateKey(item.startAt)
      if (!byDay.has(key)) byDay.set(key, [])
      byDay.get(key)!.push(item)
    }
    for (const list of byDay.values()) {
      list.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))
    }
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [items])

  const spansManyDays = groups.length > 3

  if (items.length === 0) {
    return <p className="day-plan-empty">Nothing in this plan yet.</p>
  }

  return (
    <div className="day-plan-timeline">
      {spansManyDays && (
        <p className="day-plan-span-note">
          This plan spans {groups.length} days. It is a day planner, nothing more —
          the timeline below still groups everything by day.
        </p>
      )}
      {groups.map(([dateKey, dayItems]) => {
        const overlaps = findOverlaps(
          dayItems.map((i) => ({ event_id: i.key, start_at: i.startAt, end_at: i.endAt })),
        )
        const overlapPairs = new Set(overlaps.map((o) => `${o.aId}|${o.bId}`))
        return (
          <div key={dateKey} className="day-plan-day-group">
            <DateHeading dateKey={dateKey} />
            {dayItems.map((item, i) => {
              const prev = i > 0 ? dayItems[i - 1] : null
              const gap = prev ? gapMinutes({ event_id: prev.key, start_at: prev.startAt, end_at: prev.endAt }, { event_id: item.key, start_at: item.startAt, end_at: item.endAt }) : null
              const miles = prev ? distanceMiles(prev.venueGeo, item.venueGeo) : null
              const overlapsPrev = prev ? overlapPairs.has(`${prev.key}|${item.key}`) : false
              return (
                <Fragment key={item.key}>
                  {prev && (gap != null || overlapsPrev) && (
                    <div className="day-plan-gap-line" aria-hidden="false">
                      {gap != null && <span>{gap >= 0 ? `${gap} min gap` : `overlaps by ${Math.abs(gap)} min`}</span>}
                      {miles != null && <span> · {miles.toFixed(1)} mi apart</span>}
                      {overlapsPrev && <span className="day-plan-overlap-note"> · These two overlap.</span>}
                    </div>
                  )}
                  <PlanItemRow item={item} />
                </Fragment>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

function PlanItemRow({ item }: { item: PlanRenderItem }) {
  const struck = isStruck(item.rotStatus)
  const note = item.rotStatus ? ROT_COPY[item.rotStatus] : null
  const title = item.eventPath && !struck
    ? <Link to={item.eventPath} className="day-plan-item-title">{item.title}</Link>
    : <span className="day-plan-item-title">{item.title}</span>

  return (
    <div className={`day-plan-item${struck ? ' day-plan-item--struck' : ''}`}>
      <div className="day-plan-item-time">{formatEventDate(item.startAt)}</div>
      <div className="day-plan-item-body">
        {title}
        {item.venueName && <div className="day-plan-item-venue">{item.venueName}</div>}
        {item.rotStatus === 'moved' && item.oldStartAt && (
          <div className="day-plan-item-moved">
            Moved — was <s>{formatEventDate(item.oldStartAt)}</s>, now {formatEventDate(item.startAt)}
          </div>
        )}
        {note && <div className={`day-plan-item-note day-plan-item-note--${item.rotStatus}`}>{note}</div>}
      </div>
      <button
        type="button"
        className="day-plan-item-remove"
        onClick={item.onRemove}
        aria-label={`Remove "${item.title}" from this plan`}
      >
        Remove
      </button>
    </div>
  )
}
