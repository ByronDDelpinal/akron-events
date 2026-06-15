import { registerSW } from 'virtual:pwa-register'

/**
 * Service-worker registration + active update polling.
 *
 * The app uses Workbox `autoUpdate`: a freshly deployed SW skip-waits and the
 * page reloads to it automatically. The catch is *when the browser notices* a
 * new SW — by default only on navigation, and at most once every ~24h. A PWA
 * that's left open, or an iOS standalone app resumed from suspension, can go
 * far longer than a day without ever checking, pinning users to a stale shell.
 *
 * So we poll `registration.update()`:
 *   • on a timer (bounds shell staleness to UPDATE_INTERVAL_MS), and
 *   • whenever the tab/app becomes visible (the only reliable hook on iOS
 *     standalone), and when connectivity returns.
 *
 * `update()` is a cheap conditional GET of sw.js — a 304 when nothing changed,
 * so polling costs almost nothing and only triggers a reload right after an
 * actual deploy.
 */
const UPDATE_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
// Floor between checks: the timer is already hour-spaced, but the visibility /
// online triggers can fire in bursts (rapid tab switching), so coalesce them so
// we never re-fetch sw.js more than once per this window.
const MIN_CHECK_GAP_MS = 5 * 60 * 1000 // 5 minutes

export function registerPwa(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return

  registerSW({
    immediate: true,
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return

      let lastCheck = 0
      const checkForUpdate = () => {
        if (!navigator.onLine) return // offline: update() would just fail
        const now = Date.now()
        if (now - lastCheck < MIN_CHECK_GAP_MS) return // throttle bursty triggers
        lastCheck = now
        registration.update().catch(() => { /* transient; next trigger retries */ })
      }

      setInterval(checkForUpdate, UPDATE_INTERVAL_MS)

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate()
      })
      window.addEventListener('online', checkForUpdate)
    },
  })
}
