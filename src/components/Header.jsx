import { useState, useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import './Header.css'

export default function Header() {
  const [scrolled,    setScrolled]    = useState(false)
  const [menuOpen,    setMenuOpen]    = useState(false)
  const location  = useLocation()
  const navigate  = useNavigate()
  const isHome    = location.pathname === '/'
  const isAdmin   = location.pathname.startsWith('/admin')

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

  // Hide header on admin page
  if (isAdmin) return null

  const navTo = (path) => {
    setMenuOpen(false)
    navigate(path)
  }

  const isActive = (path) =>
    path === '/'
      ? location.pathname === '/'
      : location.pathname.startsWith(path)

  return (
    <header className={scrolled ? 'scrolled' : ''}>
      <div className="header-inner">
        <Link to="/" className="nav-logo">
          <div className="logo-dot" />
          Turn<span className="amber">out</span>
        </Link>

        <nav className="nav-links">
          <Link to="/"              className={`nav-link ${isActive('/')              ? 'active' : ''}`}>Browse Events</Link>
          <Link to="/venues"        className={`nav-link ${isActive('/venues')        ? 'active' : ''}`}>Venues</Link>
          <Link to="/organizations" className={`nav-link ${isActive('/organizations') ? 'active' : ''}`}>Organizations</Link>
          <Link to="/subscribe"     className={`nav-link ${isActive('/subscribe')     ? 'active' : ''}`}>Subscribe</Link>
          <Link to="/about"         className={`nav-link ${isActive('/about')         ? 'active' : ''}`}>About</Link>
          <Link to="/admin"         className={`nav-link ${isActive('/admin')         ? 'active' : ''}`}>Admin</Link>
        </nav>

        <div className="nav-cta-group">
          <Link to="/submit" className="btn-nav-cta">+ Submit Event</Link>
          <Link to="/organizations/submit" className="btn-nav-cta btn-nav-cta-outline">+ Register Organization</Link>
        </div>

        <button
          className={`btn-hamburger ${menuOpen ? 'open' : ''}`}
          onClick={() => setMenuOpen(o => !o)}
          aria-label="Menu"
          aria-expanded={menuOpen}
        >
          <span /><span /><span />
        </button>
      </div>

      {menuOpen && (
        <div className="mobile-menu open">
          <button className={`mobile-nav-link ${isActive('/')              ? 'active' : ''}`} onClick={() => navTo('/')}>Browse Events</button>
          <button className={`mobile-nav-link ${isActive('/venues')        ? 'active' : ''}`} onClick={() => navTo('/venues')}>Venues</button>
          <button className={`mobile-nav-link ${isActive('/organizations') ? 'active' : ''}`} onClick={() => navTo('/organizations')}>Organizations</button>
          <button className={`mobile-nav-link ${isActive('/subscribe')     ? 'active' : ''}`} onClick={() => navTo('/subscribe')}>Subscribe</button>
          <button className={`mobile-nav-link ${isActive('/about')         ? 'active' : ''}`} onClick={() => navTo('/about')}>About</button>
          <button className={`mobile-nav-link ${isActive('/admin')         ? 'active' : ''}`} onClick={() => navTo('/admin')}>Admin</button>
          <button className="mobile-menu-cta" onClick={() => navTo('/submit')}>+ Submit Event</button>
          <button className="mobile-menu-cta mobile-menu-cta-outline" onClick={() => navTo('/organizations/submit')}>+ Register Organization</button>
        </div>
      )}
    </header>
  )
}
