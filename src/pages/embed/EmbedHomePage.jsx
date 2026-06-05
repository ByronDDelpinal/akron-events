import { useState } from 'react'
import EventsBrowser from '@/components/EventsBrowser'
import { useEventFilters } from '@/hooks/useEventFilters'
import { useEmbed } from '@/hooks/useEmbed'

/**
 * EmbedHomePage — the grid surface for the white-label embed.
 *
 * Just a title ("Upcoming Events") + the shared EventsBrowser, configured
 * from the embed config. No hero, search, neighborhood picker, popular
 * searches, promos, or footer — those all live on the full site only.
 *
 * Partner-preset filters arrive as ordinary URL params (categories / price /
 * date), which useEventFilters reads back; lockedKeys keep "Clear filters"
 * from escaping them, and the family facet is applied via preset.
 */
export default function EmbedHomePage() {
  const config = useEmbed()

  const filters = useEventFilters({
    lockedKeys: config.lockedKeys,
    preset: { family: config.family },
  })

  // View + density are seeded from config and then user-controllable
  // (when those toggles are enabled).
  const [view, setView] = useState(config.view)
  const [density, setDensity] = useState(config.density)

  return (
    <>
      <div className="embed-header">
        <h2 className="embed-title">Upcoming Events</h2>
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
      />
    </>
  )
}
