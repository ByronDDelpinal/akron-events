/**
 * prerender.js — post-build static prerender for crawlable routes.
 *
 * Runs after `vite build` (wired into `npm run build`). Boots a local
 * static server over dist/, loads each stable route in headless Chrome
 * (Puppeteer is already a dependency), waits for React + react-helmet
 * to finish, and writes the fully rendered HTML back into dist/ as
 * static files:
 *
 *   /                     → dist/index.html        (overwrites the shell)
 *   /events/this-weekend  → dist/events/this-weekend/index.html
 *   /about                → dist/about/index.html  … etc.
 *
 * Why: the site is a client-rendered SPA, so without this step every
 * URL serves the same empty #root shell with one generic <title>. On a
 * young, low-authority domain Googlebot's JS-rendering pass is slow and
 * rationed, which is why the site wasn't getting indexed (see
 * docs/SEO-diagnosis-2026-07-09.md). After this step the raw HTML of
 * each prerendered route contains its real title, meta description,
 * canonical, Open Graph tags, JSON-LD, and page content — no JS needed.
 *
 * The SPA fallback: before anything else we copy the pristine Vite
 * shell to dist/app.html. The catch-all rewrite in vercel.json points
 * at /app.html, so dynamic routes (event/venue/org detail pages) keep
 * getting the untouched shell. Vercel serves real files before applying
 * rewrites, so the prerendered routes win automatically.
 *
 * Only STABLE routes are prerendered (home, hub pages, static pages) —
 * ~50 pages, refreshed on every deploy. Event detail pages are dynamic
 * and stay covered by the bot-prerender edge middleware (middleware.js
 * → api/preview/event/[id].js).
 *
 * Env flags:
 *   SKIP_PRERENDER=1    skip the browser pass (app.html is still created
 *                       so the vercel.json rewrite never 404s)
 *   PRERENDER_STRICT=1  fail the build if any route fails (default: log
 *                       loudly and exit 0 — a failed prerender degrades
 *                       back to exactly today's SPA behavior)
 *
 * Usage:  node scripts/prerender.js
 */

/* global document -- callbacks passed to page.evaluate/waitForFunction run in the browser */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENABLED_HUB_PATHS } from '../src/lib/seo/categories.js'

const ROOT   = fileURLToPath(new URL('..', import.meta.url))
const DIST   = join(ROOT, 'dist')
const PORT   = 4173
const STRICT = process.env.PRERENDER_STRICT === '1'

// Stable, crawlable routes. Hub paths come from the SEO registry so a
// newly enabled hub is picked up here and in the sitemap with one edit.
const ROUTES = [
  '/',
  '/about',
  '/organizers',
  '/venues',
  '/venues/submit',
  '/organizations',
  '/organizations/submit',
  '/submit',
  '/subscribe',
  '/embed-builder',
  ...ENABLED_HUB_PATHS,
]

// Requests to abort during prerender: analytics (keeps GA clean), map
// tiles and images (not needed for HTML capture, big speedup).
const BLOCKED_HOSTS = /google-analytics\.com|googletagmanager\.com|doubleclick\.net|tiles\.openfreemap\.org/
const BLOCKED_TYPES = new Set(['image', 'media', 'font'])

const CONCURRENCY  = 4
const NAV_TIMEOUT  = 45_000
const META_TIMEOUT = 15_000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.mjs':  'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain',
  '.xml':  'application/xml',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map':  'application/json',
}

// ── Static server over dist/ with SPA fallback to app.html ────────────────

function startServer() {
  const fallback = readFileSync(join(DIST, 'app.html'))
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname)
    const filePath = normalize(join(DIST, pathname))
    if (filePath.startsWith(DIST) && existsSync(filePath) && statSync(filePath).isFile()) {
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' })
      res.end(readFileSync(filePath))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(fallback)
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(PORT, '127.0.0.1', () => resolve(server))
  })
}

// ── Prerender one route in a Puppeteer page ────────────────────────────────

async function renderRoute(browser, route, { metaTimeout = META_TIMEOUT } = {}) {
  const page = await browser.newPage()
  const pageErrors = []
  try {
    page.on('pageerror', (err) => pageErrors.push(String((err && err.message) || err)))
    await page.setViewport({ width: 1366, height: 900 })
    await page.setRequestInterception(true)
    page.on('request', (req) => {
      if (BLOCKED_HOSTS.test(req.url()) || BLOCKED_TYPES.has(req.resourceType())) return req.abort()
      req.continue()
    })

    await page.goto(`http://127.0.0.1:${PORT}${route}`, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT })

    // react-helmet marks everything it manages with data-rh; when the
    // page's own description exists, the SEO component has mounted.
    // polling: interval (not the default rAF) — rAF can starve in
    // backgrounded tabs; see the launch flags below for the other half.
    await page.waitForFunction(
      () => !!document.querySelector('meta[name="description"][data-rh]'),
      { timeout: metaTimeout, polling: 250 },
    ).catch(async (err) => {
      // Capture what the page actually looked like at timeout so a
      // failure is diagnosable from the build log alone.
      const diag = await page.evaluate(() => ({
        title: document.title,
        rootChildren: (document.getElementById('root') || {}).childElementCount,
        rhTags: document.querySelectorAll('[data-rh]').length,
        descriptions: document.querySelectorAll('meta[name="description"]').length,
      })).catch(() => null)
      const errs = pageErrors.length ? ` pageErrors: ${pageErrors.slice(0, 3).join(' | ')}` : ''
      throw new Error(`${err.message} — diag ${JSON.stringify(diag)}${errs}`)
    })
    // Let in-flight data requests (Supabase event lists) settle.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 10_000 }).catch(() => {})

    const html = await page.evaluate(() => {
      // Drop the static index.html description so the helmet-managed one
      // is the single source of truth in the captured document.
      const staticDesc = document.querySelector('meta[name="description"]:not([data-rh])')
      if (staticDesc && document.querySelector('meta[name="description"][data-rh]')) staticDesc.remove()
      return document.documentElement.outerHTML
    })

    // Sanity: never ship a page that lost its head or its content.
    if (!html.includes('data-rh') || html.length < 5_000) {
      throw new Error(`suspiciously small or unmanaged output (${html.length} bytes)`)
    }

    const stamp = `<!-- prerendered ${route} ${new Date().toISOString()} -->`
    const outDir = route === '/' ? DIST : join(DIST, ...route.split('/').filter(Boolean))
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'index.html'), `<!doctype html>\n${stamp}\n${html}`)
    return { route, ok: true, bytes: html.length }
  } finally {
    await page.close().catch(() => {})
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

// We render CONCURRENCY tabs in parallel and only one can be
// "frontmost". Without these flags Chrome throttles rAF/timers in
// background tabs, which starves react-helmet-async's deferred
// (rAF-batched) tag commits — pages then time out waiting for their
// meta tags even though React mounted fine.
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

/**
 * Launch Chrome. Locally, Puppeteer's own Chrome (installed by the
 * postinstall hook) works. Vercel's build image can't run it — it lacks
 * Chrome's shared system libraries (libnspr4.so etc.) — so there we
 * fall back to @sparticuz/chromium, a statically-linked Chromium built
 * for exactly this kind of bare Linux environment.
 */
async function launchBrowser(puppeteer) {
  try {
    return await puppeteer.launch({ args: LAUNCH_ARGS })
  } catch (err) {
    console.warn(`bundled Chrome failed to launch (${err.message.split('\n')[0]}); trying @sparticuz/chromium`)
    const { default: chromium } = await import('@sparticuz/chromium')
    return await puppeteer.launch({
      args: [...chromium.args, ...LAUNCH_ARGS],
      executablePath: await chromium.executablePath(),
      headless: true,
    })
  }
}

async function prerenderAll() {
  const { default: puppeteer } = await import('puppeteer')
  const server = await startServer()
  let browser
  try {
    browser = await launchBrowser(puppeteer)
  } catch (err) {
    server.close()
    throw err
  }

  const queue = [...ROUTES]
  const results = []
  try {
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      for (let route = queue.shift(); route != null; route = queue.shift()) {
        try {
          const r = await renderRoute(browser, route)
          console.log(`  ✓ ${route} (${(r.bytes / 1024).toFixed(0)} KB)`)
          results.push(r)
        } catch (err) {
          console.error(`  ✗ ${route}: ${err.message}`)
          results.push({ route, ok: false, error: err.message })
        }
      }
    })
    await Promise.all(workers)

    // Retry pass: transient failures (tab contention, slow cold start)
    // get one sequential retry with a doubled meta timeout.
    const toRetry = results.filter((r) => !r.ok)
    for (const failure of toRetry) {
      try {
        const r = await renderRoute(browser, failure.route, { metaTimeout: META_TIMEOUT * 2 })
        console.log(`  ✓ ${failure.route} (retry, ${(r.bytes / 1024).toFixed(0)} KB)`)
        results.splice(results.indexOf(failure), 1, r)
      } catch (err) {
        console.error(`  ✗ ${failure.route} (retry): ${err.message}`)
        failure.error = err.message
      }
    }
  } finally {
    await browser.close().catch(() => {})
    server.close()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\nPrerendered ${results.length - failed.length}/${ROUTES.length} routes`)
  if (failed.length > 0) {
    console.error(`FAILED: ${failed.map((f) => f.route).join(', ')}`)
    if (STRICT) process.exit(1)
    console.error('(non-strict mode: build continues; failed routes fall back to the SPA shell)')
  }
}

async function main() {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('dist/index.html not found — run `vite build` first')
  }

  // ALWAYS create the SPA fallback, even when skipping the browser pass:
  // the vercel.json catch-all rewrite targets /app.html and must never 404.
  copyFileSync(join(DIST, 'index.html'), join(DIST, 'app.html'))
  console.log('✓ dist/app.html (SPA fallback for dynamic routes)')

  if (process.env.SKIP_PRERENDER === '1') {
    console.log('SKIP_PRERENDER=1 — skipping browser prerender pass')
    return
  }

  try {
    await prerenderAll()
  } catch (err) {
    // app.html exists at this point, so shipping without prerendered
    // pages degrades to plain-SPA behavior instead of a broken deploy.
    if (STRICT) throw err
    console.error('━'.repeat(60))
    console.error(`PRERENDER SKIPPED — ${err.message}`)
    console.error('Deploy will serve the SPA shell only. SEO pages are NOT prerendered.')
    console.error('━'.repeat(60))
  }
}

main().catch((err) => {
  // A failure before/at the fallback copy must fail the build — a missing
  // app.html would 404 every dynamic route in production.
  console.error(`prerender: ${err.message}`)
  process.exit(1)
})
