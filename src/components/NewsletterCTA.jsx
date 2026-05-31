/**
 * NewsletterCTA.jsx
 *
 * Inline "Get Akron events every week" prompt mounted on event detail
 * and category/neighborhood hub pages. Converts one-time visitors
 * (especially share-traffic from social) into a recurring distribution
 * channel Akron Pulse owns end-to-end.
 *
 * Visually distinct from the rest of the page (amber-tinted card
 * background) so it reads as a callout rather than blending in.
 *
 * Props:
 *   variant — "event" or "hub". Just adjusts copy to fit the
 *             surrounding context. Defaults to "hub".
 *   surface — short identifier appended as ?utm_source to the
 *             subscribe link so analytics can attribute which page
 *             drove the signup ("event_detail", "category_hub", etc.).
 */

import { Link } from 'react-router-dom'
import './NewsletterCTA.css'

const COPY = {
  event: {
    eyebrow: 'Never miss an event',
    heading: 'Get Akron events every Thursday',
    body:
      "A free weekly email with the best upcoming events in Akron — concerts, family activities, free things to do, and more.",
    cta: 'Sign up free',
  },
  hub: {
    eyebrow: 'Weekly digest',
    heading: 'Get Akron events every Thursday',
    body:
      "A free weekly email with the best upcoming events in Akron — concerts, art shows, family activities, free things to do, and more. One inbox-friendly summary, no spam.",
    cta: 'Sign up free',
  },
}

export default function NewsletterCTA({ variant = 'hub', surface = 'inline_cta' }) {
  const copy = COPY[variant] || COPY.hub
  // UTM tags so analytics can show which surface produced the click
  // (which produced the signup, which produced the retained reader).
  const href = `/subscribe?utm_source=${encodeURIComponent(surface)}&utm_medium=inline_cta&utm_campaign=newsletter`

  return (
    <aside className="newsletter-cta" aria-labelledby="newsletter-cta-heading">
      <p className="newsletter-cta-eyebrow">{copy.eyebrow}</p>
      <h3 id="newsletter-cta-heading" className="newsletter-cta-heading">
        {copy.heading}
      </h3>
      <p className="newsletter-cta-body">{copy.body}</p>
      <Link to={href} className="newsletter-cta-btn">
        {copy.cta}
      </Link>
    </aside>
  )
}
