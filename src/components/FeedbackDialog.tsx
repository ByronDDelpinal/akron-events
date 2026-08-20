import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type FormEvent,
} from 'react'
import { supabase } from '@/lib/supabase'
import type { TablesInsert } from '@/lib/database.types'
import { trackEvent, EVENTS } from '@/lib/analytics'
import type { FeedbackPlacement } from '@/lib/analyticsEvents'
import { redactPath } from '@/lib/planPathRedaction'
import {
  MAX_LEN,
  COOLDOWN_MS,
  EMAIL_MAX_LEN,
  prefersReducedMotion,
  readCooldownUntil,
  writeCooldownUntil,
  readDraft,
  writeDraft,
  clearDraft,
  isPlausibleEmail,
} from '@/lib/feedback'
import './FeedbackDialog.css'

type Phase = 'form' | 'success' | 'error' | 'cooldown'
type ErrorKind = 'generic' | 'empty' | 'invalidEmail'

const COUNTER_THRESHOLD = 100
const COUNTER_DANGER = 20
const CLOSE_ANIMATION_MS = 150 // matches --transition-medium
const DRAFT_WRITE_DEBOUNCE_MS = 400

/**
 * The current path, redacted (P1-13). Used both for the submitted
 * `page_path` and for the draft's stored origin page, so a /d/<code>
 * day-plan bearer credential is stripped before it can reach the database
 * OR localStorage.
 */
function currentRedactedPath(): string {
  return typeof window === 'undefined' ? '' : redactPath(window.location.pathname)
}

/**
 * Copy — from docs/feedback-orb-design-spec.md §3 (see that doc's
 * 2026-07-25 addendum: the surface moved from a floating orb to this
 * header/admin-toolbar button, but every string below is unchanged).
 * Verbatim except for two strings whose spec text uses an em dash: the
 * repo-wide "no em dashes in user-facing copy" rule overrides the spec's
 * literal punctuation there. Wording/meaning is unchanged, only the dash
 * is swapped for a colon / period.
 *
 * 2026-08 revision: `heading` and `placeholder` were superseded by a
 * question-led rewrite (ask what would make Akron Pulse better, prompt for
 * specifics) when the dialog gained contextual mounts beyond the header.
 * The spec citations above stay as historical record; every other key is
 * still the spec's text.
 *
 * `emailLabel` / `emailPlaceholder` / `errorInvalidEmail` are new (the
 * optional reply-to email field) and have no spec precedent.
 */
const COPY = {
  heading: 'What would make Akron Pulse better?',
  textareaLabel: 'Your feedback',
  placeholder: 'A missing event, a wrong time, a confusing page, or something you wish this site did. Be specific if you can.',
  helper: "Your note goes straight to the small team that builds this site. Sent from the page you're on.",
  emailLabel: 'Email (optional)',
  emailPlaceholder: 'you@example.com',
  send: 'Send',
  sending: 'Sending…',
  successHeading: 'Thank you',
  successBody: 'We got your note. It goes to the people who build this site.',
  errorGeneric: 'Something went wrong. Please try again.',
  errorEmpty: 'Add a little detail first.',
  errorInvalidEmail: "That email doesn't look right.",
  errorCooldown: 'Thanks. Give it a moment before sending another.',
  close: 'Close',
}

interface FeedbackDialogProps {
  /**
   * Which surface this mount lives on. Passed through as the `placement`
   * parameter on every feedback analytics event so the funnels from the
   * different mounts stay readable apart.
   */
  placement: FeedbackPlacement
  /**
   * Extra class name(s) for the trigger button. Each mount point (desktop
   * header CTA row, mobile menu sheet, admin toolbar) passes its own local
   * button classes so the trigger matches its surrounding chrome exactly —
   * everything else about this component is identical everywhere it's used.
   */
  triggerClassName?: string
  /** Trigger button label; contextual mounts pass a surface-specific prompt. */
  triggerLabel?: string
  /** Which trigger edge the popover anchors to. Header-style mounts keep the default 'right'. */
  align?: 'right' | 'left' | 'center'
}

export default function FeedbackDialog({
  placement,
  triggerClassName = '',
  triggerLabel = '+ Feedback',
  align = 'right',
}: FeedbackDialogProps) {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [value, setValue] = useState('')
  const [emailValue, setEmailValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [phase, setPhase] = useState<Phase>('form')
  const [errorKind, setErrorKind] = useState<ErrorKind>('generic')
  const [honeypot, setHoneypot] = useState('')

  const submittedThisOpenRef = useRef(false)
  // Synchronous re-entrancy guard for requestClose (see its comment below) —
  // separate from the `open`/`closing` *state*, which only updates on the
  // next render and so can't prevent a double-fire when the document
  // `pointerdown` listener and this popover's onBlur both land in the same
  // React event batch (P1 2026-08-16: this was inflating the
  // feedback_dismissed funnel via a double trackEvent call).
  const closeRequestedRef = useRef(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const emailInputRef = useRef<HTMLInputElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const headingId = useId()
  const helperId = useId()
  const counterId = useId()
  const emailFieldId = useId()
  const errorId = useId()

  // Mirrors the latest open/value/emailValue/phase in a ref so requestClose
  // and the unmount cleanup below can flush a pending draft write
  // synchronously without needing those fast-changing values (value and
  // emailValue change on every keystroke) in their own dependency arrays —
  // that would otherwise re-create requestClose (and every effect that
  // depends on it, e.g. the global keydown/pointerdown listeners) on every
  // keystroke for no benefit.
  const draftStateRef = useRef({ open, value, emailValue, phase })
  useEffect(() => {
    draftStateRef.current = { open, value, emailValue, phase }
  }, [open, value, emailValue, phase])

  const openPopover = useCallback(() => {
    submittedThisOpenRef.current = false
    closeRequestedRef.current = false
    // Repopulate from any saved (non-expired) draft rather than always
    // starting blank — the popover is non-modal and closes on outside
    // click/Escape, so an in-progress note is easy to lose by accident.
    const draft = readDraft()
    setValue(draft?.body ?? '')
    setEmailValue(draft?.email ?? '')
    setHoneypot('')
    setErrorKind('generic')
    const cooldownUntil = readCooldownUntil()
    setPhase(cooldownUntil != null && Date.now() < cooldownUntil ? 'cooldown' : 'form')
    setClosing(false)
    setOpen(true)
    trackEvent(EVENTS.FEEDBACK_OPENED, { placement })
  }, [placement])

  const requestClose = useCallback(() => {
    // closeRequestedRef (not just the open/closing *state* check) guards
    // against a real double-fire: the document pointerdown listener and
    // this popover's onBlur can both land in the same React event batch,
    // and state reads inside that batch can be stale, letting requestClose
    // run twice for one user action (P1 2026-08-16 — was double-counting
    // feedback_dismissed). The ref updates synchronously, so the second
    // call sees it immediately regardless of batching.
    if (!open || closing || closeRequestedRef.current) return
    closeRequestedRef.current = true
    // Flush any not-yet-debounced edit synchronously before closing —
    // relying solely on the debounced write in the effect below would
    // lose up to DRAFT_WRITE_DEBOUNCE_MS of typing every time a user
    // types and immediately closes (Escape / outside click / the ×
    // button), which is a common pattern, not an edge case.
    const draftState = draftStateRef.current
    if (draftState.phase === 'form' || draftState.phase === 'error') {
      writeDraft(draftState.value, draftState.emailValue, currentRedactedPath())
    }
    if (!submittedThisOpenRef.current) trackEvent(EVENTS.FEEDBACK_DISMISSED, { placement })
    if (prefersReducedMotion()) {
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    setClosing(true)
    closeTimerRef.current = setTimeout(() => {
      setOpen(false)
      setClosing(false)
      triggerRef.current?.focus()
    }, CLOSE_ANIMATION_MS)
  }, [open, closing, placement])

  // Clicking the trigger toggles: opens when closed, closes when open —
  // the same toggle behavior the floating orb's tap gesture had.
  const togglePopover = useCallback(() => {
    if (open) requestClose()
    else openPopover()
  }, [open, requestClose, openPopover])

  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
  }, [])

  // Flush on unmount too: a contextual mount (e.g. the empty-results or
  // event-page prompt) can unmount while open if the user navigates away
  // via a route change rather than through requestClose — that path never
  // touches requestClose, so without this the debounced write in the
  // effect below gets cancelled by its own cleanup and the edit is lost
  // silently. Runs once, on final unmount only (empty dep array); reads
  // the ref rather than closed-over state so it always sees the latest
  // values regardless of when the underlying component last rendered.
  useEffect(() => () => {
    const draftState = draftStateRef.current
    if (draftState.open && (draftState.phase === 'form' || draftState.phase === 'error')) {
      writeDraft(draftState.value, draftState.emailValue, currentRedactedPath())
    }
  }, [])

  // Focus management: textarea on opening into the form (or a generic
  // error), the email field specifically when the error is about the
  // email, the popover container otherwise (success / cooldown panels
  // have no focusable field). Scroll-into-view covers the case where the
  // software keyboard is about to cover the field (spec §5).
  useEffect(() => {
    if (!open || closing) return
    // Never yank the caret out of a field the visitor is CURRENTLY typing in.
    //
    // P1 2026-08-20: handleEmailChange clears the error by setting phase back
    // to 'form' while leaving errorKind === 'invalidEmail'. Both are in this
    // effect's dependency array, so the very first keystroke after an
    // invalid-email error re-ran this effect, fell through to the
    // form/error branch, and moved focus to the TEXTAREA -- the rest of the
    // address was typed into the feedback body. Deterministic, every time.
    //
    // Every focus move this effect is actually FOR (opening the popover,
    // landing on the offending field after a failed submit, reaching the
    // success panel) happens while focus is on the trigger or the Send
    // button, never in one of the two inputs -- so gating on "the visitor is
    // mid-edit and this is not an error state" keeps all of them and drops
    // only the spurious one.
    const active = typeof document === 'undefined' ? null : document.activeElement
    const midEdit = active === textareaRef.current || active === emailInputRef.current
    if (midEdit && phase === 'form') return
    if (phase === 'error' && errorKind === 'invalidEmail') {
      emailInputRef.current?.focus()
      emailInputRef.current?.scrollIntoView({ block: 'nearest' })
    } else if (phase === 'form' || phase === 'error') {
      textareaRef.current?.focus()
      textareaRef.current?.scrollIntoView({ block: 'nearest' })
    } else {
      popoverRef.current?.focus()
    }
  }, [open, closing, phase, errorKind])

  // Mobile keyboard (spec §5): anchor to visualViewport height, not 100vh,
  // so the popover's bottom edge never sits under the on-screen keyboard.
  const [viewportMaxHeight, setViewportMaxHeight] = useState<number | null>(null)
  useEffect(() => {
    if (!open) return
    if (typeof window === 'undefined' || !window.visualViewport) return
    const vv = window.visualViewport
    const update = () => setViewportMaxHeight(Math.max(200, vv.height - 96))
    update()
    vv.addEventListener('resize', update)
    return () => vv.removeEventListener('resize', update)
  }, [open])

  // Persist the in-progress draft (body + email, never the honeypot) on a
  // short debounce while the user is actively typing — this is on top of,
  // not instead of, the synchronous flush in requestClose/unmount above,
  // so a mid-typing tab crash also loses at most DRAFT_WRITE_DEBOUNCE_MS.
  // Only while the form/error panels are actually showing the inputs.
  useEffect(() => {
    if (!open || closing) return
    if (phase !== 'form' && phase !== 'error') return
    const timer = setTimeout(() => {
      writeDraft(value, emailValue, currentRedactedPath())
    }, DRAFT_WRITE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [value, emailValue, open, closing, phase])

  // Escape closes and returns focus to the trigger. Clicking outside also
  // closes (no backdrop) — this is a non-modal popover (aria-modal="false"),
  // not a blocking dialog, so there is no hard focus trap.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose()
    }
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (popoverRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      requestClose()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, requestClose])

  // Tabbing past the last control (no hard trap) simply moves focus on;
  // when that focus lands outside the popover and the trigger, close.
  //
  // P1 2026-08-16 fix: this handler is React's onBlur (native `focusout`),
  // which bubbles from whichever child actually had focus (the textarea,
  // in practice). Clicking any NON-focusable spot inside the popover — the
  // heading, the helper text, the counter row, plain padding — blurs that
  // child with `relatedTarget === null`, because focus goes nowhere, not
  // because it left the popover. The old `next && (...)` guard treated a
  // null relatedTarget as "definitely outside" and closed anyway,
  // silently destroying whatever the visitor had typed on every such
  // click — reproduced live and root-caused via GA4 (see project memory
  // "feedback dialog blur close P1"). A null relatedTarget must be a
  // no-op here: real outside clicks are already handled by the document
  // `pointerdown` listener above, so this handler only needs to act when
  // focus visibly moved somewhere identifiable.
  const onPopoverBlur = useCallback((e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null
    if (!next) return
    if (popoverRef.current?.contains(next) || triggerRef.current?.contains(next)) return
    requestClose()
  }, [requestClose])

  const remaining = MAX_LEN - value.length
  const showCounter = remaining <= COUNTER_THRESHOLD

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    if (phase === 'error' && errorKind === 'empty') setPhase('form')
  }

  const handleEmailChange = (e: ChangeEvent<HTMLInputElement>) => {
    setEmailValue(e.target.value)
    if (phase === 'error' && errorKind === 'invalidEmail') setPhase('form')
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmedBody = value.trim()
    if (!trimmedBody) {
      setErrorKind('empty')
      setPhase('error')
      return
    }

    // Honeypot: a real visitor never fills this hidden field. Silently
    // fake success without touching the database — indistinguishable from
    // a real submission to whatever filled it in. The draft is
    // deliberately left untouched on this path (see clearDraft() below,
    // only reached on a confirmed real insert).
    if (honeypot) {
      submittedThisOpenRef.current = true
      setPhase('success')
      return
    }

    const trimmedEmail = emailValue.trim().slice(0, EMAIL_MAX_LEN)
    if (trimmedEmail && !isPlausibleEmail(trimmedEmail)) {
      setErrorKind('invalidEmail')
      setPhase('error')
      return
    }

    // The page the note was STARTED on, which is not necessarily the page
    // the visitor is standing on when they press Send: drafts survive
    // navigation on purpose, and page_path is the field triage sorts by.
    // Falls back to the current path when there is no stored draft (typed
    // and sent inside the write debounce), which is the same page anyway.
    const originPath = readDraft()?.pagePath || currentRedactedPath()

    setSubmitting(true)
    try {
      const payload = {
        // 'orb' is a fixed DB/RLS contract (migration 043's category CHECK
        // constraint and anon-insert policy, plus AdminFeedbackPage's
        // `.eq('category', 'orb')` filter) — not a UI label. It stays
        // literal even though the surface itself is no longer a floating
        // orb; changing it would need a migration, out of scope here.
        category: 'orb',
        body: trimmedBody,
        // Already redacted at capture time (P1-13): feedback sent from
        // /d/<code> would otherwise persist a live day-plan bearer
        // credential into feedback_posts -- same fix as trackPageView's,
        // same reason. See currentRedactedPath / the draft's pagePath.
        page_path: originPath,
        is_private: true,
        // Optional reply-to address. No DB format constraint (migration
        // 058) — only a length cap; format validation is client-side only
        // (isPlausibleEmail, checked above). Sent as null rather than ''
        // so it always satisfies the DB's `between 1 and 254` check.
        email: trimmedEmail ? trimmedEmail : null,
      }
      const { error } = await supabase
        .from('feedback_posts')
        .insert(payload satisfies TablesInsert<'feedback_posts'>)
        // No .select(): these rows are is_private = true and unreadable by
        // anon, so a readback would return zero rows. Fire-and-forget.

      if (error) throw error

      submittedThisOpenRef.current = true
      trackEvent(EVENTS.FEEDBACK_SUBMITTED, { placement })
      const until = Date.now() + COOLDOWN_MS
      writeCooldownUntil(until)
      // Clear the draft ONLY here, on a confirmed successful DB insert —
      // never on the honeypot fake-success path above, never on error
      // (catch block below), never on a plain close.
      clearDraft()
      setPhase('success')

      // Fire the operator notification email. Deliberately not awaited —
      // true fire-and-forget, kicked off *after* the success phase is
      // already shown so it can't delay or block the success UX. The
      // .catch swallows every failure mode (missing deploy, Resend hiccup,
      // network error) since the feedback row is already saved — nothing
      // about this call should ever surface as a user-facing error.
      supabase.functions
        .invoke('notify-feedback', {
          body: {
            body: trimmedBody,
            page_path: payload.page_path,
            ...(trimmedEmail ? { email: trimmedEmail } : {}),
          },
        })
        .then(({ error: notifyError }) => {
          if (notifyError) console.warn('[feedback] notify-feedback failed', notifyError)
        })
        .catch((err) => {
          console.warn('[feedback] notify-feedback threw', err)
        })
    } catch {
      setErrorKind('generic')
      setPhase('error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="feedback-menu-wrap">
      <button
        type="button"
        ref={triggerRef}
        className={`feedback-menu-trigger${triggerClassName ? ` ${triggerClassName}` : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={togglePopover}
      >
        {triggerLabel}
      </button>

      {open && (
        <div
          ref={popoverRef}
          className={`feedback-menu-popover${align !== 'right' ? ` feedback-menu-popover--${align}` : ''}${closing ? ' closing' : ''}`}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          tabIndex={-1}
          onBlur={onPopoverBlur}
          style={viewportMaxHeight != null ? { maxHeight: viewportMaxHeight, overflowY: 'auto' } : undefined}
        >
          {phase === 'cooldown' && (
            <div className="feedback-menu-panel">
              <h2 id={headingId} className="feedback-menu-panel-heading">{COPY.heading}</h2>
              <p className="feedback-menu-panel-body" role="alert">{COPY.errorCooldown}</p>
              <div className="feedback-menu-actions">
                <button type="button" className="feedback-menu-close" aria-label={COPY.close} onClick={requestClose}>
                  ×
                </button>
              </div>
            </div>
          )}

          {phase === 'success' && (
            <div className="feedback-menu-panel" aria-live="polite">
              <div className="feedback-menu-panel-icon" aria-hidden="true">✓</div>
              <h2 id={headingId} className="feedback-menu-panel-heading">{COPY.successHeading}</h2>
              <p className="feedback-menu-panel-body">{COPY.successBody}</p>
            </div>
          )}

          {(phase === 'form' || phase === 'error') && (
            <form onSubmit={handleSubmit}>
              <h2 id={headingId} className="feedback-menu-heading">{COPY.heading}</h2>

              {/* aria-invalid + the conditional aria-describedby are on top of
                  the role="alert" error text, not a substitute for it: the
                  alert is announced once when it appears, but a screen
                  reader user who tabs BACK to the field afterwards needs the
                  field itself to report that it is invalid and to re-read
                  why. Each field only claims the error when the error is
                  actually about that field. */}
              <textarea
                ref={textareaRef}
                className={`feedback-menu-textarea${phase === 'error' && errorKind !== 'invalidEmail' ? ' has-error' : ''}`}
                aria-label={COPY.textareaLabel}
                aria-invalid={phase === 'error' && errorKind !== 'invalidEmail'}
                aria-describedby={
                  phase === 'error' && errorKind !== 'invalidEmail'
                    ? `${helperId} ${counterId} ${errorId}`
                    : `${helperId} ${counterId}`
                }
                placeholder={COPY.placeholder}
                maxLength={MAX_LEN}
                value={value}
                onChange={handleChange}
                disabled={submitting}
              />

              <p id={helperId} className="feedback-menu-helper">{COPY.helper}</p>

              <label htmlFor={emailFieldId} className="feedback-menu-email-label">
                {COPY.emailLabel}
              </label>
              <input
                ref={emailInputRef}
                id={emailFieldId}
                type="email"
                inputMode="email"
                autoComplete="email"
                className={`feedback-menu-email${phase === 'error' && errorKind === 'invalidEmail' ? ' has-error' : ''}`}
                placeholder={COPY.emailPlaceholder}
                aria-invalid={phase === 'error' && errorKind === 'invalidEmail'}
                aria-describedby={
                  phase === 'error' && errorKind === 'invalidEmail' ? errorId : undefined
                }
                maxLength={EMAIL_MAX_LEN}
                value={emailValue}
                onChange={handleEmailChange}
                disabled={submitting}
              />

              {phase === 'error' && (
                <p id={errorId} className="feedback-menu-error-text" role="alert">
                  {errorKind === 'empty'
                    ? COPY.errorEmpty
                    : errorKind === 'invalidEmail'
                      ? COPY.errorInvalidEmail
                      : COPY.errorGeneric}
                </p>
              )}

              <div className="feedback-menu-footer-row">
                <span id={counterId} className="feedback-menu-counter-slot" aria-live="polite">
                  {showCounter && (
                    <span className={`feedback-menu-counter${remaining <= COUNTER_DANGER ? ' danger' : ''}`}>
                      {remaining} left
                    </span>
                  )}
                </span>
              </div>

              {/* Honeypot: real visitors never see or fill this. Off-screen,
                  not tab-reachable, and hidden from assistive tech. */}
              <input
                type="text"
                name="website"
                className="feedback-menu-honeypot"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                value={honeypot}
                onChange={(e) => setHoneypot(e.target.value)}
              />

              <div className="feedback-menu-actions">
                <button
                  type="submit"
                  className="feedback-menu-send"
                  disabled={!value.trim() || submitting}
                >
                  {submitting ? COPY.sending : COPY.send}
                </button>
                <button type="button" className="feedback-menu-close" aria-label={COPY.close} onClick={requestClose}>
                  ×
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  )
}
