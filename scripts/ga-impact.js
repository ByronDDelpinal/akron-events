import 'dotenv/config'
import { loadConfig, mintJwt } from './ga-snapshot.js'

/**
 * GA4 impact report: a full day's audience, event-reading and organizer-handoff
 * breakdown for one date.
 *
 * Usage:
 *   node scripts/ga-impact.js 2026-08-07
 *   node scripts/ga-impact.js            # defaults to yesterday, Eastern
 *
 * Prints one JSON object to stdout. Same NOT_CONFIGURED contract as
 * ga-snapshot.js: missing GA4_* env vars print NOT_CONFIGURED and exit 0.
 *
 * WHY THIS EXISTS, AND THE TRAP IT AVOIDS
 *
 * Same-day GA4 figures are partial and carry no signal that they are partial.
 * On 2026-08-08 the API reported 57 visitors and 2 outbound clicks for the
 * morning at 9:08am; the settled figure for the same window was 148 visitors
 * and 9 clicks. A directional finding drawn from the 9:08am pull was not just
 * imprecise, it was backwards. This script therefore REFUSES a date that is
 * not yet complete in the property's timezone unless --allow-partial is
 * passed, and stamps `partial: true` on the output when it is.
 *
 * Event identity note: outbound_click and view_event carry category and
 * source_tier but NOT the event id or destination URL, so which event a click
 * belongs to is only recoverable from pagePath. That join is done here rather
 * than by hand. If the event URL format ever changes, EVENT_PATH_RE is the
 * single place to update.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://analyticsdata.googleapis.com/v1beta'

/** Event detail pages are /events/{slug}/{uuid}; browse pages have no uuid. */
const EVENT_PATH_RE = '/[0-9a-f]{8}-[0-9a-f]{4}-'

async function accessToken(sa) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: mintJwt(sa),
    }),
  })
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`)
  const json = await res.json()
  if (!json.access_token) throw new Error('token exchange returned no access_token')
  return json.access_token
}

async function runReport(token, propertyId, body) {
  const res = await fetch(`${API}/properties/${propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) return { error: json?.error?.message ?? `http ${res.status}` }
  return (json.rows ?? []).map((row) => ({
    d: (row.dimensionValues ?? []).map((v) => v.value),
    m: (row.metricValues ?? []).map((v) => Number(v.value)),
  }))
}

/** Single-row metric-only reports: return the row's metrics, or zeros. */
function scalars(rows, count) {
  if (!Array.isArray(rows) || rows.length === 0) return new Array(count).fill(0)
  return rows[0].m
}

const eventNamed = (name) => ({
  filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: name } },
})

const isEventDetailPage = {
  andGroup: {
    expressions: [
      { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'BEGINS_WITH', value: '/events/' } } },
      { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'PARTIAL_REGEXP', value: EVENT_PATH_RE } } },
    ],
  },
}

/** Today's date in the given IANA timezone, as YYYY-MM-DD. */
function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

function yesterdayIn(tz) {
  const d = new Date(Date.now() - 86400000)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

/** Strip /events/{slug}/{uuid} down to the slug, for readable output. */
export function slugFromPath(path) {
  return String(path).replace(/^\/events\//, '').replace(/\/[0-9a-f-]{36}$/, '')
}

async function main() {
  const args = process.argv.slice(2)
  const allowPartial = args.includes('--allow-partial')
  // One date = that day. Two dates = an inclusive range, for rollups where a
  // single day is too small to say anything (handoffs, especially).
  const dateArgs = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)).sort()
  const dateArg = dateArgs[0]
  const endArg = dateArgs[1]

  const cfg = loadConfig()
  if (!cfg) { console.log('NOT_CONFIGURED'); return }
  const token = await accessToken(cfg.sa)
  const P = cfg.propertyId

  // Property timezone decides what "yesterday" and "complete" mean. Deriving
  // either from UTC would silently shift the window by up to 5 hours.
  const metaRes = await fetch(`${API}/properties/${P}/metadata`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const tz = (await metaRes.json())?.timeZone ?? 'America/New_York'

  const date = dateArg ?? yesterdayIn(tz)
  const endDate = endArg ?? date
  const partial = endDate >= todayIn(tz)
  if (partial && !allowPartial) {
    console.error(
      `ga-impact: ${endDate} is not complete in ${tz}. Same-day figures are partial ` +
      `and have previously been off by 3x. Re-run tomorrow, or pass --allow-partial.`
    )
    process.exitCode = 1
    return
  }

  const R = [{ startDate: date, endDate }]
  const q = (body) => runReport(token, P, { dateRanges: R, ...body })

  const [
    totals, engagement, byHour, sourceMedium, device, city, landing,
    eventPages, browsePages, viewEventTotals, viewByCategory, viewByTier,
    outboundTotals, outboundByPage, outboundDims, calendarAdds,
    otherEvents, trailing,
  ] = await Promise.all([
    q({ metrics: [{ name: 'activeUsers' }, { name: 'newUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }] }),
    q({ metrics: [{ name: 'engagedSessions' }, { name: 'averageSessionDuration' }, { name: 'screenPageViewsPerSession' }] }),
    q({ dimensions: [{ name: 'hour' }], metrics: [{ name: 'activeUsers' }, { name: 'screenPageViews' }], orderBys: [{ dimension: { dimensionName: 'hour' } }] }),
    q({ dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }, { name: 'activeUsers' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 15 }),
    q({ dimensions: [{ name: 'deviceCategory' }], metrics: [{ name: 'activeUsers' }] }),
    q({ dimensions: [{ name: 'city' }], metrics: [{ name: 'activeUsers' }], orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }], limit: 15 }),
    q({ dimensions: [{ name: 'landingPage' }], metrics: [{ name: 'sessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 10 }),
    q({ dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }], dimensionFilter: isEventDetailPage, orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 300 }),
    q({ dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }], dimensionFilter: { notExpression: { filter: { fieldName: 'pagePath', stringFilter: { matchType: 'PARTIAL_REGEXP', value: EVENT_PATH_RE } } } }, orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 15 }),
    q({ metrics: [{ name: 'eventCount' }, { name: 'activeUsers' }], dimensionFilter: eventNamed('view_event') }),
    q({ dimensions: [{ name: 'customEvent:category' }], metrics: [{ name: 'eventCount' }], dimensionFilter: eventNamed('view_event'), orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 40 }),
    q({ dimensions: [{ name: 'customEvent:source_tier' }], metrics: [{ name: 'eventCount' }], dimensionFilter: eventNamed('view_event'), limit: 10 }),
    q({ metrics: [{ name: 'eventCount' }, { name: 'activeUsers' }], dimensionFilter: eventNamed('outbound_click') }),
    q({ dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'eventCount' }], dimensionFilter: eventNamed('outbound_click'), orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 100 }),
    q({ dimensions: [{ name: 'customEvent:link_type' }, { name: 'customEvent:source_tier' }, { name: 'customEvent:category' }], metrics: [{ name: 'eventCount' }], dimensionFilter: eventNamed('outbound_click'), limit: 100 }),
    q({ dimensions: [{ name: 'customEvent:method' }], metrics: [{ name: 'eventCount' }], dimensionFilter: eventNamed('add_to_calendar'), limit: 10 }),
    q({ dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }, { name: 'activeUsers' }], orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }], limit: 40 }),
    runReport(token, P, {
      dateRanges: [{ startDate: '28daysAgo', endDate: date }],
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'activeUsers' }, { name: 'newUsers' }, { name: 'screenPageViews' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit: 40,
    }),
  ])

  const t = scalars(totals, 4)
  const e = scalars(engagement, 3)
  const ve = scalars(viewEventTotals, 2)
  const ob = scalars(outboundTotals, 2)

  const eventRows = Array.isArray(eventPages) ? eventPages : []
  const outRows = Array.isArray(outboundByPage) ? outboundByPage : []

  console.log(JSON.stringify({
    date,
    endDate,
    timezone: tz,
    partial,
    audience: {
      activeUsers: t[0], newUsers: t[1], sessions: t[2], pageViews: t[3],
      engagedSessions: e[0],
      avgSessionSeconds: Math.round(e[1]),
      pageViewsPerSession: Number(e[2].toFixed(2)),
    },
    reading: {
      viewEventFires: ve[0],
      distinctReaders: ve[1],
      distinctEventPages: eventRows.length,
      eventPageViews: eventRows.reduce((s, r) => s + r.m[0], 0),
      topEvents: eventRows.slice(0, 25).map((r) => ({
        slug: slugFromPath(r.d[0]), path: r.d[0], views: r.m[0], readers: r.m[1],
      })),
      byCategory: (viewByCategory ?? []).map?.((r) => ({ category: r.d[0], views: r.m[0] })) ?? viewByCategory,
      bySourceTier: (viewByTier ?? []).map?.((r) => ({ tier: r.d[0], views: r.m[0] })) ?? viewByTier,
    },
    handoffs: {
      clicks: ob[0],
      distinctClickers: ob[1],
      events: outRows.map((r) => ({ slug: slugFromPath(r.d[0]), clicks: r.m[0] })),
      breakdown: (outboundDims ?? []).map?.((r) => ({
        linkType: r.d[0], tier: r.d[1], category: r.d[2], clicks: r.m[0],
      })) ?? outboundDims,
      calendarAdds: (calendarAdds ?? []).map?.((r) => ({ method: r.d[0], count: r.m[0] })) ?? calendarAdds,
    },
    acquisition: {
      channels: (sourceMedium ?? []).map?.((r) => ({ channel: r.d[0], sessions: r.m[0], users: r.m[1] })) ?? sourceMedium,
      devices: (device ?? []).map?.((r) => ({ device: r.d[0], users: r.m[0] })) ?? device,
      cities: (city ?? []).map?.((r) => ({ city: r.d[0] || '(unknown)', users: r.m[0] })) ?? city,
      landingPages: (landing ?? []).map?.((r) => ({ path: r.d[0] || '(not set)', sessions: r.m[0] })) ?? landing,
    },
    browsePages: (browsePages ?? []).map?.((r) => ({ path: r.d[0], views: r.m[0], users: r.m[1] })) ?? browsePages,
    hourly: (byHour ?? []).map?.((r) => ({ hour: Number(r.d[0]), users: r.m[0], views: r.m[1] })) ?? byHour,
    allEvents: (otherEvents ?? []).map?.((r) => ({ name: r.d[0], count: r.m[0], users: r.m[1] })) ?? otherEvents,
    trailing28: (trailing ?? []).map?.((r) => ({ date: r.d[0], users: r.m[0], newUsers: r.m[1], views: r.m[2] })) ?? trailing,
  }, null, 2))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('ga-impact:', err.message)
    process.exitCode = 1
  })
}
