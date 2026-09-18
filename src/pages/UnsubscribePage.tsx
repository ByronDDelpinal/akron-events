import { useState, useEffect } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { EMAIL_THEME } from '@/lib/emailTheme'
import { SEO } from '@/lib/seo'
import './UnsubscribePage.css'

type Status = 'no-token' | 'processing' | 'done' | 'error'

export default function UnsubscribePage() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const [status, setStatus] = useState<Status>(token ? 'processing' : 'no-token')

  // Private user flow — explicitly noindex.
  const seo = <SEO title="Unsubscribe" path="/unsubscribe" noindex />

  useEffect(() => {
    if (!token) return

    const unsubscribe = async () => {
      // The function answers 200 for applied, already-unsubscribed AND
      // unknown-token alike, on purpose: the response must not reveal whether
      // a token is valid. So success here means "the request was processed",
      // not "that token existed", and showing the goodbye screen is correct.
      //
      // What we must NOT do is show it when the request genuinely failed.
      // Until 2026-09-17 this caught every error and rendered success anyway,
      // so a subscriber whose unsubscribe never landed was told it had — and
      // their next move is Report Spam. A 503 or a transport failure now
      // surfaces honestly.
      try {
        const { error } = await supabase.functions.invoke('unsubscribe', {
          body: { token },
        })
        setStatus(error ? 'error' : 'done')
      } catch {
        setStatus('error')
      }
    }

    unsubscribe()
  }, [token])

  if (status === 'no-token') {
    return (
      <div className="page-shell unsub-shell">
        {seo}
        <div className="unsub-box">
          <h1 className="page-title">Unsubscribe</h1>
          <p className="page-sub">
            This link doesn't look right. If you're trying to unsubscribe,
            use the link in any email we've sent you.
          </p>
        </div>
      </div>
    )
  }

  if (status === 'processing') {
    return (
      <div className="page-shell unsub-shell">
        {seo}
        <div className="unsub-box">
          <div className="unsub-spinner" />
          <p className="unsub-processing">Unsubscribing…</p>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="page-shell unsub-shell">
        {seo}
        <div className="unsub-box">
          <div className="unsub-icon">⚠️</div>
          <h1 className="unsub-title">That didn't go through</h1>
          <p className="unsub-text">
            Something on our end failed, so you are still subscribed. Please
            try the link again in a moment — or email{' '}
            <a href={`mailto:${EMAIL_THEME.email.replyTo}?subject=Unsubscribe`}>
              {EMAIL_THEME.email.replyTo}
            </a>{' '}
            and we'll take you off the list by hand.
          </p>
          <Link to="/" className="unsub-home-link">
            Back to {EMAIL_THEME.brandName}
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="page-shell unsub-shell">
      {seo}
      <div className="unsub-box">
        <div className="unsub-icon">👋</div>
        <h1 className="unsub-title">You've been unsubscribed</h1>
        <p className="unsub-text">
          If you ever want to come back, you can re-subscribe anytime.
          We hope to see you again.
        </p>
        <Link to="/subscribe" className="btn-submit-form unsub-resubscribe">
          Re-subscribe
        </Link>
        <Link to="/" className="unsub-home-link">
          Back to {EMAIL_THEME.brandName}
        </Link>
      </div>
    </div>
  )
}
