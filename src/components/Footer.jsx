import { Link, useLocation } from 'react-router-dom'
import { useTheme } from '@/hooks/useTheme'
import { THEMES, DEFAULT_THEME, THEME_STORAGE_KEY, LEGACY_THEME_STORAGE_KEY } from '@/lib/themes'
import { ENABLED_CATEGORY_HUBS, ENABLED_NEIGHBORHOOD_HUBS } from '@/lib/seo'
import './Footer.css'

// All localStorage keys that count as "preferences"
const PREF_KEYS = [
  THEME_STORAGE_KEY,
  LEGACY_THEME_STORAGE_KEY,
  'akronpulse_card_view_mode',
  'turnout_card_view_mode',   // legacy pre-rebrand key
]

export default function Footer() {
  const { pathname } = useLocation()
  const [theme, setTheme] = useTheme()

  if (pathname.startsWith('/admin')) return null

  function handleReset() {
    try { PREF_KEYS.forEach(k => localStorage.removeItem(k)) } catch {}
    setTheme(DEFAULT_THEME)
    window.location.reload()
  }

  return (
    <footer>
      <div className="footer-logo">
        <div className="logo-dot" />
        Akron <span className="amber">Pulse</span>
      </div>
      <p className="footer-tagline">Everything happening in Akron &amp; Summit County, all in one place.</p>
      <div className="footer-links">
        <Link to="/">Browse Events</Link>
        <Link to="/submit">Submit an Event</Link>
        <Link to="/subscribe">Get the Newsletter</Link>
        <Link to="/about">About</Link>
      </div>

      {/* ── Hub navigation ──
       * Surfaces the category + neighborhood landing pages on every
       * footer. Descriptive anchor text matters here ("Concerts in
       * Akron, OH" rather than "Concerts") — Google reads anchor text
       * as a relevance signal for the destination page, and we
       * specifically want each hub to win on its head keyword.
       * Also delivers SEO action plan item 08 (internal linking from
       * the homepage / every page to category & neighborhood hubs). */}
      {/* Hub nav. Only enabled categories show today; the
          neighborhood column reappears once GIS data lands. The
          parent grid collapses to a single column automatically
          when one side is empty. */}
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
          Want to switch up the vibe? Go for it, let us know what you like best.
        </label>
        <div className="footer-theme-controls">
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

      <p className="footer-copy">
        © {new Date().getFullYear()} Akron Pulse · Made with ♥ in Akron, OH
        <span className="footer-copy-sep" aria-hidden="true"> · </span>
        <Link to="/admin" className="footer-admin-link">Admin</Link>
      </p>
    </footer>
  )
}
