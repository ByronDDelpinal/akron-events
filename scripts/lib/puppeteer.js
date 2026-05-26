/**
 * Shared Puppeteer helpers.
 *
 * Use this ONLY for sites where simple HTTP fetch genuinely cannot work:
 *   • Cloudflare/Kinsta JS bot challenges that gate every URL on the domain
 *   • Single-page apps that render zero content until JS executes
 *   • Third-party event widgets (Evvnt, etc.) that inject content client-side
 *
 * Do NOT reach for Puppeteer just because a selector is awkward or a fetch
 * needs cookies — every Puppeteer scraper adds ~5–10s to scrape:all and a
 * hundred-MB-class Chromium process to memory. Most scrapers in this repo
 * should stay on the simple fetch path.
 *
 * Pattern:
 *   import { withBrowser, fetchRenderedHtml } from './lib/puppeteer.js'
 *
 *   const html = await fetchRenderedHtml('https://example.com', {
 *     waitForSelector: '.my-content',
 *   })
 *
 * Or for advanced control:
 *   const result = await withBrowser(async (browser) => {
 *     const page = await browser.newPage()
 *     await page.goto(url, { waitUntil: 'networkidle2' })
 *     return page.evaluate(() => Array.from(document.querySelectorAll('.event')).map(e => e.textContent))
 *   })
 */

import puppeteer from 'puppeteer'

// Realistic Chrome-on-Mac fingerprint — sites that fingerprint headless
// browsers often check UA + viewport + a few common features. This trio is
// the minimum to look "normal" without going full puppeteer-extra-stealth.
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const DEFAULT_VIEWPORT       = { width: 1366, height: 900 }
const DEFAULT_NAV_TIMEOUT_MS = 30_000

const LAUNCH_OPTS = {
  // 'new' is the modern headless mode that mimics a real browser more
  // faithfully than legacy headless. Falls back automatically if older
  // Puppeteer versions don't support it.
  headless: 'new',
  // --no-sandbox is required on most Linux server environments; harmless
  // on macOS. --disable-blink-features=AutomationControlled removes the
  // `navigator.webdriver = true` flag that some bot detectors check.
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
  ],
}

/**
 * Launch a browser, run `fn(browser)`, and always close — even on error.
 * Returns whatever `fn` returns.
 *
 * Prefer the higher-level helpers below for common cases.
 */
export async function withBrowser(fn) {
  const browser = await puppeteer.launch(LAUNCH_OPTS)
  try {
    return await fn(browser)
  } finally {
    // Best-effort close — never let teardown errors mask the real one.
    try { await browser.close() } catch {}
  }
}

/**
 * Open a fresh page with our defaults applied (UA, viewport, navigator stealth).
 * Caller is responsible for closing the page (or the whole browser).
 */
export async function newConfiguredPage(browser, {
  userAgent = DEFAULT_USER_AGENT,
  viewport  = DEFAULT_VIEWPORT,
} = {}) {
  const page = await browser.newPage()
  await page.setUserAgent(userAgent)
  await page.setViewport(viewport)
  // Strip the webdriver flag at the document level. Bot detectors check
  // window.navigator.webdriver; we override it to undefined on every new
  // document so even iframe content (Evvnt widget etc.) sees a clean nav.
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })
  page.setDefaultNavigationTimeout(DEFAULT_NAV_TIMEOUT_MS)
  return page
}

/**
 * Navigate to `url`, wait for content to render, return the page's outer HTML.
 *
 * Options:
 *   waitForSelector — CSS selector to wait for (preferred over network idle when
 *                     you know what element marks "ready"). Default: none.
 *   waitForNetworkIdle — true to wait until 500ms with no in-flight requests.
 *                        Default: true if no waitForSelector given.
 *   timeoutMs       — Combined navigation + wait timeout. Default: 30s.
 *   userAgent       — Override UA.
 */
export async function fetchRenderedHtml(url, {
  waitForSelector   = null,
  waitForNetworkIdle = !waitForSelector,
  timeoutMs         = DEFAULT_NAV_TIMEOUT_MS,
  userAgent,
} = {}) {
  return withBrowser(async (browser) => {
    const page = await newConfiguredPage(browser, { userAgent })
    await page.goto(url, {
      waitUntil: waitForNetworkIdle ? 'networkidle2' : 'domcontentloaded',
      timeout:   timeoutMs,
    })
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: timeoutMs })
    }
    return page.content()
  })
}

/**
 * Navigate to a JSON endpoint via the browser and return the parsed JSON.
 *
 * Useful for endpoints behind a JS bot challenge where the browser has
 * solved the cookie but a headless fetch() can't — we let the browser
 * navigate to the JSON URL directly and parse the body it shows.
 *
 * Throws if the response isn't valid JSON.
 */
export async function fetchJsonViaBrowser(url, {
  timeoutMs = DEFAULT_NAV_TIMEOUT_MS,
  userAgent,
} = {}) {
  return withBrowser(async (browser) => {
    const page = await newConfiguredPage(browser, { userAgent })
    await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs })
    // Browsers wrap JSON in <pre> tags when displaying. Extract the text body.
    const text = await page.evaluate(() => {
      const pre = document.querySelector('pre')
      return pre ? pre.textContent : document.body.textContent
    })
    return JSON.parse(text)
  })
}

/**
 * Navigate to `url`, then run `evalFn` inside the page (with `args` passed
 * through), and return whatever it returns. Standard Puppeteer page.evaluate
 * semantics: the function and args are serialised and re-deserialised inside
 * the page context, so they can't capture variables from this closure.
 */
export async function evaluateOnPage(url, evalFn, args = [], {
  waitForSelector = null,
  timeoutMs       = DEFAULT_NAV_TIMEOUT_MS,
  userAgent,
} = {}) {
  return withBrowser(async (browser) => {
    const page = await newConfiguredPage(browser, { userAgent })
    await page.goto(url, { waitUntil: 'networkidle2', timeout: timeoutMs })
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: timeoutMs })
    }
    return page.evaluate(evalFn, ...args)
  })
}
