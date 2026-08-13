import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { loadConfig, mintJwt } from './ga-snapshot.js'

/**
 * GA4 top pages: most-viewed event detail pages over a recent window.
 *
 * Companion to ga-snapshot.js — same env contract, same auth path. Queries the
 * GA4 Data API (v1beta runReport) for screenPageViews by pagePath, filtered to
 * event detail pages (pagePath begins with /events/), and prints one JSON line
 * per page to stdout, most-viewed first:
 *
 *   {"pagePath":"/events/porchrokr-2026","views":312,"users":198}
 *
 * Usage:
 *   node scripts/ga-top-pages.js [--days 7] [--limit 20] [--prefix /events/]
 *
 * Env vars (both required — see ga-snapshot.js):
 *   GA4_PROPERTY_ID   Numeric GA4 property id
 *   GA4_SA_KEY_B64    Single-line base64 of the service-account JSON key
 *
 * NOT_CONFIGURED contract: identical to ga-snapshot.js — missing env prints
 * NOT_CONFIGURED and exits 0; real failures print one stderr line prefixed
 * "ga-top-pages:" and exit 1, never including key material or tokens.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** Parse --days/--limit/--prefix with safe defaults and hard bounds. */
export function parseArgs(argv) {
  const out = { days: 7, limit: 20, prefix: '/events/' }
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i]
    if (argv[i] === '--days') out.days = Number(next())
    else if (argv[i] === '--limit') out.limit = Number(next())
    else if (argv[i] === '--prefix') out.prefix = String(next() ?? out.prefix)
  }
  if (!Number.isInteger(out.days) || out.days < 1 || out.days > 90) {
    throw new Error('--days must be an integer between 1 and 90')
  }
  if (!Number.isInteger(out.limit) || out.limit < 1 || out.limit > 100) {
    throw new Error('--limit must be an integer between 1 and 100')
  }
  if (!out.prefix.startsWith('/')) {
    throw new Error('--prefix must start with /')
  }
  return out
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) })
  const body = await res.text()
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`)
  }
  return JSON.parse(body)
}

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
  if (!data.access_token) throw new Error('token endpoint returned no access_token')
  return data.access_token
}

/** Top pages by views under `prefix`, last `days` days ending yesterday. */
async function runReport(token, propertyId, { days, limit, prefix }) {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`
  return fetchJson(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }],
      dimensionFilter: {
        filter: {
          fieldName: 'pagePath',
          stringFilter: { matchType: 'BEGINS_WITH', value: prefix },
        },
      },
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: String(limit),
    }),
  })
}

/**
 * Shape rows into printable objects. Metric values are matched to names via
 * metricHeaders by index, never assumed order (same contract as ga-snapshot).
 */
export function formatRows(report) {
  const metricHeaders = report?.metricHeaders || []
  const viewsIdx = metricHeaders.findIndex((h) => h.name === 'screenPageViews')
  const usersIdx = metricHeaders.findIndex((h) => h.name === 'totalUsers')
  return (report?.rows || []).map((row) => ({
    pagePath: row.dimensionValues?.[0]?.value ?? '',
    views: Number(viewsIdx >= 0 ? row.metricValues?.[viewsIdx]?.value ?? 0 : 0),
    users: Number(usersIdx >= 0 ? row.metricValues?.[usersIdx]?.value ?? 0 : 0),
  }))
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2))
    const config = loadConfig()
    if (!config) {
      console.log('NOT_CONFIGURED')
      return
    }
    const token = await getAccessToken(config.sa)
    const report = await runReport(token, config.propertyId, args)
    const rows = formatRows(report)
    if (rows.length === 0) {
      console.log(JSON.stringify({ note: `no pageviews under ${args.prefix} in last ${args.days} days` }))
      return
    }
    for (const row of rows) console.log(JSON.stringify(row))
  } catch (err) {
    console.error(`ga-top-pages: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
