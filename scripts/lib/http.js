/**
 * lib/http.js — a hardened fetch for scrapers running on datacenter IPs.
 *
 * Context: moving the nightly scrape to GitHub Actions (2026-07-26) put a batch
 * of sources behind bot challenges that never fired from Byron's home IP —
 * datacenter runner egress is treated as hostile. A big chunk of that damage is
 * self-inflicted and code-fixable: several scrapers fetch with a *self-
 * identifying* User-Agent ("…AkronPulse-bot/1.0", "…The330-bot/1.0") or, in one
 * case, NO User-Agent at all, which the mildest WAF rejects. Others just need a
 * retry on a transient reset.
 *
 * `fetchWithRetry` centralizes the browser-like request shaping + retry/backoff
 * that scrapers were each (not) doing by hand:
 *   • a rotating pool of realistic desktop-browser User-Agent strings,
 *   • sane default Accept / Accept-Language headers (caller can override),
 *   • a per-attempt timeout (AbortController),
 *   • exponential backoff with jitter, retrying transient network errors and
 *     the retryable status codes (408/425/429/500/502/503/504 — plus 403, which
 *     on these WAFs is often a soft, retry-recoverable challenge),
 *   • an optional undici proxy dispatcher sourced from SCRAPER_PROXY_URL, so the
 *     sources that genuinely need different egress (Cloudflare "Just a moment"
 *     pages) can be recovered by setting ONE env var — no code change.
 *
 * What it deliberately does NOT do: solve a real Cloudflare JS challenge (needs a
 * headless browser or residential proxy) or replicate a site's bespoke
 * cookie/CSRF handshake (e.g. the Eventbrite internal API — leave that scraper
 * alone). Those stay the operator's egress decision; this module just makes the
 * fixable majority fixable and gives the rest a single proxy seam.
 *
 * The live `fetch`, the sleep, and the RNG are all injectable so the retry/UA/
 * timeout logic is unit-testable without a network.
 */

import { isBotChallenge } from './ics.js'

// A small pool of current, real desktop-browser UA strings (mirrors the pool the
// Eventbrite scraper rotates). Rotated per request so a source doesn't see the
// same UA on every hit.
export const BROWSER_USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
]

/** Pick a random realistic browser User-Agent. `rng` injectable for tests. */
export function randomUserAgent(rng = Math.random) {
  return BROWSER_USER_AGENTS[Math.floor(rng() * BROWSER_USER_AGENTS.length)]
}

// Transient / soft-block statuses worth a backed-off retry. 403 is included
// because these datacenter-IP challenges are frequently soft (a retry, or a
// retry through a proxy, clears them); a hard 403 simply exhausts retries and is
// returned to the caller unchanged.
export const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504])

const DEFAULT_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Backoff delay for a 0-based attempt index: exponential (base·2ⁿ), capped, with
 * ±50% jitter. Exported for tests.
 */
export function backoffDelay(attempt, { baseDelayMs = 500, maxDelayMs = 8_000, rng = Math.random } = {}) {
  const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
  return Math.round(raw * (0.5 + rng() * 0.5))
}

/**
 * Build an undici ProxyAgent dispatcher from SCRAPER_PROXY_URL (or the passed
 * url), or return null when unset / unavailable. Guarded so a missing undici or
 * unset env is a no-op, never a throw. Async because undici is imported lazily.
 */
export async function proxyDispatcherFromEnv(url = process.env.SCRAPER_PROXY_URL) {
  if (!url) return null
  try {
    const { ProxyAgent } = await import('undici')
    return new ProxyAgent(url)
  } catch (err) {
    console.warn(`  ⚠ SCRAPER_PROXY_URL set but proxy dispatcher unavailable (${err.message}) — continuing without proxy`)
    return null
  }
}

/**
 * fetch() with browser-like headers, a per-attempt timeout, and retry/backoff.
 *
 * Returns the final Response (whether ok or a non-retryable non-ok — callers
 * already branch on `res.ok`). Throws only when every attempt raised a network
 * error (or a bot-challenge body when `treatBotChallengeAsRetryable`).
 *
 * @param {string|URL} url
 * @param {object} [opts]
 * @param {number}  [opts.retries=3]        additional attempts after the first
 * @param {number}  [opts.timeoutMs=20000]  per-attempt abort timeout
 * @param {number}  [opts.baseDelayMs=500]
 * @param {number}  [opts.maxDelayMs=8000]
 * @param {Set<number>} [opts.retryStatuses]
 * @param {object}  [opts.headers]          merged over the browser defaults
 * @param {string}  [opts.userAgent]        pin a UA (default: random per attempt)
 * @param {boolean} [opts.treatBotChallengeAsRetryable=false] peek the body of an
 *                  otherwise-ok response and retry if it's a challenge page
 * @param {*}       [opts.dispatcher]       undici dispatcher (proxy); default env
 * @param {function}[opts.fetchImpl]        injectable fetch (tests)
 * @param {function}[opts.sleep]            injectable sleep (tests)
 * @param {function}[opts.rng]              injectable RNG (tests)
 * @param {function}[opts.onRetry]          ({attempt, reason, status}) => void
 * @param {...*}    rest                     method, body, redirect, signal, …
 */
export async function fetchWithRetry(url, opts = {}) {
  const {
    retries = 3,
    timeoutMs = 20_000,
    baseDelayMs = 500,
    maxDelayMs = 8_000,
    retryStatuses = RETRYABLE_STATUS,
    headers = {},
    userAgent,
    treatBotChallengeAsRetryable = false,
    dispatcher,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    rng = Math.random,
    onRetry,
    ...rest
  } = opts

  const agent = dispatcher !== undefined ? dispatcher : await proxyDispatcherFromEnv()
  let lastError

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = rest.signal ? null : new AbortController()
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    try {
      const res = await fetchImpl(url, {
        ...rest,
        signal: rest.signal ?? controller?.signal,
        ...(agent ? { dispatcher: agent } : {}),
        headers: {
          'User-Agent': userAgent ?? randomUserAgent(rng),
          ...DEFAULT_HEADERS,
          ...headers,
        },
      })

      if (res.ok && treatBotChallengeAsRetryable) {
        // Peek without consuming the caller's body: clone first.
        const body = await res.clone().text()
        if (isBotChallenge(body)) {
          if (attempt < retries) {
            onRetry?.({ attempt, reason: 'bot-challenge', status: res.status })
            await sleep(backoffDelay(attempt, { baseDelayMs, maxDelayMs, rng }))
            continue
          }
          return res
        }
      }

      if (res.ok || !retryStatuses.has(res.status) || attempt >= retries) return res

      onRetry?.({ attempt, reason: 'status', status: res.status })
      await sleep(backoffDelay(attempt, { baseDelayMs, maxDelayMs, rng }))
    } catch (err) {
      lastError = err
      if (attempt >= retries) throw err
      onRetry?.({ attempt, reason: 'network', status: null })
      await sleep(backoffDelay(attempt, { baseDelayMs, maxDelayMs, rng }))
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // Unreachable in practice (the loop returns or throws), but satisfy the type.
  throw lastError ?? new Error(`fetchWithRetry: exhausted retries for ${url}`)
}
