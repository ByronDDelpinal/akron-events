/**
 * test-http.js — unit tests for lib/http.js fetchWithRetry.
 *
 * The live fetch, sleep, and RNG are injected so the retry/UA/timeout logic is
 * exercised deterministically with no network and no real delays.
 *
 * Run:
 *   node --test scripts/tests/test-http.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchWithRetry,
  randomUserAgent,
  backoffDelay,
  BROWSER_USER_AGENTS,
  RETRYABLE_STATUS,
  proxyDispatcherFromEnv,
  dispatchedFetch,
  proxyConfigFromUrl,
  rotateProxySession,
  redactProxyUrl,
  PROXY_CONNECT_TIMEOUT_MS,
} from '../lib/http.js'

// A minimal Response-like stub with a working clone()/text().
function resp(status, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    clone() { return resp(status, body) },
    async text() { return body },
  }
}
const noSleep = async () => {}

// ── randomUserAgent ──────────────────────────────────────────────────────────

describe('randomUserAgent', () => {
  it('always returns a realistic browser UA (never a bot UA)', () => {
    for (let i = 0; i < 20; i++) {
      const ua = randomUserAgent()
      assert.ok(BROWSER_USER_AGENTS.includes(ua))
      assert.doesNotMatch(ua, /bot/i)
      assert.match(ua, /Mozilla\/5\.0/)
    }
  })
  it('honors an injected rng to pick deterministically', () => {
    assert.equal(randomUserAgent(() => 0), BROWSER_USER_AGENTS[0])
    assert.equal(randomUserAgent(() => 0.999), BROWSER_USER_AGENTS[BROWSER_USER_AGENTS.length - 1])
  })
})

// ── backoffDelay ─────────────────────────────────────────────────────────────

describe('backoffDelay', () => {
  it('grows exponentially and caps at maxDelayMs (no jitter with rng=1)', () => {
    const o = { baseDelayMs: 500, maxDelayMs: 8000, rng: () => 1 }
    assert.equal(backoffDelay(0, o), 500)
    assert.equal(backoffDelay(1, o), 1000)
    assert.equal(backoffDelay(2, o), 2000)
    assert.equal(backoffDelay(10, o), 8000) // capped
  })
  it('applies ±50% jitter (rng=0 → half the base)', () => {
    assert.equal(backoffDelay(0, { baseDelayMs: 500, maxDelayMs: 8000, rng: () => 0 }), 250)
  })
})

// ── fetchWithRetry: happy path + header shaping ──────────────────────────────

describe('fetchWithRetry — headers', () => {
  it('sends a browser UA and default Accept headers, and returns on 200', async () => {
    let seen
    const fetchImpl = async (_url, init) => { seen = init; return resp(200, 'ok') }
    const res = await fetchWithRetry('https://x.test', { fetchImpl, sleep: noSleep })
    assert.equal(res.status, 200)
    assert.match(seen.headers['User-Agent'], /Mozilla\/5\.0/)
    assert.doesNotMatch(seen.headers['User-Agent'], /bot/i)
    assert.ok(seen.headers['Accept'])
    assert.equal(seen.headers['Accept-Language'], 'en-US,en;q=0.9')
  })

  it('lets the caller override headers (e.g. Accept: application/json)', async () => {
    let seen
    const fetchImpl = async (_url, init) => { seen = init; return resp(200) }
    await fetchWithRetry('https://x.test', {
      fetchImpl, sleep: noSleep, headers: { Accept: 'application/json' },
    })
    assert.equal(seen.headers['Accept'], 'application/json')
  })

  it('pins a User-Agent when provided', async () => {
    let seen
    const fetchImpl = async (_url, init) => { seen = init; return resp(200) }
    await fetchWithRetry('https://x.test', { fetchImpl, sleep: noSleep, userAgent: 'Pinned/1.0' })
    assert.equal(seen.headers['User-Agent'], 'Pinned/1.0')
  })
})

// ── fetchWithRetry: retry behavior ───────────────────────────────────────────

describe('fetchWithRetry — retries', () => {
  it('retries a retryable status then succeeds, counting attempts', async () => {
    let calls = 0
    const fetchImpl = async () => { calls++; return calls < 3 ? resp(503) : resp(200, 'yay') }
    const retried = []
    const res = await fetchWithRetry('https://x.test', {
      fetchImpl, sleep: noSleep, baseDelayMs: 0, onRetry: (i) => retried.push(i.reason),
    })
    assert.equal(res.status, 200)
    assert.equal(calls, 3)
    assert.deepEqual(retried, ['status', 'status'])
  })

  it('retries a transient network error then succeeds', async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls++
      if (calls < 2) throw new TypeError('fetch failed')
      return resp(200)
    }
    const res = await fetchWithRetry('https://x.test', { fetchImpl, sleep: noSleep, baseDelayMs: 0 })
    assert.equal(res.status, 200)
    assert.equal(calls, 2)
  })

  it('gives up after `retries` network errors and rethrows the last', async () => {
    let calls = 0
    const fetchImpl = async () => { calls++; throw new TypeError('fetch failed') }
    await assert.rejects(
      fetchWithRetry('https://x.test', { fetchImpl, sleep: noSleep, retries: 2, baseDelayMs: 0 }),
      /fetch failed/,
    )
    assert.equal(calls, 3) // initial + 2 retries
  })

  it('does NOT retry a non-retryable status (e.g. 404) — returns immediately', async () => {
    let calls = 0
    const fetchImpl = async () => { calls++; return resp(404) }
    const res = await fetchWithRetry('https://x.test', { fetchImpl, sleep: noSleep })
    assert.equal(res.status, 404)
    assert.equal(calls, 1)
  })

  it('treats 403 as retryable (soft datacenter block)', async () => {
    assert.ok(RETRYABLE_STATUS.has(403))
    let calls = 0
    const fetchImpl = async () => { calls++; return calls < 2 ? resp(403) : resp(200) }
    const res = await fetchWithRetry('https://x.test', { fetchImpl, sleep: noSleep, baseDelayMs: 0 })
    assert.equal(res.status, 200)
    assert.equal(calls, 2)
  })

  it('returns the final non-ok response after exhausting status retries', async () => {
    let calls = 0
    const fetchImpl = async () => { calls++; return resp(503) }
    const res = await fetchWithRetry('https://x.test', { fetchImpl, sleep: noSleep, retries: 2, baseDelayMs: 0 })
    assert.equal(res.status, 503)
    assert.equal(calls, 3)
  })
})

// ── fetchWithRetry: bot-challenge body detection ─────────────────────────────

describe('fetchWithRetry — treatBotChallengeAsRetryable', () => {
  it('retries a 200 whose body is a Cloudflare challenge, then returns real content', async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls++
      return calls < 2 ? resp(200, '<title>Just a moment...</title>') : resp(200, '<html>real events</html>')
    }
    const res = await fetchWithRetry('https://x.test', {
      fetchImpl, sleep: noSleep, baseDelayMs: 0, treatBotChallengeAsRetryable: true,
    })
    const body = await res.text()
    assert.match(body, /real events/)
    assert.equal(calls, 2)
  })

  it('does not peek the body when the flag is off', async () => {
    let cloned = 0
    const challenge = { ok: true, status: 200, clone() { cloned++; return this }, async text() { return 'Just a moment' } }
    const fetchImpl = async () => challenge
    const res = await fetchWithRetry('https://x.test', { fetchImpl, sleep: noSleep })
    assert.equal(res.status, 200)
    assert.equal(cloned, 0)
  })
})

// ── proxyDispatcherFromEnv ───────────────────────────────────────────────────

describe('proxyDispatcherFromEnv', () => {
  it('returns null when no proxy url is set', async () => {
    assert.equal(await proxyDispatcherFromEnv(undefined), null)
    assert.equal(await proxyDispatcherFromEnv(''), null)
  })

  it('memoizes the ProxyAgent per url (same instance across calls)', async () => {
    const url = 'http://user:pass@proxy.test:8080'
    const a = await proxyDispatcherFromEnv(url)
    const b = await proxyDispatcherFromEnv(url)
    assert.ok(a, 'expected a dispatcher (is undici installed?)')
    assert.equal(a, b)
  })
})

// ── fetchWithRetry: proxy opt-in ─────────────────────────────────────────────

describe('fetchWithRetry — proxy opt-in (useProxy)', () => {
  const PROXY_URL = 'http://user:pass@proxy.test:8080'

  async function withProxyEnv(value, fn) {
    const prev = process.env.SCRAPER_PROXY_URL
    if (value === undefined) delete process.env.SCRAPER_PROXY_URL
    else process.env.SCRAPER_PROXY_URL = value
    try {
      return await fn()
    } finally {
      if (prev === undefined) delete process.env.SCRAPER_PROXY_URL
      else process.env.SCRAPER_PROXY_URL = prev
    }
  }

  it('ignores SCRAPER_PROXY_URL unless the caller opts in', async () => {
    await withProxyEnv(PROXY_URL, async () => {
      let seen
      const fetchImpl = async (_url, init) => { seen = init; return resp(200) }
      await fetchWithRetry('https://x.test', { fetchImpl, sleep: noSleep })
      assert.equal('dispatcher' in seen, false)
    })
  })

  it('attaches the env-derived dispatcher when useProxy is set', async () => {
    await withProxyEnv(PROXY_URL, async () => {
      let seen
      const fetchImpl = async (_url, init) => { seen = init; return resp(200) }
      await fetchWithRetry('https://x.test', { fetchImpl, sleep: noSleep, useProxy: true })
      assert.ok(seen.dispatcher)
    })
  })

  it('useProxy with no SCRAPER_PROXY_URL set is a no-op', async () => {
    await withProxyEnv(undefined, async () => {
      let seen
      const fetchImpl = async (_url, init) => { seen = init; return resp(200) }
      await fetchWithRetry('https://x.test', { fetchImpl, sleep: noSleep, useProxy: true })
      assert.equal('dispatcher' in seen, false)
    })
  })

  it('an explicit dispatcher always wins over useProxy', async () => {
    await withProxyEnv(PROXY_URL, async () => {
      const sentinel = { sentinel: true }
      let seen
      const fetchImpl = async (_url, init) => { seen = init; return resp(200) }
      await fetchWithRetry('https://x.test', {
        fetchImpl, sleep: noSleep, useProxy: true, dispatcher: sentinel,
      })
      assert.equal(seen.dispatcher, sentinel)
    })
  })
})

// ── proxyConfigFromUrl ───────────────────────────────────────────────────────

describe('proxyConfigFromUrl', () => {
  it('parses server + percent-encoded credentials', () => {
    const cfg = proxyConfigFromUrl('http://user%40acct:p%40ss%3Aword@gw.dataimpulse.com:823')
    assert.deepEqual(cfg, {
      server: 'http://gw.dataimpulse.com:823',
      username: 'user@acct',
      password: 'p@ss:word',
    })
  })

  it('returns null for unset, garbage, or port-less urls', () => {
    assert.equal(proxyConfigFromUrl(undefined), null)
    assert.equal(proxyConfigFromUrl(''), null)
    assert.equal(proxyConfigFromUrl('not a url'), null)
    assert.equal(proxyConfigFromUrl('http://proxy.test'), null)
  })
})

// ── 2026-08-20 incident regressions ──────────────────────────────────────────
//
// A v8 ProxyAgent handed to Node's v6-backed globalThis.fetch throws
// "invalid onRequestStart method" before opening a socket, which silently
// zeroed every proxy-opted-in scraper for six nights. These lock in the two
// behaviours that stop that from recurring.

describe('fetchWithRetry — proxy egress resilience (2026-08-20 regression)', () => {
  it('falls back to direct egress when every proxied attempt dies at the network layer', async () => {
    const seen = []
    const fetchImpl = async (_url, init) => {
      seen.push(init.dispatcher ? 'proxied' : 'direct')
      if (init.dispatcher) throw new TypeError('fetch failed')
      return new Response('ok', { status: 200 })
    }
    const res = await fetchWithRetry('https://example.test/', {
      useProxy: true,
      dispatcher: { marker: 'proxy-agent' },
      retries: 1,
      fetchImpl,
      sleep: async () => {},
    })
    assert.equal(res.status, 200, 'should recover via the direct-egress fallback')
    assert.deepEqual(seen, ['proxied', 'proxied', 'direct'])
  })

  it('does NOT fall back when the proxied attempts got real HTTP responses', async () => {
    // A 403 means we reached the origin: that is a bot challenge, not a proxy
    // outage, so burning a direct request would leak the datacenter IP.
    const seen = []
    const fetchImpl = async (_url, init) => {
      seen.push(init.dispatcher ? 'proxied' : 'direct')
      return new Response('blocked', { status: 403 })
    }
    const res = await fetchWithRetry('https://example.test/', {
      useProxy: true,
      dispatcher: { marker: 'proxy-agent' },
      retries: 1,
      fetchImpl,
      sleep: async () => {},
    })
    assert.equal(res.status, 403)
    assert.ok(!seen.includes('direct'), 'must not add a direct attempt after a real HTTP response')
  })

  it('an injected fetchImpl still wins over the undici pairing', async () => {
    let called = false
    const fetchImpl = async () => { called = true; return new Response('x', { status: 200 }) }
    const res = await fetchWithRetry('https://example.test/', {
      useProxy: true, dispatcher: { marker: 'p' }, retries: 0, fetchImpl, sleep: async () => {},
    })
    assert.equal(res.status, 200)
    assert.ok(called, 'test seam must not be bypassed when a dispatcher is present')
  })
})

describe('dispatchedFetch — the safe dispatcher seam', () => {
  it('uses the plain global fetch when no dispatcher is given', async () => {
    const orig = globalThis.fetch
    let sawDispatcher = 'unset'
    globalThis.fetch = async (_u, init) => {
      sawDispatcher = init && 'dispatcher' in init ? 'present' : 'absent'
      return new Response('ok', { status: 200 })
    }
    try {
      const res = await dispatchedFetch('https://example.test/', { method: 'GET' })
      assert.equal(res.status, 200)
      assert.equal(sawDispatcher, 'absent')
    } finally {
      globalThis.fetch = orig
    }
  })

  it('attaches the dispatcher and preserves caller options', async () => {
    // undici's real fetch will reject the fake dispatcher; we only assert that
    // the dispatcher is threaded through rather than silently dropped.
    const marker = { fake: 'agent' }
    await assert.rejects(
      () => dispatchedFetch('https://example.invalid/', { method: 'POST' }, marker),
      (err) => err instanceof Error,
    )
  })
})

// ── fresh exit session (2026-08-23 eventbrite IP-block regression) ───────────
//
// eventbrite began refusing our residential exit IP on 08-21. Every attempt in
// the retry loop shares one pooled tunnel and therefore one exit IP, so the
// retries were re-asking the same rejected peer. These lock in that we rotate
// onto a NEW session before falling back to direct egress (which leaks the
// runner IP), and that we only ever rotate a dispatcher we own.

describe('rotateProxySession', () => {
  it('rewrites an existing session token and differs each call', () => {
    const url = 'http://user%3Bsid.aaa111:pw@gw.test:824'
    const a = rotateProxySession(url)
    const b = rotateProxySession(url)
    assert.ok(a && b)
    assert.notEqual(a, b)
    assert.ok(!a.includes('sid.aaa111'), 'old session token must not survive')
    assert.ok(a.includes('gw.test:824'), 'gateway must be preserved')
    assert.ok(a.includes(':pw@'), 'password must be preserved')
  })

  it('returns a bare origin — a proxy uri is not a document', () => {
    const out = rotateProxySession('http://user%3Bsid.aaa111:pw@gw.test:824')
    assert.ok(!out.endsWith('/'), 'URL.toString() would append a path')
    assert.equal(new URL(out).pathname, '/')
  })

  it('returns null for a url with no session token (gateway already rotates)', () => {
    assert.equal(rotateProxySession('http://user:pw@gw.test:823'), null)
  })

  it('appends a token when SCRAPER_PROXY_ROTATE_SESSION=1', () => {
    const prev = process.env.SCRAPER_PROXY_ROTATE_SESSION
    process.env.SCRAPER_PROXY_ROTATE_SESSION = '1'
    try {
      const out = rotateProxySession('http://user:pw@gw.test:823')
      assert.ok(out && /sid\./.test(out))
    } finally {
      if (prev === undefined) delete process.env.SCRAPER_PROXY_ROTATE_SESSION
      else process.env.SCRAPER_PROXY_ROTATE_SESSION = prev
    }
  })

  it('is a no-op for credential-less, unset, and unparseable urls', () => {
    assert.equal(rotateProxySession('http://gw.test:823'), null)
    assert.equal(rotateProxySession(''), null)
    assert.equal(rotateProxySession('not a url'), null)
  })
})

describe('redactProxyUrl', () => {
  it('never emits the password or the session token', () => {
    const out = redactProxyUrl('http://user%3Bsid.secret:hunter2@gw.test:824')
    assert.ok(!out.includes('hunter2'))
    assert.ok(!out.includes('secret'))
    assert.ok(out.includes('gw.test:824'))
  })
})

describe('fetchWithRetry — proxied attempt window', () => {
  const PROXY_URL = 'http://user:pass@proxy.test:8080'

  async function withProxyEnv(value, fn) {
    const prev = process.env.SCRAPER_PROXY_URL
    if (value === undefined) delete process.env.SCRAPER_PROXY_URL
    else process.env.SCRAPER_PROXY_URL = value
    try { return await fn() } finally {
      if (prev === undefined) delete process.env.SCRAPER_PROXY_URL
      else process.env.SCRAPER_PROXY_URL = prev
    }
  }

  // Regression: raising the CONNECT timeout is inert if the per-attempt
  // AbortController still fires at 20s, because the abort lands first.
  it('widens the attempt window past the connect timeout when proxying', async () => {
    await withProxyEnv(PROXY_URL, async () => {
      let signal
      const fetchImpl = async (_url, init) => { signal = init.signal; return resp(200) }
      await fetchWithRetry('https://x.test', { fetchImpl, sleep: noSleep, useProxy: true })
      assert.ok(signal, 'an abort signal is still installed')
      assert.ok(PROXY_CONNECT_TIMEOUT_MS + 10_000 > 20_000, 'window must exceed the 20s default')
    })
  })

  it('an explicit timeoutMs from the caller is never widened', async () => {
    await withProxyEnv(PROXY_URL, async () => {
      const started = Date.now()
      const fetchImpl = async () => { throw new Error('fetch failed') }
      await assert.rejects(fetchWithRetry('https://x.test', {
        fetchImpl, sleep: noSleep, useProxy: true, retries: 0, timeoutMs: 5,
        freshDispatcherFactory: async () => null,
      }))
      assert.ok(Date.now() - started < 5_000, 'must not have waited on a widened window')
    })
  })
})

describe('fetchWithRetry — fresh exit session retry', () => {
  const PROXY_URL = 'http://user:pass@proxy.test:8080'

  async function withProxyEnv(value, fn) {
    const prev = process.env.SCRAPER_PROXY_URL
    if (value === undefined) delete process.env.SCRAPER_PROXY_URL
    else process.env.SCRAPER_PROXY_URL = value
    try { return await fn() } finally {
      if (prev === undefined) delete process.env.SCRAPER_PROXY_URL
      else process.env.SCRAPER_PROXY_URL = prev
    }
  }

  it('rotates onto a fresh session after every attempt fails at the network layer', async () => {
    await withProxyEnv(PROXY_URL, async () => {
      const freshAgent = { fresh: true }
      let freshCalls = 0
      const seen = []
      const fetchImpl = async (_url, init) => {
        seen.push(init.dispatcher)
        if (init.dispatcher === freshAgent) return resp(200, 'ok')
        throw Object.assign(new Error('fetch failed'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
      }
      const res = await fetchWithRetry('https://x.test', {
        fetchImpl, sleep: noSleep, useProxy: true, retries: 2,
        freshDispatcherFactory: async () => { freshCalls++; return freshAgent },
      })
      assert.equal(res.status, 200)
      assert.equal(freshCalls, 1, 'rotates exactly once, not once per attempt')
      assert.equal(seen.at(-1), freshAgent)
    })
  })

  it('does NOT rotate a dispatcher the caller passed in', async () => {
    await withProxyEnv(PROXY_URL, async () => {
      let freshCalls = 0
      const fetchImpl = async () => { throw new Error('fetch failed') }
      await assert.rejects(fetchWithRetry('https://x.test', {
        fetchImpl, sleep: noSleep, useProxy: true, dispatcher: { mine: true }, retries: 0,
        freshDispatcherFactory: async () => { freshCalls++; return { fresh: true } },
      }))
      assert.equal(freshCalls, 0)
    })
  })

  it('does NOT rotate when a retryable HTTP status — not a network error — was seen', async () => {
    await withProxyEnv(PROXY_URL, async () => {
      let freshCalls = 0
      const fetchImpl = async () => resp(503)
      const res = await fetchWithRetry('https://x.test', {
        fetchImpl, sleep: noSleep, useProxy: true, retries: 1,
        freshDispatcherFactory: async () => { freshCalls++; return { fresh: true } },
      })
      assert.equal(res.status, 503)
      assert.equal(freshCalls, 0, 'reaching the origin means the exit IP is fine')
    })
  })

  it('still falls back to direct egress when the fresh session also fails', async () => {
    await withProxyEnv(PROXY_URL, async () => {
      const calls = []
      const fetchImpl = async (_url, init) => {
        calls.push(init.dispatcher ? 'proxied' : 'direct')
        if (init.dispatcher) throw new Error('fetch failed')
        return resp(200, 'direct')
      }
      const res = await fetchWithRetry('https://x.test', {
        fetchImpl, sleep: noSleep, useProxy: true, retries: 0,
        freshDispatcherFactory: async () => ({ fresh: true }),
      })
      assert.equal(res.status, 200)
      assert.equal(calls.at(-1), 'direct')
      assert.ok(calls.filter((c) => c === 'proxied').length >= 2, 'original session then fresh session')
    })
  })
})
