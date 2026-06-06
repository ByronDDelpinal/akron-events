import { Link } from 'react-router-dom'
import { useRelatedEvents, type AppEvent } from '@/hooks/useEvents'
import { CATEGORY_SHORT } from '@/lib/eventFormatting'
import EventCard from './EventCard'
import './RelatedEvents.css'

/**
 * Renders a "More like this" block at the bottom of an event detail page.
 * Shows up to 4 other upcoming events in the same category, hiding itself
 * entirely when there's nothing to show.
 */
export default function RelatedEvents({ currentEvent }: { currentEvent?: AppEvent | null }) {
  const { events, loading } = useRelatedEvents(
    currentEvent?.id,
    currentEvent?.category,
  )

  // Don't render anything while loading or if there's nothing relevant.
  if (loading || !events || events.length === 0 || !currentEvent) return null

  const visibleEvents = events.slice(0, 4)
  const categoryLabel =
    (CATEGORY_SHORT as Record<string, string>)[currentEvent.category] ?? currentEvent.category

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
