import { format } from 'date-fns'
import { normalizeOverrides } from '@/lib/admin/useOverrides'

/**
 * Displays the current override locks summary at the bottom of a form.
 *
 * The chip glyph matches the closed-padlock SVG used in <OverrideToggle />
 * so the locked state reads the same in both surfaces.
 *
 * Renders defensively through `normalizeOverrides`: legacy rows store bare
 * `true` markers instead of `{ at }` objects, and a lock whose timestamp is
 * unknown (or unparsable) says "locked earlier" instead of throwing a
 * RangeError out of date-fns.
 */
export default function OverrideLockDisplay({ overrides }: { overrides?: unknown }) {
  const entries = Object.entries(normalizeOverrides(overrides))
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
            <span className="admin-override-date">{lockedSince(val.at)}</span>
          </span>
        ))}
      </div>
    </>
  )
}

/**
 * "(since MMM d)" only when the timestamp parses; a legacy lock with no
 * usable date reads "(locked earlier)". Never throws.
 */
function lockedSince(at: string | null): string {
  if (at) {
    const parsed = new Date(at)
    if (!Number.isNaN(parsed.getTime())) return `(since ${format(parsed, 'MMM d')})`
  }
  return '(locked earlier)'
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
