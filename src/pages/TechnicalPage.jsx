import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import './TechnicalPage.css'

// ── Static data-source registry ──────────────────────────────────────────────
// Each entry describes one ingestion source regardless of whether it has ever
// logged a scraper_run. The `key` must match the scraper_name used in normalize.js.

const DATA_SOURCES = [
  // ── Public REST APIs ────────────────────────────────────────────────────
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
    key:         'rubberducks',
    label:       'Akron RubberDucks',
    method:      'REST API',
    methodDetail:'MLB Stats API (statsapi.mlb.com) — teamId 402',
    venue:       '7 17 Credit Union Park — 300 S Main St',
    notes:       'Fetches the full season home-game schedule. Home games only (teamId=402). Promotion data (Fireworks Night, etc.) surfaced in descriptions.',
    status:      'active',
  },
  {
    key:         'uakron_calendar',
    label:       'University of Akron',
    method:      'REST API',
    methodDetail:'LiveWhale calendar JSON API',
    venue:       'University of Akron campus — multiple locations',
    notes:       'Single endpoint returns 90 days of all campus events. Non-EJ-Thomas events use this source key. Includes lectures, exhibitions, athletics, and community programs.',
    status:      'active',
  },
  {
    key:         'ejthomas_hall',
    label:       'E.J. Thomas Performing Arts Hall',
    method:      'REST API',
    methodDetail:'LiveWhale calendar JSON API — group filter gid=5',
    venue:       'E.J. Thomas Hall — 198 Hill St',
    notes:       'Filtered sub-source of the UAkron LiveWhale API (group_title = "EJ Thomas Hall"). Captures Akron Symphony, touring Broadway, and other major performances.',
    status:      'active',
  },

  // ── The Events Calendar (Tribe) REST API ───────────────────────────────
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
    key:         'summit_metro_parks',
    label:       'Summit Metro Parks',
    method:      'REST API',
    methodDetail:'The Events Calendar (Tribe Events) REST',
    venue:       '18+ park locations across Summit County',
    notes:       'Tribe Events API returns 180 days, 264+ events. Per-event venue caching creates individual park records (Gorge Metro Park, Cascade Valley, etc.).',
    status:      'active',
  },
  {
    key:         'cvnp_conservancy',
    label:       'Cuyahoga Valley National Park',
    method:      'REST API',
    methodDetail:'The Events Calendar (Tribe Events) REST',
    venue:       'Cuyahoga Valley National Park — multiple trailheads',
    notes:       'Conservancy for CVNP Tribe Events API. Per-event venue caching across park locations. 180-day window.',
    status:      'active',
  },
  {
    key:         'players_guild',
    label:       'Players Guild Theatre',
    method:      'REST API',
    methodDetail:'The Events Calendar (Tribe Events) REST',
    venue:       'Players Guild Theatre — 1001 Market Ave N, Canton',
    notes:       'Canton-based community theatre. 365-day window since theatre seasons are planned well in advance.',
    status:      'active',
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

  // ── WordPress APIs ─────────────────────────────────────────────────────
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
    key:         'akronym_brewing',
    label:       'Akronym Brewing',
    method:      'REST API',
    methodDetail:'WordPress REST API (posts by category)',
    venue:       'Akronym Brewing — 58 E Mill St',
    notes:       'Events are WordPress posts filtered by category. Dates parsed from registered meta fields; falls back to post-published date.',
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

  // ── Squarespace Events Collection ───────────────────────────────────
  {
    key:         'leadership_akron',
    label:       'Leadership Akron',
    method:      'REST API',
    methodDetail:'Squarespace Events Collection JSON (?format=json&view=upcoming)',
    venue:       'The Duck Club by Firestone at 7 17 Credit Union Park — 300 S Main St',
    notes:       'Uses the shared Squarespace Events Collection module. Monthly "Leadership on Main" speaker series plus other community leadership events. Free admission with complimentary food.',
    status:      'active',
  },

  // ── HTML scrapers ──────────────────────────────────────────────────────
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
    key:         'akron_civic',
    label:       'Akron Civic Theatre',
    method:      'HTML scrape',
    methodDetail:'Bolt CMS — /view-all-shows page',
    venue:       'Akron Civic Theatre, The Knight Stage, Wild Oscar\'s — 182 S Main St',
    notes:       'Bolt CMS renders a structured text listing. Parser extracts venue / date / title triplets and maps each sub-venue to its own record. Opening night used for date ranges.',
    status:      'active',
  },
  {
    key:         'akron_zoo',
    label:       'Akron Zoo',
    method:      'HTML scrape',
    methodDetail:'Drupal (Views + Slick carousel) — /events page',
    venue:       'Akron Zoo — 500 Edgewood Ave',
    notes:       'Drupal Views renders event cards in a Slick carousel. Scraper tries 4 CSS selector patterns before falling back to text-line parsing. Zero-event runs produce a diagnostic warning.',
    status:      'active',
  },
  {
    key:         'downtown_akron',
    label:       'Downtown Akron Partnership',
    method:      'HTML scrape',
    methodDetail:'CityInsight CMS (ctycms.com) — /calendar',
    venue:       'Downtown Akron district — 49 blocks, multiple venues',
    notes:       'Fetches current month + 2 ahead via ?month=YYYY-MM params. Extracts venue name from the "time / venue" line in each card. Surfaces events not listed elsewhere (The Nightlight Cinema, The Green Dragon Inn).',
    status:      'active',
  },
  {
    key:         'weathervane',
    label:       'Weathervane Playhouse',
    method:      'HTML scrape',
    methodDetail:'Drupal 11 — /upcoming-shows season listing',
    venue:       'Weathervane Playhouse — 1301 Weathervane Lane',
    notes:       'Static season lineup page. Handles 5 date formats (ranges, single dates, cross-month ranges, named-day dates). Skips past shows and season header rows.',
    status:      'active',
  },
  {
    key:         'ohio_shakespeare',
    label:       'Ohio Shakespeare Festival',
    method:      'HTML scrape',
    methodDetail:'Squarespace — homepage + individual show pages',
    venue:       'Greystone Hall / Stan Hywet Hall & Gardens',
    notes:       'Fetches homepage to discover show slugs, then each production page with 1s rate-limiting. Uses og:image/og:title meta. Venue detected from page content (Greystone Hall vs. Stan Hywet).',
    status:      'active',
  },
  {
    key:         'painting_twist',
    label:       'Painting with a Twist — Fairlawn',
    method:      'HTML scrape',
    methodDetail:'Custom ASP.NET MVC — /studio/akron-fairlawn/calendar/',
    venue:       'Painting with a Twist Fairlawn — 2955 W Market St',
    notes:       'Finds /event/{id}/ links and extracts date/price/title from surrounding container HTML. Parses "Sun, Mar 22, 6:30 pm" format dates and "$34–$44" price ranges.',
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

  // ── Aggregators ────────────────────────────────────────────────────────
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
  rubberducks:        'Akron RubberDucks',
  uakron_calendar:    'University of Akron',
  ejthomas_hall:      'E.J. Thomas Hall',
  summit_artspace:    'Summit Artspace',
  summit_metro_parks: 'Summit Metro Parks',
  cvnp_conservancy:   'CVNP Conservancy',
  players_guild:      'Players Guild Theatre',
  missing_falls:      'Missing Falls Brewery',
  jillys_music_room:  "Jilly's Music Room",
  akronym_brewing:    'Akronym Brewing',
  akron_library:      'Akron Library',
  akron_art_museum:   'Akron Art Museum',
  akron_civic:        'Akron Civic Theatre',
  akron_zoo:          'Akron Zoo',
  downtown_akron:     'Downtown Akron Partnership',
  weathervane:        'Weathervane Playhouse',
  ohio_shakespeare:   'Ohio Shakespeare Festival',
  painting_twist:     'Painting with a Twist',
  blu_jazz:           'BLU Jazz+',
  nightlight_cinema:  'The Nightlight',
  leadership_akron:   'Leadership Akron',
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
              Events are pulled from {DATA_SOURCES.length} sources — official REST APIs,
              WordPress and Tribe Events endpoints, and direct HTML scrapers. All ingestion
              runs server-side on a scheduled basis.
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
