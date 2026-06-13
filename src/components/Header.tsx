import { useState, useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useTheme } from '@/hooks/useTheme'
import { getThemeLogo } from '@/lib/themes'
import { isStandalone } from '@/hooks/usePwaInstall'
import { useNeighborhood } from '@/hooks/useNeighborhood'
import './Header.css'

/** Location-pin glyph for the "My Neighborhood" menu item. */
function PinIcon() {
  return (
    <svg className="myhood-pin" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 22s7-7.16 7-12a7 7 0 1 0-14 0c0 4.84 7 12 7 12Z"
        fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"
      />
      <circle cx="12" cy="10" r="2.6" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}

export default function Header() {
  const [scrolled,    setScrolled]    = useState(false)
  const [menuOpen,    setMenuOpen]    = useState(false)
  const [theme] = useTheme()
  const location  = useLocation()
  const navigate  = useNavigate()
  const isHome    = location.pathname === '/'
  const isAdmin   = location.pathname.startsWith('/admin')

  // "My Neighborhood" is an installed-app affordance only. Evaluate once:
  // display-mode doesn't change within a session.
  const [standalone] = useState(() => isStandalone())
  const { hubSlug, hubLabel, openPicker, clearHub } = useNeighborhood()
  // A saved hub whose label we can resolve renders "My Neighborhood: Name";
  // an orphaned slug (hub since removed) still navigates but shows generic.
  const hubName = hubSlug ? hubLabel : null

  // Header goes solid when scrolled (on home) or always on other pages
  useEffect(() => {
    if (!isHome) {
      setScrolled(true)
      return
    }
    const onScroll = () => setScrolled(window.scrollY > 20)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [isHome])

  // Close menu on route change
  useEffect(() => { setMenuOpen(false) }, [location])

  // Lock body scroll when mobile menu is open
  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [menuOpen])

  // Hide header on admin page
  if (isAdmin) return null

  const navTo = (path: string) => {
    setMenuOpen(false)
    navigate(path)
  }

  const isActive = (path: string) =>
    path === '/'
      ? location.pathname === '/'
      : location.pathname.startsWith(path)

  return (
    <header className={`site-header${scrolled ? ' scrolled' : ''}${menuOpen ? ' menu-open' : ''}`}>
      <div className="header-inner">
        <Link to="/" className="nav-logo">
          <img
            src={getThemeLogo(theme)}
            alt=""
            className="nav-logo-img"
            aria-hidden="true"
          />
          Akron <span className="amber">Pulse</span>
        </Link>

        <nav className="nav-links">
          {standalone && (
            <button
              className="nav-link nav-myhood"
              onClick={() => (hubSlug ? navigate(`/events/${hubSlug}`) : openPicker())}
            >
              <PinIcon />
              {hubName ? `My Neighborhood: ${hubName}` : 'My Neighborhood'}
            </button>
          )}
          <Link to="/about" className={`nav-link ${isActive('/about') ? 'active' : ''}`}>About</Link>
          <Link to="/organizers" className={`nav-link ${isActive('/organizers') ? 'active' : ''}`}>Organizers &amp; Partners</Link>
        </nav>

        <div className="nav-cta-group">
          <Link to="/submit" className="btn-nav-cta btn-nav-cta-outline">+ Submit Event</Link>
          <Link to="/subscribe" className="btn-nav-cta">Subscribe</Link>
        </div>

        <button
          className={`btn-hamburger ${menuOpen ? 'open' : ''}`}
          onClick={() => setMenuOpen((o) => !o)}
          aria-label="Menu"
          aria-expanded={menuOpen}
        >
          <span /><span /><span />
        </button>
      </div>

      {menuOpen && (
        <div className="mobile-menu open">
          {standalone && (
            <div className="mobile-myhood">
              {hubSlug ? (
                <>
                  <button
                    className="mobile-myhood-main"
                    onClick={() => navTo(`/events/${hubSlug}`)}
                  >
                    <PinIcon />
                    <span className="mobile-myhood-text">
                      <span className="mobile-myhood-eyebrow">My Neighborhood</span>
                      <span className="mobile-myhood-name">{hubName ?? 'View your area'}</span>
                    </span>
                  </button>
                  <div className="mobile-myhood-actions">
                    <button
                      className="mobile-myhood-link"
                      onClick={() => { setMenuOpen(false); openPicker() }}
                    >
                      Change
                    </button>
                    <span className="mobile-myhood-sep" aria-hidden="true">·</span>
                    <button className="mobile-myhood-link" onClick={clearHub}>
                      Clear
                    </button>
                  </div>
                </>
              ) : (
                <button
                  className="mobile-myhood-main mobile-myhood-unset"
                  onClick={() => { setMenuOpen(false); openPicker() }}
                >
                  <PinIcon />
                  <span className="mobile-myhood-text">
                    <span className="mobile-myhood-name">Set My Neighborhood</span>
                    <span className="mobile-myhood-eyebrow">Pick your area for a personal view</span>
                  </span>
                </button>
              )}
            </div>
          )}
          <button className={`mobile-nav-link ${isActive('/about') ? 'active' : ''}`} onClick={() => navTo('/about')}>About</button>
          <button className={`mobile-nav-link ${isActive('/organizers') ? 'active' : ''}`} onClick={() => navTo('/organizers')}>Organizers &amp; Partners</button>
          <button className="mobile-menu-cta mobile-menu-cta-outline" onClick={() => navTo('/submit')}>+ Submit Event</button>
          <button className="mobile-menu-cta" onClick={() => navTo('/subscribe')}>Subscribe</button>
        </div>
      )}
    </header>
  )
}
