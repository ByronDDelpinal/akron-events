import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation, useNavigationType, useParams } from 'react-router-dom'
import { useEffect, useRef } from 'react'
import Header   from '@/components/Header'
import Footer   from '@/components/Footer'
import InstallPrompt from '@/components/InstallPrompt'
import NeighborhoodPickerModal from '@/components/NeighborhoodPickerModal'
import { NeighborhoodProvider } from '@/hooks/useNeighborhood'
import { getMyHubSlug } from '@/lib/myHub'
import EmbedLayout   from '@/pages/embed/EmbedLayout'
import EmbedHomePage from '@/pages/embed/EmbedHomePage'
import HomePage  from '@/pages/HomePage'
import EventPage from '@/pages/EventPage'
import CategoryPage from '@/pages/CategoryPage'
import SubmitPage from '@/pages/SubmitPage'
import AboutPage     from '@/pages/AboutPage'
import OrganizersPage from '@/pages/OrganizersPage'
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
import { historyEntryKey } from '@/lib/historyKey'
import { ThemeProvider } from '@/hooks/useTheme'
import { SEO, buildGraph, organizationSchema, webSiteSchema } from '@/lib/seo'

import '@/styles/globals.css'
import '@/styles/themes.css'
import '@/styles/forms.css'

/**
 * How long a scroll restore waits for the document to grow tall enough to
 * honour the saved position. Covers the restored list page's round trip on a
 * slow connection; past it we stop rather than pester a page that is never
 * going to get there.
 */
const RESTORE_TIMEOUT_MS = 3000

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
  // A restore is "in flight" from a POP mount until we land (or give up). The
  // SAVE effect has to stand down for the duration: window.scrollTo() emits a
  // scroll event like any other, so a save during a restore writes wherever we
  // currently are over the target we're still trying to reach — corrupting the
  // entry for the visitor's NEXT visit to it.
  const restoringRef = useRef(false)

  const scrollKey = `sp:${historyEntryKey(location)}`

  // SAVE — throttled via rAF so rapid scroll events are coalesced.
  useEffect(() => {
    let rafId: number | null = null
    const onScroll = () => {
      if (restoringRef.current) return
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        try { sessionStorage.setItem(scrollKey, String(Math.round(window.scrollY))) } catch { /* ignore */ }
        rafId = null
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [scrollKey])

  // RESTORE — on POP (back/forward/reload).
  //
  // The target is routinely BEYOND the document at mount: a paginated list
  // re-mounts one page tall while its restored depth is still in flight, and a
  // scrollTo past the end silently clamps. That clamp is the whole bug — it
  // parks the visitor at the end-of-list marker with every event above them,
  // which reads as "the page is broken", not "the page is still loading".
  //
  // So: don't scroll until the document can actually honour the target. Poll
  // per frame while the pages land, then scroll once. If the deadline passes
  // without the height arriving (content genuinely shrank — events expire), we
  // leave the visitor at the top, which is at least a coherent place to be.
  useEffect(() => {
    if (navigationType !== 'POP') return
    const saved = (() => {
      try { return parseInt(sessionStorage.getItem(scrollKey) ?? '0', 10) } catch { return 0 }
    })()
    if (!saved) return

    restoringRef.current = true
    const deadline = performance.now() + RESTORE_TIMEOUT_MS
    // Aborting removes every listener below in one shot.
    const abort = new AbortController()
    let rafId = 0

    const stop = () => {
      restoringRef.current = false
      cancelAnimationFrame(rafId)
      abort.abort()
    }

    const step = () => {
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight
      if (maxScroll >= saved) {
        window.scrollTo({ top: saved, behavior: 'instant' })
        // Lift the save suppression a frame LATER, not here: a programmatic
        // scroll dispatches its scroll event asynchronously, so tearing down
        // synchronously would let that event through to the SAVE handler —
        // the exact write this ref exists to block.
        cancelAnimationFrame(rafId)
        abort.abort()
        rafId = requestAnimationFrame(() => { restoringRef.current = false })
        return
      }
      if (performance.now() > deadline) { stop(); return }
      rafId = requestAnimationFrame(step)
    }
    rafId = requestAnimationFrame(step)

    // Hand control back the instant the visitor reaches for it. These are all
    // *input* events, deliberately not 'scroll' — scroll can't tell our own
    // programmatic jump apart from a real one, and would cancel the restore.
    for (const evt of ['wheel', 'touchstart', 'keydown', 'pointerdown']) {
      window.addEventListener(evt, stop, { passive: true, signal: abort.signal })
    }

    return stop
  }, [scrollKey, navigationType])

  // ── Scroll-to-top on PUSH/REPLACE ────────────────────────────────────
  // Skip for hash fragments and navigations tagged state.preserveScroll.
  // Only react to pathname changes, not search, so filter toggles don't jump.
  //
  // pathname is the ONLY dependency on purpose. navigationType and
  // location.state are read for the guards but must NOT be deps: a search-only
  // REPLACE (any in-page filter toggle, e.g. "Hide kids' events") flips
  // navigationType PUSH→REPLACE while pathname is unchanged, and listing it
  // here re-fired this effect and scrolled to top on the first toggle. Reading
  // them without subscribing keeps the guards correct (the effect only runs on
  // a real pathname change, where the current render's values are fresh).
  useEffect(() => {
    if (navigationType === 'POP') return
    if (location.hash) return
    if ((location.state as { preserveScroll?: boolean } | null)?.preserveScroll) return
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

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
          <Route path="/go/neighborhood"     element={<GoNeighborhood />} />
          <Route path="/submit"              element={<SubmitPage />} />
          <Route path="/about"               element={<AboutPage />} />
          <Route path="/organizers"          element={<OrganizersPage />} />
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
    <NeighborhoodProvider>
      <SEO jsonLd={siteGraph} />
      <Header />
      <main>
        <Outlet />
      </main>
      <Footer />
      <InstallPrompt />
      <NeighborhoodPickerModal />
    </NeighborhoodProvider>
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
/**
 * /go/neighborhood — indirection target for the PWA's "My Neighborhood"
 * app shortcut. Manifest shortcuts can't vary per user, so the shortcut
 * points here and we redirect to the locality hub the visitor most
 * recently viewed (written by CategoryPage via rememberMyHub). First-time
 * users land on the homepage, where the location picker lives.
 */
function GoNeighborhood() {
  const slug = getMyHubSlug()
  return <Navigate to={slug ? `/events/${slug}` : '/'} replace />
}

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
