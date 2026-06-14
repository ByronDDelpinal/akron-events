import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HelmetProvider } from 'react-helmet-async'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initAnalytics, trackEvent, EVENTS } from './lib/analytics'
import { isStandalone, isIos } from './hooks/usePwaInstall'

initAnalytics()

// Count one standalone (installed-app) launch per session. This is the
// reliable signal that someone installed the PWA — and the ONLY signal on
// iOS, where the Add-to-Home-Screen flow fires no install event. Session-
// scoped so we measure launches, not in-app navigations.
if (typeof window !== 'undefined' && isStandalone()) {
  try {
    if (!sessionStorage.getItem('akronpulse.standalone_launch_counted')) {
      sessionStorage.setItem('akronpulse.standalone_launch_counted', '1')
      trackEvent(EVENTS.PWA_STANDALONE_LAUNCH, { platform: isIos() ? 'ios' : 'other' })
    }
  } catch { /* storage unavailable: skip the launch ping */ }
}

// Take manual control of scroll restoration so our sessionStorage-based
// save/restore (in App.tsx) is the single source of truth. Without this
// the browser's built-in 'auto' restoration fires before async content
// (events from Supabase) has loaded, silently failing to reach the
// target position and leaving the page at the top.
if (typeof window !== 'undefined') {
  window.history.scrollRestoration = 'manual'
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <HelmetProvider>
        <App />
      </HelmetProvider>
    </ErrorBoundary>
  </StrictMode>
)
