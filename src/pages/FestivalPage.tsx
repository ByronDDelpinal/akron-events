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
 *
 * Everything here is registry-driven (festivals.ts) so the next festival
 * gets the whole hub (map, jump bar, live states, floating plan pill) by
 * adding one registry entry plus tagged events. Nothing festival-specific
 * is hardcoded in this file.
 *
 * Venue map: FestivalMap is React.lazy'd and mount-gated, never hidden with
 * CSS. Desktop (min-width: 900px) mounts it automatically; mobile renders a
 * light "Show map" card in the same slot and mounts the map only after a tap
 * (mapRequested), so an uninterested phone fetches neither the maplibre
 * chunk nor a single tile. Once tapped the map stays mounted (no hide toggle
 * in v1), including across a breakpoint crossing: the render condition is
 * isDesktop || mapRequested.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { SEO } from '@/lib/seo'
import { eventPath } from '@/lib/slug'
import { festivalBySlug } from '@/lib/festivals'
import {
  buildFestivalSchedule,
  firstVenue,
  happeningNowSlots,
  isHappeningNow,
  plannedVenueIds,
  stripVenuePrefix,
  toFestivalMapPins,
  upNextSlot,
  type FestivalEventRow,
  type FestivalScheduleItem,
} from '@/lib/festivalSchedule'
import { easternTodayIso } from '@/lib/dayPlanDate'
import { prefersReducedMotion } from '@/lib/feedback'
import { useAsync } from '@/hooks/useAsync'
import { useDayPlan } from '@/hooks/useDayPlan'
import { useMatchMedia } from '@/hooks/useMatchMedia'
import EventCard from '@/components/EventCard'
import type { AppEvent } from '@/hooks/useEvents'
import './HomePage.css'
import './FestivalPage.css'

// Lazy: the maplibre stack never enters the static graph until the map
// section actually mounts (desktop match, or a mobile "Show map" tap).
// Same pattern and rationale as DayPlanBoard.tsx's lazy PlanMap.
const FestivalMap = lazy(() => import('@/components/FestivalMap'))

// Matches DayPlanBoard's MOBILE_QUERY split (899/900) so "desktop" means
// the same thing on both plan-adjacent surfaces.
const DESKTOP_QUERY = '(min-width: 900px)'

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

/** Venue line with the registry-declared importer prefix stripped for
 *  display (festivals.ts venueNamePrefix; same helper the map pins use, so
 *  list and map can never disagree about a venue's name). */
function venueLabel(item: FestivalScheduleItem, venueNamePrefix?: string): string | null {
  const venue = firstVenue(item.event)
  return stripVenuePrefix(venue?.name, venueNamePrefix)
}

/**
 * Adapt a schedule item to the normalized AppEvent shape EventCard consumes.
 * city is hardcoded 'Akron' on purpose: EfficientCard prints ", {city}" for
 * any city !== 'Akron', so omitting it would render ", undefined". The whole
 * event flows into EventCard's AddToPlanButton, whose snapshot needs
 * venue.lat/lng (the hub query selects them).
 */
function toAppEvent(item: FestivalScheduleItem, venueNamePrefix?: string): AppEvent {
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
      name: venueLabel(item, venueNamePrefix) ?? item.column.label,
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
  const isDesktop = useMatchMedia(DESKTOP_QUERY)
  // Mobile tap-to-load gate: false until the visitor asks for the map.
  // One-way in v1 (no hide toggle); desktop auto-mounts and ignores it.
  const [mapRequested, setMapRequested] = useState(false)

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

  const schedule = useMemo(() => buildFestivalSchedule(rows ?? []), [rows])
  const isFestivalDay = festival ? easternTodayIso() === festival.dateKey : false

  // The map's pins and planned-ring venue set (both pure derivations in
  // festivalSchedule.ts; no second query, the map renders what the
  // schedule already fetched).
  const pins = useMemo(
    () => toFestivalMapPins(schedule, { venueNamePrefix: festival?.venueNamePrefix }),
    [schedule, festival?.venueNamePrefix],
  )
  const draftEventIds = useMemo(() => new Set(draft.items.map((i) => i.event_id)), [draft.items])
  const plannedIds = useMemo(() => plannedVenueIds(schedule, draftEventIds), [schedule, draftEventIds])

  // Slot sections register themselves here (keyed by slot startAt) for the
  // jump bar and the day-of auto-scroll below.
  const slotRefs = useRef(new Map<string, HTMLElement>())
  const registerSlot = useCallback((startAt: string, el: HTMLElement | null) => {
    if (el) slotRefs.current.set(startAt, el)
    else slotRefs.current.delete(startAt)
  }, [])

  const scrollToSlot = useCallback((startAt: string) => {
    slotRefs.current.get(startAt)?.scrollIntoView({
      block: 'start',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    })
  }, [])

  // Day-of auto-scroll: once, when the rows settle on the festival's
  // Eastern day, jump to the live slot (or the up-next slot between slots).
  // Fires at most ONCE per mount (autoScrolledRef), never re-triggers on
  // the 60s tick (nowMs is read inside, not a dependency), and yields to a
  // reader who has already scrolled (only fires with the window still near
  // the top when data settles).
  const autoScrolledRef = useRef(false)
  useEffect(() => {
    if (autoScrolledRef.current) return
    if (loading || !isFestivalDay || schedule.slots.length === 0) return
    autoScrolledRef.current = true
    if (window.scrollY > 120) return
    const now = Date.now()
    const target = happeningNowSlots(schedule, now)[0] ?? upNextSlot(schedule, now)
    if (!target) return
    slotRefs.current.get(target.startAt)?.scrollIntoView({
      block: 'start',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    })
  }, [loading, isFestivalDay, schedule])

  if (!festival) {
    return (
      <div className="festival-notfound">
        <p>Festival not found</p>
        <Link to="/">← Back to events</Link>
      </div>
    )
  }

  const nextSlot = isFestivalDay ? upNextSlot(schedule, nowMs) : null
  const umbrella = schedule.umbrella

  const dateLabel = new Date(`${festival.dateKey}T12:00:00`).toLocaleDateString([], {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  })

  return (
    <div className="page-festival">
      <SEO
        title={`${festival.name} — schedule & lineup`}
        description={`Full ${festival.name} schedule: every performance, stage, and location, with times and a map.`}
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

      {/* ── Venue map: lazy, mount-gated (never display:none). Desktop
          auto-mounts; mobile mounts only after the "Show map" tap below,
          so a phone fetches no maplibre chunk and no tiles until asked ── */}
      {pins.length > 0 && (isDesktop || mapRequested) && (
        <div className="festival-map-section">
          <Suspense fallback={<div className="festival-map-skeleton" aria-hidden="true" />}>
            <FestivalMap
              pins={pins}
              bounds={festival.mapBounds}
              plannedVenueIds={plannedIds}
              festivalName={festival.name}
            />
          </Suspense>
        </div>
      )}

      {/* ── Mobile tap-to-load card: same slot as the map. One-way (no hide
          toggle in v1); crossing to desktop after tapping keeps the map
          mounted via isDesktop || mapRequested above. ── */}
      {pins.length > 0 && !isDesktop && !mapRequested && (
        <button
          type="button"
          className="festival-map-cta"
          aria-label="Show festival map"
          onClick={() => setMapRequested(true)}
        >
          <svg
            className="festival-map-cta-glyph"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M9 3 3 5v16l6-2 6 2 6-2V3l-6 2-6-2z" />
            <path d="M9 3v16" />
            <path d="M15 5v16" />
          </svg>
          <span className="festival-map-cta-text">
            <span className="festival-map-cta-title">Show map</span>
            <span className="festival-map-cta-hint">Loads the venue map</span>
          </span>
        </button>
      )}

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
            Tap + Plan on anything below to build your own {festival.name} schedule.
          </p>
        )}
      </div>

      {/* ── Slot-jump bar: sticky under the site header; one chip per
          slot, live chip gets the "Happening now" treatment on the day ── */}
      {schedule.slots.length > 0 && (
        <nav className="festival-jump-bar" aria-label="Jump to a schedule time">
          {schedule.slots.map((slot) => {
            const chipLive = isFestivalDay && slot.items.some((i) => isHappeningNow(i, nowMs))
            return (
              <button
                key={slot.startAt}
                type="button"
                className={`festival-jump-chip${chipLive ? ' festival-jump-chip--live' : ''}`}
                aria-current={chipLive ? 'true' : undefined}
                onClick={() => scrollToSlot(slot.startAt)}
              >
                {slotTimeLabel(slot.startAt)}
              </button>
            )
          })}
        </nav>
      )}

      {loading && <p className="festival-status-line">Loading schedule…</p>}
      {error && <p className="festival-status-line">Could not load the schedule. Please try again.</p>}
      {!loading && !error && schedule.slots.length === 0 && (
        <p className="festival-status-line">The full schedule hasn&apos;t been published yet. Check back soon.</p>
      )}

      {/* ── Time-major schedule — shared compact-view components ── */}
      {schedule.slots.map((slot) => {
        const isNext = nextSlot?.startMs === slot.startMs
        const slotLive = isFestivalDay && slot.items.some((i) => isHappeningNow(i, nowMs))
        return (
          <section
            key={slot.startAt}
            className="festival-slot"
            ref={(el) => { registerSlot(slot.startAt, el) }}
          >
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
                      event={toAppEvent(item, festival.venueNamePrefix)}
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

      {/* ── Floating plan pill: festival page only, draft has items ── */}
      {draft.items.length > 0 && (
        <Link
          to="/day"
          className="festival-plan-cta-btn festival-plan-float"
          aria-label={`Your plan: ${draft.items.length} ${draft.items.length === 1 ? 'stop' : 'stops'}. See your day`}
        >
          Your plan ({draft.items.length})
        </Link>
      )}
    </div>
  )
}
