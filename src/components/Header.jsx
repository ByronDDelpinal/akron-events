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

  // Lock body scroll when mobile menu is open
  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : ''
    return () => { document.body.style.overflow = '' }
  }, [menuOpen])

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
    <header className={`site-header${scrolled ? ' scrolled' : ''}${menuOpen ? ' menu-open' : ''}`}>
      <div className="header-inner">
        <Link to="/" className="nav-logo">
          <div className="logo-dot" />
          Akron <span className="amber">Pulse</span>
        </Link>

        {/* Primary nav: About is the only text link; logo handles "browse
         * events", and Submit Event + Subscribe live in the CTA group below
         * for visual emphasis. Venues + Organizations remain reachable via
         * direct URLs and admin tools; Admin login moved to the footer. */}
        <nav className="nav-links">
          <Link to="/about" className={`nav-link ${isActive('/about') ? 'active' : ''}`}>About</Link>
        </nav>

        {/* CTA group: Subscribe is the highlighted primary action per partner
         * direction ("Subscribe is our #2 driver"). Submit Event sits as the
         * secondary outline button. Register Organization removed from
         * header — reach via the submit-event flow when needed. */}
        <div className="nav-cta-group">
          <Link to="/feedback" className="btn-nav-feedback">Feedback<span className="feedback-badge">Beta</span></Link>
          <Link to="/submit" className="btn-nav-cta btn-nav-cta-outline">+ Submit Event</Link>
          <Link to="/subscribe" className="btn-nav-cta">Subscribe</Link>
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
          <button className={`mobile-nav-link ${isActive('/about') ? 'active' : ''}`} onClick={() => navTo('/about')}>About</button>
          <button className="mobile-nav-feedback" onClick={() => navTo('/feedback')}>Feedback<span className="feedback-badge">Beta</span></button>
          <button className="mobile-menu-cta mobile-menu-cta-outline" onClick={() => navTo('/submit')}>+ Submit Event</button>
          <button className="mobile-menu-cta" onClick={() => navTo('/subscribe')}>Subscribe</button>
        </div>
      )}
    </header>
  )
}
