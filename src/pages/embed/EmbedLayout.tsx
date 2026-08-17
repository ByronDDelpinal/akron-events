import { useEffect, useMemo, useRef } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { EmbedProvider } from '@/hooks/useEmbed'
import { parseEmbedConfig } from '@/lib/embedConfig'
import './EmbedLayout.css'

// postMessage channels shared with the host page's resizer script.
const HEIGHT_MESSAGE_TYPE   = 'akron-pulse-embed:height'    // iframe → parent
const VIEWPORT_MESSAGE_TYPE = 'akron-pulse-embed:viewport'  // parent → iframe
const REQUEST_MESSAGE_TYPE  = 'akron-pulse-embed:request'   // iframe → parent
const SCROLLTOP_MESSAGE_TYPE = 'akron-pulse-embed:scrolltop' // iframe → parent

/**
 * EmbedLayout — the white-label shell. Renders no site chrome; it parses the
 * embed config from the URL and provides it via context, publishes its content
 * height to the host page over postMessage, and renders the matched embed page.
 */
export default function EmbedLayout() {
  const location = useLocation()
  // The partner's config (theme, locked filters, features, defaults) is fixed at
  // embed time — it is whatever the iframe `src` carried. We capture the INITIAL
  // search once and parse the config from that, never from the live query string.
  // This matters for the locked-category set: once a visitor narrows within it,
  // their selection is written back to the `categories` param, and re-parsing the
  // live URL would silently shrink the partner's lock to the visitor's narrowing.
  const initialSearch = useRef(location.search).current
  const config = useMemo(() => parseEmbedConfig(initialSearch), [initialSearch])
  const rootRef = useRef<HTMLDivElement>(null)

  // ── Auto-height: tell the parent how tall we are ──────────────────────
  // Measure the CONTENT (the embed root's bottom edge), never
  // documentElement.scrollHeight: scrollHeight floors at the iframe's current
  // viewport height, and inside an auto-height iframe the viewport IS the last
  // height we asked for — so heights could only ever ratchet UP. Navigating
  // from a tall, paged-out list to a short event detail left the iframe at the
  // list's height with a huge dead zone below (Everyday Akron, 2026-08-17).
  const measureHeight = () => {
    const root = rootRef.current
    if (root) {
      // rect.bottom = content bottom relative to the (unscrollable) iframe
      // viewport top, so it includes any body margin/padding above the root.
      return Math.ceil(root.getBoundingClientRect().bottom)
    }
    return Math.ceil(document.documentElement.scrollHeight)
  }

  useEffect(() => {
    const postHeight = () => {
      try {
        window.parent?.postMessage({ type: HEIGHT_MESSAGE_TYPE, height: measureHeight() }, '*')
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

  // Re-post on navigation between the grid and a detail page, and ask the
  // host to bring the iframe's top back into view: the iframe has no
  // scrollport of its own, so window.scrollTo here is a no-op — only the
  // PARENT can scroll, and without this a reader who paged deep into the
  // list opened an event "below the fold" of the partner page and had to
  // scroll up to find it. Hosts running an older helper simply ignore the
  // unknown message type.
  useEffect(() => {
    try {
      window.parent?.postMessage({ type: HEIGHT_MESSAGE_TYPE, height: measureHeight() }, '*')
      window.parent?.postMessage({ type: SCROLLTOP_MESSAGE_TYPE }, '*')
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
