import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useEmbed } from '@/hooks/useEmbed'
import { useDayPlan } from '@/hooks/useDayPlan'
import type { PlanSurface } from '@/lib/analyticsEvents'
import type { SnapshotSource } from '@/lib/dayPlanDraft'
import './AddToPlanButton.css'

// How long the "plan is full" message stays visible next to the button
// after a rejected click (P0-5). Long enough to read, short enough not to
// linger as stale chrome on a card the visitor has moved on from.
const CAP_MESSAGE_MS = 4000

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
  /** 'chip' — pill with a glyph + short label ("+ Plan" / "In plan"). Used by
   *  the comfortable card footer, the efficient card end, and the featured
   *  card (day-plan-audit.md, Ask 1 -- "icon" was renamed once nothing here
   *  is icon-only any more; below 420px `.card-efficient-end` alone falls
   *  back to an icon-only circle via CSS, the label just hides).
   *  'inline' — full-width button matching EventPage's `.btn-ticket-secondary`
   *  calendar CTAs. EventPage ONLY -- the planner has its own dedicated
   *  Remove button and never renders this component at all. */
  variant?: 'chip' | 'inline'
  className?: string
}

/**
 * The day-planner add/remove control (D8). Placements per the design:
 *   - Comfortable card footer: chip, next to "View Details →".
 *   - Featured card: chip, next to "View Details →" (was `inline` -- that
 *     variant's full-width/margin-top styling, added for EventPage, silently
 *     broke this row's vertical centering; see AddToPlanButton.css).
 *   - Efficient card: chip, first child of .card-efficient-end.
 *   - EventPage: inline, in the CTA stack next to Add to Calendar.
 *
 * `EventCard` is a stretched link (a title anchor whose ::after overlay is
 * the card's hit area) and this button sits above that overlay at z-index 4,
 * so clicks and keys land here natively — no ancestor handler to defeat.
 * The stopPropagation calls on onClick and onKeyDown stay anyway, purely
 * defensively: if a future ancestor ever grows a click/key handler, this
 * control must not start navigating users away mid-add again.
 *
 * Not rendered inside the embed (decision 8): the embed is white-label, and
 * a partner's iframe must not grow an Akron Pulse feature the partner never
 * asked for.
 *
 * The 30-item cap (P0-5) is never a disabled button -- a disabled control
 * with no explanation is the same silent no-op the feature used to ship
 * with. It stays clickable; a click that hits the cap shows a transient
 * message here AND announces through the shared live region
 * (useDayPlan's `announce`, P1-9).
 */
export default function AddToPlanButton({ event, surface, variant = 'chip', className = '' }: AddToPlanButtonProps) {
  const embed = useEmbed()
  const { isInPlan, addItem, removeItem, isFull } = useDayPlan()
  const inPlan = isInPlan(event.id)
  const [capHit, setCapHit] = useState(false)
  const capTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (capTimerRef.current) clearTimeout(capTimerRef.current)
  }, [])

  const toggle = useCallback(() => {
    if (inPlan) {
      removeItem(event.id, surface)
      return
    }
    const added = addItem(event, surface)
    if (!added) {
      setCapHit(true)
      if (capTimerRef.current) clearTimeout(capTimerRef.current)
      capTimerRef.current = setTimeout(() => setCapHit(false), CAP_MESSAGE_MS)
    }
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
      // Defensive only: the card stopped being a role="button" with its own
      // onKeyDown when it became a stretched link, but stopping propagation
      // keeps any future ancestor handler from ever hijacking these keys.
      e.stopPropagation()
      if (e.key === 'Enter' || e.key === ' ') {
        // preventDefault so Space doesn't ALSO fire the button's native
        // click on keyup (double-toggle) or scroll the page.
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
    : isFull
      ? 'Your day plan is full at 30 events'
      : `Add "${event.title}" to your day plan`

  return (
    <span className={`add-to-plan-btn-wrap add-to-plan-btn-wrap--${variant}`}>
      <button
        type="button"
        className={`add-to-plan-btn add-to-plan-btn--${variant}${inPlan ? ' in-plan' : ''} ${className}`.trim()}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        aria-pressed={inPlan}
        aria-label={label}
        title={variant === 'chip' ? label : undefined}
      >
        {inPlan ? <CheckIcon /> : <PlusIcon />}
        {variant === 'chip' && (
          <span className="add-to-plan-btn-label">{inPlan ? 'In plan' : 'Plan'}</span>
        )}
        {variant === 'inline' && <span>{inPlan ? 'In your day plan' : 'Add to day plan'}</span>}
      </button>
      {capHit && (
        <span className="add-to-plan-cap-msg" role="status" aria-live="polite">
          Your day plan is full. Remove an event to add another.
        </span>
      )}
    </span>
  )
}
