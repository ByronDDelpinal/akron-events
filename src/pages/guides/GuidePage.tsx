import { Link, useParams } from 'react-router-dom'
import { SEO, buildGraph, breadcrumbSchema, videoObjectSchema } from '@/lib/seo'
import PageHero from '@/components/PageHero'
import VideoFacade from '@/components/VideoFacade'
import { guideBySlug, relatedGuides, TRACK_ANCHORS, TRACK_LABELS } from '@/lib/guides'
import { GUIDE_BODIES } from './guideBodies'
import GuideCard from './GuideCard'
import './Guides.shared.css'
import './GuidePage.css'

/**
 * GuidePage — /guides/:slug.
 *
 * Metadata comes from the registry (src/lib/guides.ts), the prose from a
 * hand-authored body module (./guideBodies.ts). The video box above the body
 * is a facade that loads nothing until it is clicked, and renders a plain
 * placeholder while a guide has no video, which today is all of them. The
 * written walkthrough is the guide, not a summary of one.
 *
 * An unknown slug renders not-found AND noindex: invented /guides/* URLs are
 * exactly what crawlers generate, and they must not be indexable.
 */
export default function GuidePage() {
  const { slug } = useParams<{ slug: string }>()
  const guide = guideBySlug(slug)

  if (!guide) {
    return (
      <>
        <SEO title="Guide not found" path="/guides" noindex />
        <div className="guide-notfound">
          <h1>We do not have a guide at that address.</h1>
          <Link to="/guides">See all guides</Link>
        </div>
      </>
    )
  }

  const Body = GUIDE_BODIES[guide.slug]
  const related = relatedGuides(guide)
  const seoGraph = buildGraph(
    breadcrumbSchema([
      { name: 'Home', url: '/' },
      { name: 'Guides', url: '/guides' },
      { name: guide.title, url: `/guides/${guide.slug}` },
    ]),
    videoObjectSchema(guide),
  )

  return (
    <>
      <SEO
        title={guide.seoTitle}
        description={guide.metaDescription}
        path={`/guides/${guide.slug}`}
        jsonLd={seoGraph}
      />

      <PageHero
        eyebrow={
          <Link className="guide-eyebrow-link" to={`/guides#${TRACK_ANCHORS[guide.track]}`}>
            {TRACK_LABELS[guide.track]}
          </Link>
        }
        title={guide.title}
      >
        {guide.blurb}
      </PageHero>

      <div className="guide-body">
        <VideoFacade
          youtubeId={guide.youtubeId}
          posterSrc={guide.posterSrc}
          title={guide.title}
          guideSlug={guide.slug}
        />

        <article className="guide-prose">{Body ? <Body /> : null}</article>

        {related.length > 0 && (
          <nav className="guide-related" aria-labelledby="guide-related-heading">
            <h2 className="guide-related-heading" id="guide-related-heading">Next</h2>
            <div className="guide-related-grid">
              {related.map((g) => (
                <GuideCard key={g.slug} guide={g} placement="related_guides" />
              ))}
            </div>
          </nav>
        )}

        <p className="guide-footnote">
          Still stuck, or think this guide is wrong about something? Email{' '}
          <a href="mailto:byron@akronpulse.com">byron@akronpulse.com</a>, or head back to{' '}
          <Link to="/guides">all the guides</Link>.
        </p>
      </div>
    </>
  )
}
