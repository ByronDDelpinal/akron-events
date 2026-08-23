import { useState, useEffect, useCallback, type FormEvent, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { SEO } from '@/lib/seo'
import FeedbackDialog from '@/components/FeedbackDialog'
import { AdminPalette, KittenBreak } from '@/components/admin'
import { ShellCountsContext, useShellCountsProvider } from '@/lib/admin/useShellCounts'
import { AdminRoleContext, useAdminRoleProvider, type AdminRoleState } from '@/lib/admin/useAdminRole'
import NobodyPage from '@/pages/admin/NobodyPage'
import { format } from 'date-fns'
import './AdminLayout.css'
import './AdminShell.css'

// ── Auth ──────────────────────────────────────────────────────────────────
// Real Supabase Auth (email + password). The session JWT carries the
// `authenticated` role. There is NO public sign-up from this app — every
// account is created in the Supabase dashboard — but `authenticated` is no
// longer "the admin": since 059/061 it covers three principals, told apart
// server-side, never by the JWT alone. Admins are rows in `admin_users`
// (is_admin()), partners are live rows in `partner_memberships`
// (partner_org_context()), and any other signed-in account is a stranger
// with the anon-shaped surface. The role probe below picks which SHELL to
// render; RLS and the 061 RPCs are what actually enforce the difference.

type AuthState = 'loading' | 'signed-out' | 'signed-in'

function useAdminAuth() {
  const [state, setState] = useState<AuthState>('loading')

  useEffect(() => {
    let active = true
    supabase.auth.getSession().then(({ data }) => {
      if (active) setState(data.session ? 'signed-in' : 'signed-out')
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session: Session | null) => {
      setState(session ? 'signed-in' : 'signed-out')
    })
    return () => { active = false; sub.subscription.unsubscribe() }
  }, [])

  const login = async (email: string, password: string): Promise<string | null> => {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    return error ? error.message : null
  }
  const logout = async () => { await supabase.auth.signOut() }

  return { state, login, logout }
}

function LoginGate({ onLogin }: { onLogin: (email: string, password: string) => Promise<string | null> }) {
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr(null)
    const message = await onLogin(email, pw)
    if (message) setErr(message)
    setBusy(false)
  }

  return (
    <div className="admin-login-wrap">
      <form className="admin-login-card" onSubmit={submit}>
        <div className="admin-login-icon">🔒</div>
        <h2 className="admin-login-title">Pulse Control</h2>
        <p className="admin-login-sub">Sign in with your admin account to continue.</p>
        {err && <p className="admin-login-err">{err}</p>}
        <input
          className="form-input"
          type="email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); setErr(null) }}
          placeholder="Email"
          autoComplete="username"
          autoFocus
        />
        <input
          className="form-input"
          type="password"
          value={pw}
          onChange={(e) => { setPw(e.target.value); setErr(null) }}
          placeholder="Password"
          autoComplete="current-password"
        />
        <button className="btn-admin-primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign In'}
        </button>
      </form>
    </div>
  )
}

// ── Section titles ────────────────────────────────────────────────────────

const ADMIN_SECTION_LABELS: Record<string, string> = {
  '':             'Pulse',
  events:         'Events',
  venues:         'Venues',
  organizations:  'Organizations',
  areas:          'Areas',
  'scraper-runs': 'Scraper Runs',
  email:          'Email',
  review:         'Review Queue',
  feedback:       'Feedback',
  partners:       'Partners',
}

function adminSectionTitle(pathname: string, prefix = 'Admin'): string {
  const seg = pathname.replace(/^\/admin\/?/, '').split('/')[0] || ''
  const label = ADMIN_SECTION_LABELS[seg] || seg
  return `${prefix}: ${label}`
}

// ── Rail icons — inline SVGs, stroke follows currentColor ─────────────────

function railIcon(path: ReactNode) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {path}
    </svg>
  )
}

interface RailItem {
  to: string
  end?: boolean
  label: string
  icon: ReactNode
  badge?: boolean
}

const RAIL_ITEMS: RailItem[] = [
  { to: '/admin', end: true, label: 'Pulse, the overview',
    icon: railIcon(<path d="M2 12h4l3-8 4 16 3-8h6" />) },
  { to: '/admin/events', label: 'Events',
    icon: railIcon(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /></>) },
  { to: '/admin/venues', label: 'Venues',
    icon: railIcon(<><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" /></>) },
  { to: '/admin/organizations', label: 'Organizations',
    icon: railIcon(<path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M9 13h.01M9 17h.01M15 9h.01M15 13h.01M15 17h.01" />) },
  { to: '/admin/areas', label: 'Areas',
    icon: railIcon(<><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 12h18M12 3v9" /></>) },
  { to: '/admin/scraper-runs', label: 'Scraper runs',
    icon: railIcon(<><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4M8 4h8M9 13h.01M15 13h.01M9 17h6" /></>) },
  { to: '/admin/review', label: 'Review queue', badge: true,
    icon: railIcon(<><path d="M22 12h-5l-2 3h-6l-2-3H2" /><path d="M5 5h14l3 7v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7l3-7Z" /></>) },
  { to: '/admin/email', label: 'Email',
    icon: railIcon(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>) },
  { to: '/admin/feedback', label: 'Feedback',
    icon: railIcon(<path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5Z" />) },
  { to: '/admin/partners', label: 'Partners',
    // Handshake-ish: two hands meeting. No badge (design §4.3).
    icon: railIcon(<><path d="M2 9l4-4 6 5 6-5 4 4" /><path d="M12 10l-3.5 3.5a1.6 1.6 0 0 0 2.3 2.3L12 14.5" /><path d="M12 10l3.5 3.5a1.6 1.6 0 0 1-2.3 2.3L12 14.5" /><path d="M2 9v6M22 9v6" /></>) },
]

/**
 * The partner rail: exactly three sections plus utilities (design §4.3).
 * Create is a first-class rail action (the D4 full-flow decision), not a
 * button hidden in a list. No kitten break, no palette, no scrape pill --
 * admin furniture; a partner's pending rows live in THEIR events list.
 */
const PARTNER_RAIL_ITEMS: RailItem[] = [
  { to: '/admin', end: true, label: 'Pulse, your overview',
    icon: railIcon(<path d="M2 12h4l3-8 4 16 3-8h6" />) },
  { to: '/admin/events', end: true, label: 'Your events',
    icon: railIcon(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /></>) },
  { to: '/admin/events/new', label: 'New event',
    icon: railIcon(<><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>) },
]

const PAW_ICON = railIcon(
  <>
    <ellipse cx="12" cy="15.5" rx="4.4" ry="3.6" />
    <ellipse cx="5.4" cy="10.5" rx="1.7" ry="2.2" />
    <ellipse cx="9.6" cy="6.8" rx="1.7" ry="2.3" />
    <ellipse cx="14.4" cy="6.8" rx="1.7" ry="2.3" />
    <ellipse cx="18.6" cy="10.5" rx="1.7" ry="2.2" />
  </>,
)

const SITE_ICON = railIcon(
  <path d="M15 3h6v6M21 3l-9 9M11 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />,
)

const LOGOUT_ICON = railIcon(
  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />,
)

// ── Shell ─────────────────────────────────────────────────────────────────

export default function AdminLayout() {
  const { state, login, logout } = useAdminAuth()
  const navigate = useNavigate()
  // The role probe (design §4.2): fires once sign-in resolves, cached per
  // session. UX routing only, never security -- see useAdminRole.ts.
  const roleState = useAdminRoleProvider(state === 'signed-in')

  if (state === 'loading') {
    return <div className="admin-login-wrap"><p className="admin-login-sub">Loading…</p></div>
  }
  if (state === 'signed-out') return <LoginGate onLogin={login} />

  const handleLogout = async () => { await logout(); navigate('/') }

  if (roleState.status === 'loading') {
    return <div className="admin-login-wrap"><p className="admin-login-sub">Checking your access…</p></div>
  }
  if (roleState.status === 'error') {
    // The probe FAILED; that is not "no access" and must not read as it.
    return <RoleProbeError roleState={roleState} onLogout={handleLogout} />
  }
  return (
    <AdminRoleContext.Provider value={roleState}>
      {roleState.role === 'admin' && <AdminShell onLogout={handleLogout} />}
      {roleState.role === 'partner' && <PartnerShell onLogout={handleLogout} />}
      {roleState.role === 'none' && <NobodyPage onLogout={handleLogout} />}
    </AdminRoleContext.Provider>
  )
}

/**
 * The probe could not answer (network, backend down). "We could not ask"
 * and "you have no access" are opposite facts, so this renders an error
 * state with a retry, never NobodyPage and never a guessed shell.
 */
function RoleProbeError({ roleState, onLogout }: { roleState: AdminRoleState; onLogout: () => void }) {
  return (
    <div className="admin-login-wrap">
      <div className="admin-login-card" role="alert">
        <div className="admin-login-icon" aria-hidden="true">⚡</div>
        <h2 className="admin-login-title">Pulse Control</h2>
        <p className="admin-login-sub">
          You are signed in, but we could not work out what this account can
          see. This is a lookup failure, not a verdict on your access.
        </p>
        {roleState.error && <p className="admin-login-err">{roleState.error}</p>}
        <button type="button" className="btn-admin-primary" onClick={roleState.retry}>
          Try again
        </button>
        <button type="button" className="btn-admin-ghost" onClick={onLogout}>
          Log out
        </button>
      </div>
    </div>
  )
}

function greeting(): string {
  // Viewer-local hour, display only. Every PREDICATE date in the shell goes
  // through easternDate.ts; this one just says hello.
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
}

function isMacLike(): boolean {
  if (typeof navigator === 'undefined') return false
  // `navigator.platform` is deprecated; prefer User-Agent Client Hints and
  // fall back where they are not implemented. Display-only (the kbd label).
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
  const platform = uaData?.platform ?? navigator.platform ?? ''
  return /mac|iphone|ipad/i.test(platform)
}

function AdminShell({ onLogout }: { onLogout: () => void }) {
  const location = useLocation()
  const shellCounts = useShellCountsProvider()
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [kittenOpen, setKittenOpen] = useState(false)
  // Stable close/open handlers: the dialogs key focus effects on these, and
  // a new function identity per render would re-run those effects (stealing
  // focus back to the palette input) every time a count lands.
  const closePalette = useCallback(() => setPaletteOpen(false), [])
  const closeKitten = useCallback(() => setKittenOpen(false), [])
  const openKitten = useCallback(() => setKittenOpen(true), [])

  // The operator's display name, only if their auth profile carries one.
  // No name in the metadata means no name in the greeting; never invent one.
  const [displayName, setDisplayName] = useState<string | null>(null)
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const name = data.user?.user_metadata?.name
      setDisplayName(typeof name === 'string' && name.trim() ? name.trim() : null)
    })
  }, [])

  // The SOLE sanctioned keyboard affordance in this shell: Cmd/Ctrl+K opens
  // the search palette, per the maintainer-approved prototype (2026-08-22 --
  // the maintainer was told ⌘K was kept, was invited to remove it, declined,
  // and approved the prototype as the spec). The palette also opens by
  // click, and there are no other shortcuts: no row hotkeys, no legend, no
  // key hints in tooltips.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(true)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const { reviewCount, scrape } = shellCounts
  const dateLine = new Intl.DateTimeFormat(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  }).format(new Date())

  return (
    <ShellCountsContext.Provider value={shellCounts}>
      <div className="admin-shell">
        <SEO title={adminSectionTitle(location.pathname)} noindex />

        <nav className="ashell-rail" aria-label="Admin sections">
          <NavLink to="/admin" end className="ashell-rail-logo" aria-label="Akron Pulse admin home">
            <img src="/favicon.svg" alt="" />
          </NavLink>
          {RAIL_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `ashell-rail-btn ${isActive ? 'ashell-rail-btn--active' : ''}`}
              aria-label={item.label}
            >
              {item.icon}
              {item.badge && reviewCount != null && reviewCount > 0 && (
                <span className="ashell-pip">{reviewCount > 999 ? '999+' : reviewCount}</span>
              )}
              <span className="ashell-tip" aria-hidden="true">{item.label}</span>
            </NavLink>
          ))}
          <div className="ashell-rail-spacer" />
          <button
            type="button"
            className="ashell-rail-btn"
            aria-label="Take a kitten break"
            onClick={openKitten}
          >
            {PAW_ICON}
            <span className="ashell-tip" aria-hidden="true">Kitten break</span>
          </button>
          <a className="ashell-rail-btn" href="/" target="_blank" rel="noopener noreferrer" aria-label="Open the public site">
            {SITE_ICON}
            <span className="ashell-tip" aria-hidden="true">Open the public site</span>
          </a>
          <button type="button" className="ashell-rail-btn" aria-label="Log out" onClick={onLogout}>
            {LOGOUT_ICON}
            <span className="ashell-tip" aria-hidden="true">Log out</span>
          </button>
        </nav>

        <div className="ashell-main">
          <header className="ashell-topbar">
            <div className="ashell-hello">
              <h1>{displayName ? `${greeting()}, ${displayName}` : greeting()}</h1>
              <p>{dateLine} · here is what needs you today</p>
            </div>
            <div className="ashell-grow" />
            <button
              type="button"
              className="ashell-cmdk"
              onClick={() => setPaletteOpen(true)}
              aria-haspopup="dialog"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              Search sections and actions…
              <kbd>{isMacLike() ? '⌘K' : 'Ctrl K'}</kbd>
            </button>
            {scrape != null && scrape.latestRanAt != null && (
              <div className="ashell-scrape-pill" title="Last 24 hours of scraper runs">
                <span
                  className={`ashell-dot ${scrape.sourcesError > 0 ? 'ashell-dot--warn' : ''}`}
                  aria-hidden="true"
                />
                Last scrape <b>{format(new Date(scrape.latestRanAt), 'h:mm a')}</b>
                {' · '}
                {scrape.sourcesOk}/{scrape.sourcesOk + scrape.sourcesError} sources
              </div>
            )}
            {/* Admin pages don't render the site Header (Header itself hides
                on /admin), so the feedback affordance is mounted here
                separately — same component, same plumbing. */}
            <FeedbackDialog placement="admin_toolbar" triggerClassName="ashell-feedback-trigger" />
          </header>

          <div className="admin-main">
            <Outlet />
          </div>
        </div>

        <AdminPalette
          open={paletteOpen}
          onClose={closePalette}
          includeEnded={shellCounts.includeEnded}
          onToggleEnded={() => shellCounts.setIncludeEnded(!shellCounts.includeEnded)}
          onKittenBreak={openKitten}
          onLogout={onLogout}
        />
        <KittenBreak open={kittenOpen} onClose={closeKitten} />
      </div>
    </ShellCountsContext.Provider>
  )
}

/**
 * The scoped partner shell (design §4.3/§6.10): same chrome, same dark
 * Pulse Control styling (the .admin-shell token block is shell-scoped, not
 * role-scoped), a three-item rail. Kept: "Open the public site", "Log out",
 * and the feedback affordance (public plumbing; partners are legitimate
 * reporters). Removed: kitten break, the Cmd-K palette (admin-scoped
 * actions), and the scrape pill (admin telemetry -- presentation, not
 * secrecy). No ShellCounts provider: those six queries are admin numbers a
 * partner page never reads.
 */
function PartnerShell({ onLogout }: { onLogout: () => void }) {
  const location = useLocation()

  const [displayName, setDisplayName] = useState<string | null>(null)
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const name = data.user?.user_metadata?.name
      setDisplayName(typeof name === 'string' && name.trim() ? name.trim() : null)
    })
  }, [])

  const dateLine = new Intl.DateTimeFormat(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  }).format(new Date())

  return (
    <div className="admin-shell">
      <SEO title={adminSectionTitle(location.pathname, 'Partner')} noindex />

      <nav className="ashell-rail" aria-label="Partner sections">
        <NavLink to="/admin" end className="ashell-rail-logo" aria-label="Akron Pulse partner home">
          <img src="/favicon.svg" alt="" />
        </NavLink>
        {PARTNER_RAIL_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `ashell-rail-btn ${isActive ? 'ashell-rail-btn--active' : ''}`}
            aria-label={item.label}
          >
            {item.icon}
            <span className="ashell-tip" aria-hidden="true">{item.label}</span>
          </NavLink>
        ))}
        <div className="ashell-rail-spacer" />
        <a className="ashell-rail-btn" href="/" target="_blank" rel="noopener noreferrer" aria-label="Open the public site">
          {SITE_ICON}
          <span className="ashell-tip" aria-hidden="true">Open the public site</span>
        </a>
        <button type="button" className="ashell-rail-btn" aria-label="Log out" onClick={onLogout}>
          {LOGOUT_ICON}
          <span className="ashell-tip" aria-hidden="true">Log out</span>
        </button>
      </nav>

      <div className="ashell-main">
        <header className="ashell-topbar">
          <div className="ashell-hello">
            <h1>{displayName ? `${greeting()}, ${displayName}` : greeting()}</h1>
            <p>{dateLine} · your events on Akron Pulse</p>
          </div>
          <div className="ashell-grow" />
          {/* Same feedback plumbing as the public site and the admin
              topbar; partners report real problems. */}
          <FeedbackDialog placement="admin_toolbar" triggerClassName="ashell-feedback-trigger" />
        </header>

        <div className="admin-main">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
