import { useState } from 'react'
import EventsBrowser from '@/components/EventsBrowser'
import { useEventFilters } from '@/hooks/useEventFilters'
import { useEmbed } from '@/hooks/useEmbed'

/**
 * EmbedHomePage — the grid surface for the white-label embed: a title plus the
 * shared EventsBrowser, configured from the embed config. Partner-preset
 * filters arrive as ordinary URL params; lockedKeys keep "Clear filters" from
 * escaping them, and the family facet is applied via preset.
 */
export default function EmbedHomePage() {
  const config = useEmbed()

  const filters = useEventFilters({
    lockedKeys: config?.lockedKeys,
    preset: { family: config?.family },
    lockedCategories: config?.categories,
    lockedNeighborhoodSlug: config?.neighborhoodSlug,
    lockedVenueCities: config?.venueCities,
  })

  // View + density are seeded from config and then user-controllable.
  const [view, setView] = useState<string>(config?.view ?? 'list')
  const [density, setDensity] = useState<string>(config?.density ?? 'comfortable')

  if (!config) return null

  return (
    <>
      <div className="embed-header">
        <h2 className="embed-title">
          {config.title ?? 'Upcoming Events'}
          {config.placeLabel && (
            <span className="embed-place"> · {config.placeLabel}</span>
          )}
        </h2>
        <span className="embed-attribution">
          Powered by{' '}
          <a href={window.location.origin} target="_blank" rel="noopener noreferrer">
            Akron Pulse
          </a>
        </span>
      </div>

      <EventsBrowser
        filters={filters}
        view={view}        onView={setView}
        density={density}  onDensity={setDensity}
        features={config.features}
        lockedDimensions={config.lockedDimensions}
        lockedCategories={config.categories}
      />
    </>
  )
}
