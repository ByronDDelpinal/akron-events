import { Link } from 'react-router-dom'
import { trackEvent } from '@/lib/analytics'
import { EVENTS } from '@/lib/analyticsEvents'
import type { GuideLinkPlacement } from '@/lib/analyticsEvents'
import type { Guide } from '@/lib/guides'

interface GuideCardProps {
  guide: Guide
  /** Where this card is rendered, for analytics. */
  placement: Extract<GuideLinkPlacement, 'guides_hub' | 'related_guides'>
}

/**
 * GuideCard — one guide, as a link. Rendered by both the hub and the related
 * list at the bottom of a guide page, which is why its classes live in
 * Guides.shared.css rather than either page's own stylesheet.
 *
 * The whole card is the link, so its accessible name is the title, the blurb
 * and the duration read together. Wordy, but every part of it is about this
 * guide, which beats a bare "Read more" that means nothing out of context.
 */
export default function GuideCard({ guide, placement }: GuideCardProps) {
  return (
    <Link
      to={`/guides/${guide.slug}`}
      className="guide-card"
      onClick={() => trackEvent(EVENTS.GUIDE_LINK_CLICK, { guide_slug: guide.slug, placement })}
    >
      <h3 className="guide-card-title">{guide.title}</h3>
      <p className="guide-card-blurb">{guide.blurb}</p>
      <p className="guide-card-meta">{guide.durationLabel} read</p>
    </Link>
  )
}
