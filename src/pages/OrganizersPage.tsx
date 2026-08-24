import { Link } from 'react-router-dom'
import { SEO, buildGraph, breadcrumbSchema } from '@/lib/seo'
import PageHero from '@/components/PageHero'
import { trackEvent, EVENTS } from '@/lib/analytics'
import './OrganizersPage.css'

const INTAKE_EMAIL = 'intake@akronpulse.com'

/**
 * OrganizersPage — the "For Organizers & Partners" hub.
 *
 * The site serves two audiences: people finding events and people making
 * them. This page consolidates every way the second audience plugs in —
 * the submit form, the email intake pipeline, org/venue registration, and
 * the white-label embed — so none of those paths is an orphan.
 */

interface PathCard {
  title: string
  isNew?: boolean
  description: React.ReactNode
  cta: React.ReactNode
  /** Slug of the guide that walks through this path in more detail. */
  guideSlug?: string
  /** Link text for that guide. Specific on purpose: a bare "Learn more" is
   *  useless to anyone reading the links out of context. */
  guideLabel?: string
}

export default function OrganizersPage() {
  const seoGraph = buildGraph(
    breadcrumbSchema([
      { name: 'Home', url: '/' },
      { name: 'Organizers & Partners', url: '/organizers' },
    ]),
  )

  const cards: PathCard[] = [
    {
      title: 'Email it in',
      isNew: true,
      description: (
        <>
          Send your flyer, press release, or newsletter to{' '}
          <a href={`mailto:${INTAKE_EMAIL}`} className="organizers-email">{INTAKE_EMAIL}</a>.
          Our pipeline reads it, and your event is live within 24 hours. No
          forms to fill out. If you can forward an email, you can be on the
          calendar.
        </>
      ),
      cta: <a href={`mailto:${INTAKE_EMAIL}`} className="organizers-card-btn">Email your event →</a>,
      guideSlug: 'how-to-get-on-the-calendar',
      guideLabel: 'What happens after you send it',
    },
    {
      title: 'Submit the form',
      description: (
        <>
          The five-minute version. Tell us what, where, and when. We review
          every submission before it goes live, usually the same day.
        </>
      ),
      cta: <Link to="/submit" className="organizers-card-btn">Submit an event →</Link>,
      guideSlug: 'write-a-listing-that-gets-clicked',
      guideLabel: 'How to write a listing people click',
    },
    {
      title: 'Put this calendar on your site',
      isNew: true,
      description: (
        <>
          A live Akron Pulse calendar embedded on your website: your colors,
          your filters, only the events that fit your audience. We set each
          one up personally and it stays current on its own.
        </>
      ),
      cta: <Link to="/embed-builder" className="organizers-card-btn">Preview your embed →</Link>,
      guideSlug: 'embed-and-partner-portal',
      guideLabel: 'How the embed and the partner portal work',
    },
    {
      title: 'Get listed in the directory',
      description: (
        <>
          Register your organization so it shows up in our public directory
          with its own page listing your upcoming events. No account to
          manage, we keep it current. Run a space instead?{' '}
          <Link to="/venues/submit">Register a venue</Link>.
        </>
      ),
      cta: <Link to="/organizations/submit" className="organizers-card-btn">Register your org →</Link>,
      guideSlug: 'make-your-website-machine-readable',
      guideLabel: 'How to get pulled in automatically',
    },
  ]

  return (
    <>
      <SEO
        title="For Organizers & Partners | Get Your Events on Akron Pulse"
        description="Put your events in front of Akron, free. Submit through a form, email intake@akronpulse.com, register your organization, or embed the live calendar on your own website."
        path="/organizers"
        jsonLd={seoGraph}
      />

      <PageHero title={<>You make it happen. <span>We make it heard.</span></>}>
        Akron Pulse exists so people see what&apos;s going on before it happens.
        If you&apos;re the one making the good stuff happen, here are four ways to
        plug in, all of them free.
      </PageHero>

      <div className="organizers-body">
        <div className="organizers-grid">
          {cards.map(({ title, isNew, description, cta, guideSlug, guideLabel }) => (
            <section key={title} className="organizers-card">
              <h2 className="organizers-card-title">
                {title}
                {isNew && <span className="organizers-new-badge">New</span>}
              </h2>
              <p className="organizers-card-desc">{description}</p>
              {cta}
              {guideSlug && (
                <Link
                  to={`/guides/${guideSlug}`}
                  className="organizers-card-guide"
                  onClick={() => trackEvent(EVENTS.GUIDE_LINK_CLICK, { guide_slug: guideSlug, placement: 'organizers_card' })}
                >
                  {guideLabel}
                </Link>
              )}
            </section>
          ))}
        </div>

        <p className="organizers-footnote">
          Not sure which fits, or want to partner on something bigger? We read
          everything: <a href="mailto:byron@akronpulse.com">byron@akronpulse.com</a> and{' '}
          <a href="mailto:mac@akronpulse.com">mac@akronpulse.com</a>.
        </p>
      </div>
    </>
  )
}
