import { useState } from 'react'
import { Outlet, NavLink, useNavigate } from 'react-router-dom'
import '../../pages/AdminPage.css'

// ── Auth ──────────────────────────────────────────────────────────────────
const ADMIN_PW = 'admin'

function useAdminAuth() {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem('admin_auth') === '1')
  const login = (pw) => {
    if (pw === ADMIN_PW) {
      sessionStorage.setItem('admin_auth', '1')
      setAuthed(true)
      return true
    }
    return false
  }
  const logout = () => { sessionStorage.removeItem('admin_auth'); setAuthed(false) }
  return { authed, login, logout }
}

function LoginGate({ onLogin }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState(false)
  const submit = (e) => {
    e.preventDefault()
    if (!onLogin(pw)) setErr(true)
  }
  return (
    <div className="admin-login-wrap">
      <form className="admin-login-card" onSubmit={submit}>
        <div className="admin-login-icon">🔒</div>
        <h2 className="admin-login-title">Admin Dashboard</h2>
        <p className="admin-login-sub">Enter the admin password to continue.</p>
        {err && <p className="admin-login-err">Incorrect password</p>}
        <input
          className="form-input"
          type="password"
          value={pw}
          onChange={e => { setPw(e.target.value); setErr(false) }}
          placeholder="Password"
          autoFocus
        />
        <button className="btn-admin-primary" type="submit">Sign In</button>
      </form>
    </div>
  )
}

// ── Sidebar nav items ─────────────────────────────────────────────────────
const NAV_ITEMS = [
  { to: 'events',        label: 'Events',        icon: '📅' },
  { to: 'venues',        label: 'Venues',        icon: '📍' },
  { to: 'organizations', label: 'Organizations', icon: '🏢' },
  { to: 'areas',         label: 'Areas',         icon: '🏟️' },
  { to: 'scraper-runs',  label: 'Scraper Runs',  icon: '🤖' },
]

// ── Layout ────────────────────────────────────────────────────────────────
export default function AdminLayout() {
  const { authed, login, logout } = useAdminAuth()
  const navigate = useNavigate()

  if (!authed) return <LoginGate onLogin={login} />

  const handleLogout = () => { logout(); navigate('/') }

  return (
    <div className="admin-page">
      <div className="admin-topbar">
        <h1 className="admin-topbar-title">Turnout Admin</h1>
        <button className="btn-admin-ghost" onClick={handleLogout}>Log out</button>
      </div>
      <div className="admin-layout">
        <nav className="admin-sidebar">
          <a href="/" className="admin-nav-btn admin-nav-back">
            <span className="admin-nav-icon">←</span>
            Back to Site
          </a>
          {NAV_ITEMS.map(item => (
            <NavLink
              key={item.to}
              to={`/admin/${item.to}`}
              className={({ isActive }) => `admin-nav-btn ${isActive ? 'active' : ''}`}
              end={false}
            >
              <span className="admin-nav-icon">{item.icon}</span>
              {item.label}
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
