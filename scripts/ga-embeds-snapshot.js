import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { loadConfig, mintJwt } from './ga-snapshot.js'

/**
 * GA4 embed-reach snapshot: which partner sites embed Akron Pulse and how many
 * views they drove YESTERDAY, for the 9am morning briefing.
 *
 * Reuses ga-snapshot.js's service-account auth (same GA4_PROPERTY_ID /
 * GA4_SA_KEY_B64) and runs a report grouped by the `embed_host` custom
 * dimension, filtered to `surface = embed`, ordered by views. Prints a single
 * JSON line to stdout, e.g.:
 *
 *   {"embeds":[{"host":"everydayakron.com","views":128,"users":41},
 *              {"host":"southgatefarm.com","views":34,"users":12}]}
 *
 * `embed_host` and `surface` are set on every hit by src/lib/analytics.ts, but
 * they only become queryable once registered as event-scoped custom dimensions
 * in GA4 Admin. Until then the Data API rejects the field; we treat that (and
 * missing creds) as NOT_CONFIGURED so the briefing omits the tile rather than
 * going red.
 *
 * Usage:  node scripts/ga-embeds-snapshot.js
 *
 * NOT_CONFIGURED contract: printed to stdout (exit 0) when GA creds are absent
 * OR the custom dimensions aren't registered yet. Real failures print one line
 * to stderr prefixed "ga-embeds-snapshot:" and exit 1. Error paths never
 * include key material, JWT assertions, or access tokens.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
// Number of embedding sites to report. Low-cardinality in practice (a handful
// of partners); the cap just bounds a pathological long tail.
const LIMIT = 25

/** fetch wrapper: 10s timeout, JSON response; non-2xx throws with a truncated body. */
async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) })
  const body = await res.text()
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`)
    err.status = res.status
    throw err
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
  if (!data.access_token) throw new Error('token endpoint returned no access_token')
  return data.access_token
}

/** Run the GA4 report: yesterday, views + users by embed_host, embed surface only. */
async function runEmbedReport(token, propertyId) {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`
  return fetchJson(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
      dimensions: [{ name: 'customEvent:embed_host' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }],
      dimensionFilter: {
        filter: {
          fieldName: 'customEvent:surface',
          stringFilter: { matchType: 'EXACT', value: 'embed' },
        },
      },
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: LIMIT,
    }),
  })
}

/**
 * A 400 that names the custom dimension/metric means it isn't registered in
 * GA4 yet — a setup step, not a failure. Matched narrowly so a genuine API
 * error still surfaces as a real error.
 */
export function isDimensionNotRegistered(message) {
  return /is not a valid (dimension|metric)/i.test(message) ||
         /Field customEvent:(embed_host|surface)/i.test(message)
}

/** Shape the API response into the one-line JSON we print. */
export function formatOutput(report) {
  const rows = report?.rows || []
  const dimHeaders = report?.dimensionHeaders || []
  const metHeaders = report?.metricHeaders || []
  const hostIdx = dimHeaders.findIndex((h) => h.name === 'customEvent:embed_host')
  const viewsIdx = metHeaders.findIndex((h) => h.name === 'screenPageViews')
  const usersIdx = metHeaders.findIndex((h) => h.name === 'activeUsers')

  const embeds = rows.map((r) => {
    const rawHost = hostIdx >= 0 ? r.dimensionValues?.[hostIdx]?.value : undefined
    const host = rawHost && rawHost !== '(not set)' ? rawHost : '(unknown)'
    const views = Number((viewsIdx >= 0 ? r.metricValues?.[viewsIdx]?.value : 0) ?? 0)
    const users = Number((usersIdx >= 0 ? r.metricValues?.[usersIdx]?.value : 0) ?? 0)
    return { host, views, users }
  })
  return { embeds }
}

async function main() {
  try {
    const config = loadConfig()
    if (!config) {
      console.log('NOT_CONFIGURED')
      return
    }
    const token = await getAccessToken(config.sa)
    let report
    try {
      report = await runEmbedReport(token, config.propertyId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (err?.status === 400 && isDimensionNotRegistered(msg)) {
        console.log('NOT_CONFIGURED')
        return
      }
      throw err
    }
    console.log(JSON.stringify(formatOutput(report)))
  } catch (err) {
    console.error(`ga-embeds-snapshot: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
