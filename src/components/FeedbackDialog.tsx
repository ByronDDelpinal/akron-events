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
import {
  MAX_LEN,
  COOLDOWN_MS,
  prefersReducedMotion,
  readCooldownUntil,
  writeCooldownUntil,
} from '@/lib/feedback'
import './FeedbackDialog.css'

type Phase = 'form' | 'success' | 'error' | 'cooldown'
type ErrorKind = 'generic' | 'empty'

const COUNTER_THRESHOLD = 100
const COUNTER_DANGER = 20
const CLOSE_ANIMATION_MS = 150 // matches --transition-medium

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
 */
const COPY = {
  heading: 'What would make Akron Pulse better?',
  textareaLabel: 'Your feedback',
  placeholder: 'A missing event, a wrong time, a confusing page, or something you wish this site did. Be specific if you can.',
  helper: "Your note goes straight to the small team that builds this site. Sent from the page you're on.",
  send: 'Send',
  sending: 'Sending…',
  successHeading: 'Thank you',
  successBody: 'We got your note. It goes to the people who build this site.',
  errorGeneric: 'Something went wrong. Please try again.',
  errorEmpty: 'Add a little detail first.',
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
  triggerLabel = '+Feedback',
  align = 'right',
}: FeedbackDialogProps) {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [phase, setPhase] = useState<Phase>('form')
  const [errorKind, setErrorKind] = useState<ErrorKind>('generic')
  const [honeypot, setHoneypot] = useState('')

  const submittedThisOpenRef = useRef(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const headingId = useId()
  const helperId = useId()
  const counterId = useId()

  const openPopover = useCallback(() => {
    submittedThisOpenRef.current = false
    setValue('')
    setHoneypot('')
    setErrorKind('generic')
    const cooldownUntil = readCooldownUntil()
    setPhase(cooldownUntil != null && Date.now() < cooldownUntil ? 'cooldown' : 'form')
    setClosing(false)
    setOpen(true)
    trackEvent(EVENTS.FEEDBACK_OPENED, { placement })
  }, [placement])

  const requestClose = useCallback(() => {
    if (!open || closing) return
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

  // Focus management: textarea on opening into the form, the popover
  // container otherwise (success / cooldown panels have no textarea).
  // Scroll-into-view covers the case where the software keyboard is about
  // to cover the field (spec §5).
  useEffect(() => {
    if (!open || closing) return
    if (phase === 'form' || phase === 'error') {
      textareaRef.current?.focus()
      textareaRef.current?.scrollIntoView({ block: 'nearest' })
    } else {
      popoverRef.current?.focus()
    }
  }, [open, closing, phase])

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
  const onPopoverBlur = useCallback((e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null
    if (next && (popoverRef.current?.contains(next) || triggerRef.current?.contains(next))) return
    requestClose()
  }, [requestClose])

  const remaining = MAX_LEN - value.length
  const showCounter = remaining <= COUNTER_THRESHOLD

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value)
    if (phase === 'error' && errorKind === 'empty') setPhase('form')
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) {
      setErrorKind('empty')
      setPhase('error')
      return
    }

    // Honeypot: a real visitor never fills this hidden field. Silently
    // fake success without touching the database — indistinguishable from
    // a real submission to whatever filled it in.
    if (honeypot) {
      submittedThisOpenRef.current = true
      setPhase('success')
      return
    }

    setSubmitting(true)
    try {
      const payload = {
        // 'orb' is a fixed DB/RLS contract (migration 043's category CHECK
        // constraint and anon-insert policy, plus AdminFeedbackPage's
        // `.eq('category', 'orb')` filter) — not a UI label. It stays
        // literal even though the surface itself is no longer a floating
        // orb; changing it would need a migration, out of scope here.
        category: 'orb',
        body: trimmed,
        page_path: typeof window === 'undefined' ? '' : window.location.pathname,
        is_private: true,
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
            body: trimmed,
            page_path: payload.page_path,
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

              <textarea
                ref={textareaRef}
                className={`feedback-menu-textarea${phase === 'error' ? ' has-error' : ''}`}
                aria-label={COPY.textareaLabel}
                aria-describedby={`${helperId} ${counterId}`}
                placeholder={COPY.placeholder}
                maxLength={MAX_LEN}
                value={value}
                onChange={handleChange}
                disabled={submitting}
              />

              <p id={helperId} className="feedback-menu-helper">{COPY.helper}</p>

              {phase === 'error' && (
                <p className="feedback-menu-error-text" role="alert">
                  {errorKind === 'empty' ? COPY.errorEmpty : COPY.errorGeneric}
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
