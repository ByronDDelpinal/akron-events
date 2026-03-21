import { BrowserRouter, Routes, Route, ScrollRestoration } from 'react-router-dom'
import Header   from '@/components/Header'
import Footer   from '@/components/Footer'
import HomePage  from '@/pages/HomePage'
import EventPage from '@/pages/EventPage'
import SubmitPage from '@/pages/SubmitPage'
import AboutPage  from '@/pages/AboutPage'
import '@/styles/globals.css'

function ScrollToTop() {
  // Scroll to top on every route change
  const { pathname } = window.location
  return null
}

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
          <Route path="/"           element={<HomePage />} />
          <Route path="/events/:id" element={<EventPage />} />
          <Route path="/submit"     element={<SubmitPage />} />
          <Route path="/about"      element={<AboutPage />} />
          <Route path="*"           element={<NotFound />} />
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
