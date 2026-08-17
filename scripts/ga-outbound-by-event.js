import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { loadConfig, mintJwt } from './ga-snapshot.js'

/**
 * GA4 outbound clicks, aggregated by event detail page.
 *
 * Companion to ga-snapshot.js / ga-top-pages.js — same env contract, same auth
 * path. Answers "which events sent the most people off the platform?" by
 * querying the GA4 Data API (v1beta runReport) for the `outbound_click` event
 * (src/lib/analyticsEvents.ts EVENTS.OUTBOUND_CLICK), grouped by pagePath.
 *
 * WHY pagePath: `outbound_click` carries link_type / source_tier / category but
 * NO event identifier, and it is fired from exactly one place
 * (src/pages/EventPage.tsx). The event detail page's path is therefore the only
 * per-event key available. Join the slug back to events.slug for titles.
 *
 * Prints one JSON line per page, most clicks first:
 *   {"pagePath":"/events/porchrokr-...","clicks":42,"users":31,"tickets":30,"source":12}
 *
 * The tickets/source split comes from the `link_type` custom dimension. If that
 * dimension is not registered in GA4, those two keys are omitted and a
 * {"note":"link_type unavailable..."} line is printed instead of failing — the
 * totals are still correct.
 *
 * Usage:
 *   node scripts/ga-outbound-by-event.js [--days 7] [--limit 100]
 *
 * Env vars (both required — see ga-snapshot.js):
 *   GA4_PROPERTY_ID   Numeric GA4 property id
 *   GA4_SA_KEY_B64    Single-line base64 of the service-account JSON key
 *
 * NOT_CONFIGURED contract: identical to its siblings — missing env prints
 * NOT_CONFIGURED and exits 0; real failures print one stderr line prefixed
 * "ga-outbound-by-event:" and exit 1, never including key material or tokens.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://analyticsdata.googleapis.com/v1beta'
const EVENT_NAME = 'outbound_click'

export function parseArgs(argv) {
  const out = { days: 7, limit: 100 }
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i]
    if (argv[i] === '--days') out.days = Number(next())
    else if (argv[i] === '--limit') out.limit = Number(next())
  }
  if (!Number.isInteger(out.days) || out.days < 1 || out.days > 90) {
    throw new Error('--days must be an integer between 1 and 90')
  }
  if (!Number.isInteger(out.limit) || out.limit < 1 || out.limit > 1000) {
    throw new Error('--limit must be an integer between 1 and 1000')
  }
  return out
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) })
  const body = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`)
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

function report(token, propertyId, body) {
  return fetchJson(`${API}/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const eventFilter = {
  filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: EVENT_NAME } },
}

/** Totals by pagePath. */
export function runTotals(token, propertyId, { days, limit }) {
  return report(token, propertyId, {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
    dimensionFilter: eventFilter,
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: String(limit),
  })
}

/** Same, split by the link_type custom dimension. May legitimately fail. */
export function runByLinkType(token, propertyId, { days, limit }) {
  return report(token, propertyId, {
    dateRanges: [{ startDate: `${days}daysAgo`, endDate: 'yesterday' }],
    dimensions: [{ name: 'pagePath' }, { name: 'customEvent:link_type' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: eventFilter,
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: String(limit * 3),
  })
}

/** Metric values matched to names via metricHeaders by index, never by order. */
export function formatTotals(rep) {
  const mh = rep?.metricHeaders || []
  const cIdx = mh.findIndex((h) => h.name === 'eventCount')
  const uIdx = mh.findIndex((h) => h.name === 'totalUsers')
  return (rep?.rows || []).map((row) => ({
    pagePath: row.dimensionValues?.[0]?.value ?? '',
    clicks: Number(cIdx >= 0 ? row.metricValues?.[cIdx]?.value ?? 0 : 0),
    users: Number(uIdx >= 0 ? row.metricValues?.[uIdx]?.value ?? 0 : 0),
  }))
}

export function formatLinkTypes(rep) {
  const out = new Map()
  for (const row of rep?.rows || []) {
    const path = row.dimensionValues?.[0]?.value ?? ''
    const type = row.dimensionValues?.[1]?.value ?? ''
    const n = Number(row.metricValues?.[0]?.value ?? 0)
    if (!out.has(path)) out.set(path, {})
    if (type === 'tickets' || type === 'source') out.get(path)[type] = n
  }
  return out
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2))
    const config = loadConfig()
    if (!config) { console.log('NOT_CONFIGURED'); return }

    const token = await getAccessToken(config.sa)
    const rows = formatTotals(await runTotals(token, config.propertyId, args))

    if (rows.length === 0) {
      console.log(JSON.stringify({ note: `no ${EVENT_NAME} events in last ${args.days} days` }))
      return
    }

    let split = new Map()
    try {
      split = formatLinkTypes(await runByLinkType(token, config.propertyId, args))
    } catch {
      console.log(JSON.stringify({ note: 'link_type unavailable (custom dimension not registered); totals still correct' }))
    }

    let totalClicks = 0
    for (const row of rows) {
      totalClicks += row.clicks
      console.log(JSON.stringify({ ...row, ...(split.get(row.pagePath) || {}) }))
    }
    console.log(JSON.stringify({ summary: true, pages: rows.length, totalClicks, days: args.days }))
  } catch (err) {
    console.error(`ga-outbound-by-event: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
