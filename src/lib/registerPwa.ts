import { registerSW } from 'virtual:pwa-register'

/**
 * Register the cache-free service worker (src/sw.js).
 *
 * Keeps the app installable while caching nothing, so deploys are always live.
 * There's no precache to poll for freshness anymore — the SW itself guarantees
 * it — so registration is all we do here. `autoUpdate` activates a new SW on
 * deploy; our SW skip-waits, claims clients, and clears any old caches.
 */
export function registerPwa(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
  registerSW({ immediate: true })
}
