import { useState, useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useTheme } from '@/hooks/useTheme'
import { getThemeLogo } from '@/lib/themes'
import { trackEvent, EVENTS } from '@/lib/analytics'
import { isStandalone } from '@/hooks/usePwaInstall'
import { useNeighborhood } from '@/hooks/useNeighborhood'
import { useDayPlan } from '@/hooks/useDayPlan'
import FeedbackDialog from '@/components/FeedbackDialog'
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
  // Initialised from the route, not false: a non-home route is solid from
  // the first commit, so the over-hero scrim never paints and fades out
  // on entry. The effect below still owns every later transition.
  const [scrolled,    setScrolled]    = useState(() => window.location.pathname !== '/')
  const [menuOpen,    setMenuOpen]    = useState(false)
  const [theme] = useTheme()
  // Escape closes the sheet and hands focus back to the control that opened
  // it, so a keyboard user is not dropped at the top of the document.
  const hamburgerRef = useRef<HTMLButtonElement>(null)
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

  // "Plan · N" — the only new permanent chrome this feature adds, and it's
  // conditional. Count is the LOCAL draft's live item count: the draft
  // persists for 7 days after a share (dayPlanDraft.ts), so this stays
  // accurate on the device that built the plan without a network round
  // trip. /day resolves to the shared /d/<code> view on its own when this
  // device holds an active plan code (§6.5 of the design).
  const { draft } = useDayPlan()
  const planCount = draft.items.length

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

  // Lock body scroll when mobile menu is open, and let Escape close it.
  useEffect(() => {
    document.body.style.overflow = menuOpen ? 'hidden' : ''
    if (!menuOpen) {
      return () => { document.body.style.overflow = '' }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // A dialog rendered inside the sheet (the feedback popover) owns
      // Escape while it is open. Both handlers sit on `document` in the
      // bubble phase, so without this bail one Escape would dismiss the
      // popover AND unmount the whole sheet underneath it.
      if ((e.target as Element | null)?.closest?.('[role="dialog"]')) return
      setMenuOpen(false)
      // Guarded: the sheet also closes on route change (see the effect
      // above), by which point the hamburger may be unmounted.
      hamburgerRef.current?.focus()
    }
    // Widening past the desktop breakpoint hides the hamburger but would
    // otherwise leave the fixed sheet covering the viewport with nothing
    // left to dismiss it, and body scroll still locked.
    const onResize = () => {
      if (window.innerWidth >= 1280) setMenuOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onResize, { passive: true })
    return () => {
      document.body.style.overflow = ''
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onResize)
    }
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

        {/* Two nav landmarks can be exposed at once (the sheet is reachable
            at any width until the resize handler closes it), so their names
            must differ: this row is "Main", the sheet's <nav> is "Menu".
            Under 1280px this row is display:none and drops out of the
            accessibility tree, leaving the sheet as the only one. */}
        <nav className="nav-links" aria-label="Main">
          {standalone && (
            <button
              className="nav-link nav-myhood"
              onClick={() => (hubSlug ? navigate(`/events/${hubSlug}`) : openPicker())}
            >
              <PinIcon />
              {hubName ? `My Community: ${hubName}` : 'My Community'}
            </button>
          )}
          <Link to="/about" className={`nav-link ${isActive('/about') ? 'active' : ''}`}>About</Link>
          <Link
            to="/guides"
            className={`nav-link ${isActive('/guides') ? 'active' : ''}`}
            onClick={() => trackEvent(EVENTS.GUIDE_LINK_CLICK, { guide_slug: 'hub', placement: 'header' })}
          >
            Guides
          </Link>
          <Link to="/organizers" className={`nav-link ${isActive('/organizers') ? 'active' : ''}`}>Organizers &amp; Partners</Link>
          <Link to="/submit" className={`nav-link ${isActive('/submit') ? 'active' : ''}`}>Submit an Event</Link>
        </nav>

        <div className="nav-cta-group">
          {planCount > 0 && (
            <Link to="/day" className="nav-link nav-plan-pill">Plan · {planCount}</Link>
          )}
          <FeedbackDialog placement="header" triggerClassName="btn-nav-cta btn-nav-cta-outline" />
          <Link to="/subscribe" className="btn-nav-cta">Subscribe</Link>
        </div>

        {/* Mobile plan entry point outside the hamburger (day-plan-audit.md,
            Ask 2). `display: contents` above 1280px keeps the hamburger's
            position in the desktop flex row byte-identical to before this
            wrapper existed -- see Header.css. Renders nothing at count 0:
            the pill is a RETURN affordance, not a discovery one (that's the
            "+ Plan" chip's job on every card), so the header gains zero
            permanent width for visitors who never touch the feature. */}
        <div className="header-mobile-actions">
          {planCount > 0 && (
            <Link
              to="/day"
              className="nav-plan-pill nav-plan-pill--bar"
              aria-label={`Your day plan, ${planCount} ${planCount === 1 ? 'event' : 'events'}`}
            >
              Plan · {planCount}
            </Link>
          )}
          {/* aria-controls is set only while the sheet is open: the sheet is
              conditionally mounted, so in the closed state the id it names
              does not exist and the reference would dangle. */}
          <button
            className={`btn-hamburger ${menuOpen ? 'open' : ''}`}
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? 'mobile-menu' : undefined}
            ref={hamburgerRef}
          >
            <span /><span /><span />
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="mobile-menu open" id="mobile-menu">
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
                      <span className="mobile-myhood-eyebrow">My Community</span>
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
                    <span className="mobile-myhood-name">Set My Community</span>
                    <span className="mobile-myhood-eyebrow">Pick your area for a personal view</span>
                  </span>
                </button>
              )}
            </div>
          )}
          {/* Named "Menu", not "Main": the desktop row above already owns
              the "Main" landmark name, and duplicating it would leave two
              indistinguishable entries in a screen reader's landmark list
              in any state where both rows are exposed. */}
          <nav className="mobile-nav-group" aria-label="Menu">
            {planCount > 0 && (
              <button className={`mobile-nav-link ${isActive('/day') ? 'active' : ''}`} onClick={() => navTo('/day')}>
                Plan · {planCount}
              </button>
            )}
            <button className={`mobile-nav-link ${isActive('/about') ? 'active' : ''}`} onClick={() => navTo('/about')}>About</button>
            <button
              className={`mobile-nav-link ${isActive('/guides') ? 'active' : ''}`}
              onClick={() => {
                trackEvent(EVENTS.GUIDE_LINK_CLICK, { guide_slug: 'hub', placement: 'mobile_menu' })
                navTo('/guides')
              }}
            >
              Guides
            </button>
            <button className={`mobile-nav-link ${isActive('/organizers') ? 'active' : ''}`} onClick={() => navTo('/organizers')}>Organizers &amp; Partners</button>
            <button className={`mobile-nav-link ${isActive('/submit') ? 'active' : ''}`} onClick={() => navTo('/submit')}>Submit an Event</button>
          </nav>
          <FeedbackDialog placement="mobile_menu" triggerClassName="mobile-menu-cta mobile-menu-cta-outline" />
          <button className="mobile-menu-cta" onClick={() => navTo('/subscribe')}>Subscribe</button>
        </div>
      )}
    </header>
  )
}
