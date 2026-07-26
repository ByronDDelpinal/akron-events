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
import { useLocation } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import type { TablesInsert } from '@/lib/database.types'
import { trackEvent, EVENTS } from '@/lib/analytics'
import { useFeedbackOrbDrag } from '@/hooks/useFeedbackOrbDrag'
import {
  MAX_LEN,
  COOLDOWN_MS,
  prefersReducedMotion,
  readCooldownUntil,
  writeCooldownUntil,
} from '@/lib/feedbackOrb'
import './FeedbackOrb.css'

type Phase = 'form' | 'success' | 'error' | 'cooldown'
type ErrorKind = 'generic' | 'empty'

const COUNTER_THRESHOLD = 100
const COUNTER_DANGER = 20
const CLOSE_ANIMATION_MS = 150 // matches --transition-medium

/**
 * Copy — from docs/feedback-orb-design-spec.md §3. Verbatim except for two
 * strings whose spec text uses an em dash: the repo-wide "no em dashes in
 * user-facing copy" rule (and this task's own instructions) overrides the
 * spec's literal punctuation there. Wording/meaning is unchanged, only the
 * dash is swapped for a colon / period. See the deviations note in the
 * handoff report.
 */
const COPY = {
  orbLabel: 'Send feedback',
  heading: 'Share your thoughts',
  textareaLabel: 'Your feedback',
  placeholder: "Tell us anything: what's working, what's broken, or what you wish this site did.",
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

export default function FeedbackOrb() {
  const { pathname } = useLocation()

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
  const orbButtonRef = useRef<HTMLButtonElement | null>(null)

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
    trackEvent(EVENTS.FEEDBACK_OPENED)
  }, [])

  const requestClose = useCallback(() => {
    if (!open || closing) return
    if (!submittedThisOpenRef.current) trackEvent(EVENTS.FEEDBACK_DISMISSED)
    if (prefersReducedMotion()) {
      setOpen(false)
      orbButtonRef.current?.focus()
      return
    }
    setClosing(true)
    closeTimerRef.current = setTimeout(() => {
      setOpen(false)
      setClosing(false)
      orbButtonRef.current?.focus()
    }, CLOSE_ANIMATION_MS)
  }, [open, closing])

  // Tapping the orb toggles: opens when closed, closes when open.
  const togglePopover = useCallback(() => {
    if (open) requestClose()
    else openPopover()
  }, [open, requestClose, openPopover])

  const { corner, style: dragStyle, dragging, handlers } = useFeedbackOrbDrag(togglePopover)

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
  // The CSS corner anchoring already opens the popover upward from a
  // bottom corner; this clamps its max height to whatever of the viewport
  // is actually still visible once the keyboard has resized it.
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

  // Escape closes and returns focus to the orb. Clicking outside also
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
      if (orbButtonRef.current?.contains(target)) return
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
  // when that focus lands outside the popover and the orb, close.
  const onPopoverBlur = useCallback((e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null
    if (next && (popoverRef.current?.contains(next) || orbButtonRef.current?.contains(next))) return
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
        category: 'orb',
        body: trimmed,
        page_path: typeof window === 'undefined' ? '' : window.location.pathname,
        is_private: true,
      }
      const { error } = await supabase
        .from('feedback_posts')
        .insert(payload satisfies TablesInsert<'feedback_posts'>)
        // No .select(): orb rows are is_private = true and unreadable by
        // anon, so a readback would return zero rows. Fire-and-forget.

      if (error) throw error

      submittedThisOpenRef.current = true
      trackEvent(EVENTS.FEEDBACK_SUBMITTED)
      const until = Date.now() + COOLDOWN_MS
      writeCooldownUntil(until)
      setPhase('success')

      // Fire the operator notification email. Deliberately not awaited —
      // this is a true fire-and-forget, same intent as SubmitPage's call to
      // notify-pending-event, but here it's kicked off *after* the success
      // phase is already shown so it can't delay or block the success UX.
      // The .catch swallows every failure mode (missing deploy, Resend
      // hiccup, network error) since the feedback row is already saved —
      // nothing about this call should ever surface as a user-facing error.
      supabase.functions
        .invoke('notify-feedback', {
          body: {
            body: trimmed,
            page_path: payload.page_path,
          },
        })
        .then(({ error: notifyError }) => {
          if (notifyError) console.warn('[feedback-orb] notify-feedback failed', notifyError)
        })
        .catch((err) => {
          console.warn('[feedback-orb] notify-feedback threw', err)
        })
    } catch {
      setErrorKind('generic')
      setPhase('error')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Route-based hiding (spec §1 / plan §4) ───────────────────────────
  // Both hooks above must run on every render regardless of route — React
  // requires hooks to run in the same order every render — so the guard is
  // a plain boolean computed after all hooks, evaluated just before JSX.
  // This mirrors how InstallPrompt (the pattern this component follows)
  // actually implements the same /embed + /admin guard.
  const hidden = pathname.startsWith('/embed') || pathname.startsWith('/admin')
  if (hidden) return null

  return (
    <div
      className={`feedback-orb-wrap${dragging ? ' dragging' : ''}${submitting ? ' submitting' : ''}`}
      data-corner={corner}
      style={dragStyle}
    >
      <button
        type="button"
        ref={orbButtonRef}
        className="feedback-orb"
        aria-label={COPY.orbLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        {...handlers}
      >
        <svg className="feedback-orb-ekg" viewBox="0 0 32 16" aria-hidden="true">
          <path className="ekg-base" pathLength={100} d="M0 8 H9 L12 2 L15 14 L18 8 H32" />
          <path className="ekg-sweep" pathLength={100} d="M0 8 H9 L12 2 L15 14 L18 8 H32" />
        </svg>
      </button>

      {open && (
        <div
          ref={popoverRef}
          className={`feedback-orb-popover${closing ? ' closing' : ''}`}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          tabIndex={-1}
          onBlur={onPopoverBlur}
          style={viewportMaxHeight != null ? { maxHeight: viewportMaxHeight, overflowY: 'auto' } : undefined}
        >
          {phase === 'cooldown' && (
            <div className="feedback-orb-panel">
              <h2 id={headingId} className="feedback-orb-panel-heading">{COPY.heading}</h2>
              <p className="feedback-orb-panel-body" role="alert">{COPY.errorCooldown}</p>
              <div className="feedback-orb-actions">
                <button type="button" className="feedback-orb-close" aria-label={COPY.close} onClick={requestClose}>
                  ×
                </button>
              </div>
            </div>
          )}

          {phase === 'success' && (
            <div className="feedback-orb-panel" aria-live="polite">
              <div className="feedback-orb-panel-icon" aria-hidden="true">✓</div>
              <h2 id={headingId} className="feedback-orb-panel-heading">{COPY.successHeading}</h2>
              <p className="feedback-orb-panel-body">{COPY.successBody}</p>
            </div>
          )}

          {(phase === 'form' || phase === 'error') && (
            <form onSubmit={handleSubmit}>
              <h2 id={headingId} className="feedback-orb-heading">{COPY.heading}</h2>

              <textarea
                ref={textareaRef}
                className={`feedback-orb-textarea${phase === 'error' ? ' has-error' : ''}`}
                aria-label={COPY.textareaLabel}
                aria-describedby={`${helperId} ${counterId}`}
                placeholder={COPY.placeholder}
                maxLength={MAX_LEN}
                value={value}
                onChange={handleChange}
                disabled={submitting}
              />

              <p id={helperId} className="feedback-orb-helper">{COPY.helper}</p>

              {phase === 'error' && (
                <p className="feedback-orb-error-text" role="alert">
                  {errorKind === 'empty' ? COPY.errorEmpty : COPY.errorGeneric}
                </p>
              )}

              <div className="feedback-orb-footer-row">
                <span id={counterId} className="feedback-orb-counter-slot" aria-live="polite">
                  {showCounter && (
                    <span className={`feedback-orb-counter${remaining <= COUNTER_DANGER ? ' danger' : ''}`}>
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
                className="feedback-orb-honeypot"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                value={honeypot}
                onChange={(e) => setHoneypot(e.target.value)}
              />

              <div className="feedback-orb-actions">
                <button
                  type="submit"
                  className="feedback-orb-send"
                  disabled={!value.trim() || submitting}
                >
                  {submitting ? COPY.sending : COPY.send}
                </button>
                <button type="button" className="feedback-orb-close" aria-label={COPY.close} onClick={requestClose}>
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
