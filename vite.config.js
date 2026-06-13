import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// VITE_* vars from .env files / the host's process env (Vercel dashboard,
// CI). loadEnv resolves them the same way Vite's %ENV% HTML tokens do, so
// local prod builds (.env) and deploys behave identically. mode only
// selects which .env.[mode] files layer on top; the base .env — where
// VITE_SUPABASE_URL lives — loads for every mode, so a static default is
// safe here at module scope where Vite's `mode` isn't yet available.
const env = loadEnv(process.env.NODE_ENV || 'production', process.cwd(), '')

/**
 * Dev-only: strip the static boot shell out of index.html.
 *
 * The shell exists so production first paint (where the extracted CSS
 * bundle is render-blocking) shows the styled hero before React boots.
 * `vite dev` has no extracted CSS — styles arrive via JS modules — so
 * the same markup flashes completely unstyled for the whole JS load.
 * Removing it in dev restores the standard blank-until-mount behavior
 * without touching what users get.
 */
const stripBootShellInDev = () => ({
  name: 'strip-boot-shell-in-dev',
  apply: 'serve',
  transformIndexHtml(html) {
    return html.replace(
      /<!-- boot-shell:start -->[\s\S]*?<!-- boot-shell:end -->/,
      '<!-- boot shell stripped in dev (see stripBootShellInDev) -->',
    )
  },
})

/**
 * Inject the Supabase preconnect <link> at build time.
 *
 * We warm the Supabase connection (DNS + TCP + TLS) before the first
 * events query (the <!-- supabase-preconnect --> placeholder in
 * index.html marks the spot). This was previously a raw
 * `%VITE_SUPABASE_URL%` token that relied on Vite's %ENV% substitution.
 * The footgun: when the var is undefined — e.g. CI, which has no .env —
 * the literal `%VITE_SUPABASE_URL%` survived into the HTML, and
 * vite-plugin-pwa runs decodeURI() over every asset URL while building
 * the service worker. `%VI` is not a valid escape, so the whole build
 * died with "URI malformed".
 *
 * Resolving the env in JS and emitting only a well-formed tag (or
 * nothing) removes that footgun entirely: the build is green with or
 * without the var, and no malformed token can ever reach the PWA plugin.
 */
const injectSupabasePreconnect = (supabaseUrl) => ({
  name: 'inject-supabase-preconnect',
  transformIndexHtml: {
    order: 'pre',
    handler(html) {
      let origin = null
      try {
        if (supabaseUrl) origin = new URL(supabaseUrl).origin
      } catch {
        origin = null // placeholder/malformed value: skip the hint
      }
      const tag = origin
        ? `<link rel="preconnect" href="${origin}" crossorigin />`
        : ''
      return html.replace('<!-- supabase-preconnect -->', tag)
    },
  },
})

export default defineConfig({
  plugins: [
    react(),
    stripBootShellInDev(),
    injectSupabasePreconnect(env.VITE_SUPABASE_URL),

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
        // Long-press menu on the installed app icon (Android; also
        // desktop taskbar). Shortcuts are static per spec — the
        // "My Neighborhood" entry personalizes through the
        // /go/neighborhood indirection route (see src/lib/myHub.ts).
        shortcuts: [
          {
            name: 'My Neighborhood',
            short_name: 'My Hub',
            description: 'Events in the neighborhood you visit most',
            url: '/go/neighborhood',
            icons: [{ src: '/shortcut-neighborhood.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'This Weekend',
            description: 'Everything happening this weekend',
            url: '/?date=this_weekend',
            icons: [{ src: '/shortcut-weekend.png', sizes: '192x192', type: 'image/png' }],
          },
          {
            name: 'Submit an Event',
            short_name: 'Submit',
            description: 'Add your event to Akron Pulse',
            url: '/submit',
            icons: [{ src: '/shortcut-submit.png', sizes: '192x192', type: 'image/png' }],
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
          'shortcut-*.png',
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
            // Edge-cached first page of events (see api/events-first-page.js).
            // Same NetworkFirst posture as the Supabase route so repeat
            // visitors get an offline/flaky-network fallback.
            urlPattern: /\/api\/events-first-page$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'first-page',
              networkTimeoutSeconds: 2.5,
              expiration: { maxEntries: 1, maxAgeSeconds: 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Event/venue/org reads. NetworkFirst: always try the network,
            // fall back to a recent cached copy only when offline or the
            // request times out. Short TTL keeps any fallback honest.
            urlPattern: /^https:\/\/[a-z0-9-]+\.supabase\.co\/.*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-api',
              // Fall back to cached data after 2.5s rather than 4 —
              // on flaky mobile, waiting longer just feels broken.
              networkTimeoutSeconds: 2.5,
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
