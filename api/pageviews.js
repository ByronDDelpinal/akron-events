/**
 * /api/pageviews — public traffic stats for the /financials page.
 *
 * Returns 30-day active users, 30-day pageviews, and the list of embed
 * partner sites with SUSTAINED traffic (not one-time referrals), read from
 * the GA4 Data API:
 *
 *   { available: true, totalUsers30d: 2859, pageviews30d: 10400,
 *     embedHosts: [{ host: 'betterkenmore.org', views: 412 }] }
 *
 * totalUsers30d is the PRIMARY public metric as of the 2026-08-17
 * users-first refactor (see src/lib/financials.ts's TODAY_MONTHLY_ACTIVE_USERS)
 * - pageviews30d stays in the response, backward compatible, for anything
 * that still wants the internal traffic unit.
 *
 * Sustained = at least MIN_VIEWS views spread across at least MIN_WEEKS
 * distinct ISO weeks inside the trailing WINDOW_DAYS. Those three constants
 * are the server-side half of EMBED_PARTNER_POLICY in src/lib/financials.ts,
 * which is what /financials tells the reader the rule is. They are exported
 * so scripts/tests/test-financials-model.js can assert the two halves are
 * equal, instead of the pair relying on a comment nobody re-reads.
 *
 * Configuration (Vercel env vars):
 *   GA4_PROPERTY_ID   — numeric GA4 property id (Admin → Property settings)
 *   GA4_CLIENT_EMAIL  — service account email with Viewer access to the property
 *   GA4_PRIVATE_KEY   — the service account's PEM private key. Vercel stores
 *                       newlines literally; both real and "\n"-escaped keys work.
 *
 * Unconfigured or failing, the endpoint returns { available: false } with a
 * SHORT cache so the page degrades gracefully and recovers quickly once env
 * vars land. Success responses are edge-cached for a day — this number does
 * not need to be fresher than that, and one GA4 hit per day keeps us far
 * inside the API's free quota.
 *
 * No SDK on purpose: the Google auth handshake is a signed JWT swapped for an
 * access token, ~40 lines of node:crypto, versus adding googleapis (heavy) to
 * every function's cold start.
 */

import { createSign } from 'node:crypto'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly'

// The embed-partner policy, server side. Must equal EMBED_PARTNER_POLICY in
// src/lib/financials.ts (minViews / minWeeks / windowDays); the sync is
// asserted by scripts/tests/test-financials-model.js.
export const MIN_VIEWS = 100
export const MIN_WEEKS = 2
export const WINDOW_DAYS = 30

/** Hosts that are not real embed partners, whatever the volume. */
const IGNORED_HOSTS = new Set(['(direct)', '(unknown)', '(not set)', 'akronpulse.com', 'localhost'])

/**
 * Per-request timeout for both outbound calls. Without one, a hung Google
 * endpoint holds the function open until the platform kills it, and the page
 * spins instead of degrading to { available: false }.
 */
const FETCH_TIMEOUT_MS = 8000

const b64url = (buf) => Buffer.from(buf).toString('base64url')

/** Mint a GA4 access token from service-account credentials. */
async function getAccessToken(clientEmail, privateKey) {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(JSON.stringify({
    iss: clientEmail,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claims}`)
  const signature = signer.sign(privateKey.replace(/\\n/g, '\n'), 'base64url')

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`)
  const json = await res.json()
  return json.access_token
}

async function runReport(propertyId, token, body) {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  )
  // Status only, never the response body. A GA4 permission failure echoes the
  // service-account email back in its error payload, and this message is
  // console.error'd in the handler below. Nothing reaches the client either
  // way, but the deploy logs are not the place for a credential identifier.
  if (!res.ok) throw new Error(`runReport failed: ${res.status}`)
  return res.json()
}

/** ISO week key (YYYY-Www) for a GA4 `date` dimension value (YYYYMMDD). */
export function isoWeekKey(yyyymmdd) {
  const d = new Date(Date.UTC(
    Number(yyyymmdd.slice(0, 4)),
    Number(yyyymmdd.slice(4, 6)) - 1,
    Number(yyyymmdd.slice(6, 8)),
  ))
  // Shift to the Thursday of this week — ISO weeks belong to the year of
  // their Thursday — then count weeks from the year's first Thursday.
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * Reduce (host, date, views) rows to hosts with sustained traffic.
 * Pure — exercised directly by scripts/tests/test-pageviews-api.js.
 */
export function aggregateSustainedHosts(rows, { minViews = MIN_VIEWS, minWeeks = MIN_WEEKS } = {}) {
  const byHost = new Map()
  for (const { host, date, views } of rows) {
    if (!host || IGNORED_HOSTS.has(host)) continue
    const entry = byHost.get(host) ?? { views: 0, weeks: new Set() }
    entry.views += views
    if (views > 0) entry.weeks.add(isoWeekKey(date))
    byHost.set(host, entry)
  }
  return [...byHost.entries()]
    .filter(([, e]) => e.views >= minViews && e.weeks.size >= minWeeks)
    .map(([host, e]) => ({ host, views: e.views }))
    .sort((a, b) => b.views - a.views)
}

export default async function handler(req, res) {
  const propertyId = process.env.GA4_PROPERTY_ID
  const clientEmail = process.env.GA4_CLIENT_EMAIL
  const privateKey = process.env.GA4_PRIVATE_KEY

  if (!propertyId || !clientEmail || !privateKey) {
    res.setHeader('Cache-Control', 's-maxage=300')
    res.status(200).json({ available: false })
    return
  }

  try {
    const token = await getAccessToken(clientEmail, privateKey)
    const dateRanges = [{ startDate: `${WINDOW_DAYS}daysAgo`, endDate: 'today' }]

    // Report 1: total active users and total pageviews, trailing 30 days,
    // all surfaces. One report, two metrics — totalUsers is the primary
    // public figure (users-first, 2026-08-17); screenPageViews stays the
    // internal unit the cost model's traffic driver evaluates against.
    const totals = await runReport(propertyId, token, {
      dateRanges,
      metrics: [{ name: 'totalUsers' }, { name: 'screenPageViews' }],
    })
    const totalUsers30d = Number(totals.rows?.[0]?.metricValues?.[0]?.value ?? 0)
    const pageviews30d = Number(totals.rows?.[0]?.metricValues?.[1]?.value ?? 0)

    // Report 2: embed views by host and day. embed_host is an event-scoped
    // custom dimension (set as a default gtag param in src/lib/analytics.ts);
    // until it's registered in GA4 Admin this report errors — treat that as
    // "no partners yet" rather than failing the whole endpoint.
    let embedHosts = []
    try {
      const embeds = await runReport(propertyId, token, {
        dateRanges,
        dimensions: [{ name: 'customEvent:embed_host' }, { name: 'date' }],
        metrics: [{ name: 'screenPageViews' }],
        limit: 10000,
      })
      const rows = (embeds.rows ?? []).map(r => ({
        host: r.dimensionValues[0].value,
        date: r.dimensionValues[1].value,
        views: Number(r.metricValues[0].value),
      }))
      embedHosts = aggregateSustainedHosts(rows)
    } catch {
      embedHosts = []
    }

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=172800')
    res.status(200).json({ available: true, totalUsers30d, pageviews30d, embedHosts })
  } catch (err) {
    console.error('pageviews:', err.message)
    res.setHeader('Cache-Control', 's-maxage=300')
    res.status(200).json({ available: false })
  }
}
