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
 *   • an optional undici proxy dispatcher sourced from SCRAPER_PROXY_URL. Proxy
 *     egress is OPT-IN per scraper via `useProxy: true` — the budget is a 5 GB
 *     residential plan, so only the sources that genuinely need different egress
 *     (Cloudflare "Just a moment" pages, IP-reputation blocks) should opt in.
 *     Everything else egresses direct, exactly as before.
 *
 * What it deliberately does NOT do: solve a real Cloudflare JS challenge (needs a
 * headless browser or residential proxy) or replicate a site's bespoke
 * cookie/CSRF handshake (e.g. the Eventbrite internal API — leave that scraper
 * alone). Those stay the operator's egress decision; this module just makes the
 * fixable majority fixable and gives the rest a single proxy seam. If Cloudflare
 * still loops a source through a ROTATING proxy, the operator-side fix is a
 * sticky-session port/credential in SCRAPER_PROXY_URL — no code change.
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

// Memoized ProxyAgent per proxy url — one connection pool per proxy, not one
// per request.
const _proxyAgents = new Map()

/**
 * Build an undici ProxyAgent dispatcher from SCRAPER_PROXY_URL (or the passed
 * url), or return null when unset / unavailable. Guarded so a missing undici or
 * unset env is a no-op, never a throw. Async because undici is imported lazily.
 */
export async function proxyDispatcherFromEnv(url = process.env.SCRAPER_PROXY_URL) {
  if (!url) return null
  if (_proxyAgents.has(url)) return _proxyAgents.get(url)
  try {
    const { ProxyAgent } = await import('undici')
    const agent = new ProxyAgent(url)
    _proxyAgents.set(url, agent)
    return agent
  } catch (err) {
    console.warn(`  ⚠ SCRAPER_PROXY_URL set but proxy dispatcher unavailable (${err.message}) — continuing without proxy`)
    return null
  }
}

/**
 * The `fetch` that belongs to the SAME undici build as `proxyDispatcherFromEnv`'s
 * ProxyAgent.
 *
 * WHY THIS EXISTS (2026-08-20 incident): `globalThis.fetch` is backed by the
 * undici that ships *inside* Node (6.28.0 on Node 22), while this repo installs
 * undici ^8 from npm. Handing a v8 ProxyAgent to the v6-backed global fetch
 * throws `TypeError: fetch failed` with cause `invalid onRequestStart method` —
 * the dispatcher handler API changed between majors. It fails BEFORE any socket
 * is opened, so no proxy credential, balance or gateway problem is involved and
 * nothing shows up in the proxy's logs. That is what took eventbrite,
 * cvnp_conservancy, wine_mill and village_of_reminderville from "403 bot
 * challenge" to "fetch failed" the night the proxy landed.
 *
 * Pairing the dispatcher with its own package's fetch makes this version-proof:
 * whatever undici major is installed, both halves come from it.
 */
/**
 * Flatten an Error's `cause` chain into one line.
 *
 * WHY: Node's fetch reports every transport failure as the useless
 * `TypeError: fetch failed`. The actual reason only lives in `err.cause`
 * (often nested two deep) — e.g. `Proxy response (407) !== 200 when HTTP
 * Tunneling` for a bad proxy credential vs `ConnectTimeoutError` for an
 * unreachable gateway. Those demand opposite fixes, and logging only the
 * top-level message is what made the 2026-08-20 proxy outage take six nights
 * and a bisect to characterise. Always log this, never `err.message` alone.
 */
export function describeError(err) {
  const parts = []
  for (let e = err, depth = 0; e && depth < 5; e = e.cause, depth++) {
    parts.push(`${e.name ?? 'Error'}: ${e.message}${e.code ? ` (${e.code})` : ''}`)
  }
  return parts.join(' <= ')
}

let _undiciFetch
async function undiciFetch() {
  if (_undiciFetch !== undefined) return _undiciFetch
  try {
    const { fetch: f } = await import('undici')
    _undiciFetch = typeof f === 'function' ? f : null
  } catch {
    _undiciFetch = null
  }
  return _undiciFetch
}

/**
 * Parse SCRAPER_PROXY_URL (or the passed url) into the pieces consumers that
 * can't take an undici dispatcher need (e.g. Chromium's --proxy-server flag +
 * page.authenticate). Pure and synchronous.
 *
 * Returns null when the url is unset, unparseable, or has no explicit port;
 * otherwise { server, username, password } with credentials percent-decoded.
 */
export function proxyConfigFromUrl(url = process.env.SCRAPER_PROXY_URL) {
  if (!url) return null
  try {
    const u = new URL(url)
    if (!u.port) return null
    return {
      server: `${u.protocol}//${u.hostname}:${u.port}`,
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    }
  } catch {
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
 * @param {boolean} [opts.useProxy=false]   opt in to SCRAPER_PROXY_URL egress
 * @param {*}       [opts.dispatcher]       undici dispatcher; explicit value always wins
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
    useProxy = false,
    dispatcher,
    fetchImpl,
    sleep = defaultSleep,
    rng = Math.random,
    onRetry,
    ...rest
  } = opts

  let agent = dispatcher !== undefined ? dispatcher : (useProxy ? await proxyDispatcherFromEnv() : null)

  // A proxy dispatcher must be driven by its own package's fetch — see
  // undiciFetch() above. If undici can't be loaded we drop the dispatcher
  // rather than hand it to an incompatible fetch and fail every attempt.
  let doFetch = fetchImpl ?? globalThis.fetch
  if (agent && !fetchImpl) {
    const uf = await undiciFetch()
    if (uf) {
      doFetch = uf
    } else {
      console.warn('  ⚠ proxy dispatcher requested but undici fetch unavailable — falling back to direct egress')
      agent = null
    }
  }

  let lastError
  let allFailuresWereNetwork = true

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = rest.signal ? null : new AbortController()
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    try {
      const res = await doFetch(url, {
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

      allFailuresWereNetwork = false
      onRetry?.({ attempt, reason: 'status', status: res.status })
      await sleep(backoffDelay(attempt, { baseDelayMs, maxDelayMs, rng }))
    } catch (err) {
      lastError = err
      if (attempt >= retries) break
      onRetry?.({ attempt, reason: 'network', status: null })
      await sleep(backoffDelay(attempt, { baseDelayMs, maxDelayMs, rng }))
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  // DIRECT-EGRESS FALLBACK. If we were proxying and every single attempt died at
  // the network layer, the proxy itself is the most likely suspect (dead
  // gateway, bad credential, exhausted balance, incompatible dispatcher). A
  // degraded source that still reaches the origin — even to be bot-challenged —
  // is strictly more useful than a source that reports nothing at all, and it
  // keeps a proxy outage from silently zeroing every opted-in scraper the way
  // the 2026-08-20 incident did.
  if (agent && allFailuresWereNetwork && lastError) {
    console.warn(`  ⚠ proxy egress failed for ${url} — retrying once direct`)
    console.warn(`     cause: ${describeError(lastError)}`)
    const controller = rest.signal ? null : new AbortController()
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
    try {
      return await (fetchImpl ?? globalThis.fetch)(url, {
        ...rest,
        signal: rest.signal ?? controller?.signal,
        headers: {
          'User-Agent': userAgent ?? randomUserAgent(rng),
          ...DEFAULT_HEADERS,
          ...headers,
        },
      })
    } catch (err) {
      lastError = err
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  throw lastError ?? new Error(`fetchWithRetry: exhausted retries for ${url}`)
}
