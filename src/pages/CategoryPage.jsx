/**
 * CategoryPage.jsx
 *
 * Renders both category hubs ("Concerts in Akron") and neighborhood
 * hubs ("Downtown Akron Events") from a single component. Each hub is
 * defined declaratively in `/src/lib/seo/categories.js` so adding a
 * new landing page is one entry + one route — no copy-pasted JSX.
 *
 * Why one component for both:
 *   - The page structure is identical: hero header, unique intro copy,
 *     filter-able event list, related-hubs strip.
 *   - The only thing that changes between a category and a
 *     neighborhood is which filter the page applies before listing
 *     events (category vs. venue neighborhood_slug / city).
 *   - Sharing the component guarantees both hub types emit the same
 *     SEO surface (canonical, OG, JSON-LD ItemList + Breadcrumb).
 *
 * Light search / filter / sort layer (added 2026-06):
 *   Each hub page now exposes a plain text search input below the
 *   intro and the shared FilterBar + FilterTray above the events grid
 *   so users can narrow further without leaving the page. The hub's
 *   defining dimension is "locked" — Category on category hubs, Price
 *   on /events/free, Custom date range on /events/today and
 *   /events/this-weekend — so users can only filter *into* a page, not
 *   contradict it. Filter / search state is URL-backed (?q=,
 *   ?categories=, ?price=, ?sort=, ?from=, ?to=, ?hide=) so hub URLs
 *   stay shareable. The search input intentionally omits the intent-
 *   suggestion dropdown the homepage hero uses.
 *
 * SEO surface emitted here:
 *   - <title>, <meta description>, canonical, OG, Twitter (via <SEO />)
 *   - JSON-LD @graph: BreadcrumbList, ItemList of upcoming events
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, Link, Navigate, useSearchParams } from 'react-router-dom'
import { useEvents, PAGE_SIZE } from '@/hooks/useEvents'
import { INTENTS } from '@/lib/intents'
import EventCard from '@/components/EventCard'
import ShareButtons from '@/components/ShareButtons'
import NewsletterCTA from '@/components/NewsletterCTA'
import NeighborhoodMap from '@/components/NeighborhoodMap'
import SummitCountyMap from '@/components/SummitCountyMap'
import SourceOverflowCard from '@/components/SourceOverflowCard'
import DateHeading from '@/components/DateHeading'
import { groupEventsByDate, applySourceCap } from '@/lib/eventGrouping'
import {
  CATEGORY_OPTIONS,
  SORT_OPTIONS,
  PRICE_OPTIONS,
} from '@/lib/filterOptions'
import {
  SEO,
  buildGraph,
  breadcrumbSchema,
  itemListSchema,
  hubTitle,
  hubDescription,
  getHub,
  getCategoryHub,
  getNeighborhoodHub,
  getCityHub,
} from '@/lib/seo'
import { NEIGHBORHOOD_SLUGS } from '@/lib/neighborhoods'
import { CITY_SLUGS, AKRON_SLUG, AKRON_LABEL } from '@/lib/cities'
import { eventPath } from '@/lib/slug'
import './CategoryPage.css'

/**
 * Neighborhood matcher.
 *
 * Two strategies, chosen by the hub's slug:
 *
 *   1. Akron neighborhoods (the 24 City-recognized neighborhoods in
 *      src/lib/neighborhoods.js): match by `venue.neighborhood_slug`.
 *      This is the structured replacement for the original substring-
 *      based `venueIncludes` matcher, which was authored from memory
 *      without verified data (see docs/neighborhoods.md). Venues are
 *      classified manually today via the admin venue editor; a future
 *      PostGIS backfill will resolve them automatically from lat/lng
 *      against the official polygon set — same column either way.
 *
 *   2. Non-Akron city hubs (Cuyahoga Falls, Stow, Fairlawn & Copley):
 *      these are separate Summit County municipalities, not Akron
 *      neighborhoods, so `neighborhood_slug` doesn't apply. They
 *      match by the hub's declared `cityMatch` strings against
 *      `venue.city`.
 *
 * Events with no venue can't be placed on a map and have no
 * neighborhood, so they're excluded — same behavior as the old matcher.
 */
function eventMatchesNeighborhood(event, hub) {
  const venue = event.venue
  if (!venue) return false

  // Strategy 1: structured slug match for Akron neighborhoods.
  if (NEIGHBORHOOD_SLUGS.has(hub.slug)) {
    return venue.neighborhood_slug === hub.slug
  }

  // Strategy 2: city match for non-Akron municipalities.
  if (!hub.cityMatch || hub.cityMatch.length === 0) return false
  const city = (venue.city || '').toLowerCase()
  return hub.cityMatch.some((c) => c.toLowerCase() === city)
}

/**
 * Returns the dimensions locked by this hub — what the page is *about*.
 * The FilterBar / FilterTray hide these sections so the user can only
 * narrow further, never contradict the page's constraint.
 *
 * Neighborhood hubs filter by venue substring on the client and don't
 * lock any homepage-style dimension, so they get an empty object.
 */
function getLockedDimensions(hub, isCategory) {
  return {
    category:  isCategory && Array.isArray(hub.categoryFilter) && hub.categoryFilter.length > 0,
    price:     !!hub.freeOnly,
    dateRange: !!hub.dateRange,
  }
}

export default function CategoryPage() {
  const { slug } = useParams()
  const hub = getHub(slug)

  // Hub slugs are validated client-side via the registry. Anything
  // else under /events/:slug that isn't an event detail route (those
  // have a trailing UUID segment matched by /events/:slug/:id) is a
  // dead-end — redirect to the homepage so users land somewhere
  // useful instead of a barren 404.
  //
  // Disabled hubs (currently every neighborhood — see categories.js
  // header note about the GIS data gap) also redirect, so previously-
  // shared neighborhood URLs stay useful even with the hubs hidden
  // from the rest of the site.
  //
  // Exception: `preview: true` lets a disabled hub's URL resolve
  // anyway so we can share an unlisted link to a work-in-progress
  // design (e.g. the Highland Square map mockup). The hub still
  // remains absent from sitemap, footer, related strips, and
  // homepage chips — only people with the URL see it.
  if (!hub || (hub.disabled && !hub.preview)) return <Navigate to="/" replace />

  const isCategory     = !!getCategoryHub(slug)
  const isNeighborhood = !isCategory && !!getNeighborhoodHub(slug)
  const isCity         = !isCategory && !isNeighborhood && !!getCityHub(slug)
  // Akron-the-city is special: it shows the Akron neighborhood map
  // (not the Summit County map) since users on /events/akron drill
  // INTO Akron neighborhoods rather than across to other cities.
  // Every Akron-neighborhood hub also lists Akron as its breadcrumb
  // parent, which keeps "Home > Akron > Highland Square" valid.
  const isAkronCity    = isCity && hub.slug === AKRON_SLUG

  const lockedDimensions = useMemo(() => getLockedDimensions(hub, isCategory), [hub, isCategory])

  // ── URL-backed user filters ───────────────────────────────────────
  // Mirrors HomePage so /events/free?q=lock+3&sort=latest is a
  // shareable link. We use `replace` on every setter so filter
  // toggling doesn't pollute the browser back history.
  const [searchParams, setSearchParams] = useSearchParams()

  const updateParam = useCallback((key, value) => {
    const params = new URLSearchParams(searchParams)
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) {
      params.delete(key)
    } else {
      params.set(key, Array.isArray(value) ? value.join(',') : String(value))
    }
    setSearchParams(params, { replace: true })
  }, [searchParams, setSearchParams])

  // Read params — locked dimensions are ignored even if the URL contains
  // them (defensive: a copy-pasted homepage URL into a hub shouldn't
  // suddenly undo the hub's constraint).
  const search        = useMemo(() => searchParams.get('q') || '', [searchParams])
  const rawCategories = useMemo(() => {
    if (lockedDimensions.category) return []
    const c = searchParams.get('categories')
    return c ? c.split(',').filter(Boolean) : []
  }, [searchParams, lockedDimensions.category])
  const priceFilter   = useMemo(() => {
    if (lockedDimensions.price) return null
    return searchParams.get('price') || null
  }, [searchParams, lockedDimensions.price])
  const dateFrom      = useMemo(() => {
    if (lockedDimensions.dateRange) return null
    return searchParams.get('from') || null
  }, [searchParams, lockedDimensions.dateRange])
  const dateTo        = useMemo(() => {
    if (lockedDimensions.dateRange) return null
    return searchParams.get('to') || null
  }, [searchParams, lockedDimensions.dateRange])
  const sort          = useMemo(() => searchParams.get('sort') || 'soonest', [searchParams])
  // Intent is a category preset — only meaningful when Category isn't
  // locked. The FilterTray's Category section is hidden anyway when
  // category is locked, but we still need a stable value for FilterBar.
  const activeIntentId = useMemo(() => {
    if (lockedDimensions.category) return null
    return searchParams.get('intent') || null
  }, [searchParams, lockedDimensions.category])

  // Setters — each one writes to the URL. Locked-dimension setters are
  // no-ops; they exist only so the same FilterBar/Tray props pass
  // through cleanly.
  const setSearch         = useCallback((v) => updateParam('q', v), [updateParam])
  const setRawCategories  = useCallback((v) => updateParam('categories', v), [updateParam])
  const setPriceFilter    = useCallback((v) => updateParam('price', v), [updateParam])
  const setDateFrom       = useCallback((v) => updateParam('from', v), [updateParam])
  const setDateTo         = useCallback((v) => updateParam('to', v), [updateParam])
  const setSort           = useCallback((v) => updateParam('sort', v === 'soonest' ? null : v), [updateParam])
  const setActiveIntentId = useCallback((v) => updateParam('intent', v), [updateParam])

  // ── Search input draft (committed on Enter) ───────────────────────
  const [searchInput, setSearchInput] = useState(search)
  // Keep the input in sync with external URL changes (e.g. back button).
  useEffect(() => { setSearchInput(search) }, [search])
  const onSearchKeyDown = (e) => { if (e.key === 'Enter') setSearch(searchInput) }
  const onSearchBlur = () => { if (!searchInput) setSearch('') }

  // ── Resolve fetch parameters ──────────────────────────────────────
  // Categories: locked hubs override the user's choice with the hub's
  // own filter. If the user picked an intent (category preset), expand
  // it. Otherwise fall back to rawCategories.
  // Resolve the active intent from the canonical registry (single source of
  // truth — no duplicated mapping). Intents carry `categories` and/or `facets`.
  const intentDef = useMemo(
    () => (activeIntentId ? (INTENTS.find((i) => i.id === activeIntentId) ?? null) : null),
    [activeIntentId]
  )
  const intentCategories = intentDef?.categories ?? []
  const intentFacets     = intentDef?.facets ?? []

  // A hub can lock the facet axis (e.g. the Family hub → facetFilter:['family']).
  const hubFacets = Array.isArray(hub.facetFilter) ? hub.facetFilter : []

  const effectiveCategories = lockedDimensions.category
    ? hub.categoryFilter
    : (rawCategories.length > 0 ? rawCategories : intentCategories)

  // Facet flags: hub-locked facets always apply; intent facets apply when no
  // hub facet is set.
  const effectiveFamily     = hubFacets.includes('family')     || intentFacets.includes('family')
  const effectiveFundraiser = hubFacets.includes('fundraiser') || intentFacets.includes('fundraiser')

  const effectiveFreeOnly = lockedDimensions.price ? true : (priceFilter === 'free')
  const effectivePriceMax = lockedDimensions.price ? null
    : (priceFilter === 'free' ? null : priceFilter)
  const effectiveDateRange = lockedDimensions.dateRange ? hub.dateRange : null

  // ── Pagination state ──
  // Mirrors HomePage's accumulating-pages pattern: each Supabase fetch
  // returns one PAGE_SIZE page, an IntersectionObserver sentinel at the
  // end of the grid triggers the next, and allEvents is the cumulative
  // list rendered as date groups. Hub pages can have hundreds of events
  // (downtown alone) so we never want to materialize everything upfront,
  // and the user wants accurate totals — `total` from useEvents
  // (PostgREST count=exact) gives the real number even when only a
  // handful of pages are loaded.
  const [offset,      setOffset]      = useState(0)
  const [allEvents,   setAllEvents]   = useState([])
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [resultsKey,  setResultsKey]  = useState(0)

  // Akron city hub map toggle. Defaults to the neighborhood drill-down
  // — that's the most useful first view, since 24 polygons are the
  // user's reason to be on /events/akron at all. Switching to
  // "summit-county" swaps in the SummitCountyMap with Akron active,
  // giving a one-click zoom-out without leaving the page. Local state,
  // not URL-backed: the choice is a UI preference and shouldn't
  // pollute shareable links.
  const [akronMapView, setAkronMapView] = useState('neighborhoods')

  // Source-overflow expansion state — same pattern as HomePage.
  // Library/CDC/etc. calendars can dominate a single day's listing;
  // the cap shows the first SOURCE_CAP from each source per day, with
  // an overflow card that expands the rest on click. Keys are
  // `${dateKey}-${source}`.
  const [expandedSources, setExpandedSources] = useState(() => new Set())
  const toggleSource = useCallback((dateKey, source) => {
    const key = `${dateKey}-${source}`
    setExpandedSources((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // ── Filter signature → reset pagination on any change ──
  // Includes hub.slug so navigating from one neighborhood map polygon
  // to another (same component instance, different slug param) resets
  // the page rather than appending to the previous hub's events.
  const filterKey = [
    hub.slug,
    activeIntentId,
    effectiveCategories.join(','),
    effectiveDateRange,
    dateFrom,
    dateTo,
    search,
    effectiveFreeOnly,
    effectivePriceMax,
    sort,
  ].join('|')
  const prevFilterKey = useRef(filterKey)
  useEffect(() => {
    if (prevFilterKey.current !== filterKey) {
      prevFilterKey.current = filterKey
      setOffset(0)
      setIsRefreshing(true)
      // Don't clear allEvents — old cards stay visible (dimmed via
      // CSS) until the new first page lands. Avoids a content-jump
      // flash when only one filter changes.
    }
  }, [filterKey])

  // ── Data fetch ──
  // For all three hub types (category, Akron neighborhood, non-Akron
  // city), we push every available filter into Supabase. The
  // neighborhood-slug filter is the inner-join trick documented in
  // useEvents. Non-Akron city hubs (Cuyahoga Falls etc.) still need
  // a client-side cityMatch pass below since they don't have a
  // neighborhood_slug.
  const isAkronNeighborhood = isNeighborhood && NEIGHBORHOOD_SLUGS.has(hub.slug)
  const { events: page, loading, error, total, hasMore } = useEvents({
    categories: effectiveCategories,
    family:     effectiveFamily,
    fundraiser: effectiveFundraiser,
    freeOnly:   effectiveFreeOnly,
    priceMax:   effectivePriceMax,
    dateRange:  effectiveDateRange,
    dateFrom,
    dateTo,
    search,
    sort,
    neighborhoodSlug: isAkronNeighborhood ? hub.slug : null,
    limit:    PAGE_SIZE,
    offset,
  })

  // Append each incoming page to the accumulator, deduped by id so
  // any timing-related double-fetch can't render duplicate cards.
  useEffect(() => {
    if (loading) return
    if (offset === 0) {
      setAllEvents(page)
      setIsRefreshing(false)
      // Bumping resultsKey rotates the date-group div keys, which
      // remounts them — that retriggers the CSS entrance animation
      // for the fresh first page (same trick HomePage uses).
      setResultsKey((k) => k + 1)
    } else {
      setAllEvents((prev) => {
        const ids = new Set(prev.map((e) => e.id))
        return [...prev, ...page.filter((e) => !ids.has(e.id))]
      })
    }
  }, [page, loading, offset])

  // For city hubs (Akron city + every other Summit County city),
  // apply the client-side cityMatch filter. We don't push city
  // filtering down to Supabase yet — the neighborhoodSlug inner-join
  // trick that the Akron-neighborhood hubs use doesn't have a direct
  // city analog wired up. Hubs still benefit from pagination + the
  // infinite-scroll grid; counts on those pages are approximate per
  // page rather than exact. Akron-neighborhood and category hubs
  // pass straight through (they're already exact server-side).
  const events = useMemo(() => {
    if (isCity) {
      return allEvents.filter((e) => eventMatchesNeighborhood(e, hub))
    }
    return allEvents
  }, [allEvents, isCity, hub])

  const grouped = useMemo(() => groupEventsByDate(events), [events])

  // ── Infinite scroll ──
  // Same IntersectionObserver pattern HomePage uses. A zero-height
  // sentinel sits below the grid; when it enters a 1500px-tall
  // prefetch zone above the viewport bottom we fetch the next page.
  // The observer is recreated on hasMore / count flips so a freshly-
  // painted page can immediately trigger the next if the sentinel
  // is still inside the zone.
  const sentinelRef = useRef(null)
  const loadingRef  = useRef(loading)
  useEffect(() => { loadingRef.current = loading }, [loading])

  const loadMoreRef = useRef()
  loadMoreRef.current = () => {
    if (loadingRef.current || !hasMore) return
    setOffset((prev) => prev + PAGE_SIZE)
  }

  useEffect(() => {
    if (!hasMore) return
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            loadMoreRef.current?.()
            break
          }
        }
      },
      { rootMargin: '0px 0px 1500px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasMore, allEvents.length])

  // ── Breadcrumb trail ──
  // Akron neighborhoods nest under the Akron city hub so the
  // hierarchy reads as "Home > Akron > Highland Square". City hubs
  // (Akron included) sit one level below Home: "Home > Cuyahoga
  // Falls". Category hubs stay flat under Home as before. The same
  // trail drives both the visible <nav> and the JSON-LD
  // BreadcrumbList SEO graph.
  const canonicalPath = `/events/${hub.slug}`
  const breadcrumbTrail = useMemo(() => {
    const trail = [{ name: 'Home', url: '/' }]
    if (isNeighborhood) {
      trail.push({ name: AKRON_LABEL, url: `/events/${AKRON_SLUG}` })
    }
    trail.push({ name: hub.label, url: canonicalPath })
    return trail
  }, [isNeighborhood, hub.label, canonicalPath])
  const breadcrumb = breadcrumbSchema(breadcrumbTrail)
  const itemList = itemListSchema(
    events.slice(0, 20).map((e) => ({
      name: e.title,
      url: eventPath(e),
    })),
  )

  const seoGraph = buildGraph(breadcrumb, itemList)

  // ── Related hubs strip ── (Action 08: internal linking)
  // Skip disabled hubs in the related-hubs strip too — we don't want
  // to send the user from an accurate hub to one that filters wrong.
  const related = (hub.relatedSlugs ?? [])
    .map((s) => getHub(s))
    .filter((h) => h && !h.disabled)

  return (
    <div className="hub-page">
      <SEO
        title={hubTitle(hub)}
        description={hubDescription(hub)}
        path={canonicalPath}
        // Branded per-hub OG image generated by /api/og/hub/[slug].
        // Falls back to /og-default.jpg if the edge function fails.
        image={`/api/og/hub/${hub.slug}`}
        type="website"
        jsonLd={seoGraph}
      />

      {/* NOTE: this wrapper used to be a <header> element, but a
       *  global rule in Header.css (`header { position: sticky;
       *  top: 0; z-index: 100; }`) was matching it and pinning the
       *  intro to the viewport top. Using a plain <div> sidesteps
       *  the global selector. The semantic site header lives in
       *  the shared <Header /> component. */}
      <div className="hub-header">
        {/* Breadcrumb. Driven by breadcrumbTrail so the visible
            navigation and the JSON-LD BreadcrumbList stay in lockstep.
            The final crumb is rendered as plain text since it's the
            current page; earlier crumbs are clickable links. */}
        <nav className="hub-breadcrumb" aria-label="Breadcrumb">
          {breadcrumbTrail.map((crumb, i) => {
            const isLast = i === breadcrumbTrail.length - 1
            return (
              <Fragment key={crumb.url}>
                {i > 0 && <span aria-hidden="true">›</span>}
                {isLast
                  ? <span aria-current="page">{crumb.name}</span>
                  : <Link to={crumb.url}>{crumb.name}</Link>}
              </Fragment>
            )
          })}
        </nav>
        <h1 className="hub-h1">{hub.h1}</h1>

        {/* Hero body.
         *
         * Three map-driven hero layouts, picked by hub type:
         *
         *   - Akron neighborhood hub: NeighborhoodMap with this
         *     neighborhood active. User can click another polygon to
         *     pivot inside Akron.
         *   - Akron city hub (/events/akron): NeighborhoodMap with
         *     no active slug. The map IS the discovery surface for
         *     drilling into a specific neighborhood.
         *   - Any other city hub (/events/cuyahoga-falls, etc.):
         *     SummitCountyMap with this city active. User can click
         *     across to other Summit County cities — or to Akron,
         *     which lands on the neighborhood-drill version above.
         *   - Category hubs and anything else: single-column intro
         *     with no map.
         *
         * The grid collapses to single column on narrow viewports —
         * see CategoryPage.css. */}
        {isNeighborhood ? (
          <div className="hub-hero-grid">
            <p className="hub-intro hub-intro--with-map">{hub.intro}</p>
            <NeighborhoodMap activeSlug={hub.slug} />
          </div>
        ) : isAkronCity ? (
          <div className="hub-hero-grid">
            <p className="hub-intro hub-intro--with-map">{hub.intro}</p>
            <div className="akron-map-stack">
              {/* Map swap — default is the neighborhood drill-down;
                  toggle below switches to the county-level zoom-out
                  with Akron pre-selected. */}
              {akronMapView === 'neighborhoods'
                ? <NeighborhoodMap activeSlug={null} activeLabelOverride="all of Akron" />
                : <SummitCountyMap activeSlug={AKRON_SLUG} />}

              {/* Zoom-level dropdown.
               *  Sits under the map so it reads as a meta-control on
               *  the widget rather than a competing primary action.
               *  Local state only — not URL-backed — because the
               *  view is a personal preference, not a shareable
               *  filter dimension. */}
              <div className="akron-map-toggle">
                <label htmlFor="akron-map-toggle-select" className="akron-map-toggle-label">
                  View
                </label>
                <select
                  id="akron-map-toggle-select"
                  className="akron-map-toggle-select"
                  value={akronMapView}
                  onChange={(e) => setAkronMapView(e.target.value)}
                >
                  <option value="neighborhoods">Akron Neighborhoods</option>
                  <option value="summit-county">Summit County</option>
                </select>
              </div>
            </div>
          </div>
        ) : isCity ? (
          <div className="hub-hero-grid">
            <p className="hub-intro hub-intro--with-map">{hub.intro}</p>
            <SummitCountyMap activeSlug={hub.slug} />
          </div>
        ) : (
          <p className="hub-intro">{hub.intro}</p>
        )}

        {/* Share / copy-link row — UTM campaign differs between
            category and neighborhood hubs so analytics can tell them
            apart. */}
        <div className="hub-share">
          <ShareButtons
            url={canonicalPath}
            title={hub.h1}
            text={hub.metaDescription}
            campaign={isCategory ? 'category_hub' : isCity ? 'city_hub' : 'neighborhood_hub'}
          />
        </div>

        {/* Search input — plain text only, no intent suggestion
            dropdown. Same max-width as the intro paragraph so the
            header reads as one tidy column. URL-backed (?q=) for
            shareable links. */}
        <div className="hub-search">
          <HubSearchIcon />
          <input
            className="hub-search-input"
            type="text"
            placeholder={`Search ${hub.label.toLowerCase()}…`}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={onSearchKeyDown}
            onBlur={onSearchBlur}
            aria-label={`Search ${hub.label}`}
          />
          {searchInput && (
            <button
              type="button"
              className="hub-search-clear"
              onClick={() => { setSearchInput(''); setSearch('') }}
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        {/* Filter & sort — exposed inline (no modal on hub pages).
            Sections corresponding to the hub's defining dimension
            (Category, Price, Custom date range) are omitted so users
            can only narrow further, never contradict the page. */}
        <HubFilters
          lockedDimensions={lockedDimensions}
          sort={sort}                      onSort={setSort}
          activeIntentId={activeIntentId}  onIntentId={setActiveIntentId}
          rawCategories={rawCategories}    onRawCategories={setRawCategories}
          priceFilter={priceFilter}        onPriceFilter={setPriceFilter}
          dateFrom={dateFrom}              onDateFrom={setDateFrom}
          dateTo={dateTo}                  onDateTo={setDateTo}
          hasAnyUserFilter={
            !!activeIntentId
            || rawCategories.length > 0
            || priceFilter !== null
            || dateFrom !== null
            || dateTo !== null
            || sort !== 'soonest'
          }
          onClearAll={() => {
            setSearchInput('')
            // One setSearchParams call wipes every user filter param at
            // once; the slug-based hub route stays put.
            setSearchParams({}, { replace: true })
          }}
        />
      </div>

      <section
        className={`hub-events${isRefreshing ? ' hub-events--refreshing' : ''}`}
        aria-labelledby="hub-events-heading"
      >
        <h2 id="hub-events-heading" className="hub-section-heading">
          {/* For Akron neighborhoods + category hubs we have an exact
              server-side count, so `total` reflects every event that
              matches the active filters — not just the loaded pages.
              That's the "accurate event count of everything" the user
              asked for, even when only the first PAGE_SIZE are
              materialized below. Non-Akron city hubs fall back to the
              client-filtered length since cityMatch happens here. */}
          {(() => {
            const showCount = isAkronNeighborhood || isCategory
              ? total
              : events.length
            if (showCount > 0) {
              return `${showCount.toLocaleString()} upcoming ${showCount === 1 ? 'event' : 'events'}`
            }
            return 'Upcoming events'
          })()}
        </h2>

        {/* Initial load — only show a spinner state when we have
            nothing to render yet. During a filter refresh the old
            grid stays visible (dimmed via .hub-events--refreshing)
            so the page doesn't flash. */}
        {loading && allEvents.length === 0 && !isRefreshing && (
          <p className="hub-empty">Loading events…</p>
        )}

        {error && (
          <p className="hub-empty">Couldn't load events right now. Please try again.</p>
        )}

        {!loading && !isRefreshing && !error && events.length === 0 && (
          <p className="hub-empty">
            No upcoming events match your filters. Try clearing them, or{' '}
            <Link to="/">browse all events</Link>.
          </p>
        )}

        {/* Date-grouped grid with source-overflow caps. Each day
            wraps its own .cards-grid, headed by a DateHeading. Within
            each day, applySourceCap interleaves SourceOverflowCard
            tiles after a source's third event — clicking one expands
            the rest in place. */}
        {grouped.map(([dateKey, dayEvents]) => {
          const items = applySourceCap(dayEvents, expandedSources, dateKey)
          return (
            <div key={`${resultsKey}-${dateKey}`}>
              <DateHeading dateKey={dateKey} />
              <div className="cards-grid">
                {items.map((item) => {
                  if (item.type === 'overflow') {
                    return (
                      <SourceOverflowCard
                        key={`overflow-${item.dateKey}-${item.source}`}
                        source={item.source}
                        hiddenCount={item.hiddenCount}
                        isExpanded={item.isExpanded}
                        onToggle={() => toggleSource(item.dateKey, item.source)}
                      />
                    )
                  }
                  const ev = item.event
                  return (
                    <div
                      key={ev.id}
                      className={`card-enter${item.isRevealed ? ' card-reveal' : ''}`}
                    >
                      <EventCard event={ev} viewMode="comfortable" />
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}

        {/* Infinite scroll sentinel + end-of-list marker. Same
            IntersectionObserver wiring as HomePage. When hasMore
            flips false we render the "Showing all N events" line
            using the exact server count so the user always sees the
            real total. */}
        {allEvents.length > 0 && (
          <div className="load-more">
            {hasMore ? (
              <>
                <div ref={sentinelRef} aria-hidden="true" className="load-more-sentinel" />
                <p className="load-more-loading" aria-live="polite">
                  <span className="load-more-spinner" aria-hidden="true" />
                  <span className="sr-only">Loading more events…</span>
                </p>
              </>
            ) : (
              <p className="load-more-end">
                Showing all {(isAkronNeighborhood || isCategory ? total : events.length).toLocaleString()}{' '}
                {(isAkronNeighborhood || isCategory ? total : events.length) === 1 ? 'event' : 'events'}
              </p>
            )}
          </div>
        )}
      </section>

      {/* Newsletter callout sits between the events list and the
          related-hubs strip so anyone who already scanned the list
          gets the prompt before they decide to leave the page. */}
      <NewsletterCTA
        variant="hub"
        surface={isCategory ? 'category_hub' : isCity ? 'city_hub' : 'neighborhood_hub'}
      />

      {related.length > 0 && (
        <section className="hub-related" aria-labelledby="hub-related-heading">
          <h2 id="hub-related-heading" className="hub-section-heading">Browse other Akron event guides</h2>
          <ul className="hub-related-list">
            {related.map((r) => (
              <li key={r.slug}>
                <Link to={`/events/${r.slug}`}>{r.h1 || r.label}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function HubSearchIcon() {
  return (
    <svg
      className="hub-search-icon"
      width="16" height="16" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth="2.5"
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  )
}

const TODAY = new Date().toISOString().split('T')[0]

/**
 * HubFilters — inline (non-modal) filter & sort strip for hub pages.
 *
 * Mirrors the FilterTray sections used in the homepage modal but lays
 * them out directly on the page so users can browse and toggle without
 * a click-to-open step. Sections corresponding to a locked dimension
 * are omitted. The Sort selector lives on the right of the panel
 * header as a dropdown; a "Clear all" button surfaces next to it when
 * the user has any non-default filter active. The "Hide sources" chip
 * group was removed in 2026-06 — the SourceOverflowCard already covers
 * that need with a per-date-group "See N more from …" affordance.
 */
function HubFilters({
  lockedDimensions,
  sort,            onSort,
  activeIntentId,  onIntentId,
  rawCategories,   onRawCategories,
  priceFilter,     onPriceFilter,
  dateFrom,        onDateFrom,
  dateTo,          onDateTo,
  hasAnyUserFilter,
  onClearAll,
}) {
  function toggleCategoryOption(opt) {
    if (opt.kind === 'intent') {
      onIntentId(activeIntentId === opt.value ? null : opt.value)
      return
    }
    if (rawCategories.includes(opt.value)) {
      onRawCategories(rawCategories.filter(c => c !== opt.value))
    } else {
      onRawCategories([...rawCategories, opt.value])
    }
  }

  function isCategoryOptionActive(opt) {
    return opt.kind === 'intent'
      ? activeIntentId === opt.value
      : rawCategories.includes(opt.value)
  }

  // If every filterable dimension is locked there are no body sections
  // to show — the header (title + sort + clear) is still useful, so
  // we keep rendering the panel rather than collapsing it out.

  return (
    <div className="hub-filters" aria-label="Filter and sort">
      <div className="hub-filters-header">
        <span className="hub-filters-title">Filter &amp; sort</span>
        <div className="hub-filters-actions">
          {hasAnyUserFilter && (
            <button type="button" className="hub-filters-clear" onClick={onClearAll}>
              Clear all
            </button>
          )}
          <label className="hub-filters-sort">
            <span className="hub-filters-sort-label">Sort</span>
            <select
              className="hub-filters-sort-select"
              value={sort}
              onChange={(e) => onSort(e.target.value)}
              aria-label="Sort events"
            >
              {SORT_OPTIONS.map(({ value, label }) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {!lockedDimensions.category && (
        <HubFilterSection label="Category">
          {CATEGORY_OPTIONS.map(opt => (
            <HubChip
              key={`${opt.kind}:${opt.value}`}
              active={isCategoryOptionActive(opt)}
              onClick={() => toggleCategoryOption(opt)}
            >
              {opt.label}
            </HubChip>
          ))}
        </HubFilterSection>
      )}

      {!lockedDimensions.price && (
        <HubFilterSection label="Price">
          {PRICE_OPTIONS.map(({ value, label }) => (
            <HubChip
              key={String(value)}
              active={priceFilter === value}
              onClick={() => onPriceFilter(priceFilter === value ? null : value)}
            >
              {label}
            </HubChip>
          ))}
        </HubFilterSection>
      )}

      {!lockedDimensions.dateRange && (
        <HubFilterSection label="Custom date range">
          <div className="hub-filter-date-row">
            <label className="hub-filter-date-label">
              From
              <input
                type="date"
                className="hub-filter-date-input"
                value={dateFrom ?? ''}
                min={TODAY}
                onChange={e => onDateFrom(e.target.value || null)}
              />
            </label>
            <label className="hub-filter-date-label">
              To
              <input
                type="date"
                className="hub-filter-date-input"
                value={dateTo ?? ''}
                min={dateFrom ?? TODAY}
                onChange={e => onDateTo(e.target.value || null)}
              />
            </label>
            {(dateFrom || dateTo) && (
              <button
                type="button"
                className="hub-filter-date-clear"
                onClick={() => { onDateFrom(null); onDateTo(null) }}
              >
                Clear dates
              </button>
            )}
          </div>
        </HubFilterSection>
      )}
    </div>
  )
}

function HubFilterSection({ label, children }) {
  return (
    <div className="hub-filter-section">
      <span className="hub-filter-section-label">{label}</span>
      <div className="hub-filter-chips">{children}</div>
    </div>
  )
}

function HubChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      className={`hub-filter-chip ${active ? 'active' : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
