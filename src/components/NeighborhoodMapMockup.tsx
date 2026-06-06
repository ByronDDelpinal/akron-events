/**
 * NeighborhoodMapMockup.tsx
 *
 * Static stand-in for the eventual interactive neighborhood map. Displays a
 * high-fidelity poster (public/neighborhood-map.webp) and overlays a
 * brand-color "you are here" indicator over the active neighborhood.
 *
 * Swap path: when the GIS asset arrives, replace the body with a polygon
 * `<svg>` keyed by `data-slug`; the CategoryPage call site keeps the same props.
 *
 * Props:
 *   activeLabel — the active neighborhood's display name.
 *   hotspot — { x, y } percentages (0–100) locating it on the poster.
 */

import type { CSSProperties } from 'react'
import './NeighborhoodMapMockup.css'

const MAP_SRC = '/neighborhood-map.webp'

interface Hotspot {
  x?: number
  y?: number
}

interface NeighborhoodMapMockupProps {
  activeLabel: string
  hotspot?: Hotspot | null
}

export default function NeighborhoodMapMockup({ activeLabel, hotspot }: NeighborhoodMapMockupProps) {
  // Defensive default: render the bare map if a hub forgets the hotspot.
  const x = hotspot?.x ?? 50
  const y = hotspot?.y ?? 50

  return (
    <figure className="neighborhood-map-mockup" aria-label={`Map of City of Akron neighborhoods, with ${activeLabel} highlighted`}>
      <div className="neighborhood-map-frame">
        <img
          src={MAP_SRC}
          alt=""               // decorative — figure already has aria-label
          loading="lazy"
          decoding="async"
          className="neighborhood-map-image"
        />

        <span
          className="neighborhood-map-hotspot"
          style={{ '--hotspot-x': `${x}%`, '--hotspot-y': `${y}%` } as CSSProperties}
          aria-hidden="true"
        />

        <span className="neighborhood-map-preview-badge">Preview</span>
      </div>

      <figcaption className="neighborhood-map-caption">
        Interactive map coming soon. Hover &amp; click navigation will ship
        with the City of Akron neighborhood polygons.
      </figcaption>
    </figure>
  )
}
