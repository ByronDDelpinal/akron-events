import { useCallback } from 'react'
import { useLocation } from 'react-router-dom'
import { useEmbed } from '@/hooks/useEmbed'
import { buildEventHref, type EventHref, type HrefEvent } from '@/lib/eventHref'

/**
 * useEventHref — binds lib/eventHref's pure buildEventHref (the SSOT for
 * "what an event click means") to the live router search, embed config, and
 * window origin. Returned resolver feeds EventLink's real anchors and
 * useEventNavigator's imperative fallback, so both agree by construction.
 */
export function useEventHref(): (event: HrefEvent) => EventHref {
  const location = useLocation()
  const embed = useEmbed()

  return useCallback(
    (event: HrefEvent) =>
      buildEventHref(event, embed, {
        search: location.search,
        origin: window.location.origin,
      }),
    [location.search, embed],
  )
}
