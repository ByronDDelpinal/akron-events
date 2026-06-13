/**
 * NewsletterCTA.tsx
 *
 * Inline "Get Akron events every week" prompt mounted on event detail
 * and category/neighborhood hub pages.
 *
 * Props:
 *   variant — "event" or "hub". Adjusts copy to fit context. Defaults to "hub".
 *   surface — short identifier passed as an internal ?placement= param so the
 *             newsletter_signup event can attribute which page drove the signup.
 *             Deliberately NOT a UTM tag: UTM on internal links resets GA4
 *             session-source attribution and can spawn a new session.
 */

import { Link } from 'react-router-dom'
import './NewsletterCTA.css'

type Variant = 'event' | 'hub'

interface CopyBlock {
  eyebrow: string
  heading: string
  body: string
  cta: string
}

const COPY: Record<Variant, CopyBlock> = {
  event: {
    eyebrow: 'Never miss an event',
    heading: 'Get Akron events in your inbox, on your schedule',
    body:
      "A free email roundup of the best upcoming events in Akron: concerts, family activities, free things to do, and more. Pick how often you want it.",
    cta: 'Sign up free',
  },
  hub: {
    eyebrow: 'Weekly digest',
    heading: 'Get Akron events in your inbox, on your schedule',
    body:
      "A free email roundup of the best upcoming events in Akron: concerts, art shows, family activities, free things to do, and more. Pick how often you want it.",
    cta: 'Sign up free',
  },
}

interface NewsletterCTAProps {
  variant?: Variant
  surface?: string
}

export default function NewsletterCTA({ variant = 'hub', surface = 'inline_cta' }: NewsletterCTAProps) {
  const copy = COPY[variant] || COPY.hub
  const href = `/subscribe?placement=${encodeURIComponent(surface)}`

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
