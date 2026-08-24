import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { SEO, buildGraph, breadcrumbSchema, itemListSchema } from '@/lib/seo'
import PageHero from '@/components/PageHero'
import { prefersReducedMotion } from '@/lib/feedback'
import { GUIDES, TRACK_ANCHORS, TRACK_LABELS, guidesByTrack, type GuideTrack } from '@/lib/guides'
import GuideCard from './GuideCard'
import './Guides.shared.css'
import './GuidesHubPage.css'

const TRACK_INTROS: Record<GuideTrack, string> = {
  using:
    'Short walkthroughs of the parts of the site people tend not to find on their own. None of them take longer to read than they take to do.',
  organizers:
    'How to get your events listed, how to write them so people click, and how to set your own website up so this stops being a chore.',
}

const TRACK_ORDER: GuideTrack[] = ['using', 'organizers']

/**
 * GuidesHubPage — /guides.
 *
 * Two sections, one per audience, mirroring the split the rest of the site
 * already commits to: people finding events and people making them. The
 * footer links straight to each section's anchor, so a visitor never has to
 * read past the other audience's track to reach their own.
 */
export default function GuidesHubPage() {
  const { hash } = useLocation()

  // App.tsx's scroll-to-top deliberately skips navigations with a hash, but
  // React Router does not scroll to one either, so a footer link to
  // /guides#for-organizers would land at the top of the page without this.
  useEffect(() => {
    if (!hash) return
    const el = document.getElementById(hash.slice(1))
    if (!el) return
    el.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }, [hash])

  const seoGraph = buildGraph(
    breadcrumbSchema([
      { name: 'Home', url: '/' },
      { name: 'Guides', url: '/guides' },
    ]),
    itemListSchema(GUIDES.map((g) => ({ name: g.title, url: `/guides/${g.slug}` }))),
  )

  return (
    <>
      <SEO
        title="Guides"
        description="Short guides to getting the most out of Akron Pulse, and to getting your own events listed, written and read the way you meant them."
        path="/guides"
        jsonLd={seoGraph}
      />

      <PageHero title={<>Short guides. <span>No fluff.</span></>}>
        Everything here is something people ask us often enough that it was
        worth writing down. Pick the track that sounds like you.
      </PageHero>

      <div className="guides-body">
        {TRACK_ORDER.map((track) => (
          <section
            key={track}
            id={TRACK_ANCHORS[track]}
            className="guides-track"
            aria-labelledby={`${TRACK_ANCHORS[track]}-heading`}
          >
            <h2 id={`${TRACK_ANCHORS[track]}-heading`} className="guides-track-heading">
              {TRACK_LABELS[track]}
            </h2>
            <p className="guides-track-intro">{TRACK_INTROS[track]}</p>
            <div className="guides-grid">
              {guidesByTrack(track).map((guide) => (
                <GuideCard key={guide.slug} guide={guide} placement="guides_hub" />
              ))}
            </div>
          </section>
        ))}

        <p className="guides-footnote">
          Something you wish was in here? Tell us what you got stuck on:{' '}
          <a href="mailto:byron@akronpulse.com">byron@akronpulse.com</a>.
        </p>
      </div>
    </>
  )
}
