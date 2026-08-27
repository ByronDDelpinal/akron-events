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
import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { SEO } from '@/lib/seo'
import { eventPath } from '@/lib/slug'
import { festivalBySlug, festivalDateRangeLabel, festivalScheduleMode, isFestivalDateKey } from '@/lib/festivals'
import {
  buildFestivalSchedule,
  dayItems,
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

/** Display-only day label built from an already-resolved Eastern day key,
 *  never a clock read. Shared by the jump bar's short form ("Thu Sep 10")
 *  and the multi-day section heading's long form ("Thursday, September 10"). */
function dayLabel(dateKey: string, opts: Intl.DateTimeFormatOptions): string {
  return new Date(`${dateKey}T12:00:00`).toLocaleDateString([], opts)
}
const SHORT_DAY_OPTS: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }
const LONG_DAY_OPTS: Intl.DateTimeFormatOptions = { weekday: 'long', month: 'long', day: 'numeric' }

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
  const todayIso = easternTodayIso()
  const isFestivalDay = festival ? isFestivalDateKey(festival, todayIso) : false
  // 'slot' (a heading per start time) or 'day' (a heading per day, cards in
  // one grid). Registry-driven; 'slot' is the default and every existing
  // festival keeps it.
  const scheduleMode = festival ? festivalScheduleMode(festival) : 'slot'

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

  // Schedule sections register themselves here for the jump bar and the
  // day-of auto-scroll below. The key is whatever the jump bar's chips
  // address: a slot's startAt in 'slot' mode, a day's dateKey in 'day'
  // mode. Both are unique strings within one festival, so one map serves
  // both layouts.
  const sectionRefs = useRef(new Map<string, HTMLElement>())
  const registerSection = useCallback((key: string, el: HTMLElement | null) => {
    if (el) sectionRefs.current.set(key, el)
    else sectionRefs.current.delete(key)
  }, [])

  const scrollToSection = useCallback((key: string) => {
    sectionRefs.current.get(key)?.scrollIntoView({
      block: 'start',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    })
  }, [])

  // Day-of auto-scroll: once, when the rows settle on the festival's
  // Eastern day, jump to the live slot (or the up-next slot between slots).
  // In 'day' mode the sections ARE days, so the same target slot resolves to
  // the day section holding it: the reader still lands on the live set's
  // grid, one screen higher.
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
    const targetKey = scheduleMode === 'day'
      ? schedule.days.find((d) => d.slots.includes(target))?.dateKey
      : target.startAt
    if (!targetKey) return
    sectionRefs.current.get(targetKey)?.scrollIntoView({
      block: 'start',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    })
  }, [loading, isFestivalDay, schedule, scheduleMode])

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
  const multiDay = schedule.days.length > 1

  const dateLabel = festivalDateRangeLabel(festival)

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

      {/* ── Jump bar: sticky under the site header. 'slot' mode gets one
          chip per start time (with a day label ahead of each day's run when
          the festival spans days); 'day' mode gets one chip per day, since
          the day sections are what there is to jump to. Either way the live
          chip gets the "Happening now" treatment on the day. ── */}
      {schedule.slots.length > 0 && (
        <nav
          className="festival-jump-bar"
          aria-label={scheduleMode === 'day' ? 'Jump to a schedule day' : 'Jump to a schedule time'}
        >
          {scheduleMode === 'day'
            ? schedule.days.map((day) => {
              const chipLive = isFestivalDay && dayItems(day).some((i) => isHappeningNow(i, nowMs))
              return (
                <button
                  key={day.dateKey}
                  type="button"
                  className={`festival-jump-chip${chipLive ? ' festival-jump-chip--live' : ''}`}
                  aria-current={chipLive ? 'true' : undefined}
                  onClick={() => scrollToSection(day.dateKey)}
                >
                  {dayLabel(day.dateKey, SHORT_DAY_OPTS)}
                </button>
              )
            })
            : schedule.days.map((day) => (
              <Fragment key={day.dateKey}>
                {multiDay && (
                  <span className="festival-jump-day" aria-hidden="true">
                    {dayLabel(day.dateKey, SHORT_DAY_OPTS)}
                  </span>
                )}
                {day.slots.map((slot) => {
                  const chipLive = isFestivalDay && slot.items.some((i) => isHappeningNow(i, nowMs))
                  return (
                    <button
                      key={slot.startAt}
                      type="button"
                      className={`festival-jump-chip${chipLive ? ' festival-jump-chip--live' : ''}`}
                      aria-current={chipLive ? 'true' : undefined}
                      onClick={() => scrollToSection(slot.startAt)}
                    >
                      {slotTimeLabel(slot.startAt)}
                    </button>
                  )
                })}
              </Fragment>
            ))}
        </nav>
      )}

      {loading && <p className="festival-status-line">Loading schedule…</p>}
      {error && <p className="festival-status-line">Could not load the schedule. Please try again.</p>}
      {!loading && !error && schedule.slots.length === 0 && (
        <p className="festival-status-line">The full schedule hasn&apos;t been published yet. Check back soon.</p>
      )}

      {/* ── The schedule. Both modes render the SAME EventCard in the SAME
          .cards-grid--efficient; they differ only in what gets a heading.

          'slot' (default, PorchRokr and Pride): a heading per start time,
          holding the cards that share that instant. Single-day output is
          byte-identical to before day grouping existed, and multi-day only
          inserts a day heading ahead of each day's run of slots.

          'day' (Rubber City Jazz): a heading per day, holding the whole
          day's cards as one grid in start order. With 17 distinct starts
          across 18 sets, per-slot headings would be one heading per card;
          the card already carries its own date, time and venue, so the
          per-slot boundary buys nothing and costs a very long scroll. ── */}
      {schedule.days.map((day) => {
        const dayHeading = multiDay && (
          <h2 className="date-heading festival-day-heading">
            <span className="date-label">{dayLabel(day.dateKey, LONG_DAY_OPTS)}</span>
            {day.dateKey === todayIso && <span className="today-badge">Today</span>}
            <div className="date-line" />
          </h2>
        )

        // Card states are per ROW in both modes: "live" is a per-item
        // instant test, and "up next" is membership of the single up-next
        // slot. Slot mode says both in the slot HEADING (badge text) and
        // uses the card outline as reinforcement. Day mode has no slot
        // heading, so the badge moves onto the card itself: the state has
        // to be carried by TEXT, not by outline hue alone, or a screen
        // reader gets nothing and a sighted reader is told apart amber from
        // green (WCAG 1.4.1). Same .today-badge pill, same green inline
        // style the "Up next" heading badge already uses.
        const card = (item: FestivalScheduleItem) => {
          const live = isFestivalDay && isHappeningNow(item, nowMs)
          const isNext = scheduleMode === 'day' && !live && nextSlot?.startMs === item.startMs
          return (
            <div
              key={item.event.id}
              className={live ? 'festival-card--live' : isNext ? 'festival-card--next' : undefined}
            >
              {scheduleMode === 'day' && live && (
                <span className="today-badge festival-card-state">Happening now</span>
              )}
              {isNext && (
                <span
                  className="today-badge festival-card-state"
                  style={{ background: 'var(--green-mid)' }}
                >Up next</span>
              )}
              <EventCard
                event={toAppEvent(item, festival.venueNamePrefix)}
                viewMode="efficient"
                planSurface="festival_hub"
                subtitle={genreFromDescription(item.event.description)}
              />
            </div>
          )
        }

        if (scheduleMode === 'day') {
          return (
            <section
              key={day.dateKey}
              className="festival-day"
              ref={(el) => { registerSection(day.dateKey, el) }}
            >
              {dayHeading}
              <div className="cards-grid--efficient">{dayItems(day).map(card)}</div>
            </section>
          )
        }

        const daySlots = day.slots.map((slot) => {
          const isNext = nextSlot?.startMs === slot.startMs
          const slotLive = isFestivalDay && slot.items.some((i) => isHappeningNow(i, nowMs))
          return (
            <section
              key={slot.startAt}
              className="festival-slot"
              ref={(el) => { registerSection(slot.startAt, el) }}
            >
              <h2 className="date-heading">
                <span className="date-label">{slotTimeLabel(slot.startAt)}</span>
                {slotLive && <span className="today-badge">Happening now</span>}
                {isNext && !slotLive && (
                  <span className="today-badge" style={{ background: 'var(--green-mid)' }}>Up next</span>
                )}
                <div className="date-line" />
              </h2>
              <div className="cards-grid--efficient">{slot.items.map(card)}</div>
            </section>
          )
        })

        if (!multiDay) return <Fragment key={day.dateKey}>{daySlots}</Fragment>

        return (
          <section key={day.dateKey} className="festival-day">
            {dayHeading}
            {daySlots}
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
