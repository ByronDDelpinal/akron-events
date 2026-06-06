import { useState, useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useTheme } from '@/hooks/useTheme'
import { getThemeLogo } from '@/lib/themes'
import './Header.css'

export default function Header() {
  const [scrolled,    setScrolled]    = useState(false)
  const [menuOpen,    setMenuOpen]    = useState(false)
  const [theme] = useTheme()
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
          <Link to="/about" className={`nav-link ${isActive('/about') ? 'active' : ''}`}>About</Link>
        </nav>

        <div className="nav-cta-group">
          <Link to="/feedback" className="btn-nav-feedback">Feedback<span className="feedback-badge">Beta</span></Link>
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
          <button className={`mobile-nav-link ${isActive('/about') ? 'active' : ''}`} onClick={() => navTo('/about')}>About</button>
          <button className="mobile-nav-feedback" onClick={() => navTo('/feedback')}>Feedback<span className="feedback-badge">Beta</span></button>
          <button className="mobile-menu-cta mobile-menu-cta-outline" onClick={() => navTo('/submit')}>+ Submit Event</button>
          <button className="mobile-menu-cta" onClick={() => navTo('/subscribe')}>Subscribe</button>
        </div>
      )}
    </header>
  )
}
