import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { loadConfig, mintJwt } from './ga-snapshot.js'

/**
 * GA4 PWA-install snapshot for the 9am morning briefing.
 *
 * Answers "is the app actually installed and used?" — the one thing the
 * standard traffic metrics can't show. Prints a single JSON line, e.g.:
 *
 *   {"installedUsers28d":41,"launchesYesterday":12,"launchUsersYesterday":6,"nativeInstallsYesterday":1}
 *
 * Metrics (GA4 event names are case-sensitive — only the canonical lowercase
 * events are queried; legacy capitalized remnants are ignored):
 *   - installedUsers28d      distinct users who opened the app in standalone
 *                            (home-screen) mode in the last 28 days. This is the
 *                            reliable CROSS-PLATFORM install-and-use signal — the
 *                            only way iOS installs are visible at all.
 *   - launchesYesterday      pwa_standalone_launch event count, yesterday.
 *   - launchUsersYesterday   distinct standalone users, yesterday.
 *   - nativeInstallsYesterday pwa_install_accepted count, yesterday (Android/
 *                            desktop prompt only; iOS never fires this).
 *
 * Reuses ga-snapshot.js's service-account auth. Same NOT_CONFIGURED contract:
 * missing/empty GA4_PROPERTY_ID or GA4_SA_KEY_B64 prints the literal line
 * NOT_CONFIGURED and exits 0. Real failures print one "ga-install-snapshot:"
 * line to stderr and exit 1 — never echoing key material or tokens.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const STANDALONE = 'pwa_standalone_launch'
const INSTALL_ACCEPTED = 'pwa_install_accepted'

async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) })
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

function runReport(token, propertyId, requestBody) {
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`
  return fetchJson(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })
}

/** eventName -> { eventCount, totalUsers } from a report keyed on eventName. */
function indexByEvent(report) {
  const out = {}
  const dimHeaders = report?.dimensionHeaders || []
  const metHeaders = report?.metricHeaders || []
  const nameIdx = dimHeaders.findIndex((h) => h.name === 'eventName')
  const countIdx = metHeaders.findIndex((h) => h.name === 'eventCount')
  const usersIdx = metHeaders.findIndex((h) => h.name === 'totalUsers')
  for (const row of report?.rows || []) {
    const name = row.dimensionValues?.[nameIdx]?.value
    if (!name) continue
    out[name] = {
      eventCount: Number(countIdx >= 0 ? row.metricValues?.[countIdx]?.value ?? 0 : 0),
      totalUsers: Number(usersIdx >= 0 ? row.metricValues?.[usersIdx]?.value ?? 0 : 0),
    }
  }
  return out
}

const inList = (values) => ({
  filter: { fieldName: 'eventName', inListFilter: { values } },
})

async function main() {
  try {
    const config = loadConfig()
    if (!config) {
      console.log('NOT_CONFIGURED')
      return
    }
    const token = await getAccessToken(config.sa)

    // Yesterday: new native installs + standalone launches/users.
    const yesterday = await runReport(token, config.propertyId, {
      dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }, { name: 'totalUsers' }],
      dimensionFilter: inList([STANDALONE, INSTALL_ACCEPTED]),
    })
    // Trailing 28 days: installed-and-active user base (cross-platform).
    const rolling = await runReport(token, config.propertyId, {
      dateRanges: [{ startDate: '28daysAgo', endDate: 'yesterday' }],
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'totalUsers' }],
      dimensionFilter: inList([STANDALONE]),
    })

    const y = indexByEvent(yesterday)
    const r = indexByEvent(rolling)
    const out = {
      installedUsers28d: r[STANDALONE]?.totalUsers ?? 0,
      launchesYesterday: y[STANDALONE]?.eventCount ?? 0,
      launchUsersYesterday: y[STANDALONE]?.totalUsers ?? 0,
      nativeInstallsYesterday: y[INSTALL_ACCEPTED]?.eventCount ?? 0,
    }
    console.log(JSON.stringify(out))
  } catch (err) {
    console.error(`ga-install-snapshot: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
