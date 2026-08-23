/**
 * NobodyPage (design §4.2): the honest empty states of the role-switched
 * /admin shell. Two variants:
 *
 *   'no-access'  -- a signed-in account with no role at all (not an admin,
 *                   zero live partner memberships). Rendered INSTEAD of any
 *                   shell, with a log-out control. NEVER a fallback to
 *                   "show everything" (the ADR's exact warning).
 *   'off-limits' -- a signed-in partner reached an admin-only path (or an
 *                   admin reached nothing). Rendered inside their shell.
 */

interface NobodyPageProps {
  variant?: 'no-access' | 'off-limits'
  onLogout?: () => void
}

export default function NobodyPage({ variant = 'no-access', onLogout }: NobodyPageProps) {
  if (variant === 'off-limits') {
    return (
      <div className="ashell-empty" role="status">
        <div className="ashell-empty-ring" aria-hidden="true">·</div>
        <h3>Nothing for you here</h3>
        <p>This section is not part of your tools. If you think it should be, contact Akron Pulse.</p>
      </div>
    )
  }
  return (
    <div className="admin-login-wrap">
      <div className="admin-login-card" role="status">
        <div className="admin-login-icon" aria-hidden="true">🚪</div>
        <h2 className="admin-login-title">No access here</h2>
        <p className="admin-login-sub">
          This account is signed in, but it has no role in Pulse Control.
          If that seems wrong, contact Akron Pulse.
        </p>
        {onLogout && (
          <button type="button" className="btn-admin-ghost" onClick={onLogout}>
            Log out
          </button>
        )}
      </div>
    </div>
  )
}
