/**
 * FestivalPage — /festival/:slug
 *
 * Festival hub: a mobile-first, time-major schedule over ordinary event rows
 * discovered by tag (see src/lib/festivals.ts for the registry and
 * src/lib/festivalSchedule.ts for the pure derivation this page renders).
 * One PostgREST query; acts render on the site's shared compact view
 * (<EventCard viewMode="efficient"> in .cards-grid--efficient), grouped
 * under slot headers that reuse HomePage's date-heading classes. EventCard's
 * own AddToPlanButton carries the analytics surface via planSurface
 * 'festival_hub'. EfficientCard renders no images (digest image gate
 * parity) — the umbrella poster stays the page's only image.
 *
 * Day-of state (live "Now" outlines + the "Up next" slot) only renders on
 * the festival's Eastern calendar day — compared string-to-string via
 * dayPlanDate.ts helpers, never a UTC-derived today, never Date-vs-string —
 * and refreshes on a 60s tick of an epoch-ms instant.
 */
import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { SEO } from '@/lib/seo'
import { eventPath } from '@/lib/slug'
import { festivalBySlug } from '@/lib/festivals'
import {
  buildFestivalSchedule,
  firstVenue,
  isHappeningNow,
  upNextSlot,
  type FestivalEventRow,
  type FestivalScheduleItem,
} from '@/lib/festivalSchedule'
import { easternTodayIso } from '@/lib/dayPlanDate'
import { useAsync } from '@/hooks/useAsync'
import { useDayPlan } from '@/hooks/useDayPlan'
import EventCard from '@/components/EventCard'
import type { AppEvent } from '@/hooks/useEvents'
import './HomePage.css'
import './FestivalPage.css'

/** "11:00 AM" in the viewer's local timezone (site-wide display rule). */
function slotTimeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** Display name for an act: the title minus the importer's " - PorchRokr…" suffix. */
function actName(title: string): string {
  const i = title.indexOf(' - PorchRokr')
  return i === -1 ? title : title.slice(0, i)
}

/** The set's genre, extracted from the importer's "Genre: X." description
 *  prefix (scripts/import-porchrokr.js writes it on every set row). Some
 *  genres contain periods ("Rock Exp. Hip Hop"), so first try to match up to
 *  the sentence the importer appends next ("30-minute" / "Headlining"), then
 *  fall back to first-period. Rows without the prefix get no subtitle. */
function genreFromDescription(description: string | null | undefined): string | undefined {
  const d = description ?? ''
  const m = /^Genre:\s*(.+?)\.\s+(?:30-minute|Headlining|[A-Z][a-z]+ set)/.exec(d) ?? /^Genre:\s*([^.]+)\./.exec(d)
  return m ? m[1] : undefined
}

/** Venue line with the importer's "PorchRokr " prefix stripped for display. */
function venueLabel(item: FestivalScheduleItem): string | null {
  const venue = firstVenue(item.event)
  if (!venue?.name) return null
  return venue.name.startsWith('PorchRokr ') ? venue.name.slice('PorchRokr '.length) : venue.name
}

/**
 * Adapt a schedule item to the normalized AppEvent shape EventCard consumes.
 * city is hardcoded 'Akron' on purpose: EfficientCard prints ", {city}" for
 * any city !== 'Akron', so omitting it would render ", undefined". The whole
 * event flows into EventCard's AddToPlanButton, whose snapshot needs
 * venue.lat/lng (the hub query selects them).
 */
function toAppEvent(item: FestivalScheduleItem): AppEvent {
  const row = item.event
  const venue = firstVenue(row)
  const cats = (row.event_categories ?? []).map((ec) => ec.category).filter(Boolean)
  return {
    id: row.id,
    title: actName(row.title),
    start_at: row.start_at,
    end_at: row.end_at,
    description: row.description,
    category: cats[0] ?? 'other',
    categories: cats,
    venue: {
      name: venueLabel(item) ?? item.column.label,
      city: 'Akron',
      lat: venue?.lat ?? null,
      lng: venue?.lng ?? null,
    },
    venues: [],
    organizer: null,
    organizations: [],
    price_min: row.price_min,
    price_max: row.price_max,
  }
}

export default function FestivalPage() {
  const { slug } = useParams()
  const festival = festivalBySlug(slug)
  const { draft } = useDayPlan()

  const { data: rows, loading, error } = useAsync<FestivalEventRow[]>(
    async () => {
      if (!festival) return []
      const { data, error: fetchError } = await supabase
        .from('events')
        .select('id, title, description, image_url, start_at, end_at, tags, status, price_min, price_max, event_categories ( category ), event_venues ( venues ( id, name, lat, lng ) )')
        .contains('tags', [festival.tag])
        .eq('status', 'published')
        .order('start_at', { ascending: true })
        .limit(250)
      if (fetchError) throw fetchError
      return (data ?? []) as unknown as FestivalEventRow[]
    },
    [festival?.tag],
    [],
  )

  // 60-second tick — cheap, and only consulted for live-status rendering on
  // the festival day itself.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  if (!festival) {
    return (
      <div className="festival-notfound">
        <p>Festival not found</p>
        <Link to="/">← Back to events</Link>
      </div>
    )
  }

  const schedule = buildFestivalSchedule(rows ?? [])
  const isFestivalDay = easternTodayIso() === festival.dateKey
  const nextSlot = isFestivalDay ? upNextSlot(schedule, nowMs) : null
  const umbrella = schedule.umbrella

  const dateLabel = new Date(`${festival.dateKey}T12:00:00`).toLocaleDateString([], {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })

  return (
    <div className="page-festival">
      <SEO
        title={`${festival.name} — schedule & lineup`}
        description={`Full ${festival.name} schedule: every set, stage, and porch, with times and locations.`}
        path={`/festival/${festival.slug}`}
        image={umbrella?.image_url || undefined}
      />

      {/* ── Umbrella header card — the page's only image ── */}
      <header className="festival-header">
        {umbrella?.image_url && (
          <img className="festival-poster" src={umbrella.image_url} alt={`${festival.name} poster`} loading="eager" />
        )}
        <div className="festival-header-text">
          <h1 className="festival-title">{festival.name}</h1>
          <p className="festival-date">{dateLabel}</p>
          {umbrella?.description && (
            <p className="festival-logistics">{umbrella.description}</p>
          )}
          <p className="festival-links">
            {umbrella && <Link to={eventPath(umbrella)}>Festival details →</Link>}
            {festival.website && (
              <a href={festival.website} target="_blank" rel="noopener noreferrer">Organizer site ↗</a>
            )}
          </p>
        </div>
      </header>

      {/* ── Day-plan call-out — the hub's whole point is building a day.
          Copy rule: no em dashes in user-facing strings. ── */}
      <div className="festival-plan-cta">
        {draft.items.length > 0 ? (
          <>
            <p className="festival-plan-cta-text">
              You&apos;ve planned {draft.items.length} {draft.items.length === 1 ? 'stop' : 'stops'}
            </p>
            <Link to="/day" className="festival-plan-cta-btn">See your day</Link>
          </>
        ) : (
          <p className="festival-plan-cta-text">
            Tap + Plan on any set below to build your own PorchRokr schedule.
          </p>
        )}
      </div>

      {loading && <p className="festival-status-line">Loading schedule…</p>}
      {error && <p className="festival-status-line">Could not load the schedule. Please try again.</p>}
      {!loading && !error && schedule.slots.length === 0 && (
        <p className="festival-status-line">The set-by-set schedule hasn&apos;t been published yet — check back soon.</p>
      )}

      {/* ── Time-major schedule — shared compact-view components ── */}
      {schedule.slots.map((slot) => {
        const isNext = nextSlot?.startMs === slot.startMs
        const slotLive = isFestivalDay && slot.items.some((i) => isHappeningNow(i, nowMs))
        return (
          <section key={slot.startAt} className="festival-slot">
            <h2 className="date-heading">
              <span className="date-label">{slotTimeLabel(slot.startAt)}</span>
              {slotLive && <span className="today-badge">Happening now</span>}
              {isNext && !slotLive && (
                <span className="today-badge" style={{ background: 'var(--green-mid)' }}>Up next</span>
              )}
              <div className="date-line" />
            </h2>
            <div className="cards-grid--efficient">
              {slot.items.map((item) => {
                const live = isFestivalDay && isHappeningNow(item, nowMs)
                return (
                  <div key={item.event.id} className={live ? 'festival-card--live' : undefined}>
                    <EventCard
                      event={toAppEvent(item)}
                      viewMode="efficient"
                      planSurface="festival_hub"
                      subtitle={genreFromDescription(item.event.description)}
                    />
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
