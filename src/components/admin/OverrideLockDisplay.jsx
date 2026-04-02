import { format } from 'date-fns'

/**
 * Displays the current override locks summary at the bottom of a form.
 */
export default function OverrideLockDisplay({ overrides }) {
  const entries = Object.entries(overrides ?? {})
  if (entries.length === 0) return null

  return (
    <>
      <div className="admin-section-label">Override Locks</div>
      <p className="admin-hint">
        Locked fields are protected from scraper overwrites. Click the lock icon next to any field above to toggle.
      </p>
      <div className="admin-override-list">
        {entries.map(([field, val]) => (
          <span key={field} className="admin-override-chip">
            🔒 {field}
            <span className="admin-override-date">
              {' '}(since {format(new Date(val.at), 'MMM d')})
            </span>
          </span>
        ))}
      </div>
    </>
  )
}
