import { useEffect, useMemo, useRef } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { EmbedProvider } from '@/hooks/useEmbed'
import { parseEmbedConfig } from '@/lib/embedConfig'
import './EmbedLayout.css'

// postMessage channels shared with the host page's resizer script.
const HEIGHT_MESSAGE_TYPE   = 'akron-pulse-embed:height'   // iframe → parent
const VIEWPORT_MESSAGE_TYPE = 'akron-pulse-embed:viewport' // parent → iframe
const REQUEST_MESSAGE_TYPE  = 'akron-pulse-embed:request'  // iframe → parent

/**
 * EmbedLayout — the white-label shell. Renders no site chrome; it parses the
 * embed config from the URL and provides it via context, publishes its content
 * height to the host page over postMessage, and renders the matched embed page.
 */
export default function EmbedLayout() {
  const location = useLocation()
  const config = useMemo(() => parseEmbedConfig(location.search), [location.search])
  const rootRef = useRef<HTMLDivElement>(null)

  // ── Auto-height: tell the parent how tall we are ──────────────────────
  useEffect(() => {
    const postHeight = () => {
      const h = Math.ceil(document.documentElement.scrollHeight)
      try {
        window.parent?.postMessage({ type: HEIGHT_MESSAGE_TYPE, height: h }, '*')
      } catch { /* cross-origin parent without a listener — ignore */ }
    }

    postHeight()

    const ro = new ResizeObserver(postHeight)
    if (rootRef.current) ro.observe(rootRef.current)
    // Body too: late-loading images change height after the observer binds.
    ro.observe(document.body)

    window.addEventListener('load', postHeight)
    return () => {
      ro.disconnect()
      window.removeEventListener('load', postHeight)
    }
  }, [])

  // Re-post on navigation between the grid and a detail page.
  useEffect(() => {
    const h = Math.ceil(document.documentElement.scrollHeight)
    try {
      window.parent?.postMessage({ type: HEIGHT_MESSAGE_TYPE, height: h }, '*')
    } catch { /* ignore */ }
  }, [location.pathname])

  // ── Visible-viewport relay (fixes modals in a tall iframe) ────────────
  useEffect(() => {
    const root = document.documentElement
    root.classList.add('embed-mode')

    const onMessage = (e: MessageEvent) => {
      const d = e.data
      if (!d || d.type !== VIEWPORT_MESSAGE_TYPE) return
      if (typeof d.top === 'number') root.style.setProperty('--embed-vp-top', `${d.top}px`)
      if (typeof d.height === 'number' && d.height > 0) {
        root.style.setProperty('--embed-vp-height', `${d.height}px`)
      }
    }
    window.addEventListener('message', onMessage)

    // Ask the host for the current band now.
    try {
      window.parent?.postMessage({ type: REQUEST_MESSAGE_TYPE }, '*')
    } catch { /* no listener — fall back to CSS defaults */ }

    return () => {
      window.removeEventListener('message', onMessage)
      root.classList.remove('embed-mode')
      root.style.removeProperty('--embed-vp-top')
      root.style.removeProperty('--embed-vp-height')
    }
  }, [])

  return (
    <EmbedProvider config={config}>
      <div className="embed-root" ref={rootRef}>
        <Outlet />
      </div>
    </EmbedProvider>
  )
}
