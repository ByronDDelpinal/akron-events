import { useCallback, type KeyboardEvent, type MouseEvent } from 'react'
import { useEmbed } from '@/hooks/useEmbed'
import { useDayPlan } from '@/hooks/useDayPlan'
import type { PlanSurface } from '@/lib/analyticsEvents'
import type { SnapshotSource } from '@/lib/dayPlanDraft'
import './AddToPlanButton.css'

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" focusable="false">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

interface AddToPlanEvent extends SnapshotSource {
  category?: string | null
}

interface AddToPlanButtonProps {
  event: AddToPlanEvent
  /** Which mount this is — rides on plan_item_added/removed for funnel readability (§6.8). */
  surface: PlanSurface
  /** 'icon' — round icon-only button (comfortable card footer, efficient card).
   *  'inline' — icon + label (featured card, EventPage CTA stack, planner). */
  variant?: 'icon' | 'inline'
  className?: string
}

/**
 * The day-planner add/remove control (D8). Placements per the design:
 *   - Comfortable card: icon-only, in .card-footer next to "View Details →".
 *   - Featured card: inline, next to "View Details →".
 *   - Efficient card: icon-only, first child of .card-efficient-end.
 *   - EventPage: inline, in the CTA stack next to Add to Calendar.
 *
 * `EventCard` renders the whole card as `role="button"` with onClick
 * (navigate) and onKeyDown (Enter navigates). This control MUST call
 * stopPropagation on BOTH onClick and onKeyDown — missing the keydown
 * handler means keyboard users get navigated away every time they try to
 * add an event, which is exactly the kind of bug that only shows up in an
 * accessibility pass.
 *
 * Not rendered inside the embed (decision 8): the embed is white-label, and
 * a partner's iframe must not grow an Akron Pulse feature the partner never
 * asked for.
 */
export default function AddToPlanButton({ event, surface, variant = 'icon', className = '' }: AddToPlanButtonProps) {
  const embed = useEmbed()
  const { isInPlan, addItem, removeItem } = useDayPlan()
  const inPlan = isInPlan(event.id)

  const toggle = useCallback(() => {
    if (inPlan) removeItem(event.id, surface)
    else addItem(event, surface)
  }, [inPlan, event, surface, addItem, removeItem])

  const handleClick = useCallback(
    (e: MouseEvent) => {
      e.stopPropagation()
      toggle()
    },
    [toggle],
  )

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Always stop propagation, even on keys that don't trigger a toggle —
      // the card's own onKeyDown listens for Enter and would otherwise
      // navigate away as this bubbles up.
      e.stopPropagation()
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        toggle()
      }
    },
    [toggle],
  )

  // Hooks above run unconditionally (rules of hooks); bail on render only.
  if (embed) return null

  const label = inPlan
    ? `Remove "${event.title}" from your day plan`
    : `Add "${event.title}" to your day plan`

  return (
    <button
      type="button"
      className={`add-to-plan-btn add-to-plan-btn--${variant}${inPlan ? ' in-plan' : ''} ${className}`.trim()}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-pressed={inPlan}
      aria-label={label}
      title={variant === 'icon' ? label : undefined}
    >
      {inPlan ? <CheckIcon /> : <PlusIcon />}
      {variant === 'inline' && <span>{inPlan ? 'In your day plan' : 'Add to day plan'}</span>}
    </button>
  )
}
