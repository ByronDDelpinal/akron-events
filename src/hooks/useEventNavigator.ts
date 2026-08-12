import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import type { HrefEvent } from '@/lib/eventHref'
import { useEventHref } from '@/hooks/useEventHref'

/**
 * useEventNavigator — imperative event click-through for surfaces that can't
 * render a real anchor (MapView's pin popups). The policy for what a click
 * MEANS lives in lib/eventHref's buildEventHref (single source of truth,
 * shared with EventLink's anchors); this hook only executes the result:
 * internal hrefs client-side navigate, external hrefs open a new tab.
 */
export function useEventNavigator(): (event: HrefEvent) => void {
  const navigate = useNavigate()
  const getHref = useEventHref()

  return useCallback(
    (event: HrefEvent) => {
      const { kind, href } = getHref(event)
      if (kind === 'internal') {
        navigate(href)
        return
      }
      window.open(href, '_blank', 'noopener,noreferrer')
    },
    [navigate, getHref],
  )
}
