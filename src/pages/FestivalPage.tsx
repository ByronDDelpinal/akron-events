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
 * CSS. Desktop (min-width: 900px) mounts it automatically; mobile mounts it
 * on the map section's first intersection (useInViewOnce, 200px lead,
 * latched once and then the observer disconnects), and a framed document or
 * a browser with no IntersectionObserver fails open to mounting. The 360px
 * .festival-map-section wrapper renders from first paint, before the schedule
 * query resolves, and reserves the height, so swapping the placeholder for
 * the map shifts nothing.
 *
 * Honest accounting on the deferral: it no longer saves an uninterested
 * phone the maplibre chunk the way the old tap card did, because the section
 * sits near the top of the page and an ordinary scroll reaches it in a
 * moment. What it still buys is the day-of visitor, whose auto-scroll jumps
 * straight past the map to the live slot and who therefore never pays for
 * tiles at all.
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
import { useInViewOnce } from '@/hooks/useInViewOnce'
import { useMatchMedia } from '@/hooks/useMatchMedia'
import EventCard from '@/components/EventCard'
import type { AppEvent } from '@/hooks/useEvents'
import './HomePage.css'
import './FestivalPage.css'

// Lazy: the maplibre stack never enters the static graph until the map
// actually mounts (desktop match, or the map section scrolling into view on
// mobile). Same pattern and rationale as DayPlanBoard.tsx's lazy PlanMap.
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

  // Map mount gate. Desktop mounts synchronously off the media query AND
  // passes force, which latches the hook without observing. Leaving a live
  // desktop observer to do the latching was wrong: both App.tsx's POP scroll
  // restore (a rAF jump, and rAF runs before intersection observations are
  // updated) and the festival-day auto-scroll under reduced motion can move
  // the section out of view before the first record is delivered. With force,
  // a visitor who crosses the 900px breakpoint downward can never have an
  // already-mounted map yanked out from under them.
  const mapSectionRef = useRef<HTMLDivElement | null>(null)
  const mapInView = useInViewOnce(mapSectionRef, {
    rootMargin: '200px 0px',
    enabled: pins.length > 0,
    force: isDesktop,
  })
  const showMap = pins.length > 0 && (isDesktop || mapInView)

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
          auto-mounts; mobile mounts on the section's first intersection.
          The wrapper renders from FIRST PAINT, while the schedule query is
          still in flight, so its 360px height is reserved before the rows
          land and neither the query resolving nor the map mounting shifts
          anything below it. Gating this on pins alone (the obvious reading)
          inverts that: it inserts ~380px the moment the query resolves.
          Residual, accepted: a festival with no geocoded venue, or a failed
          schedule fetch (useAsync leaves data at its [] initial on rejection,
          so pins is empty there too), drops the wrapper on resolve (one
          upward shift on a page that is already showing "the schedule
          hasn't been published yet" or the error line). Reserving it
          permanently instead would leave an empty dark box on those pages,
          which DayPlanBoard's own rule already rejects. ── */}
      {(loading || pins.length > 0) && (
        <div className="festival-map-section" ref={mapSectionRef}>
          {/* Heading-navigable name for the section. Also the mobile escape
              hatch: the tap card that used to be the only focusable thing in
              this slot is gone, and jumping to this heading scrolls the
              section into view, which is what fires the observer. .sr-only is
              globals.css's app-wide utility: absolute + clip, so it adds no
              height and the 360px reservation is untouched. Borrowed from
              CategoryPage's hub-events heading, but only the hiding, not the
              wiring: that heading is an aria-labelledby target naming a
              landmark section, while this one names nothing on purpose and is
              purely a heading-navigation target. Do NOT "restore" an
              aria-labelledby here. It would turn the wrapper into a landmark
              that duplicates the label FestivalMap already supplies (role
              group + aria-label) once mounted. */}
          <h2 className="sr-only">Venue map</h2>
          {showMap ? (
            <Suspense fallback={<div className="festival-map-skeleton" aria-hidden="true" />}>
              <FestivalMap
                pins={pins}
                bounds={festival.mapBounds}
                plannedVenueIds={plannedIds}
                festivalName={festival.name}
              />
            </Suspense>
          ) : (
            <div className="festival-map-skeleton" aria-hidden="true" />
          )}
        </div>
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
