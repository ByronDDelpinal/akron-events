import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation, useNavigationType, useParams } from 'react-router-dom'
import { useEffect } from 'react'
import Header   from '@/components/Header'
import Footer   from '@/components/Footer'
import EmbedLayout   from '@/pages/embed/EmbedLayout'
import EmbedHomePage from '@/pages/embed/EmbedHomePage'
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
import EmbedBuilderPage  from '@/pages/EmbedBuilderPage'

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

  // ── Scroll persistence ────────────────────────────────────────────────
  // Manual scroll restoration (history.scrollRestoration = 'manual' set in
  // main.tsx) so back/forward AND reload restore the user's exact position.
  // Position is stored in sessionStorage keyed by location.key.
  //
  // SAVE — throttled via rAF so rapid scroll events are coalesced.
  useEffect(() => {
    let rafId: number | null = null
    const onScroll = () => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        try { sessionStorage.setItem(`sp:${location.key}`, String(Math.round(window.scrollY))) } catch { /* ignore */ }
        rafId = null
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [location.key])

  // RESTORE — on POP (back/forward/reload). Immediate rAF + a 600ms retry to
  // cover async Supabase fetches; the retry is gated on scrollY < 50.
  useEffect(() => {
    if (navigationType !== 'POP') return
    const saved = (() => {
      try { return parseInt(sessionStorage.getItem(`sp:${location.key}`) ?? '0', 10) } catch { return 0 }
    })()
    if (!saved) return

    requestAnimationFrame(() => {
      window.scrollTo({ top: saved, behavior: 'instant' })
      setTimeout(() => {
        if (window.scrollY < 50) window.scrollTo({ top: saved, behavior: 'instant' })
      }, 600)
    })
  }, [location.key, navigationType])

  // ── Scroll-to-top on PUSH/REPLACE ────────────────────────────────────
  // Skip for hash fragments and navigations tagged state.preserveScroll.
  // Only react to pathname changes, not search, so filter toggles don't jump.
  useEffect(() => {
    if (navigationType === 'POP') return
    if (location.hash) return
    if ((location.state as { preserveScroll?: boolean } | null)?.preserveScroll) return
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [location.pathname, navigationType, location.state])

  return (
    <Routes>
      {/* ── White-label embed — chrome-free route group for partner iframes. */}
      <Route path="/embed" element={<EmbedLayout />}>
        <Route index element={<EmbedHomePage />} />
        <Route path="events/:slug/:id" element={<EventPage />} />
      </Route>

      {/* ── Full site — everything else renders inside SiteChrome. */}
      <Route element={<SiteChrome />}>
        <Route path="/"                    element={<HomePage />} />
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
          <Route path="/embed-builder"           element={<EmbedBuilderPage />} />

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
      </Route>
    </Routes>
  )
}

/**
 * SiteChrome — the full-site layout: header, footer, and the site-wide
 * default JSON-LD. Wraps every non-embed route via <Outlet />.
 */
function SiteChrome() {
  const siteGraph = buildGraph(organizationSchema(), webSiteSchema())
  return (
    <>
      <SEO jsonLd={siteGraph} />
      <Header />
      <main>
        <Outlet />
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

// Matches a v4 UUID-shaped string — used to decide whether a single-segment
// /events/:slug is a legacy event UUID or a known category/neighborhood hub.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Dispatch /events/:slug. UUIDs → legacy EventPage (which canonicalizes the
 * URL); known hub slugs → CategoryPage.
 */
function EventsSlugRouter() {
  const { slug } = useParams()
  if (slug && UUID_RE.test(slug)) return <EventPage />
  return <CategoryPage />
}
