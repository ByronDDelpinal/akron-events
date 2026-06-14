import { useState, useEffect, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { SEO } from '@/lib/seo'
import './AdminLayout.css'

// ── Auth ──────────────────────────────────────────────────────────────────
// Real Supabase Auth (email + password). The session JWT carries the
// `authenticated` role, which is what the admin RLS policies are scoped to
// (see migration 038). There is NO public sign-up from this app — the single
// admin user is created in the Supabase dashboard, and email sign-ups must be
// disabled in the project's Auth settings so `authenticated` == the admin.

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
        <h2 className="admin-login-title">Admin Dashboard</h2>
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

// ── Review queue count badge ──────────────────────────────────────────────
function useReviewCount() {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    supabase
      .from('events')
      .select('id', { count: 'exact', head: true })
      .eq('needs_review', true)
      .then(({ count: c, error }) => {
        if (!error) setCount(c ?? 0)
      })
  }, [])
  return count
}

// ── Sidebar nav items ─────────────────────────────────────────────────────
interface NavItem {
  to: string
  label: string
  icon: string
  badge?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { to: 'events',        label: 'Events',        icon: '📅' },
  { to: 'venues',        label: 'Venues',        icon: '📍' },
  { to: 'organizations', label: 'Organizations', icon: '🏢' },
  { to: 'areas',         label: 'Areas',         icon: '🏟️' },
  { to: 'scraper-runs',  label: 'Scraper Runs',  icon: '🤖' },
  { to: 'email',         label: 'Email',         icon: '✉️' },
  { to: 'feedback',      label: 'Feedback',      icon: '📣' },
  { to: 'review',        label: 'Review Queue',  icon: '🔍', badge: true },
]

const ADMIN_SECTION_LABELS: Record<string, string> = {
  events:         'Events',
  venues:         'Venues',
  organizations:  'Organizations',
  areas:          'Areas',
  'scraper-runs': 'Scraper Runs',
  email:          'Email',
  feedback:       'Feedback',
  review:         'Review Queue',
}

function adminSectionTitle(pathname: string): string {
  const seg = pathname.replace(/^\/admin\/?/, '').split('/')[0] || 'events'
  const label = ADMIN_SECTION_LABELS[seg] || seg
  return `Admin: ${label}`
}

export default function AdminLayout() {
  const { state, login, logout } = useAdminAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const reviewCount = useReviewCount()

  if (state === 'loading') {
    return <div className="admin-login-wrap"><p className="admin-login-sub">Loading…</p></div>
  }
  if (state === 'signed-out') return <LoginGate onLogin={login} />

  const handleLogout = async () => { await logout(); navigate('/') }

  return (
    <div className="admin-page">
      <SEO title={adminSectionTitle(location.pathname)} noindex />
      <div className="admin-topbar">
        <h1 className="admin-topbar-title">Akron Pulse Admin</h1>
        <button className="btn-admin-ghost" onClick={handleLogout}>Log out</button>
      </div>
      <div className="admin-layout">
        <nav className="admin-sidebar">
          <a href="/" className="admin-nav-btn admin-nav-back">
            <span className="admin-nav-icon">←</span>
            Back to Site
          </a>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={`/admin/${item.to}`}
              className={({ isActive }) => `admin-nav-btn ${isActive ? 'active' : ''}`}
              end={false}
            >
              <span className="admin-nav-icon">{item.icon}</span>
              {item.label}
              {item.badge && reviewCount != null && reviewCount > 0 && (
                <span className="admin-nav-badge">{reviewCount}</span>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="admin-main">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
