import { useState, useEffect } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { EMAIL_THEME } from '@/lib/emailTheme'
import './UnsubscribePage.css'

export default function UnsubscribePage() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const [status, setStatus] = useState(token ? 'processing' : 'no-token')

  useEffect(() => {
    if (!token) return

    const unsubscribe = async () => {
      try {
        await supabase.functions.invoke('unsubscribe', {
          body: { token },
        })
        // Always show success — idempotent, don't reveal token validity
        setStatus('done')
      } catch {
        setStatus('done') // still show success for privacy
      }
    }

    unsubscribe()
  }, [token])

  if (status === 'no-token') {
    return (
      <div className="page-shell unsub-shell">
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
        <div className="unsub-box">
          <div className="unsub-spinner" />
          <p className="unsub-processing">Unsubscribing…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page-shell unsub-shell">
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
