import { format } from 'date-fns'
import type { Overrides } from '@/lib/admin/useOverrides'

/**
 * Displays the current override locks summary at the bottom of a form.
 *
 * The chip glyph matches the closed-padlock SVG used in <OverrideToggle />
 * so the locked state reads the same in both surfaces.
 */
export default function OverrideLockDisplay({ overrides }: { overrides?: Overrides }) {
  const entries = Object.entries(overrides ?? {})
  if (entries.length === 0) return null

  return (
    <>
      <div className="admin-section-label">Override Locks</div>
      <p className="admin-hint">
        Locked fields are protected from scraper overwrites. Click the
        "Locked" pill next to any field above to unlock it.
      </p>
      <div className="admin-override-list">
        {entries.map(([field, val]) => (
          <span key={field} className="admin-override-chip">
            <ClosedLockGlyph />
            <span>{field}</span>
            <span className="admin-override-date">
              (since {format(new Date(val.at), 'MMM d')})
            </span>
          </span>
        ))}
      </div>
    </>
  )
}

function ClosedLockGlyph() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}
