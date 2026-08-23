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
 * How long to wait for the CONNECT tunnel, in ms.
 *
 * WHY THIS OVERRIDES undici's DEFAULT (2026-08-23): undici's connect timeout is
 * 10s. A residential gateway has to select an exit peer, reach it, and only
 * then open the tunnel to the origin — routinely slower than a datacenter hop.
 * The eventbrite nightly failed three nights running with
 * `UND_ERR_CONNECT_TIMEOUT (attempted address: www.eventbrite.com:443)` while
 * the provider dashboard showed the CONNECT being billed, i.e. the tunnel was
 * opening and we were walking away from it too early.
 */
export const PROXY_CONNECT_TIMEOUT_MS = Number(process.env.SCRAPER_PROXY_CONNECT_TIMEOUT_MS ?? 30_000)

/** Username token that carries the sticky-session id (DataImpulse: `user;sid.123`). */
const PROXY_SESSION_PARAM = process.env.SCRAPER_PROXY_SESSION_PARAM || 'sid'

/**
 * Strip credentials from a proxy url so it is safe to put in a log line.
 * NEVER log SCRAPER_PROXY_URL directly: the password and the session token both
 * live in the userinfo.
 */
export function redactProxyUrl(url) {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.username ? '***:***@' : ''}${u.hostname}${u.port ? `:${u.port}` : ''}`
  } catch {
    return '(unparseable proxy url)'
  }
}

/**
 * Return a copy of `url` bound to a NEW exit session, or null when there is
 * nothing to rotate.
 *
 * Residential gateways express stickiness in the username (DataImpulse:
 * `user;sid.123456`). Rewriting that token asks the gateway for a different
 * exit peer. When no token is present the gateway is already rotating per
 * tunnel, so a brand-new dispatcher alone is enough and this returns null —
 * set SCRAPER_PROXY_ROTATE_SESSION=1 to append one anyway.
 */
export function rotateProxySession(url = process.env.SCRAPER_PROXY_URL, { rng = Math.random } = {}) {
  if (!url) return null
  let u
  try { u = new URL(url) } catch { return null }
  if (!u.username) return null

  const username = decodeURIComponent(u.username)
  const token = `${Math.floor(rng() * 1e9).toString(36)}${Date.now().toString(36)}`
  const re = new RegExp(`(;${PROXY_SESSION_PARAM}\\.)[^;]*`)

  let next
  if (re.test(username)) next = username.replace(re, `$1${token}`)
  else if (process.env.SCRAPER_PROXY_ROTATE_SESSION === '1') next = `${username};${PROXY_SESSION_PARAM}.${token}`
  else return null

  u.username = next
  // Build the origin by hand: URL.toString() appends a path ("/"), and a proxy
  // uri is an origin, not a document. Harmless for undici, surprising for
  // anything else that ends up parsing this.
  return `${u.protocol}//${u.username}${u.password ? `:${u.password}` : ''}@${u.host}`
}

async function buildProxyAgent(url) {
  const { ProxyAgent } = await import('undici')
  // Timeouts on all three legs: to the proxy, the TLS handshake with the proxy,
  // and the TLS handshake with the origin through the tunnel. Any one of them
  // firing at 10s produces the same UND_ERR_CONNECT_TIMEOUT.
  return new ProxyAgent({
    uri: url,
    connect: { timeout: PROXY_CONNECT_TIMEOUT_MS },
    proxyTls: { timeout: PROXY_CONNECT_TIMEOUT_MS },
    requestTls: { timeout: PROXY_CONNECT_TIMEOUT_MS },
  })
}

/**
 * Build an undici ProxyAgent dispatcher from SCRAPER_PROXY_URL (or the passed
 * url), or return null when unset / unavailable. Guarded so a missing undici or
 * unset env is a no-op, never a throw. Async because undici is imported lazily.
 */
export async function proxyDispatcherFromEnv(url = process.env.SCRAPER_PROXY_URL) {
  if (!url) return null
  if (_proxyAgents.has(url)) return _proxyAgents.get(url)
  try {
    const agent = await buildProxyAgent(url)
    _proxyAgents.set(url, agent)
    return agent
  } catch (err) {
    console.warn(`  ⚠ SCRAPER_PROXY_URL set but proxy dispatcher unavailable (${err.message}) — continuing without proxy`)
    return null
  }
}

// Fresh dispatchers are deliberately NOT memoized, so nothing else will close
// them. Track them and close on exit rather than closing at the call site: the
// Response body is still streaming over that socket when the fetch resolves.
const _freshAgents = new Set()
let _freshExitHookInstalled = false

/**
 * A dispatcher on a FRESH exit session.
 *
 * Never memoized — the whole point is a new tunnel, and reusing a pooled
 * keep-alive connection would reuse the same exit IP, which is exactly what
 * makes a retry against an IP-blocking origin worthless.
 *
 * Returns null when no proxy is configured or undici is unavailable.
 */
export async function freshProxyDispatcher(url = process.env.SCRAPER_PROXY_URL, { rng = Math.random } = {}) {
  if (!url) return null
  try {
    const agent = await buildProxyAgent(rotateProxySession(url, { rng }) ?? url)
    _freshAgents.add(agent)
    if (!_freshExitHookInstalled) {
      _freshExitHookInstalled = true
      process.once('beforeExit', closeFreshProxyAgents)
    }
    return agent
  } catch (err) {
    console.warn(`  ⚠ could not open a fresh proxy session via ${redactProxyUrl(url)} (${err.message})`)
    return null
  }
}

/** Close every dispatcher handed out by freshProxyDispatcher(). Idempotent. */
export async function closeFreshProxyAgents() {
  const agents = [..._freshAgents]
  _freshAgents.clear()
  await Promise.allSettled(agents.map((a) => a.close?.()))
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
 * The ONLY safe way to issue a fetch with an undici dispatcher.
 *
 * Any call site that does `fetch(url, { dispatcher })` against the global fetch
 * is broken whenever the installed undici major differs from Node's bundled one
 * — see undiciFetch() above. `fetchWithRetry` handles this internally; this
 * export exists for the scrapers that legitimately can't use fetchWithRetry
 * (e.g. Eventbrite, whose cookie handshake needs bespoke sequencing) so they
 * don't have to re-derive the rule and get it wrong.
 *
 * Passing a null/undefined dispatcher is a plain global fetch, unchanged.
 */
export async function dispatchedFetch(url, opts = {}, dispatcher = null) {
  if (!dispatcher) return globalThis.fetch(url, opts)
  const f = (await undiciFetch()) ?? globalThis.fetch
  return f(url, { ...opts, dispatcher })
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
 * @param {number}  [opts.timeoutMs=20000]  per-attempt abort timeout (widened
 *                  automatically when proxying, unless pinned by the caller)
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
 * @param {function}[opts.freshDispatcherFactory] injectable fresh-session factory (tests)
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
    freshDispatcherFactory = freshProxyDispatcher,
    ...rest
  } = opts

  // Whether the dispatcher is ours (env opt-in) or the caller's. Only ours may
  // be rotated onto a different exit session.
  const agentFromEnv = dispatcher === undefined && useProxy
  let agent = dispatcher !== undefined ? dispatcher : (useProxy ? await proxyDispatcherFromEnv() : null)

  // A connect timeout ABOVE the per-attempt abort can never fire — the
  // AbortController cancels the fetch first, and raising PROXY_CONNECT_TIMEOUT_MS
  // alone would be inert. When we are proxying on our own dispatcher and the
  // caller has not pinned timeoutMs, widen the attempt window to leave the
  // tunnel room to finish. An explicit timeoutMs from the caller always wins.
  const effectiveTimeoutMs = (agent && agentFromEnv && opts.timeoutMs === undefined)
    ? Math.max(timeoutMs, PROXY_CONNECT_TIMEOUT_MS + 10_000)
    : timeoutMs

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
    const timer = controller ? setTimeout(() => controller.abort(), effectiveTimeoutMs) : null
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

  // FRESH-EXIT-SESSION RETRY (2026-08-23). Every attempt above shared one
  // pooled keep-alive tunnel and therefore ONE residential exit IP. When an
  // origin rejects that peer — eventbrite from 08-21, billed CONNECT returning
  // 224 bytes — retrying on the same session proves nothing. Ask the gateway
  // for a different exit BEFORE considering the direct fallback, because going
  // direct leaks the runner IP and is strictly worse than trying another peer.
  //
  // Only when the agent came from the env opt-in: an explicitly passed
  // dispatcher belongs to the caller and may not be a proxy at all.
  if (agent && agentFromEnv && allFailuresWereNetwork && lastError) {
    const fresh = await freshDispatcherFactory(undefined, { rng })
    if (fresh) {
      console.warn(`  ⚠ proxy egress failed for ${url} — retrying on a fresh exit session`)
      console.warn(`     cause: ${describeError(lastError)}`)
      const controller = rest.signal ? null : new AbortController()
      const timer = controller ? setTimeout(() => controller.abort(), effectiveTimeoutMs) : null
      try {
        return await doFetch(url, {
          ...rest,
          signal: rest.signal ?? controller?.signal,
          dispatcher: fresh,
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
