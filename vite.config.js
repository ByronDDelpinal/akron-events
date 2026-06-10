import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),

    /**
     * PWA: makes the site installable (Android/desktop install prompt,
     * iOS "Add to Home Screen" opens standalone) and adds a Workbox
     * service worker for an offline-capable app shell.
     *
     * Caching philosophy: this is an events site, so FRESHNESS BEATS
     * OFFLINE. Only the app shell (JS/CSS/HTML/icons) is precached.
     * Event data from Supabase is NetworkFirst with a short-lived
     * fallback cache — users must never see a stale calendar just
     * because a service worker got in the way. Never switch the
     * Supabase route to CacheFirst.
     *
     * Updates: `autoUpdate` means a new deploy's service worker
     * activates on the next navigation without user interaction —
     * nobody gets pinned to an old build.
     */
    VitePWA({
      registerType: 'autoUpdate',
      // Deferred script: the default injection was render-blocking
      // (flagged by Lighthouse). SW registration never needs to beat
      // first paint.
      injectRegister: 'script-defer',
      includeAssets: ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Akron Pulse',
        short_name: 'Akron Pulse',
        description:
          "Discover what's happening in Akron, OH and Summit County. Concerts, art shows, community gatherings, fundraisers, and more, all in one place.",
        lang: 'en-US',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // Matches --amber (brand teal) in src/styles/globals.css and the
        // theme-color meta in index.html. Update all three together.
        theme_color: '#0E5163',
        // Splash screen background; matches --bg-page in globals.css.
        background_color: '#FCFAF4',
        categories: ['events', 'entertainment', 'lifestyle'],
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          // 1024px: Android's install splash shows the largest icon at
          // ~192dp, which is >512 physical px on 3x screens. Providing
          // 1024 means the splash downscales (sharp) instead of
          // upscaling (pixelated).
          { src: '/pwa-1024x1024.png', sizes: '1024x1024', type: 'image/png' },
          {
            src: '/maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/maskable-icon-1024x1024.png',
            sizes: '1024x1024',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // App shell only. Deliberately excludes the large static payloads
        // (geojson polygons, og-default.jpg, neighborhood-map.webp, hero
        // video) — they'd bloat every install for pages most visitors
        // never open. PWA icons are listed explicitly so installed apps
        // keep their icon offline.
        globPatterns: [
          '**/*.{js,css,html,svg,ico,woff2}',
          'pwa-*.png',
          'maskable-icon-*.png',
          'apple-touch-icon.png',
        ],
        // mapbox-gl makes the main chunk large; default cap is 2 MiB.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        // SPA routing: unknown navigations get index.html, EXCEPT the
        // server-rendered routes that vercel.json/middleware.js own.
        // (/events/* unfurler SSR is crawler-only — crawlers don't run
        // service workers, so no exclusion is needed for it.)
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/feed\.xml$/, /^\/sitemap\.xml$/],
        runtimeCaching: [
          {
            // Event/venue/org reads. NetworkFirst: always try the network,
            // fall back to a recent cached copy only when offline or the
            // request times out. Short TTL keeps any fallback honest.
            urlPattern: /^https:\/\/[a-z0-9-]+\.supabase\.co\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-api',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Map tiles/styles/sprites are immutable-ish and expensive;
            // cache hard with a bounded entry count so the quota stays sane.
            urlPattern: /^https:\/\/api\.mapbox\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'mapbox',
              expiration: { maxEntries: 300, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Theme font stylesheets swap at runtime (useTheme.jsx), so
            // revalidate in the background rather than pinning.
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-stylesheets' },
          },
          {
            // The font binaries themselves are content-hashed by Google;
            // safe to cache for a year.
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 365 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': '/src',
    },
  },
})
