/**
 * icons.tsx — Shared inline SVG icon components.
 *
 * Centralises the ~30 redundant icon function definitions that were
 * copy-pasted across pages and component files. Every icon accepts an
 * optional `size` prop (defaults to the most common usage size) so
 * individual call sites that need a different dimension can pass it
 * without duplicating the whole definition.
 *
 * Usage:
 *   import { BackIcon, PinIcon, CalIcon } from '@/components/icons'
 *
 * Adding a new icon: drop it here as a named export. Do not define
 * single-use icons here — keep those co-located with their component.
 */

const SHARED = {
  fill:           'none',
  stroke:         'currentColor',
  strokeLinecap:  'round' as const,
  strokeLinejoin: 'round' as const,
}

// ── Navigation ────────────────────────────────────────────────────────────────

/** Left-arrow "back" chevron. Default 14 px. */
export function BackIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="2.5" {...SHARED}>
      <path d="M19 12H5"/>
      <path d="m12 19-7-7 7-7"/>
    </svg>
  )
}

// ── Location / place ──────────────────────────────────────────────────────────

/** Map-pin "location" marker. Default 16 px. */
export function PinIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="2" {...SHARED}>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/>
      <circle cx="12" cy="10" r="3"/>
    </svg>
  )
}

/** Globe / website icon. Default 13 px. */
export function GlobeIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="2" {...SHARED}>
      <circle cx="12" cy="12" r="10"/>
      <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
    </svg>
  )
}

/** Parking "P" badge. Default 16 px. */
export function ParkingIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="2" {...SHARED}>
      <rect width="18" height="18" x="3" y="3" rx="2"/>
      <path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>
    </svg>
  )
}

// ── Date / time ───────────────────────────────────────────────────────────────

/**
 * Calendar icon (absorbs `CalendarIcon` and `CalIcon` variants).
 * Default 14 px.
 */
export function CalIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="2" {...SHARED}>
      <rect width="18" height="18" x="3" y="4" rx="2"/>
      <line x1="16" x2="16" y1="2" y2="6"/>
      <line x1="8" x2="8" y1="2" y2="6"/>
      <line x1="3" x2="21" y1="10" y2="10"/>
    </svg>
  )
}

// ── Search ────────────────────────────────────────────────────────────────────

/** Magnifying-glass search icon. Default 16 px. */
export function SearchIcon({
  size = 16,
  className,
}: {
  size?: number
  className?: string
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      strokeWidth="2.5"
      {...SHARED}
    >
      <circle cx="11" cy="11" r="8"/>
      <path d="m21 21-4.35-4.35"/>
    </svg>
  )
}

// ── Organisation / venue ──────────────────────────────────────────────────────

/** Building / organisation icon. Default 13 px. */
export function OrgIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth="2" {...SHARED}>
      <path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/>
      <path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/>
      <path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/>
      <path d="M10 6h4"/><path d="M10 10h4"/>
      <path d="M10 14h4"/><path d="M10 18h4"/>
    </svg>
  )
}
