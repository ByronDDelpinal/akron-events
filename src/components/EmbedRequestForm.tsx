import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { Json } from '@/lib/database.types'
import { trackEvent, EVENTS } from '@/lib/analytics'
import type { EmbedRequestFailure } from '@/lib/analyticsEvents'
import type { EmbedFeature, EmbedPrice, EmbedDate, EmbedView, EmbedDensity, EmbedTarget } from '@/lib/embedConfig'
import {
  COOLDOWN_MS,
  readCooldownUntil,
  writeCooldownUntil,
  isValidEmail,
  normalizeWebsite,
  NAME_MAX_LEN,
  ORGANIZATION_MAX_LEN,
  WEBSITE_MAX_LEN,
  NOTE_MAX_LEN,
} from '@/lib/embedRequest'
import { prefersReducedMotion } from '@/lib/feedback'
import './EmbedRequestForm.css'

// Mirrors EmbedBuilderPage.tsx's BuilderState shape (imported there from
// src/lib/embedParams.ts) — the exact submitted config this form persists
// verbatim as `embed_requests.config` jsonb. Declared structurally here
// (rather than importing BuilderState) so this component has no dependency
// on the page module beyond the prop it's handed.
export interface EmbedRequestConfig {
  title: string
  theme: string
  place: string
  categories: string[]
  price: EmbedPrice | ''
  date: EmbedDate | ''
  family: boolean
  features: Record<EmbedFeature, boolean>
  view: EmbedView
  density: EmbedDensity
  target: EmbedTarget
}

// TODO(remove after Supabase regenerates src/lib/database.types.ts following
// migration 051): `embed_requests` is not in the generated Database type
// yet, so the typed client's `.from()` rejects the table name at compile
// time. This narrow local type mirrors exactly the columns the client
// writes — same pattern FeedbackDialog.tsx's
// `payload satisfies TablesInsert<'feedback_posts'>` follows, adapted here
// because the generated type doesn't exist for this table yet. Swap for
// `TablesInsert<'embed_requests'>` once regenerated, and drop the
// `untypedSupabase` cast below along with it.
interface EmbedRequestInsert {
  id: string
  name: string
  email: string
  organization: string
  website: string | null
  note: string | null
  config: Json
}

// Same reasoning as EmbedRequestInsert above: `.from('embed_requests')`
// needs an untyped client until the generated Database type includes the
// table. SupabaseClient defaults its Database generic to `any`, so this
// cast narrowly loosens ONLY the `.from()` call site below — every field
// still going onto the wire is checked against EmbedRequestInsert via the
// `satisfies` assertion at the insert call site.
const untypedSupabase = supabase as unknown as SupabaseClient

type Phase = 'idle' | 'open' | 'submitting' | 'success' | 'error' | 'cooldown'

interface FieldErrors {
  name?: string
  email?: string
  organization?: string
  website?: string
}

const COPY = {
  cta: 'Request this embed',
  heading: 'Tell us about your site',
  helper: "We'll email you if it's a fit, usually within a few days.",
  send: 'Send request',
  sending: 'Sending…',
  successHeading: 'Request received.',
  successBody: "Byron reviews every embed personally, usually within a few days. If it's a fit, you'll get an email with your calendar code, ready to paste.",
  errorGeneric: 'Something went wrong. You can also email byron@akronpulse.com.',
  cooldown: 'Thanks. Give it a moment before sending another.',
}

interface EmbedRequestFormProps {
  /** The submitted BuilderState, persisted verbatim as `config` jsonb. */
  config: EmbedRequestConfig
}

/**
 * The "request an embed" form. NON-NEGOTIABLE (docs/embed-request-capture.md
 * §5.4 + the maintainer's own instructions): the visitor is NEVER shown the
 * embed URL or the snippet here — not on success, not in a toast, not
 * anywhere in the DOM. This component has no copy button and no preview
 * link by design. Do not "helpfully" add one; the server-rendered email/
 * Slack message is the only place the snippet is ever surfaced, and only to
 * the maintainer, after manual review.
 */
export default function EmbedRequestForm({ config }: EmbedRequestFormProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [organization, setOrganization] = useState('')
  const [website, setWebsite] = useState('')
  const [note, setNote] = useState('')
  const [honeypot, setHoneypot] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [triedSubmit, setTriedSubmit] = useState(false)

  const openedTrackedRef = useRef(false)
  const formRef = useRef<HTMLFormElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  const headingId = useId()

  const checkCooldown = useCallback((): boolean => {
    const until = readCooldownUntil()
    if (until != null && Date.now() < until) {
      setPhase('cooldown')
      trackEvent(EVENTS.EMBED_REQUEST_FAILED, { reason: 'cooldown' satisfies EmbedRequestFailure })
      return true
    }
    return false
  }, [])

  const handleOpen = useCallback(() => {
    if (checkCooldown()) return
    setPhase('open')
    if (!openedTrackedRef.current) {
      openedTrackedRef.current = true
      trackEvent(EVENTS.EMBED_REQUEST_OPENED)
    }
  }, [checkCooldown])

  useEffect(() => {
    if (phase !== 'open' && phase !== 'error') return
    const raf = requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({
        block: 'nearest',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      })
      nameRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [phase])

  const validate = useCallback((): FieldErrors => {
    const next: FieldErrors = {}
    const trimmedName = name.trim()
    const trimmedOrg = organization.trim()

    if (!trimmedName) next.name = 'Your name is required.'
    else if (trimmedName.length > NAME_MAX_LEN) next.name = `Keep it under ${NAME_MAX_LEN} characters.`

    if (!email.trim()) next.email = 'Email is required.'
    else if (!isValidEmail(email.trim())) next.email = 'Enter a valid email address.'

    if (!trimmedOrg) next.organization = 'Organization is required.'
    else if (trimmedOrg.length > ORGANIZATION_MAX_LEN) next.organization = `Keep it under ${ORGANIZATION_MAX_LEN} characters.`

    if (website.trim() && normalizeWebsite(website) === null) {
      next.website = 'Enter a valid web address, or leave this blank.'
    } else if (website.trim().length > WEBSITE_MAX_LEN) {
      next.website = `Keep it under ${WEBSITE_MAX_LEN} characters.`
    }

    return next
  }, [name, email, organization, website])

  const handleBlur = useCallback(() => {
    if (!triedSubmit) return
    setErrors(validate())
  }, [triedSubmit, validate])

  const lockedFilterCount = (): number =>
    [config.place, config.categories.length > 0, config.price, config.date, config.family].filter(Boolean).length

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()

    // Honeypot: a real visitor never fills this hidden field. Silently
    // fake success without touching the database — indistinguishable from
    // a real submission to whatever filled it in. Deliberately NOT named
    // "website": this form has a REAL website field, and browser autofill
    // would otherwise fill a field literally named "website" for a
    // legitimate visitor, silently swallowing real requests.
    if (honeypot) {
      setPhase('success')
      return
    }

    if (checkCooldown()) return

    setTriedSubmit(true)
    const fieldErrors = validate()
    setErrors(fieldErrors)
    if (Object.keys(fieldErrors).length > 0) {
      trackEvent(EVENTS.EMBED_REQUEST_FAILED, { reason: 'validation' satisfies EmbedRequestFailure })
      return
    }

    setPhase('submitting')

    const id = crypto.randomUUID()
    const normalizedWebsite = website.trim() ? normalizeWebsite(website) : null
    const payload = {
      id,
      name: name.trim(),
      email: email.trim(),
      organization: organization.trim(),
      website: normalizedWebsite,
      note: note.trim() ? note.trim().slice(0, NOTE_MAX_LEN) : null,
      config: config as unknown as Json,
    } satisfies EmbedRequestInsert

    // No .select(): there is no anon SELECT policy on embed_requests (the
    // client's insert is fire-and-forget, same contract as
    // FeedbackDialog.tsx's feedback_posts insert), so a readback would
    // return zero rows.
    const { error } = await untypedSupabase.from('embed_requests').insert(payload)

    if (error) {
      setPhase('error')
      trackEvent(EVENTS.EMBED_REQUEST_FAILED, { reason: 'insert' satisfies EmbedRequestFailure })
      return
    }

    setPhase('success')
    trackEvent(EVENTS.EMBED_REQUEST_SUBMITTED, { theme: config.theme, locked_filters: lockedFilterCount() })
    writeCooldownUntil(Date.now() + COOLDOWN_MS)

    // Fire the operator notification. Deliberately not awaited — kicked off
    // AFTER the success state is already shown, so it can never delay or
    // block the success UX. The row is already saved; a notifier failure
    // must never surface to the visitor.
    supabase.functions
      .invoke('notify-embed-request', { body: { request_id: id } })
      .then(({ error: notifyError }) => {
        if (notifyError) console.warn('[embed request] notify-embed-request failed', notifyError)
      })
      .catch((err) => {
        console.warn('[embed request] notify-embed-request threw', err)
      })
  }

  const handleRetry = useCallback(() => {
    setPhase('open')
  }, [])

  // success REPLACES the form entirely (docs/embed-request-capture.md §5.4)
  // — the CTA button is gone too, not just the fields.
  if (phase === 'success') {
    return (
      <div className="embed-request-panel embed-request-panel--success" aria-live="polite">
        <div className="embed-request-panel-icon" aria-hidden="true">✓</div>
        <p className="embed-request-panel-heading">{COPY.successHeading}</p>
        <p>{COPY.successBody}</p>
        {/* Explicitly NOT shown here: no snippet, no embed URL, no copy
            button, no "preview link." This is the requirement — see this
            component's own docstring. */}
      </div>
    )
  }

  const submitting = phase === 'submitting'
  const expanded = phase !== 'idle'

  return (
    <div className="embed-request-wrap">
      <button type="button" className="embed-request-cta" aria-expanded={expanded} onClick={handleOpen}>
        {COPY.cta}
      </button>

      {phase === 'cooldown' && (
        <div className="embed-request-panel embed-request-panel--cooldown" role="status">
          <p>{COPY.cooldown}</p>
        </div>
      )}

      {(phase === 'open' || phase === 'submitting' || phase === 'error') && (
        <form ref={formRef} className="embed-request-form" onSubmit={handleSubmit} noValidate>
          <h3 id={headingId} className="embed-request-form-heading">{COPY.heading}</h3>

          {phase === 'error' && (
            <p className="embed-request-error-text" role="alert">{COPY.errorGeneric}</p>
          )}

          <div className="builder-field">
            <label className="builder-label" htmlFor="er-name">Your name</label>
            <input
              id="er-name"
              ref={nameRef}
              className="builder-input"
              type="text"
              maxLength={NAME_MAX_LEN}
              value={name}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
              onBlur={handleBlur}
              disabled={submitting}
              aria-invalid={!!errors.name}
              aria-describedby={errors.name ? 'er-name-error' : undefined}
              autoComplete="name"
            />
            {errors.name && <span id="er-name-error" className="embed-request-field-error">{errors.name}</span>}
          </div>

          <div className="builder-field">
            <label className="builder-label" htmlFor="er-email">Email</label>
            <input
              id="er-email"
              className="builder-input"
              type="email"
              maxLength={254}
              value={email}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
              onBlur={handleBlur}
              disabled={submitting}
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? 'er-email-error' : undefined}
              autoComplete="email"
            />
            {errors.email && <span id="er-email-error" className="embed-request-field-error">{errors.email}</span>}
          </div>

          <div className="builder-field">
            <label className="builder-label" htmlFor="er-organization">Organization</label>
            <input
              id="er-organization"
              className="builder-input"
              type="text"
              maxLength={ORGANIZATION_MAX_LEN}
              value={organization}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setOrganization(e.target.value)}
              onBlur={handleBlur}
              disabled={submitting}
              aria-invalid={!!errors.organization}
              aria-describedby={errors.organization ? 'er-organization-error' : undefined}
              autoComplete="organization"
            />
            {errors.organization && <span id="er-organization-error" className="embed-request-field-error">{errors.organization}</span>}
          </div>

          <div className="builder-field">
            <label className="builder-label" htmlFor="er-website">Website <span className="embed-request-optional">(optional)</span></label>
            <input
              id="er-website"
              className="builder-input"
              type="text"
              maxLength={WEBSITE_MAX_LEN}
              placeholder="example.org"
              value={website}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setWebsite(e.target.value)}
              onBlur={handleBlur}
              disabled={submitting}
              aria-invalid={!!errors.website}
              aria-describedby={errors.website ? 'er-website-error' : 'er-website-hint'}
              autoComplete="url"
            />
            {errors.website
              ? <span id="er-website-error" className="embed-request-field-error">{errors.website}</span>
              : <span id="er-website-hint" className="builder-hint">Where the calendar will live.</span>}
          </div>

          {/* Honeypot: real visitors never see or fill this. Off-screen,
              not tab-reachable, hidden from assistive tech. NOT named
              "website" — see the "website only becomes a link" comment in
              notify-embed-request/email.ts and this form's own
              handleSubmit. */}
          <input
            type="text"
            name="company_fax"
            className="embed-request-honeypot"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            value={honeypot}
            onChange={(e) => setHoneypot(e.target.value)}
          />

          <div className="builder-field">
            <label className="builder-label" htmlFor="er-note">Anything else we should know? <span className="embed-request-optional">(optional)</span></label>
            <textarea
              id="er-note"
              className="embed-request-textarea"
              maxLength={NOTE_MAX_LEN}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={submitting}
            />
          </div>

          <p className="embed-request-helper">{COPY.helper}</p>

          <div className="embed-request-actions">
            <button type="submit" className="embed-request-submit" disabled={submitting}>
              {submitting ? COPY.sending : COPY.send}
            </button>
            {phase === 'error' && (
              <button type="button" className="embed-request-retry" onClick={handleRetry}>
                Try again
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  )
}
