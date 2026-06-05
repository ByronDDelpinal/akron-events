import { useEffect, useMemo, useRef } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { EmbedProvider } from '@/hooks/useEmbed'
import { parseEmbedConfig } from '@/lib/embedConfig'
import './EmbedLayout.css'

// postMessage channel the host page's resizer script (akron-pulse-embed.js)
// listens on. Kept in one place so the script and the app agree on the name.
const HEIGHT_MESSAGE_TYPE = 'akron-pulse-embed:height'

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

  return (
    <EmbedProvider config={config}>
      <div className="embed-root" ref={rootRef}>
        <Outlet />
      </div>
    </EmbedProvider>
  )
}
