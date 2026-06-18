/**
 * sw.js — Akron Pulse service worker.
 *
 * Deliberately caches NOTHING. Its only jobs are:
 *   1. Keep the app installable. A registered service worker plus the web
 *      manifest is what lets browsers offer "Install" / "Add to Home Screen",
 *      so the installed experience (standalone window, icon, shortcuts) and all
 *      of the app's features stay intact.
 *   2. Guarantee freshness. With no precache and a network-passthrough fetch
 *      handler, every request hits the network, so a new deploy is live the
 *      moment it ships — no stale build can hide behind a cache.
 *   3. Un-stick existing installs. On activate it deletes EVERY cache (including
 *      the precaches the previous Workbox build created), so anyone still
 *      carrying old cached assets is cleaned up on their next visit.
 *
 * Built via vite-plugin-pwa's injectManifest strategy (see vite.config.js).
 */

self.addEventListener('install', () => {
  // Take over as soon as possible instead of waiting for old tabs to close.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Nuke every cache left by this or any previous (precaching) SW.
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
      await self.clients.claim()
    })(),
  )
})

// A fetch listener that never calls respondWith() leaves the request to the
// browser's normal (network) handling. Its presence is what keeps the SW
// install-eligible while still caching nothing.
self.addEventListener('fetch', () => {})
