import { useEffect, useMemo, useRef } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { EmbedProvider } from '@/hooks/useEmbed'
import { parseEmbedConfig } from '@/lib/embedConfig'
import './EmbedLayout.css'

// postMessage channels shared with the host page's resizer script
// (akron-pulse-embed.js). Kept in one place so the script and the app agree.
const HEIGHT_MESSAGE_TYPE   = 'akron-pulse-embed:height'   // iframe → parent
const VIEWPORT_MESSAGE_TYPE = 'akron-pulse-embed:viewport' // parent → iframe
const REQUEST_MESSAGE_TYPE  = 'akron-pulse-embed:request'  // iframe → parent

/**
 * EmbedLayout — the white-label shell.
 *
 * Renders NONE of the site chrome (no Header, Footer, hero, search,
 * neighborhood picker, popular searches, promos). It:
 *   1. parses the embed config from the URL and provides it via context,
 *   2. publishes its content height to the host page over postMessage so the
 *      optional resizer script can grow the iframe to fit (no inner scroll),
 *   3. renders the matched embed page through <Outlet />.
 *
 * The theme is applied by ThemeProvider (which reads ?theme= on /embed/*),
 * so there's nothing theme-related to do here.
 */
export default function EmbedLayout() {
  const location = useLocation()
  const config = useMemo(() => parseEmbedConfig(location.search), [location.search])
  const rootRef = useRef(null)

  // ── Auto-height: tell the parent how tall we are ──────────────────────
  // The iframe has a fixed height until the host script resizes it, so we
  // broadcast our scrollHeight on mount, whenever content resizes
  // (ResizeObserver), and on every route change. The host script keys on
  // the message type; we post to '*' because we can't know the parent
  // origin and the payload is non-sensitive (a number).
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
  // The host script tells us which slice of the iframe is on-screen; we
  // publish it as CSS vars so fixed overlays (the filter tray, dialogs) can
  // sit in the band the visitor is actually looking at instead of pinning to
  // the iframe's full height. The `embed-mode` class scopes those overrides
  // and also reaches modals that portal to <body> (outside .embed-root).
  useEffect(() => {
    const root = document.documentElement
    root.classList.add('embed-mode')

    const onMessage = (e) => {
      const d = e.data
      if (!d || d.type !== VIEWPORT_MESSAGE_TYPE) return
      if (typeof d.top === 'number') root.style.setProperty('--embed-vp-top', `${d.top}px`)
      if (typeof d.height === 'number' && d.height > 0) {
        root.style.setProperty('--embed-vp-height', `${d.height}px`)
      }
    }
    window.addEventListener('message', onMessage)

    // Ask the host for the current band now (covers opening a modal before
    // any scroll has happened).
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
