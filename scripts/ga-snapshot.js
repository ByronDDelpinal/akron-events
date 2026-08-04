import 'dotenv/config'
import { createSign, createPrivateKey } from 'node:crypto'
import { pathToFileURL } from 'node:url'

/**
 * GA4 snapshot: yesterday's traffic metrics for the 9am morning briefing.
 *
 * Fetches activeUsers, totalUsers, and screenPageViews for yesterday from the
 * Google Analytics Data API (v1beta runReport) and prints a single JSON line
 * to stdout, e.g.:
 *
 *   {"date":"2026-08-03","activeUsers":42,"totalUsers":45,"screenPageViews":180}
 *
 * Usage:
 *   node scripts/ga-snapshot.js
 *
 * Env vars (both required):
 *   GA4_PROPERTY_ID   Numeric GA4 property id (538991588)
 *   GA4_SA_KEY_B64    Single-line base64 of the Google service-account JSON
 *                     key (the whole key file, base64-encoded)
 *
 * NOT_CONFIGURED contract: when either env var is missing or empty, the
 * script prints the literal line NOT_CONFIGURED to stdout and exits 0, so
 * callers (the morning briefing) can skip the section without treating the
 * absence of credentials as a failure. Real failures (bad key, API error)
 * print one line to stderr prefixed "ga-snapshot:" and exit 1. Error paths
 * never include key material, JWT assertions, or access tokens.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GA_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly'
const METRICS = ['activeUsers', 'totalUsers', 'screenPageViews']

/**
 * Read and validate config from env. Missing or empty env vars mean the
 * feature is intentionally unconfigured: return null. A present-but-broken
 * key is a real error: throw with a clean message that never echoes the
 * decoded payload or any key material.
 */
export function loadConfig() {
  const propertyId = (process.env.GA4_PROPERTY_ID || '').trim()
  const keyB64 = (process.env.GA4_SA_KEY_B64 || '').trim()
  if (!propertyId || !keyB64) return null

  let sa
  try {
    sa = JSON.parse(Buffer.from(keyB64, 'base64').toString('utf8'))
  } catch {
    throw new Error('GA4_SA_KEY_B64 is not valid base64-encoded JSON')
  }
  if (!sa || typeof sa !== 'object' || !sa.client_email || !sa.private_key) {
    throw new Error('service-account key is missing client_email or private_key')
  }
  try {
    createPrivateKey(sa.private_key)
  } catch {
    throw new Error('service-account private_key failed to parse as a PEM key')
  }
  return { propertyId, sa }
}

/** Base64url encoding per RFC 7515 (JWT segments). */
export function b64url(input) {
  return Buffer.from(input).toString('base64url')
}

/**
 * Mint a short-lived RS256 JWT asserting the service-account identity,
 * scoped to Analytics read-only. Exchanged for an access token below.
 */
export function mintJwt(sa) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: GA_SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    })
  )
  const unsigned = `${header}.${claims}`
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(sa.private_key, 'base64url')
  return `${unsigned}.${signature}`
}

/**
 * fetch wrapper: 10s timeout, JSON response. Non-2xx throws with the status
 * and the response body truncated to 200 chars (Google error bodies are safe
 * to surface; our own secrets never appear in them).
 */
async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) })
  const body = await res.text()
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`)
  }
  return JSON.parse(body)
}

/** Exchange the signed JWT for an OAuth2 access token. */
async function getAccessToken(sa) {
  const params = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: mintJwt(sa),
  })
  const data = await fetchJson(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  if (!data.access_token) {
    throw new Error('token endpoint returned no access_token')
  }
  return data.access_token
}

/** Run the GA4 report: yesterday only, three metrics, date dimension. */
async function runReport(token, propertyId) {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`
  return fetchJson(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
      metrics: METRICS.map((name) => ({ name })),
      dimensions: [{ name: 'date' }],
    }),
  })
}

/**
 * Shape the API response into the one-line JSON we print. No rows (a brand
 * new property, or zero traffic yesterday) yields all-zero metrics with no
 * date key. Metric values are matched to names via metricHeaders by index,
 * never by assumed order, since the API echoes whatever order it likes.
 */
export function formatOutput(report) {
  const out = {}
  const rows = report?.rows || []
  if (rows.length === 0) {
    for (const name of METRICS) out[name] = 0
    return out
  }

  const row = rows[0]
  const dimHeaders = report.dimensionHeaders || []
  const dateIdx = dimHeaders.findIndex((h) => h.name === 'date')
  const raw = dateIdx >= 0 ? row.dimensionValues?.[dateIdx]?.value : undefined
  if (raw && /^\d{8}$/.test(raw)) {
    out.date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  } else if (raw) {
    out.date = raw
  }

  const metricHeaders = report.metricHeaders || []
  for (const name of METRICS) {
    const idx = metricHeaders.findIndex((h) => h.name === name)
    const value = idx >= 0 ? row.metricValues?.[idx]?.value : undefined
    out[name] = Number(value ?? 0)
  }
  return out
}

async function main() {
  try {
    const config = loadConfig()
    if (!config) {
      console.log('NOT_CONFIGURED')
      return
    }
    const token = await getAccessToken(config.sa)
    const report = await runReport(token, config.propertyId)
    console.log(JSON.stringify(formatOutput(report)))
  } catch (err) {
    console.error(`ga-snapshot: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
