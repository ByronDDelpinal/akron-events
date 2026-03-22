import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import './TechnicalPage.css'

// ── Static data-source registry ──────────────────────────────────────────────
// Each entry describes one ingestion source regardless of whether it has ever
// logged a scraper_run. The `key` must match the scraper_name used in normalize.js.

const DATA_SOURCES = [
  {
    key:         'ticketmaster',
    label:       'Ticketmaster',
    method:      'REST API',
    methodDetail:'Ticketmaster Discovery API v2',
    venue:       'Regional events (Akron / Summit County)',
    notes:       'Queries by lat/lng radius. Covers major ticketed shows at Blossom, Akron Civic, etc.',
    status:      'active',
  },
  {
    key:         'summit_artspace',
    label:       'Summit Artspace',
    method:      'REST API',
    methodDetail:'The Events Calendar (Tribe Events) REST',
    venue:       'Summit Artspace — 140 E Market St',
    notes:       'Paginated /wp-json/tribe/events/v1/events endpoint. Includes exhibitions, workshops, and openings.',
    status:      'active',
  },
  {
    key:         'akron_library',
    label:       'Akron-Summit Co. Public Library',
    method:      'REST API',
    methodDetail:'Communico / Libnet calendar API',
    venue:       '27+ branch locations across Summit County',
    notes:       'Fetches 180 days of events in one call. ~400+ events per window: programs, classes, story times.',
    status:      'active',
  },
  {
    key:         'jillys_music_room',
    label:       "Jilly's Music Room",
    method:      'Hybrid API',
    methodDetail:'EventON AJAX + WP REST API',
    venue:       "Jilly's Music Room — 111 N Main St",
    notes:       "EventON's AJAX endpoint returns 6 months of events with UTC timestamps. WP REST API fills in images and descriptions.",
    status:      'active',
  },
  {
    key:         'blu_jazz',
    label:       'BLU Jazz+',
    method:      'HTML scrape',
    methodDetail:'TurnTable Tickets show-list page',
    venue:       'BLU Jazz+ — 47 E Market St',
    notes:       'Server-rendered page lists ~4–6 weeks of upcoming shows. Dates parsed from card id attributes; times/prices from description text.',
    status:      'active',
  },
  {
    key:         'nightlight_cinema',
    label:       'The Nightlight Cinema',
    method:      'HTML scrape',
    methodDetail:'INDY Cinema platform (blocked)',
    venue:       'The Nightlight — 30 N High St',
    notes:       'The INDY Cinema platform rewrites all /wp-json/ paths server-side and returns HTML for all API requests. Monitoring active; data currently unavailable.',
    status:      'degraded',
  },
  {
    key:         'missing_falls',
    label:       'Missing Falls Brewery',
    method:      'REST API',
    methodDetail:'The Events Calendar (Tribe Events) REST',
    venue:       'Missing Falls Brewery — 1250 Triplett Blvd',
    notes:       'Same Tribe Events platform as Summit Artspace. This venue hosts fewer events — zero-event runs are normal between active periods.',
    status:      'active',
  },
  {
    key:         'akronym_brewing',
    label:       'Akronym Brewing',
    method:      'REST API',
    methodDetail:'WordPress REST API (posts by category)',
    venue:       'Akronym Brewing — 58 E Mill St',
    notes:       'Events are WordPress posts filtered by category. Dates parsed from registered meta fields; falls back to post-published date.',
    status:      'active',
  },
  {
    key:         'akron_art_museum',
    label:       'Akron Art Museum',
    method:      'HTML scrape',
    methodDetail:'Museum Events plugin — /calendar/ page',
    venue:       'Akron Art Museum — 1 S High St',
    notes:       'Custom WordPress plugin with no REST API. Scraper fetches 6 monthly calendar pages and parses .me-event-list-item elements. Detail pages fetched for pricing.',
    status:      'active',
  },
  {
    key:         'eventbrite',
    label:       'Eventbrite',
    method:      'HTML scrape',
    methodDetail:'window.__SERVER_DATA__ + internal POST API',
    venue:       'Regional events (Akron / Summit County)',
    notes:       'Public API deprecated in 2020. Scraper fetches the Akron search page, extracts event buckets from window.__SERVER_DATA__, and paginates via the internal /api/v3/destination/search/ POST endpoint using session cookies for auth. Catches the long tail of community events not listed anywhere else.',
    status:      'active',
  },
]

// ── Human-readable scraper name mapping ──────────────────────────────────────
const SCRAPER_LABELS = {
  ticketmaster:       'Ticketmaster',
  summit_artspace:    'Summit Artspace',
  akron_library:      'Akron Library',
  jillys_music_room:  "Jilly's Music Room",
  blu_jazz:           'BLU Jazz+',
  nightlight_cinema:  'The Nightlight',
  missing_falls:      'Missing Falls Brewery',
  akronym_brewing:    'Akronym Brewing',
  akron_art_museum:   'Akron Art Museum',
  eventbrite:         'Eventbrite',
}

function labelFor(key) {
  return SCRAPER_LABELS[key] ?? key.replace(/_/g, ' ')
}

// ── Health row status helpers ─────────────────────────────────────────────────
function healthState(row) {
  if (row.is_error)       return 'error'
  if (row.is_stale)       return 'stale'
  if (row.is_zero_streak) return 'warn'
  return 'ok'
}

function formatAge(hours) {
  if (hours == null) return '—'
  if (hours < 1)    return '< 1h ago'
  if (hours < 24)   return `${Math.round(hours)}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function formatTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZoneName: 'short',
  })
}

// ── Components ────────────────────────────────────────────────────────────────

function SourceBadge({ status }) {
  return (
    <span className={`tp-badge tp-badge--${status}`}>
      {status === 'active'  ? '● Active'   : null}
      {status === 'degraded'? '◐ Degraded' : null}
      {status === 'planned' ? '○ Planned'  : null}
    </span>
  )
}

function MethodBadge({ method }) {
  const slug = method.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z-]/g, '')
  return <span className={`tp-method tp-method--${slug}`}>{method}</span>
}

function HealthBadge({ state }) {
  const labels = { ok: '✓ OK', error: '✕ Error', stale: '⚠ Stale', warn: '⚠ Low events' }
  return <span className={`tp-health tp-health--${state}`}>{labels[state] ?? state}</span>
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TechnicalPage() {
  const [health,  setHealth]  = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [eventCounts, setEventCounts] = useState({})

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)
      try {
        // Scraper health
        const { data: healthData, error: healthErr } = await supabase
          .from('scraper_health')
          .select('*')
        if (healthErr) throw healthErr
        setHealth(healthData ?? [])

        // Event counts per source — paginate to bypass the 1 000-row PostgREST default
        const BATCH = 1000
        let from = 0
        const counts = {}
        while (true) {
          const { data: batch, error: batchErr } = await supabase
            .from('events')
            .select('source')
            .eq('status', 'published')
            .range(from, from + BATCH - 1)
          if (batchErr || !batch || batch.length === 0) break
          batch.forEach(e => { counts[e.source] = (counts[e.source] ?? 0) + 1 })
          if (batch.length < BATCH) break
          from += BATCH
        }
        setEventCounts(counts)
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  // Index health rows by scraper_name for fast lookup
  const healthByKey = {}
  health.forEach(h => { healthByKey[h.scraper_name] = h })

  const totalEvents = Object.values(eventCounts).reduce((a, b) => a + b, 0)
  const activeAlerts = health.filter(h => h.alert).length

  return (
    <>
      {/* ── Hero ── */}
      <div className="tp-hero">
        <div className="tp-hero__inner">
          <p className="tp-hero__eyebrow">Turnout / Open Infrastructure</p>
          <h2 className="tp-hero__title">Technical Details</h2>
          <p className="tp-hero__sub">
            A transparent look at how event data flows into this site — every source,
            every scraper, and the live health of each pipeline.
          </p>
        </div>
      </div>

      <div className="tp-body">

        {/* ── Summary stats ── */}
        <div className="tp-stats">
          <div className="tp-stat">
            <span className="tp-stat__num">{loading ? '—' : totalEvents.toLocaleString()}</span>
            <span className="tp-stat__label">Published events</span>
          </div>
          <div className="tp-stat">
            <span className="tp-stat__num">{DATA_SOURCES.filter(s => s.status === 'active').length}</span>
            <span className="tp-stat__label">Active sources</span>
          </div>
          <div className="tp-stat">
            <span className={`tp-stat__num ${activeAlerts > 0 ? 'tp-stat__num--alert' : ''}`}>
              {loading ? '—' : activeAlerts}
            </span>
            <span className="tp-stat__label">Health alerts</span>
          </div>
        </div>

        {/* ── Data Sources ── */}
        <section className="tp-section">
          <div className="tp-section__hd">
            <h3 className="tp-section__title">Data Sources</h3>
            <p className="tp-section__desc">
              Events are pulled from {DATA_SOURCES.length} sources using a mix of official APIs,
              plugin-specific endpoints, and HTML scraping. All ingestion runs server-side on
              a scheduled basis.
            </p>
          </div>

          <div className="tp-sources">
            {DATA_SOURCES.map(src => {
              const liveCount = eventCounts[src.key]
              const hRow      = healthByKey[src.key]
              return (
                <div key={src.key} className={`tp-source tp-source--${src.status}`}>
                  <div className="tp-source__top">
                    <div className="tp-source__name">{src.label}</div>
                    <div className="tp-source__badges">
                      <SourceBadge status={src.status} />
                      <MethodBadge method={src.method} />
                    </div>
                  </div>

                  <div className="tp-source__venue">{src.venue}</div>
                  <div className="tp-source__detail">{src.methodDetail}</div>
                  <p className="tp-source__notes">{src.notes}</p>

                  <div className="tp-source__meta">
                    {liveCount != null && (
                      <span className="tp-source__count">
                        {liveCount.toLocaleString()} event{liveCount !== 1 ? 's' : ''} in DB
                      </span>
                    )}
                    {hRow && (
                      <span className="tp-source__lastrun">
                        Last run {formatAge(hRow.hours_since_run)}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* ── Scraper Health ── */}
        <section className="tp-section">
          <div className="tp-section__hd">
            <h3 className="tp-section__title">Scraper Health</h3>
            <p className="tp-section__desc">
              Every time a scraper runs it writes a record here. An alert fires when a
              scraper hasn't run in 26+ hours, returns an error, or produces zero events
              two runs in a row.
            </p>
          </div>

          {loading && (
            <div className="tp-loading">Loading health data…</div>
          )}

          {error && (
            <div className="tp-error">
              Could not load health data: {error}
            </div>
          )}

          {!loading && !error && health.length === 0 && (
            <div className="tp-empty">
              No scraper runs recorded yet. Run <code>npm run scrape:all</code> to populate.
            </div>
          )}

          {!loading && !error && health.length > 0 && (
            <div className="tp-table-wrap">
              <table className="tp-table">
                <thead>
                  <tr>
                    <th>Scraper</th>
                    <th>Status</th>
                    <th>Last Run</th>
                    <th className="tp-table__num">Events Found</th>
                    <th className="tp-table__num">Avg (5 runs)</th>
                    <th className="tp-table__num">Total Runs</th>
                  </tr>
                </thead>
                <tbody>
                  {health.map(row => {
                    const state = healthState(row)
                    return (
                      <tr key={row.scraper_name} className={`tp-row tp-row--${state}`}>
                        <td className="tp-row__name">{labelFor(row.scraper_name)}</td>
                        <td><HealthBadge state={state} /></td>
                        <td className="tp-row__time">
                          <span className="tp-row__time-rel">{formatAge(row.hours_since_run)}</span>
                          <span className="tp-row__time-abs">{formatTime(row.last_ran_at)}</span>
                        </td>
                        <td className="tp-table__num">{row.last_events_found ?? 0}</td>
                        <td className="tp-table__num">{row.avg_events_last5 ?? '—'}</td>
                        <td className="tp-table__num">{row.total_runs ?? 0}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              {/* Alert details */}
              {health.some(h => h.alert) && (
                <div className="tp-alerts">
                  <div className="tp-alerts__title">Active Alerts</div>
                  {health.filter(h => h.alert).map(h => (
                    <div key={h.scraper_name} className={`tp-alert tp-alert--${healthState(h)}`}>
                      <span className="tp-alert__source">{labelFor(h.scraper_name)}</span>
                      <span className="tp-alert__msg">{h.alert}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── How it works ── */}
        <section className="tp-section tp-section--how">
          <div className="tp-section__hd">
            <h3 className="tp-section__title">How It Works</h3>
          </div>
          <div className="tp-how-grid">
            <div className="tp-how-step">
              <div className="tp-how-step__num">1</div>
              <div className="tp-how-step__body">
                <strong>Ingest</strong>
                <p>Scrapers and API clients run on a schedule, pulling event data from each source. Each script normalizes fields into a common schema.</p>
              </div>
            </div>
            <div className="tp-how-step">
              <div className="tp-how-step__num">2</div>
              <div className="tp-how-step__body">
                <strong>Deduplicate</strong>
                <p>Every event is keyed by <code>source + source_id</code>. Re-running a scraper updates existing events rather than creating duplicates.</p>
              </div>
            </div>
            <div className="tp-how-step">
              <div className="tp-how-step__num">3</div>
              <div className="tp-how-step__body">
                <strong>Serve</strong>
                <p>The frontend queries Supabase directly. Events are filtered, sorted, and searched client-side without a custom backend.</p>
              </div>
            </div>
            <div className="tp-how-step">
              <div className="tp-how-step__num">4</div>
              <div className="tp-how-step__body">
                <strong>Monitor</strong>
                <p>Every scraper run logs its result to <code>scraper_runs</code>. The health view above flags stale, errored, or zero-yield scrapers automatically.</p>
              </div>
            </div>
          </div>
        </section>

      </div>
    </>
  )
}
