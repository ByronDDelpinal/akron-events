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

  // ── Scroll-driven slim bar opacity ────────────────────────────────
  // `netDown` accumulates net downward scroll (px). Scrolling down
  // increases it toward FADE_DISTANCE (opacity → 0); scrolling up
  // decreases it back toward 0 (opacity → 1).
  const [slimOpacity,    setSlimOpacity]    = useState(1)
  const [footerVisible,  setFooterVisible]  = useState(false)
  const footerRef = useRef(null)

  // IntersectionObserver: when the full footer enters the viewport the
  // slim bar should hide — the user has reached the real footer.
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
    let lastY  = window.scrollY
    let netDown = 0

    const handle = () => {
      const y  = window.scrollY
      const dy = y - lastY
      lastY    = y
      netDown  = Math.max(0, Math.min(FADE_DISTANCE, netDown + dy))
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

  // The slim bar hides when the full footer is scrolled into view.
  const effectiveOpacity = footerVisible ? 0 : slimOpacity

  return (
    <>
      {/* ── Full footer — always in document flow ─────────────────── */}
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
            <img
              src={getThemeLogo(theme)}
              alt=""
              aria-hidden="true"
              className="footer-logo-img"
            />
          </div>

          <div className="footer-links">
            <Link to="/">Browse Events</Link>
            <Link to="/submit">Submit an Event</Link>
            <Link to="/subscribe">Get the Newsletter</Link>
            <Link to="/about">About</Link>
          </div>

          <p className="footer-copy">
            © {new Date().getFullYear()} Akron Pulse
            <span className="footer-copy-sep" aria-hidden="true"> · </span>
            <Link to="/admin" className="footer-admin-link">Admin</Link>
          </p>
        </div>
      </footer>

      {/* ── Fixed slim bar — scroll-driven opacity ────────────────── */}
      <div
        className={`footer-slim-bar${effectiveOpacity < 0.05 ? ' footer-slim-bar--hidden' : ''}`}
        style={{ '--slim-opacity': effectiveOpacity }}
        aria-hidden="true"
      >
        <div className="footer-slim-bar-inner">
          <div className="footer-slim-bar-logo">
            <img src={getThemeLogo(theme)} alt="" className="footer-logo-img" />
          </div>

          <div className="footer-slim-bar-middle">
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
                tabIndex={effectiveOpacity < 0.1 ? -1 : 0}
              >
                {THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="footer-links footer-slim-bar-links">
              <Link to="/" tabIndex={effectiveOpacity < 0.1 ? -1 : 0}>Browse Events</Link>
              <Link to="/submit" tabIndex={effectiveOpacity < 0.1 ? -1 : 0}>Submit an Event</Link>
              <Link to="/subscribe" tabIndex={effectiveOpacity < 0.1 ? -1 : 0}>Get the Newsletter</Link>
              <Link to="/about" tabIndex={effectiveOpacity < 0.1 ? -1 : 0}>About</Link>
            </div>
          </div>

          <p className="footer-copy footer-slim-bar-copy">
            © {new Date().getFullYear()} Akron Pulse
          </p>
        </div>
      </div>
    </>
  )
}
