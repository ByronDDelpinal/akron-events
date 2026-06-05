import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HelmetProvider } from 'react-helmet-async'
import App from './App'
import { initAnalytics } from './lib/analytics'

initAnalytics()

// Take manual control of scroll restoration so our sessionStorage-based
// save/restore (in App.jsx) is the single source of truth. Without this
// the browser's built-in 'auto' restoration fires before async content
// (events from Supabase) has loaded, silently failing to reach the
// target position and leaving the page at the top.
if (typeof window !== 'undefined') {
  window.history.scrollRestoration = 'manual'
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HelmetProvider>
      <App />
    </HelmetProvider>
  </StrictMode>
)
