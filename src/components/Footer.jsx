import { Link } from 'react-router-dom'
import './Footer.css'

export default function Footer() {
  return (
    <footer>
      <div className="footer-logo">
        <div className="logo-dot" />
        The <span className="amber">330</span>
      </div>
      <p className="footer-tagline">Akron &amp; Summit County events, all in one place.</p>
      <div className="footer-links">
        <Link to="/">Browse Events</Link>
        <Link to="/submit">Submit an Event</Link>
        <Link to="/about">About</Link>
      </div>
      <p className="footer-copy">© {new Date().getFullYear()} The 330 · Made with ♥ in Akron, OH</p>
    </footer>
  )
}
