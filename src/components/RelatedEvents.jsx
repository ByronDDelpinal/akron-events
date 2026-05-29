import { Link } from 'react-router-dom'
import { useRelatedEvents } from '@/hooks/useEvents'
import { CATEGORY_SHORT } from '@/lib/eventFormatting'
import EventCard from './EventCard'
import './RelatedEvents.css'

/**
 * Renders a "More like this" block at the bottom of an event detail page.
 *
 * Shows up to 4 other upcoming events in the same category. Hides itself
 * entirely when there's nothing to show (no loading skeleton — this is a
 * supplementary section, not core content).
 *
 * Layout: 4-col grid on wide screens, collapsing to 2 → 1 on smaller.
 * Reuses EventCard so styling stays consistent with the homepage.
 */
export default function RelatedEvents({ currentEvent }) {
  const { events, loading } = useRelatedEvents(
    currentEvent?.id,
    currentEvent?.category,
  )

  // Don't render anything while loading or if there's nothing relevant.
  // A "Loading related…" spinner would draw attention to an optional block.
  if (loading || !events || events.length === 0) return null

  const visibleEvents = events.slice(0, 4)
  const categoryLabel = CATEGORY_SHORT[currentEvent.category] ?? currentEvent.category

  return (
    <section className="related-events" aria-labelledby="related-events-heading">
      <div className="related-events-header">
        <h2 id="related-events-heading" className="related-events-heading">
          More {categoryLabel} events
        </h2>
        <Link
          to={`/?categories=${encodeURIComponent(currentEvent.category)}`}
          className="related-events-link"
        >
          See all →
        </Link>
      </div>

      <div className="related-events-grid">
        {visibleEvents.map((event) => (
          <EventCard key={event.id} event={event} viewMode="comfortable" />
        ))}
      </div>
    </section>
  )
}
