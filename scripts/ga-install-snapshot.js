import 'dotenv/config'
import { pathToFileURL } from 'node:url'
import { loadConfig, mintJwt } from './ga-snapshot.js'

/**
 * GA4 PWA-install snapshot for the 9am morning briefing.
 *
 * Answers "is the app actually installed and used?" - the one thing the
 * standard traffic metrics can't show. Prints a single JSON line, e.g.:
 *
 *   {"installedUsers28d":42,"launchesYesterday":19,"launchUsersYesterday":14,
 *    "nativeInstallsYesterday":3,
 *    "installs":{"totalAllTime":44,"active28d":42,"since":"2026-05-27",
 *                "byPlatform":[{"platform":"Android","allTime":21,"active28d":20},
 *                              {"platform":"iOS","allTime":19,"active28d":18},
 *                              {"platform":"Other","allTime":4,"active28d":4}]}}
 *
 * EVERY window ends at 'yesterday', the all-time one included. Today is a
 * partial day that keeps growing, so ending at 'today' would make the same
 * script print a different all-time headline at 9am than at noon. A number
 * that drifts within the day is worse than one that is a day behind: expect
 * these figures to run slightly below anything you measure ad hoc with an
 * endDate of 'today', and do not "correct" them.
 *
 * Metrics (GA4 event names are case-sensitive - only the canonical lowercase
 * events are queried; legacy capitalized remnants are ignored):
 *   - installedUsers28d      distinct users who opened the app in standalone
 *                            (home-screen) mode in the last 28 days. This is the
 *                            reliable CROSS-PLATFORM install-and-use signal - the
 *                            only way iOS installs are visible at all.
 *   - launchesYesterday      pwa_standalone_launch event count, yesterday.
 *   - launchUsersYesterday   distinct standalone users, yesterday.
 *   - nativeInstallsYesterday pwa_install_accepted count, yesterday (Android/
 *                            desktop prompt only; iOS never fires this).
 *
 * The top four keys are load-bearing: the live briefing prompt reads them by
 * name, so their names, types and derivation are frozen. The `installs` section
 * is strictly additive and self-contained: it answers "how big is the installed
 * base all time, and on what?" with one signal only (pwa_standalone_launch).
 * installs.active28d deliberately duplicates installedUsers28d (same value,
 * same report) so a reader of the section never has to look outside it.
 * pwa_install_accepted stays out of the section on purpose: one signal per
 * section, and it is Android/desktop-only so it would skew a platform split.
 *
 * Reuses ga-snapshot.js's service-account auth. Same NOT_CONFIGURED contract:
 * missing/empty GA4_PROPERTY_ID or GA4_SA_KEY_B64 prints the literal line
 * NOT_CONFIGURED and exits 0. Real failures print one "ga-install-snapshot:"
 * line to stderr and exit 1 - never echoing key material or tokens. There is
 * deliberately NO NOT_CONFIGURED escape hatch for the all-time reports: they
 * use only built-in dimensions and metrics, so there is no "custom dimension
 * not registered yet" state to absorb. A 400 there is a bug and must go red.
 * Failure is all-or-nothing: no partial JSON is ever printed.
 *
 * Usage:  node scripts/ga-install-snapshot.js
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const STANDALONE = 'pwa_standalone_launch'
const INSTALL_ACCEPTED = 'pwa_install_accepted'

/**
 * First day of data in the GA4 property, i.e. what "all time" actually covers.
 * GA4 has no "since the beginning" date literal, so the window has to start at
 * a hardcoded date. It is emitted as installs.since precisely so this constant
 * cannot rot in silence: if the property is ever recreated, or historical data
 * is backfilled earlier than this, the date shown in the briefing every morning
 * is the thing that looks wrong and gets it updated.
 */
const TRACKING_START = '2026-05-27'

// Names given to the two date ranges of the by-operating-system report. When a
// request carries more than one dateRange, GA4 appends its own `dateRange`
// dimension to every row; these are the values it puts there.
const RANGE_ALL_TIME = 'allTime'
const RANGE_28D = 'd28'

// Platform buckets. `Other` is a real, reportable bucket (it is where desktop
// installs live), never a dumping ground that gets dropped.
const ANDROID = 'Android'
const IOS = 'iOS'
const OTHER = 'Other'

// Bounds the by-OS report. operatingSystem is low-cardinality (a dozen values
// at most), so this only guards against a pathological long tail.
const OS_LIMIT = 50

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

/**
 * eventName -> { eventCount, totalUsers } from a report keyed on eventName.
 *
 * ASSUMES A SINGLE DATE RANGE. With two or more ranges GA4 adds a `dateRange`
 * dimension and emits one row per event PER RANGE; this keys on eventName
 * alone, so the ranges would collide and the last row would silently win. If a
 * second window is ever needed, run a separate report (as the all-time reports
 * below do) rather than adding a range here.
 */
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

/**
 * eventName in-list filter, case-sensitive because GA4's inListFilter defaults
 * that to FALSE. Here the flag is belt-and-braces rather than load-bearing:
 * these reports group BY eventName, so a legacy capitalized
 * `Pwa_install_accepted` comes back as its own row and indexByEvent, which keys
 * on the exact name, never reads it. The flag is set anyway so that the two
 * eventName filters in this file cannot drift apart, and so that adding a
 * dimension-free variant later does not quietly inherit case-insensitivity.
 * See exactEvent() for where case sensitivity actually decides a number.
 */
const inList = (values) => ({
  filter: { fieldName: 'eventName', inListFilter: { values, caseSensitive: true } },
})

/**
 * Exact eventName filter. caseSensitive is LOAD-BEARING here and must not be
 * removed. The reports using this filter have no eventName dimension, so their
 * rows are already summed across whatever the filter matched: a case-insensitive
 * EXACT match would silently pull a capitalized `Pwa_standalone_launch` into the
 * all-time totals with nothing in the output to show it happened. That is the
 * opposite of the grouped reports above, where a stray variant would at worst
 * appear as its own visible row. The property has no capitalized standalone-launch
 * rows today (only Pwa_install_accepted and friends), so this currently changes
 * no number; it is here to keep it that way if one is ever sent again.
 */
const exactEvent = (value) => ({
  filter: {
    fieldName: 'eventName',
    stringFilter: { matchType: 'EXACT', value, caseSensitive: true },
  },
})

/**
 * Map a GA4 `operatingSystem` value to a reporting bucket.
 *
 * ALLOWLIST, not a denylist: only the exact values we recognise become Android
 * or iOS, and everything else (Macintosh, Windows, Linux, Chrome OS,
 * '(not set)', '<Other>', empty, and whatever Google invents next year) falls
 * into Other. A denylist would let a new GA4 value silently inflate a headline
 * platform; this way the worst case is an over-full Other bucket, which is
 * visible rather than misleading. Note 'Macintosh' is NOT iOS.
 */
export function bucketOs(raw) {
  const key = String(raw ?? '').trim().toLowerCase()
  if (key === 'android') return ANDROID
  if (key === 'ios' || key === 'ipados') return IOS
  return OTHER
}

/** totalUsers out of an un-dimensioned single-row report. */
function totalUsersOf(report) {
  const idx = (report?.metricHeaders || []).findIndex((h) => h.name === 'totalUsers')
  const row = (report?.rows || [])[0]
  if (!row || idx < 0) return 0
  return Number(row.metricValues?.[idx]?.value ?? 0)
}

/** Other sorts last; everything else by allTime desc, then platform A-Z. */
function comparePlatforms(a, b) {
  const rank = (p) => (p === OTHER ? 1 : 0)
  return (
    rank(a.platform) - rank(b.platform) ||
    b.allTime - a.allTime ||
    a.platform.localeCompare(b.platform, 'en')
  )
}

/**
 * Shape the `installs` section.
 *
 * @param osReport     two-date-range report grouped by operatingSystem (R3)
 * @param totalReport  un-dimensioned all-time report (R4)
 * @param active28d    installedUsers28d, reused from the existing 28-day report
 *
 * ON THE NUMBERS NOT ADDING UP - THIS IS INTENDED, DO NOT "FIX" IT.
 * Every figure here is a count of DISTINCT USERS, and distinct-user counts are
 * not additive. totalAllTime comes from the un-dimensioned report and is the
 * authoritative header: one person is one person there, however many devices
 * they used. The per-platform lines come from the grouped report, where a
 * person who installed on both a phone and a laptop is counted on both lines.
 * So the lines may exceed the header (and, for the same reason, values summed
 * into the Other bucket may exceed a true distinct Other count). The script
 * deliberately never reconciles, clamps, normalises, or emits a residual row:
 * every one of those would replace a real number with an invented one.
 *
 * Rows whose all-time count is zero are omitted entirely. A zero row is never
 * synthesised, so the section only ever names platforms that really appeared.
 */
export function formatInstalls(osReport, totalReport, active28d) {
  const dimHeaders = osReport?.dimensionHeaders || []
  const metHeaders = osReport?.metricHeaders || []
  const osIdx = dimHeaders.findIndex((h) => h.name === 'operatingSystem')
  const usersIdx = metHeaders.findIndex((h) => h.name === 'totalUsers')
  // Located BY HEADER NAME, never by position: GA4 decides where in the
  // dimension list it appends its synthetic dateRange column, and it moves.
  const rangeIdx = dimHeaders.findIndex((h) => h.name === 'dateRange')

  // Every check below turns a mislabelled response into an exit-1 failure
  // rather than a plausible-looking section. A briefing that is missing is
  // obviously missing; a briefing that says "Other 44" or shows an empty
  // platform list reads as fact and gets believed.
  const rows = osReport?.rows || []
  if (rows.length > 0) {
    if (osIdx < 0) {
      // Without this the fallback would hand undefined to bucketOs and file
      // 100% of users under Other, which looks like a real finding.
      throw new Error('by-OS report has rows but no operatingSystem column; cannot bucket them')
    }
    if (rangeIdx < 0) {
      throw new Error('by-OS report has rows but no dateRange column; cannot attribute them')
    }
  }

  const buckets = new Map()
  const bucketFor = (platform) => {
    if (!buckets.has(platform)) buckets.set(platform, { platform, allTime: 0, active28d: 0 })
    return buckets.get(platform)
  }

  let attributed = 0
  for (const row of rows) {
    const range = row.dimensionValues?.[rangeIdx]?.value
    // A row belonging to neither named range is not something we can attribute,
    // so it is skipped rather than guessed into one of them.
    if (range !== RANGE_ALL_TIME && range !== RANGE_28D) continue
    attributed += 1
    const platform = bucketOs(row.dimensionValues?.[osIdx]?.value)
    const users = Number((usersIdx >= 0 ? row.metricValues?.[usersIdx]?.value : 0) ?? 0)
    const bucket = bucketFor(platform)
    if (range === RANGE_ALL_TIME) bucket.allTime += users
    else bucket.active28d += users
  }
  if (rows.length > 0 && attributed === 0) {
    // Skipping the odd unrecognised row is fine; skipping ALL of them is not.
    // It is what would happen if the `name` fields on the date ranges were ever
    // dropped and GA4 fell back to labelling them date_range_0/date_range_1,
    // and it would print an empty byPlatform under a real header.
    throw new Error(
      `by-OS report returned ${rows.length} rows, none tagged ${RANGE_ALL_TIME} or ${RANGE_28D}; cannot attribute them`
    )
  }

  const byPlatform = [...buckets.values()].filter((b) => b.allTime > 0).sort(comparePlatforms)

  return {
    totalAllTime: totalUsersOf(totalReport),
    active28d,
    since: TRACKING_START,
    byPlatform,
  }
}

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
    // Platform split. Both windows come back in one request, tagged with the
    // range names above, so all-time and 28-day lines are guaranteed to be
    // built from an identical definition of a platform.
    const byOs = await runReport(token, config.propertyId, {
      dateRanges: [
        { startDate: TRACKING_START, endDate: 'yesterday', name: RANGE_ALL_TIME },
        { startDate: '28daysAgo', endDate: 'yesterday', name: RANGE_28D },
      ],
      dimensions: [{ name: 'operatingSystem' }],
      metrics: [{ name: 'totalUsers' }],
      dimensionFilter: exactEvent(STANDALONE),
      limit: OS_LIMIT,
    })
    // Authoritative all-time headline: un-dimensioned, so GA4 does the
    // de-duplication across platforms that we cannot do ourselves.
    const allTimeTotal = await runReport(token, config.propertyId, {
      dateRanges: [{ startDate: TRACKING_START, endDate: 'yesterday' }],
      metrics: [{ name: 'totalUsers' }],
      dimensionFilter: exactEvent(STANDALONE),
    })

    const y = indexByEvent(yesterday)
    const r = indexByEvent(rolling)
    const installedUsers28d = r[STANDALONE]?.totalUsers ?? 0
    const out = {
      installedUsers28d,
      launchesYesterday: y[STANDALONE]?.eventCount ?? 0,
      launchUsersYesterday: y[STANDALONE]?.totalUsers ?? 0,
      nativeInstallsYesterday: y[INSTALL_ACCEPTED]?.eventCount ?? 0,
      installs: formatInstalls(byOs, allTimeTotal, installedUsers28d),
    }
    console.log(JSON.stringify(out))
  } catch (err) {
    console.error(`ga-install-snapshot: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
