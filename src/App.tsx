import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation, useNavigationType, useParams } from 'react-router-dom'
import { Suspense, lazy, useEffect, useRef } from 'react'
import Header   from '@/components/Header'
import Footer   from '@/components/Footer'
import InstallPrompt from '@/components/InstallPrompt'
import NeighborhoodPickerModal from '@/components/NeighborhoodPickerModal'
import { NeighborhoodProvider } from '@/hooks/useNeighborhood'
import { getMyHubSlug } from '@/lib/myHub'
// Eager pages — the high-traffic surfaces on the critical path: the homepage,
// hub pages (CategoryPage via EventsSlugRouter), event detail, and the embed
// shell. Everything else is React.lazy below so its code (and anything only it
// imports) leaves the entry chunk.
import EmbedLayout   from '@/pages/embed/EmbedLayout'
import EmbedHomePage from '@/pages/embed/EmbedHomePage'
import HomePage  from '@/pages/HomePage'
import EventPage from '@/pages/EventPage'
import CategoryPage from '@/pages/CategoryPage'

// Route-split pages — each becomes its own chunk, fetched on first visit.
// The single <Suspense> around SiteChrome's <Outlet/> shows RouteFallback
// while a chunk loads. (Every route in the /embed group is eager, so the
// embed outlet needs no Suspense.)
const SubmitPage = lazy(() => import('@/pages/SubmitPage'))
const AboutPage     = lazy(() => import('@/pages/AboutPage'))
const OrganizersPage = lazy(() => import('@/pages/OrganizersPage'))
const TechnicalPage = lazy(() => import('@/pages/TechnicalPage'))
const VenuesPage      = lazy(() => import('@/pages/VenuesPage'))
const VenueDetailPage = lazy(() => import('@/pages/VenueDetailPage'))
const VenueSubmitPage = lazy(() => import('@/pages/VenueSubmitPage'))
const OrganizationsPage     = lazy(() => import('@/pages/OrganizationsPage'))
const OrganizationDetailPage = lazy(() => import('@/pages/OrganizationDetailPage'))
const OrganizationSubmitPage = lazy(() => import('@/pages/OrganizationSubmitPage'))
const SubscribePage     = lazy(() => import('@/pages/SubscribePage'))
const PreferencesPage   = lazy(() => import('@/pages/PreferencesPage'))
const UnsubscribePage   = lazy(() => import('@/pages/UnsubscribePage'))
const EmbedBuilderPage  = lazy(() => import('@/pages/EmbedBuilderPage'))
const DayPlanPage    = lazy(() => import('@/pages/DayPlanPage'))
const SharedPlanPage = lazy(() => import('@/pages/SharedPlanPage'))
const FestivalPage   = lazy(() => import('@/pages/FestivalPage'))

// Admin pages — visitors never pay for the admin surface.
const AdminLayout = lazy(() => import('@/pages/admin/AdminLayout'))
const EventsListPage = lazy(() => import('@/pages/admin/events/EventsListPage'))
const EventEditPage = lazy(() => import('@/pages/admin/events/EventEditPage'))
const VenuesListPage = lazy(() => import('@/pages/admin/venues/VenuesListPage'))
const VenueEditPage = lazy(() => import('@/pages/admin/venues/VenueEditPage'))
const OrganizationsListPage = lazy(() => import('@/pages/admin/organizations/OrganizationsListPage'))
const OrgEditPage = lazy(() => import('@/pages/admin/organizations/OrgEditPage'))
const AreasListPage = lazy(() => import('@/pages/admin/areas/AreasListPage'))
const AreaEditPage = lazy(() => import('@/pages/admin/areas/AreaEditPage'))
const ScraperRunsPage = lazy(() => import('@/pages/admin/scraper-runs/ScraperRunsPage'))
const EmailPage = lazy(() => import('@/pages/admin/email/EmailPage'))
const ReviewQueuePage = lazy(() => import('@/pages/admin/review/ReviewQueuePage'))
const AdminFeedbackPage = lazy(() => import('@/pages/admin/feedback/AdminFeedbackPage'))

import { trackPageView } from '@/lib/analytics'
import { historyEntryKey } from '@/lib/historyKey'
import { ThemeProvider } from '@/hooks/useTheme'
import { DayPlanProvider } from '@/hooks/useDayPlan'
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
        {/* Wraps BOTH the /embed route group and the full-site SiteChrome
            group, above <Routes>, so the local day-plan draft is available
            to every consumer (Header's pill, AddToPlanButton on cards/
            EventPage, /day) via one unconditional hook call regardless of
            surface. AddToPlanButton itself decides not to render inside the
            embed (decision 8) -- this provider does not gate on that. */}
        <DayPlanProvider>
          <AppInner />
        </DayPlanProvider>
      </ThemeProvider>
    </BrowserRouter>
  )
}

function AppInner() {
  const location       = useLocation()
  const navigationType = useNavigationType()

  // Fire a GA4 page_view on real navigations only. useEventFilters writes
  // every filter toggle to the URL search params (setSearchParams with
  // { replace: true }), which mutates `location` without a navigation. Keying
  // the hit on the whole location counted that filter-param churn as
  // pageviews and inflated screenPageViews ~2-4x. Guarding on pathname means a
  // hit fires once per page and filter changes don't; filter usage is captured
  // separately via custom events (category_filter, when_filter, …). We still
  // send location.search so the landing filter state is recorded on arrival.
  // NOTE: a future route whose primary navigation is param-only (e.g.
  // /search?q=) would need a carve-out here.
  const lastPathRef = useRef<string | null>(null)
  useEffect(() => {
    if (location.pathname === lastPathRef.current) return
    lastPathRef.current = location.pathname
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
          <Route path="/embed-builder"           element={<EmbedBuilderPage />} />
          {/* Day planner. Both noindex via vercel.json's X-Robots-Tag header
              (the code in /d/:code is a bearer credential -- see
              src/lib/analytics.ts's redactPath) and excluded from
              scripts/prerender.js + api/sitemap.xml.js -- see
              scripts/tests/test-day-plan-guards.js. */}
          <Route path="/day"                     element={<DayPlanPage />} />
          <Route path="/d/:code"                 element={<SharedPlanPage />} />
          {/* Festival hubs — per-tag schedule pages driven by the static
              registry in src/lib/festivals.ts (unknown slug → not found). */}
          <Route path="/festival/:slug"          element={<FestivalPage />} />

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
            <Route path="review"             element={<ReviewQueuePage />} />
            <Route path="feedback"           element={<AdminFeedbackPage />} />
          </Route>

          <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}

/**
 * SiteChrome — the full-site layout: header, footer, and the site-wide
 * default JSON-LD. Wraps every non-embed route via <Outlet />.
 *
 * The feedback affordance is NOT mounted here — it lives inside Header
 * (desktop CTA row + mobile menu) so it naturally shares Header's own
 * /admin hide-check, and is separately mounted in AdminLayout's topbar
 * so admin pages keep it too. Only /embed gets neither, since EmbedLayout
 * never renders Header or AdminLayout.
 */
function SiteChrome() {
  const siteGraph = buildGraph(organizationSchema(), webSiteSchema())
  return (
    <NeighborhoodProvider>
      <SEO jsonLd={siteGraph} />
      <Header />
      <main>
        {/* One Suspense boundary for every route-split page above: the lazy
            chunk loads behind RouteFallback while the chrome stays mounted. */}
        <Suspense fallback={<RouteFallback />}>
          <Outlet />
        </Suspense>
      </main>
      <Footer />
      <InstallPrompt />
      <NeighborhoodPickerModal />
    </NeighborhoodProvider>
  )
}

/**
 * RouteFallback — minimal centered loading state shown while a lazy route
 * chunk downloads. Inline styles (like NotFound below) so it depends on no
 * page-specific CSS; copy mirrors the existing "Loading events…" states.
 */
function RouteFallback() {
  return (
    <div style={{ textAlign: 'center', padding: '100px 20px', color: 'var(--text-muted)' }} role="status">
      <p style={{ fontFamily: 'var(--font-body)', fontSize: '0.92rem' }}>Loading…</p>
    </div>
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
