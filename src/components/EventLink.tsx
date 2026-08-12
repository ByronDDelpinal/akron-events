import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useEventHref } from '@/hooks/useEventHref'
import type { HrefEvent } from '@/lib/eventHref'

interface EventLinkProps {
  event: HrefEvent
  className?: string
  /** A card can render the same destination twice (stretched title link +
   *  "View Details" affordance). Marking the duplicate `decorative` removes
   *  it from the tab order and a11y tree so keyboard and screen-reader users
   *  get exactly one link per card instead of stuttering through repeats. */
  decorative?: boolean
  children: ReactNode
}

/**
 * EventLink — a real anchor to wherever clicking this event should go
 * (lib/eventHref decides). Internal destinations get a client-side router
 * <Link>; embed blank/external destinations get a plain <a> into a new tab
 * so the partner page underneath is never navigated away.
 */
export default function EventLink({ event, className, decorative = false, children }: EventLinkProps) {
  const getHref = useEventHref()
  const { kind, href } = getHref(event)
  const hidden = decorative ? { 'aria-hidden': true, tabIndex: -1 } : {}

  if (kind === 'internal') {
    return (
      <Link to={href} className={className} {...hidden}>
        {children}
      </Link>
    )
  }
  return (
    <a href={href} className={className} target="_blank" rel="noopener noreferrer" {...hidden}>
      {children}
    </a>
  )
}
