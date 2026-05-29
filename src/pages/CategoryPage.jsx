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
 * SEO surface emitted here:
 *   - <title>, <meta description>, canonical, OG, Twitter (via <SEO />)
 *   - JSON-LD @graph: BreadcrumbList, ItemList of upcoming events,
 *     FAQPage (when the hub has FAQs)
 */

import { useMemo } from 'react'
import { useParams, Link, Navigate } from 'react-router-dom'
import { format } from 'date-fns'
import { useEvents, PAGE_SIZE } from '@/hooks/useEvents'
import EventCard from '@/components/EventCard'
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
  CATEGORY_HUBS,
  NEIGHBORHOOD_HUBS,
} from '@/lib/seo'
import { eventPath } from '@/lib/slug'
import './CategoryPage.css'

// Compile-time set of all valid hub slugs — used to 404 cleanly when
// someone hits /events/:something that isn't a known hub or an event
// detail. (Event detail URLs always have a UUID segment after the slug
// — react-router resolves those via the more specific routes in App.)
const ALL_HUB_SLUGS = new Set([
  ...CATEGORY_HUBS.map((h) => h.slug),
  ...NEIGHBORHOOD_HUBS.map((h) => h.slug),
])

/**
 * Neighborhood matcher.
 *
 * Filters the raw event list down to events whose venue matches the
 * neighborhood's `cityMatch` (canonical city strings) AND/OR whose
 * venue name contains one of the hub's `venueIncludes` substrings.
 * This is intentionally permissive — neighborhood boundaries inside a
 * single city ("downtown Akron" vs. "Akron") aren't stored as a strict
 * column, so we match by well-known venue names. Cuyahoga Falls and
 * Stow are separate municipalities so `cityMatch` alone is enough.
 */
function eventMatchesNeighborhood(event, hub) {
  const venue = event.venue
  if (!venue) return false
  const city = (venue.city || '').toLowerCase()
  const cityHit = hub.cityMatch?.some((c) => c.toLowerCase() === city)
  if (!cityHit) return false
  // If the hub didn't specify venue keywords, city match alone is
  // enough (Cuyahoga Falls, Stow, Fairlawn, Copley).
  if (!hub.venueIncludes || hub.venueIncludes.length === 0) return true
  const name = (venue.name || '').toLowerCase()
  return hub.venueIncludes.some((needle) => name.includes(needle.toLowerCase()))
}

export default function CategoryPage() {
  const { slug } = useParams()
  const hub = getHub(slug)

  // Hub slugs are validated client-side via the registry. Anything
  // else under /events/:slug that isn't an event detail route (those
  // have a trailing UUID segment matched by /events/:slug/:id) is a
  // dead-end — redirect to the homepage so users land somewhere
  // useful instead of a barren 404.
  if (!hub) return <Navigate to="/" replace />

  const isCategory = !!getCategoryHub(slug)
  const isNeighborhood = !isCategory && !!getNeighborhoodHub(slug)

  // ── Event fetch ──
  // Categories use the homepage's category/freeOnly/dateRange filters
  // (server-side narrows the result set). Neighborhoods fetch a wider
  // window and filter client-side because the venue-city match isn't
  // expressible in a PostgREST `.eq()`.
  const fetchParams = isCategory
    ? {
        categories: hub.categoryFilter ?? [],
        freeOnly:   !!hub.freeOnly,
        dateRange:  hub.dateRange ?? null,
        limit:      PAGE_SIZE * 2, // hub pages show more than the homepage default
      }
    : {
        // Pull a wider window for neighborhood pages so client-side
        // venue filtering has enough candidates. The total volume is
        // small enough that 100 events is well within Supabase row
        // limits.
        limit: 100,
      }

  const { events: rawEvents, loading, error } = useEvents(fetchParams)

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
  const related = (hub.relatedSlugs ?? [])
    .map((s) => getHub(s))
    .filter(Boolean)

  return (
    <div className="hub-page">
      <SEO
        title={hubTitle(hub)}
        description={hubDescription(hub)}
        path={canonicalPath}
        jsonLd={seoGraph}
      />

      <header className="hub-header">
        <nav className="hub-breadcrumb" aria-label="Breadcrumb">
          <Link to="/">Home</Link>
          <span aria-hidden="true">›</span>
          <span>{hub.label}</span>
        </nav>
        <h1 className="hub-h1">{hub.h1}</h1>
        <p className="hub-intro">{hub.intro}</p>
      </header>

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
            No upcoming events in this category yet. Check back soon, or{' '}
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

// Exported for the App router so callers can decide whether to mount
// CategoryPage or EventPage based on whether the :slug param matches a
// known hub. The two routes share the /events/:slug prefix; the more
// specific /events/:slug/:id event detail is matched first by the
// router thanks to route ordering.
export { ALL_HUB_SLUGS }
