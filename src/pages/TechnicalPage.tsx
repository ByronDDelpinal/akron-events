import type { LooseRow } from '@/types'
import { Fragment, useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { SEO } from '@/lib/seo'
import PageHero from '@/components/PageHero'
import {
  DATA_SOURCES,
  SOURCE_GROUPS,
  SOURCE_GROUP_BY_KEY,
  SCRAPER_LABELS,
  labelFor,
  type SourceGroup,
} from '@/lib/dataSources'
import './TechnicalPage.css'

interface EvaluatedSource {
  name: string
  url: string
  reason: string
}

/** A row from the scraper_health view (dynamic shape). */
type HealthRow = LooseRow

// ── Static data-source registry ──────────────────────────────────────────────
// ── Source groupings by platform / data-feed family ──────────────────────────
// Renders the Data Sources section as a series of tables — one per platform —
// so a reader can scan section headings ("Eventbrite", "The Events Calendar",
// "Ticketmaster") and answer "are we pulling from X, and how?" without reading
// 38 card bodies. Order is editorial: aggregators first, then standards-based
// platforms (Tribe, ICS, Squarespace, LiveWhale), then single-platform APIs,
// then the bespoke HTML scrapers as a final catch-all.

// ── Human-readable scraper name mapping ──────────────────────────────────────

// ── Source evaluation log ────────────────────────────────────────────────────
// Sources we investigated and deliberately chose NOT to build a scraper for.
// Documenting these matters for the project's transparency goals — every
// "we don't have X" question has a reasoned answer here rather than an
// implicit gap. Revisit any entry when the underlying conditions change.

const EVALUATED_SOURCES: EvaluatedSource[] = [
  {
    name:   'City of Barberton',
    url:    'https://www.cityofbarberton.com/Calendar.aspx',
    reason: 'Barberton runs CivicPlus like the other Summit County cities, but its iCalendar module returns an empty body for every category ID we probed (catID=14, 0, and the no-catID default), and the Calendar.aspx page itself renders client-side with no server HTML to parse — so neither the shared civicplus.js iCal path nor an HTML scrape works as-is. Public Barberton programming (First Friday, the BLVD events) is better covered by Mainstreet Barberton (WordPress) and Better Kenmore; revisit with a direct Mainstreet Barberton scraper, or recheck the CivicPlus feed if the city re-enables it. This is the only Summit County hub city without a working city-government scraper.',
  },
  {
    name:   'Greystone Hall',
    url:    'https://www.visitakron-summit.org/greystone-hall/',
    reason: 'No public events page — bookings are private (weddings, banquets, meetings). The one recurring public tenant is Ohio Shakespeare Festival, which is already covered by the ohio_shakespeare scraper.',
  },
  {
    name:   'Akron Beacon Journal community calendar',
    url:    'https://www.ohio.com/calendar/events',
    reason: 'Client-rendered React app on the Gannett/Evvnt national network. Evvnt syndicates from Eventbrite and Ticketmaster, so most distinctly-Akron entries would already be duplicates. Skip until Evvnt exposes a public JSON endpoint or until Gannett ships a server-rendered variant.',
  },
  {
    name:   'Remaining neighborhood association sites',
    url:    'whno.org (West Hill), goodyearheights.org, eandc.org (East Akron), progressakron.org (Sherbondy Hill / West Akron)',
    reason: "Highland Square, Better Kenmore, The Well (Middlebury), and North Hill CDC now have direct scrapers. The remaining neighborhood orgs are a mixed CMS stack (Wix, WordPress, Weebly, Squarespace) but operationally Facebook-driven: EANDC and Progressive Alliance publish what little they ticket through Eventbrite (caught by the citywide geo-feed), and the others run <10 public events/year. Revisit any individually if its public-event volume grows.",
  },
]


// ── Health row status helpers ─────────────────────────────────────────────────
function healthState(row: HealthRow): string {
  if (row.is_error)       return 'error'
  if (row.is_stale)       return 'stale'
  if (row.is_zero_streak) return 'warn'
  return 'ok'
}

function formatAge(hours: number | null | undefined): string {
  if (hours == null) return '—'
  if (hours < 1)    return '< 1h ago'
  if (hours < 24)   return `${Math.round(hours)}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
    timeZoneName: 'short',
  })
}

// ── Components ────────────────────────────────────────────────────────────────

function SourceBadge({ status }: { status: string }) {
  return (
    <span className={`tp-badge tp-badge--${status}`}>
      {status === 'active'  ? '● Active'   : null}
      {status === 'degraded'? '◐ Degraded' : null}
      {status === 'paused'  ? '⏸ Paused'   : null}
      {status === 'planned' ? '○ Planned'  : null}
    </span>
  )
}

function HealthBadge({ state }: { state: string }) {
  const labels: Record<string, string> = { ok: '✓ OK', error: '✕ Error', stale: '⚠ Stale', warn: '⚠ Low events' }
  return <span className={`tp-health tp-health--${state}`}>{labels[state] ?? state}</span>
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function TechnicalPage() {
  const [health,  setHealth]  = useState<HealthRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [eventCounts, setEventCounts] = useState<Record<string, number>>({})
  // Per-row expanded notes — keys are DATA_SOURCES.key values
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

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
        setHealth((healthData ?? []) as HealthRow[])

        // Event counts per source — paginate to bypass the 1 000-row PostgREST default
        const BATCH = 1000
        let from = 0
        const counts: Record<string, number> = {}
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
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  // Index health rows by scraper_name for fast lookup
  const healthByKey: Record<string, HealthRow> = {}
  health.forEach(h => { healthByKey[h.scraper_name] = h })

  const totalEvents = Object.values(eventCounts).reduce((a, b) => a + b, 0)
  const activeAlerts = health.filter(h => h.alert).length

  // SOURCE_GROUPS lookup for the table's platform column / anchor links.
  const groupById: Record<string, SourceGroup> = {}
  SOURCE_GROUPS.forEach(g => { groupById[g.id] = g })

  // Sources alphabetised by display label — the table is a flat directory
  // where the platform lives in a column rather than a section header. Each
  // platform's own roll-up (sources · events · description) lives below in
  // the Platforms section.
  const [sourceQuery, setSourceQuery] = useState('')

  const sortedSources = [...DATA_SOURCES].sort((a, b) => a.label.localeCompare(b.label))

  const filteredSources = sourceQuery.trim()
    ? (() => {
        const q = sourceQuery.trim().toLowerCase()
        return sortedSources.filter(s =>
          s.label.toLowerCase().includes(q) ||
          s.venue.toLowerCase().includes(q) ||
          s.method.toLowerCase().includes(q) ||
          s.methodDetail.toLowerCase().includes(q) ||
          (s.notes ?? '').toLowerCase().includes(q)
        )
      })()
    : sortedSources

  return (
    <>
      <SEO
        title="Technical | How Akron Pulse Is Built"
        description="A transparent look at the data sources, scrapers, and pipeline health behind Akron Pulse. Every source listed, with live ingestion status."
        path="/technical"
      />
      {/* ── Hero ── */}
      <PageHero eyebrow="Akron Pulse / Open Infrastructure" title="Technical Details">
        A transparent look at how event data flows into this site: every source,
        every scraper, and the live health of each pipeline.
      </PageHero>

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

        {/* ── Data Sources — single flat directory ── */}
        <section className="tp-section">
          <div className="tp-section__hd">
            <h2 className="tp-section__title">Data Sources</h2>
            <p className="tp-section__desc">
              Every venue, organizer, and feed that produces events on this site,
              sorted alphabetically. The <strong>Source</strong> column tells you
              where the data comes from: Eventbrite, Ticketmaster, The Events
              Calendar (Tribe), an iCalendar subscription, a Squarespace events
              collection, or a per-site scraper. Sources that ride on an
              aggregator (House Three Thirty via Eventbrite, Blossom Music Center
              via Ticketmaster) get their own row but roll their event count and
              last-run up to the parent. Click any row for the method detail and
              per-source notes. The "Platforms" section below covers each
              ingestion approach in depth.
            </p>
          </div>

          <div className="tp-sources-search">
            <input
              type="search"
              className="tp-sources-search__input"
              placeholder="Search sources…"
              value={sourceQuery}
              onChange={e => setSourceQuery(e.target.value)}
              aria-label="Filter data sources"
            />
            {sourceQuery.trim() && (
              <span className="tp-sources-search__count">
                {filteredSources.length} of {sortedSources.length}
              </span>
            )}
          </div>

          <div className="tp-table-wrap">
            <table className="tp-table tp-sources-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Coverage</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th className="tp-table__num">Events</th>
                  <th>Last run</th>
                  <th aria-label="Toggle details" />
                </tr>
              </thead>
              <tbody>
                {filteredSources.map(src => {
                  const groupId   = SOURCE_GROUP_BY_KEY[src.key]
                  const group     = groupById[groupId]
                  const liveCount = eventCounts[src.key]
                  const hRow      = healthByKey[src.key]
                  const isSubOf   = !!src.subOf
                  const isOpen    = !!expanded[src.key]
                  return (
                    <Fragment key={src.key}>
                      <tr
                        className={`tp-grow tp-grow--${src.status} ${isOpen ? 'tp-grow--open' : ''}`}
                        onClick={() => setExpanded(prev => ({ ...prev, [src.key]: !prev[src.key] }))}
                      >
                        <td className="tp-grow__name">
                          {src.label}
                          {isSubOf && <span className="tp-grow__via"> · via {SCRAPER_LABELS[src.subOf!] ?? src.subOf}</span>}
                        </td>
                        <td className="tp-grow__venue">{src.venue}</td>
                        <td className="tp-grow__platform">
                          <a href={`#platform-${groupId}`} onClick={e => e.stopPropagation()}>
                            {group?.title ?? groupId}
                          </a>
                        </td>
                        <td><SourceBadge status={src.status} /></td>
                        <td className="tp-table__num">
                          {isSubOf
                            ? <span className="tp-grow__rollup">rolled up</span>
                            : loading
                              ? '—'
                              : liveCount != null
                                ? liveCount.toLocaleString()
                                : '0'}
                        </td>
                        <td className="tp-grow__time">
                          {isSubOf ? '—' : hRow ? formatAge(hRow.hours_since_run) : '—'}
                        </td>
                        <td className="tp-grow__toggle" aria-hidden="true">
                          <span className={`tp-chevron ${isOpen ? 'tp-chevron--open' : ''}`}>▸</span>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="tp-grow-detail">
                          <td colSpan={7}>
                            <div className="tp-grow-detail__inner">
                              <div className="tp-grow-detail__method">
                                <strong>How</strong> {src.methodDetail}
                              </div>
                              <p className="tp-grow-detail__notes">{src.notes}</p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── Source evaluation log ── */}
        <section className="tp-section">
          <div className="tp-section__hd">
            <h2 className="tp-section__title">Source Evaluation Log</h2>
            <p className="tp-section__desc">
              Sources we investigated and decided not to ingest. Documenting these
              keeps the coverage story honest: every "why isn't X in here?"
              has a reasoned answer. Each entry is revisited when the underlying
              conditions change.
            </p>
          </div>

          <ul className="tp-evaluated">
            {EVALUATED_SOURCES.map(src => (
              <li key={src.name} className="tp-evaluated__item">
                <div className="tp-evaluated__name">{src.name}</div>
                <div className="tp-evaluated__url">{src.url}</div>
                <p className="tp-evaluated__reason">{src.reason}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* ── Scraper Health ── */}
        <section className="tp-section">
          <div className="tp-section__hd">
            <h2 className="tp-section__title">Scraper Health</h2>
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

        {/* ── Platforms (learn-more roll-up) ── */}
        <section className="tp-section">
          <div className="tp-section__hd">
            <h2 className="tp-section__title">Platforms</h2>
            <p className="tp-section__desc">
              The same handful of platforms account for every source in the table
              above. Each card below totals the sources and events it covers, then
              explains the integration approach. Useful when the question shifts
              from "are we pulling X?" to "how exactly are we pulling it?".
            </p>
          </div>

          <div className="tp-platforms">
            {SOURCE_GROUPS.map(group => {
              const sourcesInGroup = DATA_SOURCES.filter(s => SOURCE_GROUP_BY_KEY[s.key] === group.id)
              if (sourcesInGroup.length === 0) return null

              const eventTotal = sourcesInGroup.reduce(
                (sum, s) => sum + (eventCounts[s.key] ?? 0),
                0
              )

              return (
                <div key={group.id} id={`platform-${group.id}`} className="tp-platform">
                  <div className="tp-platform__hd">
                    <h3 className="tp-platform__title">{group.title}</h3>
                    <div className="tp-platform__stats">
                      <span className="tp-platform__stat">
                        <strong>{sourcesInGroup.length}</strong> source{sourcesInGroup.length !== 1 ? 's' : ''}
                      </span>
                      {!loading && eventTotal > 0 && (
                        <span className="tp-platform__stat">
                          <strong>{eventTotal.toLocaleString()}</strong> event{eventTotal !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  </div>
                  <p className="tp-platform__desc">{group.description}</p>
                  <ul className="tp-platform__sources">
                    {sourcesInGroup
                      .slice()
                      .sort((a, b) => a.label.localeCompare(b.label))
                      .map(s => (
                        <li key={s.key} className="tp-platform__source">
                          {s.label}
                          {s.subOf && <span className="tp-platform__via"> (via {SCRAPER_LABELS[s.subOf!] ?? s.subOf})</span>}
                        </li>
                      ))}
                  </ul>
                </div>
              )
            })}
          </div>
        </section>

        {/* ── How it works ── */}
        <section className="tp-section tp-section--how">
          <div className="tp-section__hd">
            <h2 className="tp-section__title">How It Works</h2>
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
