import { Link, useLocation } from 'react-router-dom'
import { useTheme } from '@/hooks/useTheme'
import { THEMES } from '@/lib/themes'
import './Footer.css'

export default function Footer() {
  const { pathname } = useLocation()
  const [theme, setTheme] = useTheme()

  if (pathname.startsWith('/admin')) return null

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

      <div className="footer-theme">
        <label htmlFor="footer-theme-select" className="footer-theme-prompt">
          Want to switch up the vibe? Go for it, let us know what you like best.
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
      </div>

      <p className="footer-copy">
        © {new Date().getFullYear()} Akron Pulse · Made with ♥ in Akron, OH
        <span className="footer-copy-sep" aria-hidden="true"> · </span>
        <Link to="/admin" className="footer-admin-link">Admin</Link>
      </p>
    </footer>
  )
}
