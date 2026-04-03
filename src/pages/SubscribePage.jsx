import { useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { INTENTS } from '@/lib/intents'
import { EMAIL_THEME } from '@/lib/emailTheme'
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
  const [selectedIntents, setSelectedIntents] = useState(['all'])
  const [frequency, setFrequency]   = useState('weekly')
  const [lookahead, setLookahead]   = useState(7)
  const [status, setStatus]         = useState(null) // null | 'submitting' | 'success' | 'error'
  const [error, setError]           = useState(null)
  const [magicLinkMode, setMagicLinkMode] = useState(false)
  const [magicEmail, setMagicEmail] = useState('')
  const [magicStatus, setMagicStatus] = useState(null)

  /* ── Intent selection ── */
  const toggleIntent = (id) => {
    if (id === 'all') {
      setSelectedIntents(['all'])
      return
    }
    const without = selectedIntents.filter(i => i !== 'all' && i !== id)
    const next = selectedIntents.includes(id) ? without : [...without, id]
    setSelectedIntents(next.length === 0 ? ['all'] : next)
  }

  /* ── Frequency changes auto-update lookahead ── */
  const changeFrequency = (freq) => {
    setFrequency(freq)
    const match = FREQUENCIES.find(f => f.id === freq)
    if (match) setLookahead(match.lookahead)
  }

  /* ── Submit ── */
  const handleSubmit = async (e) => {
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
    } catch (err) {
      console.error('Subscribe error:', err)
      setError('Something went wrong. Please try again.')
      setStatus(null)
    }
  }

  /* ── Magic link request ── */
  const handleMagicLink = async (e) => {
    e.preventDefault()
    if (!magicEmail.trim() || !magicEmail.includes('@')) return
    setMagicStatus('sending')

    try {
      await supabase.functions.invoke('subscribe', {
        body: {
          email: magicEmail.trim(),
          resend_confirmation: true,
        },
      })
      // Always show sent — don't reveal whether email exists
      setMagicStatus('sent')
    } catch {
      setMagicStatus('sent') // fail silently for privacy
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
      {/* ── Hero messaging ── */}
      <h1 className="page-title subscribe-title">
        Get {EMAIL_THEME.brandName} in your inbox
      </h1>
      <p className="page-sub subscribe-sub">
        No password, no account — just the events you care about, delivered on your schedule.
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
            onChange={e => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
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
          {INTENTS.map(intent => (
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
          {FREQUENCIES.map(f => (
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
          {LOOKAHEADS.map(l => (
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
          where you can fine-tune everything — categories, specific venues,
          price range, and more. No password needed, ever. Not now, not later.
        </p>
      </form>

      {/* ── Already subscribed? ── */}
      <div className="subscribe-existing">
        {!magicLinkMode ? (
          <p className="subscribe-existing-text">
            Already subscribed?{' '}
            <button className="link-btn" onClick={() => setMagicLinkMode(true)}>
              Get a link to your preference center
            </button>
          </p>
        ) : (
          <form onSubmit={handleMagicLink} className="magic-link-form">
            <p className="magic-link-label">
              Enter your email and we'll send a link to your preference center.
            </p>
            <div className="magic-link-row">
              <input
                className="form-input magic-link-input"
                type="email"
                placeholder="you@example.com"
                value={magicEmail}
                onChange={e => setMagicEmail(e.target.value)}
                required
              />
              <button
                type="submit"
                className="btn-submit-form magic-link-btn"
                disabled={magicStatus === 'sending'}
              >
                {magicStatus === 'sending' ? 'Sending…' : 'Send link'}
              </button>
            </div>
            {magicStatus === 'sent' && (
              <p className="magic-link-sent">
                If that email is subscribed, a link is on its way. Check your inbox!
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  )
}
