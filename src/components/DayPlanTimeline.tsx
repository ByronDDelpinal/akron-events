import { Fragment, useCallback, useMemo, type MouseEvent as ReactMouseEvent } from 'react'
import { Link } from 'react-router-dom'
import DateHeading from '@/components/DateHeading'
import { findOverlaps, gapMinutes, distanceMiles } from '@/lib/dayPlanGap'
import { formatEventDate } from '@/lib/eventFormatting'
import type { RotStatus } from '@/lib/dayPlanApi'
import { groupPlanItemsByDay, isMapped, isStruck, type PlanRenderItem } from '@/lib/planMapPoints'
import './DayPlanTimeline.css'

// Re-exported so the existing `import DayPlanTimeline, { type PlanRenderItem }
// from '@/components/DayPlanTimeline'` at DayPlanPage.tsx/SharedPlanPage.tsx
// keeps working -- the type itself now lives in planMapPoints.ts (see that
// file's header for why: it can't import a type FROM this component while
// this component imports functions FROM it).
export type { PlanRenderItem }

const ROT_COPY: Partial<Record<RotStatus, string>> = {
  cancelled: 'Cancelled by the organizer',
  gone: 'This event is no longer on Akron Pulse',
  merged: 'This listing was merged with a duplicate',
}

// Desktop-only mouse convenience (§3.3 of the design): clicking anywhere in
// a mapped row other than the title link / Remove button also selects it.
// Matches DESKTOP_BREAKPOINT in DayPlanBoard.css/DayPlanBoard.tsx.
const DESKTOP_QUERY = '(min-width: 900px)'

export interface DayPlanTimelineProps {
  items: PlanRenderItem[]
  /** From planMapPoints.ts's numberPlanItems(items), computed ONCE by
   *  DayPlanBoard and shared with PlanMap -- see that module's header for
   *  why this must never be recomputed independently here. */
  numbers: Map<string, number>
  selectedKey: string | null
  /** Called with the item's key when its "Show on map" button (or, on
   *  desktop, a click elsewhere in a mapped row) is pressed. Owned by
   *  DayPlanBoard, which also decides whether to scroll the map into view. */
  onSelectRow: (key: string) => void
  /** Callback ref so DayPlanBoard can scroll a row into view when the map
   *  selects it -- a Map<key, element>, not an array of refs, matching the
   *  infinite-scroll sentinel's callback-ref pattern elsewhere in the app. */
  registerRow: (key: string, el: HTMLElement | null) => void
  /** Rendered instead of the list when `items` is empty. Each page supplies
   *  its own copy (day-plan-audit.md P1-8) rather than layering a second,
   *  page-level empty-state message on top of this one. */
  emptyMessage?: string
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
 *
 * Grouping/ordering is imported from planMapPoints.ts rather than computed
 * here, and numbering arrives as a prop from the same module -- this list
 * and PlanMap.tsx (rendered alongside it by DayPlanBoard) must never
 * disagree about what "#3" refers to.
 */
export default function DayPlanTimeline({ items, numbers, selectedKey, onSelectRow, registerRow, emptyMessage = 'Nothing in this plan yet.' }: DayPlanTimelineProps) {
  const groups = useMemo(() => groupPlanItemsByDay(items), [items])

  const spansManyDays = groups.length > 3

  if (items.length === 0) {
    return <p className="day-plan-empty">{emptyMessage}</p>
  }

  return (
    <div className="day-plan-timeline">
      {spansManyDays && (
        <p className="day-plan-span-note">
          This plan covers {groups.length} days. It is grouped by day below.
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
                  <PlanItemRow
                    item={item}
                    number={numbers.get(item.key) ?? 0}
                    selected={selectedKey === item.key}
                    onSelectRow={onSelectRow}
                    registerRow={registerRow}
                  />
                </Fragment>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

interface PlanItemRowProps {
  item: PlanRenderItem
  number: number
  selected: boolean
  onSelectRow: (key: string) => void
  registerRow: (key: string, el: HTMLElement | null) => void
}

function PlanItemRow({ item, number, selected, onSelectRow, registerRow }: PlanItemRowProps) {
  const struck = isStruck(item.rotStatus)
  const mapped = isMapped(item)
  const note = item.rotStatus ? ROT_COPY[item.rotStatus] : null
  const title = item.eventPath && !struck
    ? <Link to={item.eventPath} className="day-plan-item-title">{item.title}</Link>
    : <span className="day-plan-item-title">{item.title}</span>

  const handleLocate = useCallback(() => onSelectRow(item.key), [onSelectRow, item.key])

  // Desktop-only convenience: a click anywhere in a mapped row that isn't
  // the title link or the Remove button also selects it. This is a mouse
  // affordance layered on top of the real "Show on map" button, never a
  // replacement -- the row itself carries no role/tabIndex/keyboard
  // handling, so a keyboard or screen-reader user only ever sees the
  // button. Off entirely on mobile, where the button is the ONLY
  // selection affordance (§6.3 of the design).
  const handleRowClick = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
    if (!mapped) return
    const target = e.target as HTMLElement
    if (target.closest('a, button')) return
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    if (!window.matchMedia(DESKTOP_QUERY).matches) return
    onSelectRow(item.key)
  }, [mapped, onSelectRow, item.key])

  return (
    <div
      ref={(el) => registerRow(item.key, el)}
      className={`day-plan-item${struck ? ' day-plan-item--struck' : ''}${selected ? ' day-plan-item--selected' : ''}`}
      onClick={handleRowClick}
    >
      <div className="day-plan-item-time">{formatEventDate(item.startAt)}</div>
      <div className="day-plan-item-body">
        <span className="day-plan-item-number" aria-hidden="true">{number}.</span> {title}
        {item.venueName && <div className="day-plan-item-venue">{item.venueName}</div>}
        {mapped ? (
          <button
            type="button"
            className="day-plan-item-locate"
            aria-pressed={selected}
            aria-label={`Show "${item.title}" on the map`}
            onClick={handleLocate}
          >
            Show on map
          </button>
        ) : (
          <div className="day-plan-item-note">
            {item.venueName ? 'Location not mapped' : 'No location listed'}
          </div>
        )}
        {item.rotStatus === 'moved' && item.oldStartAt && (
          <div className="day-plan-item-moved">
            Moved. Was <s>{formatEventDate(item.oldStartAt)}</s>, now {formatEventDate(item.startAt)}
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
