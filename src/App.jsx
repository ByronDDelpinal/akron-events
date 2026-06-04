import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigationType, useParams } from 'react-router-dom'
import { useEffect } from 'react'
import Header   from '@/components/Header'
import Footer   from '@/components/Footer'
import HomePage  from '@/pages/HomePage'
import EventPage from '@/pages/EventPage'
import CategoryPage from '@/pages/CategoryPage'
import SubmitPage from '@/pages/SubmitPage'
import AboutPage     from '@/pages/AboutPage'
import TechnicalPage from '@/pages/TechnicalPage'
import VenuesPage      from '@/pages/VenuesPage'
import VenueDetailPage from '@/pages/VenueDetailPage'
import VenueSubmitPage from '@/pages/VenueSubmitPage'
import OrganizationsPage     from '@/pages/OrganizationsPage'
import OrganizationDetailPage from '@/pages/OrganizationDetailPage'
import OrganizationSubmitPage from '@/pages/OrganizationSubmitPage'
import SubscribePage     from '@/pages/SubscribePage'
import PreferencesPage   from '@/pages/PreferencesPage'
import UnsubscribePage   from '@/pages/UnsubscribePage'
import FeedbackPage      from '@/pages/FeedbackPage'

// Admin pages
import AdminLayout from '@/pages/admin/AdminLayout'
import EventsListPage from '@/pages/admin/events/EventsListPage'
import EventEditPage from '@/pages/admin/events/EventEditPage'
import VenuesListPage from '@/pages/admin/venues/VenuesListPage'
import VenueEditPage from '@/pages/admin/venues/VenueEditPage'
import OrganizationsListPage from '@/pages/admin/organizations/OrganizationsListPage'
import OrgEditPage from '@/pages/admin/organizations/OrgEditPage'
import AreasListPage from '@/pages/admin/areas/AreasListPage'
import AreaEditPage from '@/pages/admin/areas/AreaEditPage'
import ScraperRunsPage from '@/pages/admin/scraper-runs/ScraperRunsPage'
import EmailPage from '@/pages/admin/email/EmailPage'
import AdminFeedbackPage from '@/pages/admin/feedback/AdminFeedbackPage'
import ReviewQueuePage from '@/pages/admin/review/ReviewQueuePage'

import { trackPageView } from '@/lib/analytics'
import { ThemeProvider } from '@/hooks/useTheme'
import { SEO, buildGraph, organizationSchema, webSiteSchema } from '@/lib/seo'

import '@/styles/globals.css'
import '@/styles/themes.css'
import '@/styles/forms.css'

export default function App() {
  return (
    <BrowserRouter>
      <ThemeProvider>
        <AppInner />
      </ThemeProvider>
    </BrowserRouter>
  )
}

function AppInner() {
  const location       = useLocation()
  const navigationType = useNavigationType()

  useEffect(() => {
    trackPageView(location.pathname + location.search)
  }, [location])

  // Scroll restoration.
  //
  // React Router v6 does not auto-scroll on navigation. We want:
  //   - PUSH/REPLACE (a fresh link click or programmatic nav) → scroll
  //     to the top so the new page starts at its hero/header instead
  //     of inheriting the previous page's scroll offset.
  //   - POP (browser back/forward button) → leave the position alone
  //     so the browser's native scroll restoration can return the user
  //     to where they were. Scrolling to top here would feel wrong on
  //     a back button.
  //
  // We also skip the scroll when there's a hash fragment so anchor
  // links like /about#faq still jump to the right place. We only
  // react to pathname changes (not search) so toggling filters on the
  // homepage (`?categories=music`) doesn't yank the user to the top.
  //
  // Opt-out: navigations tagged with `state: { preserveScroll: true }`
  // skip the scroll. The neighborhood map uses this when the user
  // clicks a polygon to jump between hub pages — every hub shares the
  // same hero layout, so leaving the scroll alone keeps the map
  // roughly under their pointer instead of yanking them to the top.
  useEffect(() => {
    if (navigationType === 'POP') return
    if (location.hash) return
    if (location.state?.preserveScroll) return
    // Use 'instant' rather than 'smooth' — a smooth scroll on every
    // page change competes with the new page's first paint and feels
    // sluggish, especially on event detail pages.
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [location.pathname, navigationType, location.state])

  // Site-wide JSON-LD — appears on every page as a default. Individual
  // pages still render their own <SEO /> for page-specific meta +
  // page-specific structured data (Event, Place, etc.). react-helmet-async
  // deep-merges tags so later <Helmet> calls override these safely.
  const siteGraph = buildGraph(organizationSchema(), webSiteSchema())

  return (
    <>
      <SEO jsonLd={siteGraph} />
      <Header />
      <main>
        <Routes>
          <Route path="/"                    element={<HomePage />} />
          {/* Canonical event URL is /events/:slug/:id. The bare
              /events/:id route remains so legacy links, sitemap-cached
              URLs, and shared links without a slug still resolve —
              EventPage detects the missing/stale slug and replaces the
              URL with the canonical form.
              The single-segment /events/:slug is dispatched by
              EventsSlugRouter (defined below): UUID-looking slugs go to
              EventPage (legacy bare /events/:id), known hub slugs go
              to CategoryPage. This keeps both URL shapes working
              without route-pattern collisions. */}
          <Route path="/events/:slug/:id"    element={<EventPage />} />
          <Route path="/events/:slug"        element={<EventsSlugRouter />} />
          <Route path="/submit"              element={<SubmitPage />} />
          <Route path="/about"               element={<AboutPage />} />
          <Route path="/technical"           element={<TechnicalPage />} />
          <Route path="/venues"              element={<VenuesPage />} />
          <Route path="/venues/submit"       element={<VenueSubmitPage />} />
          <Route path="/venues/:id"          element={<VenueDetailPage />} />
          <Route path="/organizations"       element={<OrganizationsPage />} />
          <Route path="/organizations/submit" element={<OrganizationSubmitPage />} />
          <Route path="/organizations/:id"   element={<OrganizationDetailPage />} />
          <Route path="/subscribe"               element={<SubscribePage />} />
          <Route path="/subscribe/preferences"   element={<PreferencesPage />} />
          <Route path="/unsubscribe"             element={<UnsubscribePage />} />
          <Route path="/feedback"                element={<FeedbackPage />} />

          {/* Admin — nested routing with shared layout */}
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<Navigate to="events" replace />} />
            <Route path="events"             element={<EventsListPage />} />
            <Route path="events/new"         element={<EventEditPage />} />
            <Route path="events/:id/edit"    element={<EventEditPage />} />
            <Route path="venues"             element={<VenuesListPage />} />
            <Route path="venues/new"         element={<VenueEditPage />} />
            <Route path="venues/:id/edit"    element={<VenueEditPage />} />
            <Route path="organizations"      element={<OrganizationsListPage />} />
            <Route path="organizations/new"  element={<OrgEditPage />} />
            <Route path="organizations/:id/edit" element={<OrgEditPage />} />
            <Route path="areas"              element={<AreasListPage />} />
            <Route path="areas/new"          element={<AreaEditPage />} />
            <Route path="areas/:id/edit"     element={<AreaEditPage />} />
            <Route path="scraper-runs"       element={<ScraperRunsPage />} />
            <Route path="email"              element={<EmailPage />} />
            <Route path="feedback"           element={<AdminFeedbackPage />} />
            <Route path="review"             element={<ReviewQueuePage />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
    </>
  )
}

function NotFound() {
  return (
    <div style={{ textAlign: 'center', padding: '100px 20px', color: 'var(--text-muted)' }}>
      <p style={{ fontFamily: 'var(--font-display)', fontSize: '1.2rem', marginBottom: 8 }}>Page not found</p>
      <a href="/" style={{ color: 'var(--amber)', fontSize: '0.88rem' }}>← Back to events</a>
    </div>
  )
}

// Matches a v4 UUID-shaped string. Used by EventsSlugRouter to decide
// whether a single-segment /events/:slug is a legacy event UUID or a
// known category/neighborhood hub slug. We intentionally accept any
// hex-shaped UUID variant to stay compatible with however Supabase
// emits IDs.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Dispatch /events/:slug. UUIDs → legacy EventPage (the canonicalizer
 * inside EventPage replaces the URL with the slug-first form). Known
 * hub slugs → CategoryPage. Everything else → home.
 */
function EventsSlugRouter() {
  const { slug } = useParams()
  if (UUID_RE.test(slug)) return <EventPage />
  return <CategoryPage />
}
