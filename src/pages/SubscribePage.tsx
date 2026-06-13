import { useState, type FormEvent } from 'react'
import { supabase } from '@/lib/supabase'
import { INTENTS } from '@/lib/intents'
import { EMAIL_THEME } from '@/lib/emailTheme'
import { SEO } from '@/lib/seo'
import { trackEvent, EVENTS } from '@/lib/analytics'
import './SubscribePage.css'

const FREQUENCIES = [
  { id: 'daily',   label: 'Daily',   lookahead: 1  },
  { id: 'weekly',  label: 'Weekly',  lookahead: 7  },
  { id: 'monthly', label: 'Monthly', lookahead: 30 },
]

const LOOKAHEADS = [
  { days: 1,  label: 'Next Day'   },
  { days: 7,  label: 'Next Week'  },
  { days: 30, label: 'Next Month' },
]

export default function SubscribePage() {
  const [email, setEmail]           = useState('')
  const [selectedIntents, setSelectedIntents] = useState<string[]>(['all'])
  const [frequency, setFrequency]   = useState('weekly')
  const [lookahead, setLookahead]   = useState(7)
  const [status, setStatus]         = useState<string | null>(null) // null | 'submitting' | 'success' | 'error'
  const [error, setError]           = useState<string | null>(null)
  const [manageStatus, setManageStatus] = useState<'idle' | 'checking' | 'sent' | 'not_found'>('idle')

  /* ── Intent selection ── */
  const toggleIntent = (id: string) => {
    if (id === 'all') {
      setSelectedIntents(['all'])
      return
    }
    const without = selectedIntents.filter((i) => i !== 'all' && i !== id)
    const next = selectedIntents.includes(id) ? without : [...without, id]
    setSelectedIntents(next.length === 0 ? ['all'] : next)
  }

  /* ── Frequency changes auto-update lookahead ── */
  const changeFrequency = (freq: string) => {
    setFrequency(freq)
    const match = FREQUENCIES.find((f) => f.id === freq)
    if (match) setLookahead(match.lookahead)
  }

  /* ── Submit ── */
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)

    if (!email.trim() || !email.includes('@')) {
      setError('Please enter a valid email address.')
      return
    }

    setStatus('submitting')

    try {
      const { data, error: fnErr } = await supabase.functions.invoke('subscribe', {
        body: {
          email: email.trim(),
          intents: selectedIntents,
          frequency,
          lookahead_days: lookahead,
        },
      })

      if (fnErr) throw fnErr
      if (data?.error) throw new Error(data.error)

      setStatus('success')

      // GA4 event: fires for every successful signup submission, BEFORE
      // confirmation. We don't include the email address — PII stays out.
      // `placement` records which on-site CTA drove the signup (set as an
      // internal ?placement= param, not UTM, so session attribution is intact).
      const placement = new URLSearchParams(window.location.search).get('placement') || 'direct'
      trackEvent(EVENTS.NEWSLETTER_SIGNUP, {
        frequency,
        placement,
        lookahead_days: lookahead,
        intents: (selectedIntents || []).join(','),
      })
    } catch (err) {
      console.error('Subscribe error:', err)
      setError('Something went wrong. Please try again.')
      setStatus(null)
    }
  }

  /* ── Manage existing subscription ── */
  const isEmailValid = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())

  const handleManageSubscription = async () => {
    if (!isEmailValid(email)) return
    setManageStatus('checking')
    setError(null)

    try {
      const { data, error: fnErr } = await supabase.functions.invoke('subscribe', {
        body: { email: email.trim(), resend_confirmation: true },
      })
      if (fnErr) throw fnErr
      setManageStatus(data?.found === false ? 'not_found' : 'sent')
    } catch {
      setManageStatus('idle')
      setError('Something went wrong. Please try again.')
    }
  }

  /* ── Success state ── */
  if (status === 'success') {
    return (
      <div className="page-shell subscribe-shell">
        <div className="success-box">
          <div className="success-icon">✉</div>
          <h2 className="success-title">Check your inbox!</h2>
          <p className="success-text">
            We sent a confirmation email to <strong>{email}</strong>.
            Click the link inside to activate your subscription and unlock your
            full preference center.
          </p>
          <p className="success-hint">
            Didn't get it? Check your spam folder, or{' '}
            <button className="link-btn" onClick={() => { setStatus(null); setEmail('') }}>
              try again
            </button>.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="page-shell subscribe-shell">
      <SEO
        title="Subscribe | Akron Events Newsletter in Your Inbox"
        description="A free digest of upcoming events in Akron and Summit County. Pick your categories and how often you want to hear from us. No spam, easy one-click unsubscribe."
        path="/subscribe"
      />
      {/* ── Hero messaging ── */}
      <h1 className="page-title subscribe-title">
        Get {EMAIL_THEME.brandName} in your inbox
      </h1>
      <p className="page-sub subscribe-sub">
        No password, no account, just the events you care about, delivered on your schedule.
      </p>

      <form onSubmit={handleSubmit} className="subscribe-form">

        {/* ── Email ── */}
        <div className="form-group">
          <label className="form-label" htmlFor="sub-email">
            Email address <span className="req">*</span>
          </label>
          <input
            id="sub-email"
            className="form-input"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setManageStatus('idle') }}
            autoComplete="email"
            required
          />
          {/* ── Manage existing subscription ── */}
          <div className="manage-sub-wrap">
            <button
              type="button"
              className={`btn-manage-sub${isEmailValid(email) ? ' btn-manage-sub-active' : ''}`}
              onClick={handleManageSubscription}
              disabled={!isEmailValid(email) || manageStatus === 'checking'}
            >
              {manageStatus === 'checking' ? 'Checking…' : 'Manage My Subscription'}
            </button>
            {manageStatus === 'sent' && (
              <p className="manage-sub-msg manage-sub-sent">
                Check your inbox! We sent a preferences link to <strong>{email}</strong>.
              </p>
            )}
            {manageStatus === 'not_found' && (
              <p className="manage-sub-msg manage-sub-not-found">
                No subscription found for that email. Fill out the form below to get started.
              </p>
            )}
          </div>
        </div>

        {/* ── Intents ── */}
        <div className="form-section-label">What are you into?</div>
        <div className="intent-grid">
          <button
            type="button"
            className={`intent-card ${selectedIntents.includes('all') ? 'intent-active' : ''}`}
            onClick={() => toggleIntent('all')}
          >
            <span className="intent-emoji">✨</span>
            <span className="intent-label">All Events</span>
          </button>
          {INTENTS.map((intent) => (
            <button
              key={intent.id}
              type="button"
              className={`intent-card ${selectedIntents.includes(intent.id) ? 'intent-active' : ''}`}
              onClick={() => toggleIntent(intent.id)}
            >
              <span className="intent-emoji">{intent.emoji}</span>
              <span className="intent-label">{intent.label}</span>
            </button>
          ))}
        </div>

        {/* ── Frequency ── */}
        <div className="form-section-label">How often?</div>
        <div className="pill-group">
          {FREQUENCIES.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`pill ${frequency === f.id ? 'pill-active' : ''}`}
              onClick={() => changeFrequency(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* ── Lookahead ── */}
        <div className="form-section-label">How far ahead?</div>
        <div className="pill-group">
          {LOOKAHEADS.map((l) => (
            <button
              key={l.days}
              type="button"
              className={`pill ${lookahead === l.days ? 'pill-active' : ''}`}
              onClick={() => setLookahead(l.days)}
            >
              {l.label}
            </button>
          ))}
        </div>

        {/* ── Error ── */}
        {error && <p className="form-error">{error}</p>}

        {/* ── Submit ── */}
        <button
          type="submit"
          className="btn-submit-form subscribe-btn"
          disabled={status === 'submitting'}
        >
          {status === 'submitting' ? 'Subscribing…' : "Subscribe — it's that easy"}
        </button>

        {/* ── Post-CTA messaging ── */}
        <p className="subscribe-fine-print">
          After confirming your email, you'll unlock your preference center
          where you can fine-tune everything: categories, specific venues,
          price range, and more. No password needed, ever.
        </p>
      </form>

    </div>
  )
}
