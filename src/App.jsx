import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Header   from '@/components/Header'
import Footer   from '@/components/Footer'
import HomePage  from '@/pages/HomePage'
import EventPage from '@/pages/EventPage'
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

import '@/styles/globals.css'

export default function App() {
  return (
    <BrowserRouter>
      <AppInner />
    </BrowserRouter>
  )
}

function AppInner() {
  return (
    <>
      <Header />
      <main>
        <Routes>
          <Route path="/"                    element={<HomePage />} />
          <Route path="/events/:id"          element={<EventPage />} />
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
