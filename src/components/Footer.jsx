import { Link, useLocation } from 'react-router-dom'
import './Footer.css'

export default function Footer() {
  const { pathname } = useLocation()
  if (pathname.startsWith('/admin')) return null

  return (
    <footer>
      <div className="footer-logo">
        <div className="logo-dot" />
        Turn<span className="amber">out</span>
      </div>
      <p className="footer-tagline">Everything happening in Akron &amp; Summit County, all in one place.</p>
      <div className="footer-links">
        <Link to="/">Browse Events</Link>
        <Link to="/submit">Submit an Event</Link>
        <Link to="/subscribe">Get the Newsletter</Link>
        <Link to="/about">About</Link>
      </div>
      <p className="footer-copy">© {new Date().getFullYear()} Turnout · Made with ♥ in Akron, OH</p>
    </footer>
  )
}
