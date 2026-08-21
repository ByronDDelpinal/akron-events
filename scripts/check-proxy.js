#!/usr/bin/env node
/**
 * check-proxy.js — is SCRAPER_PROXY_URL actually usable, right now?
 *
 * Answers the one question the nightly logs could not: when proxy egress fails,
 * is it the gateway, the credential, the balance, or our own code? Node's fetch
 * flattens all of those into `TypeError: fetch failed`, so this walks the
 * `cause` chain and maps the real error onto an operator action.
 *
 * Runs in ~5 seconds, touches no database, and burns a trivial amount of proxy
 * quota (one request to a tiny echo endpoint).
 *
 * Usage:
 *   node scripts/check-proxy.js                 # reads SCRAPER_PROXY_URL from .env
 *   SCRAPER_PROXY_URL='http://user:pass@gw.dataimpulse.com:823' node scripts/check-proxy.js
 *
 * Exit codes: 0 = proxy healthy, 1 = actionable problem (message says which).
 */

import 'dotenv/config'
import net from 'node:net'

const PROBE_URL = 'https://api.ipify.org?format=json'
const url = process.env.SCRAPER_PROXY_URL

if (!url) {
  console.error('✗ SCRAPER_PROXY_URL is not set.')
  console.error('  Scrapers using useProxy:true will egress direct (datacenter IP) and may be bot-challenged.')
  process.exit(1)
}

let parsed
try {
  parsed = new URL(url)
} catch {
  console.error('✗ SCRAPER_PROXY_URL is not a parseable URL.')
  console.error('  Expected shape: http://<user>:<pass>@<host>:<port>')
  process.exit(1)
}

const redacted = `${parsed.protocol}//${parsed.username ? parsed.username + ':***@' : ''}${parsed.hostname}:${parsed.port || '(none)'}`
console.log(`Proxy under test: ${redacted}`)

if (!parsed.port) {
  console.error('✗ No explicit port. proxyConfigFromUrl() returns null without one, so Puppeteer scrapers')
  console.error('  will silently skip the proxy. Add the port (DataImpulse: 823 rotating, 824 sticky).')
  process.exit(1)
}
if (!parsed.username || !parsed.password) {
  console.error('✗ No credentials in the URL. DataImpulse answers unauthenticated CONNECT with 407 NO_USER.')
  process.exit(1)
}

// ── 1. Is the gateway even listening? ────────────────────────────────────────
const reachable = await new Promise((resolve) => {
  const sock = net.connect({ host: parsed.hostname, port: Number(parsed.port) })
  const done = (v) => { sock.destroy(); resolve(v) }
  sock.setTimeout(8000)
  sock.on('connect', () => done(true))
  sock.on('timeout', () => done(false))
  sock.on('error', () => done(false))
})

if (!reachable) {
  console.error(`✗ Cannot open a TCP connection to ${parsed.hostname}:${parsed.port}.`)
  console.error('  → The gateway is down, the port is wrong, or egress to it is firewalled.')
  process.exit(1)
}
console.log('✓ TCP reachable')

// ── 2. Does a real proxied request succeed? ──────────────────────────────────
let ProxyAgent, fetch
try {
  ;({ ProxyAgent, fetch } = await import('undici'))
} catch {
  console.error('✗ undici is not installed — run `npm ci`.')
  process.exit(1)
}

// The dispatcher and the fetch MUST come from the same undici major; Node's
// global fetch is backed by Node's bundled undici and will reject a v8 agent.
try {
  const res = await fetch(PROBE_URL, { dispatcher: new ProxyAgent(url) })
  const body = await res.text()
  console.log(`✓ Proxied request succeeded — HTTP ${res.status}`)
  console.log(`✓ Egress IP as seen by the internet: ${body.trim()}`)
  console.log('\nPROXY HEALTHY. If a scraper still fails, the source is challenging the residential IP itself')
  console.log('(Cloudflare "Just a moment..." is a JS challenge — that needs the Puppeteer path, not a proxy).')
  process.exit(0)
} catch (err) {
  const chain = []
  for (let e = err, d = 0; e && d < 5; e = e.cause, d++) {
    chain.push(`${e.name ?? 'Error'}: ${e.message}${e.code ? ` (${e.code})` : ''}`)
  }
  const detail = chain.join(' <= ')
  console.error(`✗ Proxied request failed\n  ${detail}\n`)

  if (/407/.test(detail)) {
    console.error('  → 407 from the proxy: the CREDENTIAL is being rejected.')
    console.error('    Most likely the DataImpulse password was rotated without updating the Actions secret,')
    console.error('    or the sub-user is disabled, or the PAYG balance is exhausted (DataImpulse 407s a')
    console.error('    depleted plan rather than returning a billing error).')
    console.error('    Check the balance at dataimpulse.com, then:')
    console.error("      gh secret set SCRAPER_PROXY_URL --body 'http://<user>:<pass>@gw.dataimpulse.com:823'")
  } else if (/TIMEOUT|ConnectTimeout/i.test(detail)) {
    console.error('  → Connect timeout: the port answered TCP but not the proxy handshake. Wrong port?')
  } else if (/onRequestStart|invalid/i.test(detail)) {
    console.error('  → Dispatcher/fetch undici major mismatch (the 2026-08-20 bug). Pair the ProxyAgent with')
    console.error("    undici's own fetch, not globalThis.fetch.")
  } else {
    console.error('  → Unrecognised failure; the cause chain above is the thing to search for.')
  }
  process.exit(1)
}
