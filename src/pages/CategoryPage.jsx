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
 *     filter-able event list, FAQ block, related-hubs strip.
 *   - The only thing that changes between a category and a
 *     neighborhood is which filter the page applies before listing
 *     events (category vs. venue city/name).
 *   - Sharing the component guarantees both hub types emit the same
 *     SEO surface (canonical, OG, JSON-LD ItemList + FAQ + Breadcrumb).
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
 *   - JSON-LD @graph: BreadcrumbList, ItemList of upcoming events,
 *     FAQPage (when the hub has FAQs)
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, Link, Navigate, useSearchParams } from 'react-router-dom'
import { useEvents, PAGE_SIZE } from '@/hooks/useEvents'
import EventCard from '@/components/EventCard'
import ShareButtons from '@/components/ShareButtons'
import NewsletterCTA from '@/components/NewsletterCTA'
import NeighborhoodMapMockup from '@/components/NeighborhoodMapMockup'
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
  faqPageSchema,
  hubTitle,
  hubDescription,
  getHub,
  getCategoryHub,
  getNeighborhoodHub,
} from '@/lib/seo'
import { NEIGHBORHOOD_SLUGS } from '@/lib/neighborhoods'
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

  const isCategory = !!getCategoryHub(slug)
  const isNeighborhood = !isCategory && !!getNeighborhoodHub(slug)

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
  const intentDef = useMemo(() => {
    if (!activeIntentId) return null
    // Avoid hard-coding the intent list here — duplicate of categories
    // mapping in intents.js. Simple inline lookup keeps this file
    // self-contained without importing the whole intent module for one
    // expansion.
    const intents = {
      'date-night': ['music', 'art', 'food', 'sports'],
      'family-fun': ['education', 'community'],
      'give-back':  ['nonprofit', 'community'],
    }
    return intents[activeIntentId] || null
  }, [activeIntentId])

  const effectiveCategories = lockedDimensions.category
    ? hub.categoryFilter
    : (rawCategories.length > 0 ? rawCategories : (intentDef ?? []))

  const effectiveFreeOnly = lockedDimensions.price ? true : (priceFilter === 'free')
  const effectivePriceMax = lockedDimensions.price ? null
    : (priceFilter === 'free' ? null : priceFilter)
  const effectiveDateRange = lockedDimensions.dateRange ? hub.dateRange : null

  // ── Event fetch ──
  // Categories use the homepage's category/freeOnly/dateRange filters
  // (server-side narrows the result set) and now also pass through the
  // user's search / sort / hide-sources / custom-date overrides.
  //
  // Neighborhoods fetch a wider window and filter client-side because
  // the venue-city match isn't expressible in a PostgREST `.eq()`. We
  // still pass through search/sort so the user's text query and sort
  // pick still narrow the candidate set before client filtering.
  const fetchParams = isCategory
    ? {
        categories: effectiveCategories,
        freeOnly:   effectiveFreeOnly,
        priceMax:   effectivePriceMax,
        dateRange:  effectiveDateRange,
        dateFrom,
        dateTo,
        search,
        sort,
        limit:      PAGE_SIZE * 2, // hub pages show more than the homepage default
      }
    : {
        // Pull a wider window for neighborhood pages so client-side
        // venue filtering has enough candidates. The total volume is
        // small enough that 100 events is well within Supabase row
        // limits.
        search,
        priceMax:  effectivePriceMax,
        freeOnly:  effectiveFreeOnly,
        dateFrom,
        dateTo,
        sort,
        limit:     100,
      }

  const { events: rawEvents, loading, error, total } = useEvents(fetchParams)

  const events = useMemo(() => {
    if (isNeighborhood) {
      return rawEvents.filter((e) => eventMatchesNeighborhood(e, hub))
    }
    return rawEvents
  }, [rawEvents, isNeighborhood, hub])

  // ── SEO graph ──
  const canonicalPath = `/events/${hub.slug}`
  const breadcrumb = breadcrumbSchema([
    { name: 'Home', url: '/' },
    { name: 'Events', url: '/' },
    { name: hub.label, url: canonicalPath },
  ])
  const itemList = itemListSchema(
    events.slice(0, 20).map((e) => ({
      name: e.title,
      url: eventPath(e),
    })),
  )
  const faq = hub.faqs && hub.faqs.length > 0 ? faqPageSchema(hub.faqs) : undefined

  const seoGraph = buildGraph(breadcrumb, itemList, faq)

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
        <nav className="hub-breadcrumb" aria-label="Breadcrumb">
          <Link to="/">Home</Link>
          <span aria-hidden="true">›</span>
          <span>{hub.label}</span>
        </nav>
        <h1 className="hub-h1">{hub.h1}</h1>

        {/* Hero body.
         *
         * Neighborhood hubs that ship with a `mapMockup` (config in
         * src/lib/seo/categories.js) get a two-column hero: intro
         * paragraph on the left, branded neighborhood map on the
         * right. This mirrors the Art × Love poster layout the
         * project is targeting. The grid collapses to a single
         * column on narrow viewports — see CategoryPage.css.
         *
         * Category hubs and neighborhood hubs without a map keep
         * the original single-column intro so nothing about the
         * existing pages changes. */}
        {isNeighborhood && hub.mapMockup ? (
          <div className="hub-hero-grid">
            <p className="hub-intro hub-intro--with-map">{hub.intro}</p>
            <NeighborhoodMapMockup
              activeLabel={hub.label}
              hotspot={hub.mapMockup.hotspot}
            />
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
            campaign={isCategory ? 'category_hub' : 'neighborhood_hub'}
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

      <section className="hub-events" aria-labelledby="hub-events-heading">
        <h2 id="hub-events-heading" className="hub-section-heading">
          {events.length > 0
            ? `${events.length} upcoming ${events.length === 1 ? 'event' : 'events'}`
            : 'Upcoming events'}
        </h2>

        {loading && (
          <p className="hub-empty">Loading events…</p>
        )}

        {!loading && error && (
          <p className="hub-empty">Couldn't load events right now. Please try again.</p>
        )}

        {!loading && !error && events.length === 0 && (
          <p className="hub-empty">
            No upcoming events match your filters. Try clearing them, or{' '}
            <Link to="/">browse all events</Link>.
          </p>
        )}

        {!loading && events.length > 0 && (
          <div className="hub-events-grid">
            {events.map((event) => (
              <EventCard
                key={event.id}
                event={event}
                viewMode="comfortable"
              />
            ))}
          </div>
        )}
      </section>

      {/* Newsletter callout sits between the events list and the FAQ
          so anyone who already scanned the list gets the prompt
          before they decide to leave the page. */}
      <NewsletterCTA
        variant="hub"
        surface={isCategory ? 'category_hub' : 'neighborhood_hub'}
      />

      {hub.faqs && hub.faqs.length > 0 && (
        <section className="hub-faq" aria-labelledby="hub-faq-heading">
          <h2 id="hub-faq-heading" className="hub-section-heading">Frequently asked questions</h2>
          <dl className="hub-faq-list">
            {hub.faqs.map((q, i) => (
              <div key={i} className="hub-faq-item">
                <dt>{q.question}</dt>
                <dd>{q.answer}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

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
