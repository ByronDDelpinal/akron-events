/**
 * feedbackOrb.ts
 *
 * Pure, DOM-free helpers for the feedback orb (see
 * docs/feedback-orb-implementation-plan.md §4 and
 * docs/feedback-orb-design-spec.md §1). Kept separate from FeedbackOrb.tsx
 * and useFeedbackOrbDrag.ts so the corner-snap math and persistence
 * contract are independently testable without a DOM.
 *
 * All storage reads/writes are wrapped in try/catch (private-mode safe),
 * matching InstallPrompt.tsx.
 */

export type Corner = 'br' | 'bl' | 'tr' | 'tl'

export const CORNERS: Corner[] = ['br', 'bl', 'tr', 'tl']

export const ORB_CORNER_KEY = 'akronpulse_feedback_orb_corner'
export const COOLDOWN_KEY = 'akronpulse_feedback_cooldown_until'
export const COOLDOWN_MS = 45_000
export const TAP_THRESHOLD_PX = 6
export const MAX_LEN = 1000

/**
 * Nearest of the four corners to a release point, given the current
 * viewport size. Used on pointerup to decide where the orb snaps to.
 */
export function nearestCorner(x: number, y: number, vw: number, vh: number): Corner {
  const isRight = x >= vw / 2
  const isBottom = y >= vh / 2
  if (isBottom && isRight) return 'br'
  if (isBottom && !isRight) return 'bl'
  if (!isBottom && isRight) return 'tr'
  return 'tl'
}

/** Inline style fragment (right/left/top/bottom keys) for a given corner. */
export function cornerToPosition(corner: Corner): {
  top?: string
  bottom?: string
  left?: string
  right?: string
} {
  // Safe-area insets on every side (spec §1: "Insets honor
  // env(safe-area-inset-*) on iOS standalone, add to right/bottom") — plus
  // the top/bottom clearance so the orb never slides under the sticky
  // header or the slim footer bar.
  const TOP = 'calc(80px + env(safe-area-inset-top))'
  const BOTTOM = 'calc(84px + env(safe-area-inset-bottom))'
  const RIGHT = 'calc(var(--space-2xl) + env(safe-area-inset-right))'
  const LEFT = 'calc(var(--space-2xl) + env(safe-area-inset-left))'

  switch (corner) {
    case 'br':
      return { bottom: BOTTOM, right: RIGHT }
    case 'bl':
      return { bottom: BOTTOM, left: LEFT }
    case 'tr':
      return { top: TOP, right: RIGHT }
    case 'tl':
      return { top: TOP, left: LEFT }
    default:
      return { bottom: BOTTOM, right: RIGHT }
  }
}

/** A pointer movement below this threshold counts as a tap, not a drag. */
export function isTap(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) < TAP_THRESHOLD_PX
}

function isValidCorner(value: unknown): value is Corner {
  return typeof value === 'string' && (CORNERS as string[]).includes(value)
}

/** Reads the persisted corner id. Defaults to 'br' when unset or invalid. */
export function readCorner(): Corner {
  try {
    const stored = localStorage.getItem(ORB_CORNER_KEY)
    return isValidCorner(stored) ? stored : 'br'
  } catch {
    return 'br'
  }
}

export function writeCorner(corner: Corner): void {
  try {
    localStorage.setItem(ORB_CORNER_KEY, corner)
  } catch { /* ignore — private mode / storage disabled */ }
}

/** Epoch ms the post-send cooldown ends, or null when there isn't one active. */
export function readCooldownUntil(): number | null {
  try {
    const stored = parseInt(localStorage.getItem(COOLDOWN_KEY) ?? '', 10)
    return Number.isFinite(stored) ? stored : null
  } catch {
    return null
  }
}

export function writeCooldownUntil(untilMs: number): void {
  try {
    localStorage.setItem(COOLDOWN_KEY, String(untilMs))
  } catch { /* ignore — private mode / storage disabled */ }
}

/**
 * Guarded reduced-motion read, shared by the drag hook and the component
 * (matches useTheme.tsx / analytics.ts house style — browser globals are
 * always present at runtime, but the guard keeps modules import-safe for
 * prerender and costs nothing).
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
