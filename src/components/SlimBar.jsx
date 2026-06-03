import { Link, useLocation } from 'react-router-dom'
import { useTheme } from '@/hooks/useTheme'
import { THEMES, getThemeLogo } from '@/lib/themes'
import './SlimBar.css'

/**
 * SlimBar — compact in-flow navigation bar that sits between the hub strip
 * and the sticky FilterBar on the homepage. Visible on page load; scrolls
 * away naturally as the user moves down, leaving the FilterBar to stick.
 *
 * Desktop (single row): logo · vibes · Events · Venues · Organizations · The Pulse · © 2026
 * Mobile (two rows):    row1 = logo + vibes   /   row2 = links + copyright
 * Very small mobile:    "Events" is dropped (homepage is already the top nav destination)
 */
export default function SlimBar() {
  const { pathname } = useLocation()
  const [theme, setTheme] = useTheme()

  if (pathname.startsWith('/admin')) return null

  return (
    <div className="slim-bar" role="navigation" aria-label="Site quick-links">
      <div className="slim-bar-inner">

        {/* ── Identity: logo + vibe switcher (Row 1 on mobile) ── */}
        <div className="slim-bar-identity">
          <Link to="/" className="slim-bar-logo" aria-label="Akron Pulse — home">
            <img
              src={getThemeLogo(theme)}
              alt=""
              aria-hidden="true"
              className="slim-bar-logo-img"
            />
          </Link>

          <div className="slim-bar-vibes">
            <label htmlFor="slim-bar-theme-select" className="slim-bar-vibes-label">
              Vibes:
            </label>
            <select
              id="slim-bar-theme-select"
              className="slim-bar-theme-select"
              value={theme}
              onChange={e => setTheme(e.target.value)}
              aria-label="Theme"
            >
              {THEMES.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* ── Nav + copyright (Row 2 on mobile) ── */}
        <div className="slim-bar-nav">
          <nav className="slim-bar-links">
            {/* Hidden at very small breakpoints — homepage is already the primary nav destination */}
            <Link to="/" className="slim-bar-link slim-bar-link--events">Events</Link>
            <Link to="/venues" className="slim-bar-link">Venues</Link>
            <Link to="/organizations" className="slim-bar-link">Organizations</Link>
            <Link to="/subscribe" className="slim-bar-link slim-bar-link--pulse">The Pulse</Link>
          </nav>

          <p className="slim-bar-copy">© {new Date().getFullYear()} Akron Pulse</p>
        </div>

      </div>
    </div>
  )
}
