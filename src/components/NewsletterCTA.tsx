/**
 * NewsletterCTA.tsx
 *
 * Inline "Get Akron events every week" prompt mounted on event detail
 * and category/neighborhood hub pages.
 *
 * Props:
 *   variant — "event" or "hub". Adjusts copy to fit context. Defaults to "hub".
 *   surface — short identifier appended as ?utm_source so analytics can
 *             attribute which page drove the signup.
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
      "A free email roundup of the best upcoming events in Akron — concerts, family activities, free things to do, and more. Pick how often you want it.",
    cta: 'Sign up free',
  },
  hub: {
    eyebrow: 'Weekly digest',
    heading: 'Get Akron events in your inbox, on your schedule',
    body:
      "A free email roundup of the best upcoming events in Akron — concerts, art shows, family activities, free things to do, and more. Pick how often you want it.",
    cta: 'Sign up free',
  },
}

interface NewsletterCTAProps {
  variant?: Variant
  surface?: string
}

export default function NewsletterCTA({ variant = 'hub', surface = 'inline_cta' }: NewsletterCTAProps) {
  const copy = COPY[variant] || COPY.hub
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
