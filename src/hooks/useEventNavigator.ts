import { useCallback } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { eventPath } from '@/lib/slug'
import { embedEventPath } from '@/lib/embedConfig'
import { useEmbed } from '@/hooks/useEmbed'

/** The event shape `eventPath` accepts (id + title + start_at). */
type NavigableEvent = Parameters<typeof eventPath>[0]

/**
 * useEventNavigator — single source of truth for "what happens when a user
 * clicks an event card / map pin". Shared by EventCard and MapView so the
 * click behavior is identical everywhere.
 *
 *   - Normal site:          client-side navigate to /events/{slug}/{id}.
 *   - Embed, target=inline: client-side navigate within the iframe to
 *                           /embed/events/{slug}/{id}, carrying the embed
 *                           config query string forward.
 *   - Embed, target=blank:  open the full hosted (chrome + SEO) detail page
 *                           in a new tab, leaving the partner page intact.
 *   - Embed, target=external: skip the detail page entirely — open the
 *                           event's ticket_url or source_url directly in a
 *                           new tab. Falls back to blank if neither exists.
 *                           Useful for sidebar widgets where a detail page
 *                           visit inside the iframe would be disruptive.
 */
export function useEventNavigator(): (event: NavigableEvent) => void {
  const navigate = useNavigate()
  const location = useLocation()
  const embed = useEmbed()

  return useCallback(
    (event: NavigableEvent) => {
      const path = eventPath(event)
      if (!embed) {
        navigate(path)
        return
      }
      if (embed.target === 'external') {
        // Go straight to the event's own site; skip the Akron Pulse detail page.
        const externalUrl = (event as any).ticket_url || (event as any).source_url
        const url = externalUrl ?? `${window.location.origin}${path}`
        window.open(url, '_blank', 'noopener,noreferrer')
        return
      }
      if (embed.target === 'blank') {
        // Full hosted detail page (real URL, indexable, full chrome).
        const url = `${window.location.origin}${path}`
        window.open(url, '_blank', 'noopener,noreferrer')
        return
      }
      // Inline: stay in the iframe, keep the embed config in the URL.
      navigate(embedEventPath(path, location.search))
    },
    [navigate, location.search, embed],
  )
}
