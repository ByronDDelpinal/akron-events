/**
 * feedback.ts
 *
 * Pure, DOM-free helpers for the feedback dialog. Originally
 * `feedbackOrb.ts` for the floating-orb affordance (see
 * docs/feedback-orb-implementation-plan.md and
 * docs/feedback-orb-design-spec.md — both carry a 2026-07-25 addendum
 * noting the surface moved from a floating orb into a header/admin-toolbar
 * button on maintainer request; every contract below is unchanged).
 *
 * Kept separate from FeedbackDialog.tsx so the cooldown contract is
 * independently testable without a DOM.
 *
 * All storage reads/writes are wrapped in try/catch (private-mode safe),
 * matching InstallPrompt.tsx.
 */

// Unchanged on purpose: renaming this would silently reset every visitor's
// in-flight cooldown. Any existing "akronpulse_feedback_cooldown_until"
// value in localStorage must keep working after this move.
export const COOLDOWN_KEY = 'akronpulse_feedback_cooldown_until'
export const COOLDOWN_MS = 45_000
export const MAX_LEN = 1000

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
 * Guarded reduced-motion read, shared by the dialog component (matches
 * useTheme.tsx / analytics.ts house style — browser globals are always
 * present at runtime, but the guard keeps modules import-safe for
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
