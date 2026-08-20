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
 * Kept separate from FeedbackDialog.tsx so the cooldown and draft
 * contracts are independently testable without a DOM.
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

// Client-side cap for the optional email field — matches the DB's
// `char_length(email) between 1 and 254` clause on the anon insert policy
// (migration 058) by construction. There is no format CHECK in the DB;
// format validation is client-side only (see isPlausibleEmail below).
export const EMAIL_MAX_LEN = 254

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

// ─────────────────────────────────────────────────────────────────────────
// Persistent draft
//
// The dialog is a non-modal popover that closes on outside click / Escape,
// so an in-progress note is easy to lose by accident. We persist `body`
// and `email` (never the honeypot field) to localStorage so reopening the
// dialog — even after a full page reload or navigating to another page —
// restores what the visitor was writing. Same try/catch, private-mode-safe
// pattern as the cooldown helpers above.
//
// The draft also carries `pagePath`: the page the note was STARTED on.
// Without it, a note typed on an event page and sent after navigating
// elsewhere would be filed against whatever page happened to be open at
// submit time, which is exactly the field an operator triages on. The
// value is STICKY — once a draft exists, later writes preserve its
// original pagePath rather than re-stamping it — so restoring a draft on
// another page never silently relabels where it came from.
//
// Callers must pass an ALREADY-REDACTED path (redactPath, P1-13). A raw
// /d/<code> path is a live day-plan bearer credential; redacting only at
// submit time would still have parked one in localStorage for up to
// DRAFT_TTL_MS.
// ─────────────────────────────────────────────────────────────────────────

export const DRAFT_KEY = 'akronpulse_feedback_draft_v1'

// Drafts older than this are treated as abandoned and not repopulated —
// bounds how long a stale, possibly-identifying draft sits in localStorage
// on a shared/public machine.
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

export interface FeedbackDraft {
  body: string
  email: string
  /** Redacted path the note was started on. '' when unknown. */
  pagePath: string
  savedAt: number
}

/**
 * True when there is anything worth persisting. Whitespace-only input is
 * not: it would leave a localStorage entry on every visitor who merely
 * opens and closes the popover, and it would restore as a blank form
 * anyway.
 */
export function hasDraftContent(body: string, email: string): boolean {
  return body.trim().length > 0 || email.trim().length > 0
}

/**
 * Returns the saved draft, or null when there isn't one, it's malformed,
 * or it's past DRAFT_TTL_MS (in which case the stale entry is cleared as
 * a side effect so it doesn't linger forever).
 */
export function readDraft(): FeedbackDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<FeedbackDraft> | null
    if (!parsed || typeof parsed.body !== 'string' || typeof parsed.savedAt !== 'number') {
      return null
    }

    if (Date.now() - parsed.savedAt > DRAFT_TTL_MS) {
      clearDraft()
      return null
    }

    return {
      body: parsed.body,
      email: typeof parsed.email === 'string' ? parsed.email : '',
      // Tolerated as missing: drafts written by the build that shipped
      // before pagePath existed must keep restoring rather than being
      // thrown away, so this is NOT part of the validity check above.
      pagePath: typeof parsed.pagePath === 'string' ? parsed.pagePath : '',
      savedAt: parsed.savedAt,
    }
  } catch {
    return null
  }
}

/**
 * Persist the in-progress note. `currentPagePath` must already be redacted.
 *
 * Two behaviours worth knowing:
 *   - Empty in, cleared out. Writing whitespace-only content REMOVES any
 *     stored draft instead of saving a blank one, so erasing the textarea
 *     is a real "never mind" and open-then-close leaves nothing behind.
 *   - pagePath is sticky. An existing draft keeps the page it was started
 *     on; only a brand-new draft takes `currentPagePath`.
 */
export function writeDraft(body: string, email: string, currentPagePath: string): void {
  try {
    if (!hasDraftContent(body, email)) {
      clearDraft()
      return
    }
    const existing = readDraft()
    const draft: FeedbackDraft = {
      body,
      email,
      pagePath: existing?.pagePath || currentPagePath,
      savedAt: Date.now(),
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  } catch { /* ignore — private mode / storage disabled */ }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY)
  } catch { /* ignore — private mode / storage disabled */ }
}

// ─────────────────────────────────────────────────────────────────────────
// Email format — UX only. The DB has no format constraint (only the
// length cap above), so this is deliberately permissive: it exists to
// catch obvious typos, not to be a source of truth, and it is NOT used to
// decide whether a stored email is safe to render as a `mailto:` link
// (see AdminFeedbackPage.tsx, which encodes rather than trusting shape).
// ─────────────────────────────────────────────────────────────────────────

// `,` and `;` are excluded on purpose, not just whitespace: both are
// address-list separators. Resend rejects a replyTo containing one with
// a 422, and because notify-feedback's send is fire-and-forget that
// failure silently drops the ENTIRE operator notification, not just the
// header. They are also mailto: recipient separators (AdminFeedbackPage).
const EMAIL_SHAPE_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

export function isPlausibleEmail(email: string): boolean {
  return EMAIL_SHAPE_RE.test(email)
}
