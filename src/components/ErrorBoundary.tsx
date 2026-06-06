/**
 * ErrorBoundary — Top-level React error boundary.
 *
 * Catches render-time JavaScript errors in the component tree and shows a
 * graceful fallback instead of a blank screen. Without this, any unhandled
 * render error empties the page entirely.
 *
 * Usage (in main.tsx):
 *   <ErrorBoundary>
 *     <App />
 *   </ErrorBoundary>
 *
 * React requires error boundaries to be class components — there is no
 * hook-based equivalent for `componentDidCatch`.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Optional custom fallback. Receives the error for display. */
  fallback?: (error: Error) => ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log to console in development; wire to Sentry / LogRocket in production.
    console.error('[ErrorBoundary] Uncaught render error:', error, info.componentStack)
  }

  handleReset = () => {
    this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    const { children, fallback } = this.props

    if (error) {
      if (fallback) return fallback(error)

      return (
        <div
          role="alert"
          style={{
            display:       'flex',
            flexDirection: 'column',
            alignItems:    'center',
            justifyContent:'center',
            minHeight:     '60vh',
            padding:       '2rem',
            textAlign:     'center',
            fontFamily:    'system-ui, sans-serif',
          }}
        >
          <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>
            Something went wrong
          </h1>
          <p style={{ color: '#666', marginBottom: '1.5rem', maxWidth: '36ch' }}>
            An unexpected error occurred. Refreshing the page usually fixes it.
          </p>
          <button
            onClick={this.handleReset}
            style={{
              padding:      '0.5rem 1.25rem',
              borderRadius: '0.375rem',
              border:       '1px solid #d1d5db',
              background:   'white',
              cursor:       'pointer',
              fontSize:     '0.875rem',
            }}
          >
            Try again
          </button>
          {import.meta.env.DEV && (
            <pre
              style={{
                marginTop:  '1.5rem',
                padding:    '1rem',
                background: '#fef2f2',
                border:     '1px solid #fecaca',
                borderRadius:'0.375rem',
                fontSize:   '0.75rem',
                textAlign:  'left',
                maxWidth:   '60ch',
                overflow:   'auto',
                color:      '#b91c1c',
              }}
            >
              {error.message}
              {'\n'}
              {error.stack}
            </pre>
          )}
        </div>
      )
    }

    return children
  }
}
