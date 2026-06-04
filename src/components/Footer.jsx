import { useState, useEffect, useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useTheme } from '@/hooks/useTheme'
import { THEMES, DEFAULT_THEME, THEME_STORAGE_KEY, LEGACY_THEME_STORAGE_KEY, getThemeLogo } from '@/lib/themes'
import { ENABLED_CATEGORY_HUBS, ENABLED_NEIGHBORHOOD_HUBS } from '@/lib/seo'
import './Footer.css'

// All localStorage keys that count as "preferences"
const PREF_KEYS = [
  THEME_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEY,
  'akronpulse_card_view_mode',
  'turnout_card_view_mode',   // legacy pre-rebrand key
]

// px of net downward scroll to fully hide the slim bar
const FADE_DISTANCE = 200

export default function Footer() {
  const { pathname } = useLocation()
  const [theme, setTheme] = useTheme()
  const isAdmin = pathname.startsWith('/admin')

  const [slimOpacity,   setSlimOpacity]   = useState(1)
  const [footerVisible, setFooterVisible] = useState(false)
  const footerRef = useRef(null)

  // IntersectionObserver: hide slim bar when the real footer is in view.
  useEffect(() => {
    if (isAdmin) return
    const el = footerRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => setFooterVisible(entry.isIntersecting),
      { threshold: 0.1 }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [isAdmin])

  // Scroll handler: track net downward travel, map to opacity.
  useEffect(() => {
    if (isAdmin) return
    let lastY   = window.scrollY
    let netDown = 0

    const handle = () => {
      const y   = window.scrollY
      const dy  = y - lastY
      lastY     = y
      netDown   = Math.max(0, Math.min(FADE_DISTANCE, netDown + dy))
      setSlimOpacity(1 - netDown / FADE_DISTANCE)
    }

    window.addEventListener('scroll', handle, { passive: true })
    return () => window.removeEventListener('scroll', handle)
  }, [isAdmin])

  // Clear any stale body padding from previous sessions / HMR.
  useEffect(() => {
    document.body.style.paddingBottom = ''
    return () => { document.body.style.paddingBottom = '' }
  }, [])

  if (isAdmin) return null

  function handleReset() {
    try { PREF_KEYS.forEach(k => localStorage.removeItem(k)) } catch {}
    setTheme(DEFAULT_THEME)
    window.location.reload()
  }

  const effectiveOpacity = footerVisible ? 0 : slimOpacity
  const hidden = effectiveOpacity < 0.05

  return (
    <>
      {/* ── Full footer — always in document flow ── */}
      <footer ref={footerRef}>
        <div className="footer-expandable-inner">
          <p className="footer-tagline">Everything happening in Akron &amp; Summit County, all in one place.</p>

          <nav className="footer-hub-nav" aria-label="Browse events by category and neighborhood">
            {ENABLED_CATEGORY_HUBS.length > 0 && (
              <div className="footer-hub-col">
                <p className="footer-hub-label">Browse by category</p>
                <ul>
                  {ENABLED_CATEGORY_HUBS.map((h) => (
                    <li key={h.slug}>
                      <Link to={`/events/${h.slug}`}>{h.title}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {ENABLED_NEIGHBORHOOD_HUBS.length > 0 && (
              <div className="footer-hub-col">
                <p className="footer-hub-label">Browse by neighborhood</p>
                <ul>
                  {ENABLED_NEIGHBORHOOD_HUBS.map((h) => (
                    <li key={h.slug}>
                      <Link to={`/events/${h.slug}`}>{h.title}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </nav>

          <div className="footer-theme">
            <label htmlFor="footer-theme-select" className="footer-theme-prompt">
              Everyone&apos;s Pulse is different, find yours:
            </label>
            <select
              id="footer-theme-select"
              className="footer-theme-select"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
            >
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button
              className="footer-reset-btn"
              onClick={handleReset}
              title="Reset theme and card view to defaults"
            >
              Reset to defaults
            </button>
          </div>
        </div>

        <div className="footer-slim">
          <div className="footer-logo">
            <img src={getThemeLogo(theme)} alt="" aria-hidden="true" className="footer-logo-img" />
          </div>
          <div className="footer-links">
            <Link to="/about">About</Link>
            <Link to="/">Browse Events</Link>
            <Link to="/subscribe">Get the Newsletter</Link>
            <Link to="/submit">Submit an Event</Link>
          </div>
          <p className="footer-copy">
            © {new Date().getFullYear()} Akron Pulse
            <span className="footer-copy-sep" aria-hidden="true"> · </span>
            <Link to="/admin" className="footer-admin-link">Admin</Link>
          </p>
        </div>
      </footer>

      {/* ── Fixed slim bar — scroll-driven opacity ──
       * Visible on page load; fades out as user scrolls down into the grid.
       * Hides completely when the real footer enters the viewport.
       *
       * Desktop (single row): logo · vibes · Events · Venues · Organizations · The Pulse · © 2026
       * Mobile (two rows):    row 1 = logo + vibes  /  row 2 = links + copyright
       * Very small mobile:    "Events" hidden (homepage is the primary nav target) */}
      <div
        className={`footer-slim-bar${hidden ? ' footer-slim-bar--hidden' : ''}`}
        style={{ '--slim-opacity': effectiveOpacity }}
        aria-hidden={hidden}
      >
        <div className="footer-slim-bar-inner">

          {/* Row 1 on mobile: logo + vibe switcher */}
          <div className="footer-slim-bar-identity">
            <Link to="/" className="footer-slim-bar-logo" aria-label="Akron Pulse — home" tabIndex={hidden ? -1 : 0}>
              <img src={getThemeLogo(theme)} alt="" className="footer-logo-img" />
            </Link>

            <div className="footer-slim-vibes">
              <label htmlFor="footer-slim-theme-select" className="footer-slim-vibes-label">
                Vibes:
              </label>
              <select
                id="footer-slim-theme-select"
                className="footer-theme-select footer-theme-select--mini"
                value={theme}
                onChange={(e) => setTheme(e.target.value)}
                aria-label="Theme"
                tabIndex={hidden ? -1 : 0}
              >
                {THEMES.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Row 2 on mobile: nav links + copyright */}
          <div className="footer-slim-bar-nav">
            <nav className="footer-slim-bar-links" aria-label="Quick navigation">
              {/* Hidden on very small screens — homepage already primary destination */}
              <Link to="/" className="footer-slim-bar-link footer-slim-bar-link--events" tabIndex={hidden ? -1 : 0}>Events</Link>
              <Link to="/venues" className="footer-slim-bar-link" tabIndex={hidden ? -1 : 0}>Venues</Link>
              <Link to="/organizations" className="footer-slim-bar-link" tabIndex={hidden ? -1 : 0}>Organizations</Link>
              <Link to="/subscribe" className="footer-slim-bar-link footer-slim-bar-link--pulse" tabIndex={hidden ? -1 : 0}>The Pulse</Link>
            </nav>

            <p className="footer-copy footer-slim-bar-copy">
              © {new Date().getFullYear()} Akron Pulse
            </p>
          </div>

        </div>
      </div>
    </>
  )
}
